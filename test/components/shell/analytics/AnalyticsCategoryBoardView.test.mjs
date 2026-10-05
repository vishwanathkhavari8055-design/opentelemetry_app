/**
 * The Category Board face of Log Analytics.
 *
 * Guards the board's contract: every category is a card with its share of the
 * estate and its microservice count (not its product count); clicking a card asks
 * for that category's services flattened past the product tier
 * (level=microservice) and clicking it again closes it; the selection survives a
 * reload but is dropped once the catalog no longer has it; a panel of all-zero
 * services says it is silence and offers a wider window; counts open Logs on
 * exactly what they counted; and a failed fetch is an error, never "no logs".
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubAnalytics, countCalls, logCounts, CATEGORIES } from './fixtures.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within, act } = await import('@testing-library/react');
const { default: AnalyticsCategoryBoardView } = await import('../../../../src/components/analytics/AnalyticsCategoryBoardView.jsx');

const LS_CATEGORY = 'observability-ui:analytics:board:category:v1';
const LS_WINDOW = 'observability-ui:analytics:window:v1';

const card = (label) => screen.getByText(label, { selector: '.acb-card-name' }).closest('button');
const serviceNames = () => [...document.querySelectorAll('.acb-row .acb-name-text')].map((n) => n.textContent);
const rowOf = (label) => screen.getByText(label, { selector: '.acb-name-text' }).closest('.acb-row');

let net;
const mount = (props = {}, stub = {}) => {
  net = stubAnalytics(stub);
  return render(React.createElement(AnalyticsCategoryBoardView, props));
};

describe('AnalyticsCategoryBoardView', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    net?.restore();
    net = null;
    localStorage.clear();
  });

  it('shows every category as a card with its share, service count and severity split', async () => {
    mount();
    await screen.findByText('Applications', { selector: '.acb-card-name' });
    const app = card('Applications');
    assert.equal(app.getAttribute('aria-pressed'), 'false');
    assert.equal(app.querySelector('.acb-card-children').textContent, '2'); // leafCount, not childCount
    assert.match(app.querySelector('.acb-card-share').textContent, /^99% of estate/);
    assert.match(app.querySelector('.acb-bar .sr-only').textContent, /Info 67%/);
    assert.match(app.title, /Counted from service_name=svcA, service_name=svcB/);
    assert.equal(card('Tools').querySelector('.acb-card-children').textContent, '1');
    assert.match(card('Tools').querySelector('.acb-card-share').textContent, /^<1%/);
    assert.ok(screen.getByText('Pick a category to list every microservice inside it.'));
    assert.deepEqual(countCalls(net.calls), [{ window: 'now-24h' }]);
    assert.ok(document.querySelector('.acb-foot-range'));
  });

  it('opens a category as a flat, ranked list of services, drills counts into Logs, and closes on a second click', async () => {
    const drills = [];
    mount({ onDrillToLogs: (d) => drills.push(d) });
    fireEvent.click(await waitFor(() => card('Applications')));
    await screen.findByText('SvcA', { selector: '.acb-name-text' });
    assert.deepEqual(countCalls(net.calls).at(-1), { category: 'APP', level: 'microservice', window: 'now-24h' });
    assert.equal(card('Applications').getAttribute('aria-pressed'), 'true');
    assert.ok(screen.getByText('Every microservice registered under Applications.'));
    assert.deepEqual(serviceNames(), ['SvcA', 'SvcB']);
    assert.equal(localStorage.getItem(LS_CATEGORY), 'APP');
    const panel = screen.getByRole('region', { name: 'Applications microservices' });
    assert.ok(within(panel).getByRole('button', { name: /^Microservice/ }));
    assert.match(rowOf('SvcA').title, /^In IoT Hub\. Counted from service_name=svcA/);

    // Sorting.
    fireEvent.click(within(panel).getByRole('button', { name: /^Total logs/ }));
    assert.deepEqual(serviceNames(), ['SvcB', 'SvcA']);
    fireEvent.click(within(panel).getByRole('button', { name: /^Microservice/ }));
    assert.deepEqual(serviceNames(), ['SvcB', 'SvcA']);
    fireEvent.click(within(panel).getByRole('button', { name: /^Microservice/ }));
    assert.deepEqual(serviceNames(), ['SvcA', 'SvcB']);
    fireEvent.click(within(panel).getByRole('button', { name: /^Warn/ }));
    assert.deepEqual(serviceNames(), ['SvcB', 'SvcA']);

    // An error count opens Logs on exactly that service and severity; Other is not a link.
    const errBtn = within(rowOf('SvcA')).getAllByRole('button').find((b) => /ERROR logs/.test(b.title));
    fireEvent.click(errBtn);
    assert.deepEqual(drills[0].services, ['svcA']);
    assert.equal(drills[0].severity, 'ERROR');
    assert.equal(drills[0].count, 100);
    const other = rowOf('SvcA').querySelector('.acb-num.is-dim');
    assert.equal(other.tagName, 'SPAN');
    assert.match(other.title, /no severity set/);

    fireEvent.click(card('Applications'));
    await waitFor(() => assert.equal(screen.queryByRole('region', { name: /microservices/ }), null));
    assert.equal(localStorage.getItem(LS_CATEGORY), null);
  });

  it('restores the open category from storage, and drops it when the catalog no longer has it', async () => {
    localStorage.setItem(LS_CATEGORY, 'TOOLS');
    mount();
    await screen.findByText('Tool1', { selector: '.acb-name-text' });
    assert.equal(card('Tools').getAttribute('aria-pressed'), 'true');
    cleanup();
    net.restore();

    localStorage.setItem(LS_CATEGORY, 'GONE');
    mount();
    await screen.findByText('Applications', { selector: '.acb-card-name' });
    await waitFor(() => assert.equal(localStorage.getItem(LS_CATEGORY), null));
    assert.equal(screen.queryByRole('region', { name: /microservices/ }), null);
  });

  it('says a panel of silent services is silence, and widens the window on request', async () => {
    const silent = (url) => {
      const res = logCounts(url);
      if (/category=TOOLS/.test(url)) {
        return { ...res, items: res.items.map((r) => ({ ...r, total: 0, info: 0 })) };
      }
      return res;
    };
    localStorage.setItem(LS_WINDOW, 'now-1h');
    mount({}, { counts: silent });
    fireEvent.click(await waitFor(() => card('Tools')));
    const note = await screen.findByText(/none produced a log line in the last hour/);
    assert.match(note.textContent, /All 1 of these microservices are registered and enabled/);
    fireEvent.click(screen.getByRole('button', { name: 'Try last 6 hours' }));
    await waitFor(() => assert.equal(countCalls(net.calls).at(-1).window, 'now-6h'));
    assert.equal(screen.getByRole('combobox', { name: 'Time range' }).value, 'now-6h');
    assert.equal(localStorage.getItem(LS_WINDOW), 'now-6h');

    // On the widest window there is nothing wider to offer.
    fireEvent.change(screen.getByRole('combobox', { name: 'Time range' }), { target: { value: 'now-7d' } });
    await screen.findByText(/none produced a log line in the last 7 days/);
    assert.equal(screen.queryByRole('button', { name: /^Try / }), null);
  });

  it('shows an empty category, and a failed category load, inside its panel', async () => {
    let membersFail = false;
    const counts = (url) => {
      if (/category=/.test(url)) {
        if (membersFail) return { status: 500, body: { message: 'services query failed' } };
        return { level: 'MICROSERVICE', items: [] };
      }
      return logCounts(url);
    };
    mount({}, { counts });
    fireEvent.click(await waitFor(() => card('Tools')));
    assert.ok(await screen.findByText('Nothing is registered under this category yet.'));
    membersFail = true;
    fireEvent.click(card('Applications'));
    const panel = await screen.findByRole('region', { name: 'Applications microservices' });
    await within(panel).findByRole('alert');
    assert.match(within(panel).getByRole('alert').textContent, /services query failed/);
  });

  it('reports a failed board load, keeps nothing reassuring on screen, and retries', async () => {
    let fail = true;
    mount({}, { counts: (url) => (fail ? { status: 503, body: { error: 'store down' } } : logCounts(url)) });
    assert.match((await screen.findByRole('alert')).textContent, /store down/);
    assert.equal(screen.queryByText(/Nothing is registered/), null);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Applications', { selector: '.acb-card-name' });
    assert.equal(screen.queryByRole('alert'), null);
  });

  it('points an empty catalog at the Product Catalog, and states partial and unsupported answers', async () => {
    const went = [];
    mount({ onNavigate: (t) => went.push(t) }, {
      counts: { level: 'CATEGORY', items: [], catalogEmpty: true, complete: false, supported: false, message: 'No logs stream' },
    });
    await screen.findByText(/there are no categories/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Product Catalog' }));
    assert.deepEqual(went, ['catalog']);
    assert.match(screen.getByRole('status').textContent, /No logs stream/);
    assert.match(screen.getByRole('alert').textContent, /No logs stream/);
  });

  it('renders a silent card with a flat bar and a default partial-scan warning', async () => {
    const quiet = { ...CATEGORIES[1], total: 0, info: 0, matchedOn: [], leafCount: 0, childCount: 0 };
    mount({}, { counts: { level: 'CATEGORY', items: [quiet], complete: false, totals: { total: 0 } } });
    await screen.findByText('Tools', { selector: '.acb-card-name' });
    assert.ok(card('Tools').querySelector('.acb-bar--empty'));
    assert.match(card('Tools').title, /No telemetry identifier recorded for this category/);
    assert.equal(card('Tools').querySelector('.acb-card-children').textContent, '0');
    assert.match(screen.getByRole('status').textContent, /these counts are a floor/);
  });

  it('refreshes on demand and on the auto-refresh interval', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      mount();
      await screen.findByText('Applications', { selector: '.acb-card-name' });
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => assert.equal(countCalls(net.calls).length, 2));
      await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Refresh' }).disabled, false));
      fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh interval' }), { target: { value: '30000' } });
      act(() => mock.timers.tick(30_000));
      await waitFor(() => assert.equal(countCalls(net.calls).length, 3));
      fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh interval' }), { target: { value: '0' } });
      act(() => mock.timers.tick(300_000));
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(countCalls(net.calls).length, 3);
    } finally {
      mock.timers.reset();
    }
  });

  it('truncates a long identifier list in the tooltip', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `service_name=s${i}`);
    mount({}, { counts: { level: 'CATEGORY', items: [{ ...CATEGORIES[0], matchedOn: many }], totals: { total: 1500 } } });
    await screen.findByText('Applications', { selector: '.acb-card-name' });
    assert.match(card('Applications').title, /Counted from service_name=s0.*service_name=s7 and 2 more$/);
  });
});
