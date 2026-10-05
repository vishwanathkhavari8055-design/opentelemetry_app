/**
 * The Category Table face of Log Analytics.
 *
 * Guards what an operator relies on when drilling log volume through the Product
 * Catalog: rows come from the backend and a row click or picker asks for the next
 * level (category -> product -> microservice) with exactly those query params; the
 * microservice step filters rows already loaded instead of refetching; a count cell
 * opens Logs on exactly what it counted without also drilling the row under it; a
 * failed fetch shows its message and never the reassuring "nothing registered";
 * and the empty-catalog, partial-scan and unsupported states each say what they are.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubAnalytics, countCalls, logCounts } from './fixtures.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within, act } = await import('@testing-library/react');
const { default: AnalyticsDashboardView } = await import('../../../../src/components/analytics/AnalyticsDashboardView.jsx');

const rowOf = (label) => screen.getByText(label, { selector: '.an-label-text' }).closest('[role="row"]');
const labels = () => [...document.querySelectorAll('.an-body .an-label-text')].map((n) => n.textContent);

let net;
const mount = async (props = {}, stub = {}) => {
  net = stubAnalytics(stub);
  const utils = render(React.createElement(AnalyticsDashboardView, props));
  return utils;
};

describe('AnalyticsDashboardView', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    net?.restore();
    net = null;
    localStorage.clear();
  });

  it('loads the categories with totals, sorted by volume, for the last 24 hours', async () => {
    await mount();
    await screen.findByText('Applications', { selector: '.an-label-text' });
    assert.deepEqual(labels(), ['Applications', 'Tools']);
    assert.deepEqual(countCalls(net.calls)[0], { window: 'now-24h' });
    // Stat tiles: 1500 + 10 total.
    const stats = document.querySelector('.an-stats');
    assert.match(stats.textContent, /Total logs1\.5K/);
    assert.match(stats.textContent, /Error100/);
    // Heading names the level the backend returned.
    assert.ok(screen.getByRole('button', { name: /^Category/ }));
    // Footer carries the window.
    assert.ok(document.querySelector('.an-foot-range'));
    // Category-level rows sum several services, so their counts are not links.
    assert.equal(within(rowOf('Applications')).queryAllByRole('button').length, 0);
  });

  it('drills category -> product -> microservice by clicking rows, and climbs back via the crumbs', async () => {
    const drills = [];
    await mount({ onDrillToLogs: (d) => drills.push(d) });
    fireEvent.click(await waitFor(() => rowOf('Applications')));
    await screen.findByText('IoT Hub', { selector: '.an-label-text' });
    assert.deepEqual(countCalls(net.calls).at(-1), { category: 'APP', window: 'now-24h' });
    assert.ok(screen.getByRole('button', { name: /^Product/ }));
    assert.ok(within(screen.getByRole('navigation', { name: 'Drill path' })).getByText('Applications'));

    // A product-less resource row is not drillable: clicking it asks for nothing.
    const before = net.calls.length;
    fireEvent.click(rowOf('Lone resource'));
    assert.equal(net.calls.length, before);

    fireEvent.keyDown(rowOf('IoT Hub'), { key: 'Enter' });
    await screen.findByText('SvcA', { selector: '.an-label-text' });
    assert.deepEqual(countCalls(net.calls).at(-1), { category: 'APP', product: 'IOT', window: 'now-24h' });
    assert.ok(screen.getByRole('button', { name: /^Microservice/ }));
    const crumbs = screen.getByRole('navigation', { name: 'Drill path' });
    assert.ok(within(crumbs).getByText('IoT Hub'));

    // Leaf rows do not drill further.
    const leafCalls = net.calls.length;
    fireEvent.click(rowOf('SvcA'));
    assert.equal(net.calls.length, leafCalls);

    // A single-service count is a link into Logs, and clicking it does not drill the row.
    const errorCell = within(rowOf('SvcA')).getByRole('button', { name: '100' });
    assert.match(errorCell.title, /Open these 100 ERROR logs for svcA in Logs/);
    const errBtn = within(rowOf('SvcA')).getAllByRole('button').find((b) => /ERROR logs/.test(b.title));
    fireEvent.keyDown(errBtn, { key: 'Enter' });
    fireEvent.click(errBtn);
    assert.equal(drills.length, 1);
    assert.deepEqual(drills[0].services, ['svcA']);
    assert.equal(drills[0].severity, 'ERROR');
    assert.deepEqual(drills[0].range, { mode: 'relative', relative: '1d', from: '', to: '' });
    assert.equal(net.calls.length, leafCalls);

    // Climb back to the category, then to the top.
    fireEvent.click(within(crumbs).getByRole('button', { name: 'Applications' }));
    await screen.findByText('Lone resource', { selector: '.an-label-text' });
    fireEvent.click(within(crumbs).getByRole('button', { name: 'All categories' }));
    await screen.findByText('Tools', { selector: '.an-label-text' });
    assert.deepEqual(countCalls(net.calls).at(-1), { window: 'now-24h' });
  });

  it('cascades the pickers from the catalog scope and filters leaf rows without refetching', async () => {
    await mount();
    const category = await screen.findByRole('combobox', { name: 'Category' });
    await waitFor(() => assert.equal(category.disabled, false));
    const product = screen.getByRole('combobox', { name: 'Product' });
    const micro = screen.getByRole('combobox', { name: 'Microservice' });
    assert.equal(product.disabled, true);
    assert.equal(micro.options[0].textContent, 'Select a category first');

    fireEvent.change(category, { target: { value: 'APP' } });
    await screen.findByText('IoT Hub', { selector: '.an-label-text' });
    assert.equal(micro.options[0].textContent, 'Select a product first');
    assert.deepEqual([...product.options].map((o) => o.textContent), ['All products', 'IoT Hub (3)']);

    fireEvent.change(product, { target: { value: 'IOT' } });
    await screen.findByText('SvcB', { selector: '.an-label-text' });
    assert.deepEqual(countCalls(net.calls).at(-1), { category: 'APP', product: 'IOT', window: 'now-24h' });

    const fetched = net.calls.length;
    fireEvent.change(screen.getByRole('combobox', { name: 'Microservice' }), { target: { value: 'svc-b' } });
    assert.deepEqual(labels(), ['SvcB']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Microservice' }), { target: { value: 'svc-z' } });
    assert.ok(screen.getByText(/That microservice is not in the current results/));
    assert.equal(net.calls.length, fetched);

    // Clearing the product step drops the microservice and goes back to products.
    fireEvent.change(screen.getByRole('combobox', { name: 'Product' }), { target: { value: '' } });
    await screen.findByText('Lone resource', { selector: '.an-label-text' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByText('Tools', { selector: '.an-label-text' });
    assert.equal(screen.queryByRole('button', { name: 'Clear' }), null);
  });

  it('skips the product step for a category with no product tier', async () => {
    await mount();
    const category = await screen.findByRole('combobox', { name: 'Category' });
    await waitFor(() => assert.equal(category.disabled, false));
    fireEvent.change(category, { target: { value: 'TOOLS' } });
    await screen.findByText('Tool1', { selector: '.an-label-text' });
    assert.equal(screen.queryByRole('combobox', { name: 'Product' }), null);
    const micro = screen.getByRole('combobox', { name: 'Microservice' });
    assert.equal(micro.disabled, false);
    assert.deepEqual([...micro.options].map((o) => o.textContent), ['All microservices', 'Tool1']);
    assert.equal(micro.closest('label').querySelector('.an-step-n').textContent, '2');
    // Unpicking the category returns to the top.
    fireEvent.change(category, { target: { value: '' } });
    await screen.findByText('Applications', { selector: '.an-label-text' });
  });

  it('sorts by any column, flipping direction on a second click', async () => {
    await mount();
    await screen.findByText('Tools', { selector: '.an-label-text' });
    fireEvent.click(screen.getByRole('button', { name: /^Total Logs/ }));
    assert.deepEqual(labels(), ['Tools', 'Applications']);
    fireEvent.click(screen.getByRole('button', { name: /^Total Logs/ }));
    assert.deepEqual(labels(), ['Applications', 'Tools']);
    fireEvent.click(screen.getByRole('button', { name: /^Category/ }));
    assert.deepEqual(labels(), ['Tools', 'Applications']);
    fireEvent.click(screen.getByRole('button', { name: /^Category/ }));
    assert.deepEqual(labels(), ['Applications', 'Tools']);
    for (const col of ['Info', 'Warn', 'Error', 'Debug']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${col}`) }));
      assert.equal(labels()[0], 'Applications');
    }
  });

  it('shows a failed fetch as an error and never as "nothing registered"; Retry asks again', async () => {
    let fail = true;
    await mount({}, {
      counts: (url) => (fail ? { status: 500, body: { message: 'OpenObserve unreachable' } } : logCounts(url)),
      scope: { status: 500, body: {} },
    });
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /OpenObserve unreachable/);
    assert.equal(screen.queryByText(/Nothing registered at this level/), null);
    // The scope failed too, so the pickers have nothing to offer.
    assert.equal(screen.getByRole('combobox', { name: 'Category' }).disabled, true);
    assert.equal(screen.getByRole('combobox', { name: 'Category' }).options[0].textContent, 'Nothing registered');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Applications', { selector: '.an-label-text' });
    assert.equal(screen.queryByRole('alert'), null);
  });

  it('keeps the rows on screen when a refresh fails', async () => {
    let fail = false;
    await mount({}, { counts: (url) => (fail ? { status: 502, body: {} } : logCounts(url)) });
    await screen.findByText('Applications', { selector: '.an-label-text' });
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('alert');
    assert.deepEqual(labels(), ['Applications', 'Tools']);
  });

  it('points an empty catalog at the Product Catalog', async () => {
    const went = [];
    await mount({ onNavigate: (t) => went.push(t) }, {
      counts: { level: 'CATEGORY', items: [], catalogEmpty: true },
    });
    await screen.findByText(/Nothing is registered in the Product Catalog yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Product Catalog' }));
    assert.deepEqual(went, ['catalog']);
  });

  it('states a partial scan and an unsupported backend, and an empty level', async () => {
    await mount({}, {
      counts: { level: 'CATEGORY', items: [], complete: false, supported: false, message: 'Logs stream missing' },
    });
    const status = await screen.findByRole('status');
    assert.match(status.textContent, /Logs stream missing/);
    assert.match(screen.getByRole('alert').textContent, /Logs stream missing/);
    assert.ok(screen.getByText('Logs stream missing', { selector: '.iam-state' }));
  });

  it('says "nothing registered at this level" with the default partial-scan warning', async () => {
    await mount({}, { counts: { level: 'CATEGORY', items: [], complete: false } });
    assert.ok(await screen.findByText('Nothing registered at this level yet.'));
    assert.match(screen.getByRole('status').textContent, /these counts are a floor/);
  });

  it('remembers the time range and refetches with it', async () => {
    localStorage.setItem('observability-ui:analytics:window:v1', 'now-7d');
    await mount();
    const range = screen.getByRole('combobox', { name: 'Time range' });
    assert.equal(range.value, 'now-7d');
    await screen.findByText('Applications', { selector: '.an-label-text' });
    fireEvent.change(range, { target: { value: 'now-1h' } });
    await waitFor(() => assert.equal(countCalls(net.calls).at(-1).window, 'now-1h'));
    assert.equal(localStorage.getItem('observability-ui:analytics:window:v1'), 'now-1h');
  });

  it('auto-refreshes on the chosen interval, and not at all when Off', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      await mount();
      await screen.findByText('Applications', { selector: '.an-label-text' });
      const first = countCalls(net.calls).length;
      act(() => mock.timers.tick(60_000));
      await waitFor(() => assert.equal(countCalls(net.calls).length, first + 1));
      fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh interval' }), { target: { value: '0' } });
      act(() => mock.timers.tick(600_000));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(countCalls(net.calls).length, first + 1);
    } finally {
      mock.timers.reset();
    }
  });
});
