/**
 * The wizard's step 1 picks the service an alert is scoped to, out of the
 * Product Catalog. What it must never do is make a false claim about the
 * registry, because each one sends an operator off to fix the wrong thing:
 *
 *  - an empty category, a category emptied by a filter, and a category whose
 *    rows have not arrived yet each say something DIFFERENT;
 *  - "no telemetry" is only claimed once discovery actually answered;
 *  - a DISABLED resource cannot be picked (its telemetry is hidden everywhere);
 *  - the category holding the current selection opens itself on mount, so
 *    stepping back never lands on a collapsed tree that reads "nothing chosen".
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const { default: ServiceCatalogPicker, resourceKey } = await import('../../../../src/components/alerts/wizard/ServiceCatalogPicker.jsx');

const CATS = [
  {
    code: 'APP', label: 'Applications', registeredCount: 3,
    resources: [
      { id: 'r1', resourceName: 'Checkout', resolvedName: 'checkout-svc', status: 'ENABLED', productLabel: 'Shop' },
      { id: 'r2', resourceName: 'cart', status: 'ENABLED', productLabel: 'Shop' },
      { id: 'r3', resourceName: 'legacy', status: 'DISABLED' },
    ],
  },
  { code: 'DB', label: 'Databases', registeredCount: 0, resources: [] },
  { code: 'MQ', label: 'Queues', registeredCount: 2, resources: [] },
];

const renderPicker = (props = {}) => {
  const picks = [];
  const utils = render(React.createElement(ServiceCatalogPicker, {
    categories: CATS, onSelect: (r) => picks.push(r), ...props,
  }));
  return { ...utils, picks };
};

const catHead = (label) => screen.getByText(label, { selector: '.awp-cat-name' }).closest('button');

describe('ServiceCatalogPicker', () => {
  afterEach(cleanup);

  it('keys a resource by its resolved name when it has one', () => {
    assert.equal(resourceKey({ resourceName: 'A', resolvedName: 'a-svc' }), 'a-svc');
    assert.equal(resourceKey({ resourceName: 'A' }), 'A');
    assert.equal(resourceKey(null), '');
  });

  it('starts collapsed with the server counts, and opens a category on click', () => {
    const { picks } = renderPicker();
    assert.equal(catHead('Applications').getAttribute('aria-expanded'), 'false');
    assert.equal(within(catHead('Applications')).getByText('3').className, 'awp-count');
    assert.equal(screen.queryByText('Checkout'), null);

    fireEvent.click(catHead('Applications'));
    assert.equal(catHead('Applications').getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText('Shop'));
    assert.ok(screen.getByText('checkout-svc'));
    assert.ok(screen.getByText('off'));

    fireEvent.click(screen.getByText('cart'));
    assert.equal(picks.length, 1);
    assert.equal(picks[0].id, 'r2');

    const legacy = screen.getByText('legacy').closest('label').querySelector('input');
    assert.equal(legacy.disabled, true);

    fireEvent.click(catHead('Applications'));
    assert.equal(screen.queryByText('Checkout'), null);
  });

  it('opens the category holding the selection on mount and checks its radio', () => {
    renderPicker({ selectedId: 'r1' });
    assert.equal(catHead('Applications').getAttribute('aria-expanded'), 'true');
    const radio = screen.getByText('Checkout').closest('label').querySelector('input');
    assert.equal(radio.checked, true);
  });

  it('tells an empty category from a pending one, and offers the catalog link', () => {
    let navigated = 0;
    renderPicker({ onNavigateToCatalog: () => { navigated += 1; }, loading: false });
    fireEvent.click(catHead('Databases'));
    assert.ok(screen.getByText(/No services registered under Databases yet\./));
    fireEvent.click(screen.getByRole('button', { name: 'Open Product Catalog' }));
    assert.equal(navigated, 1);

    fireEvent.click(catHead('Queues'));
    assert.ok(screen.getByText(/The catalog reports 2 services here but returned none of them/));
  });

  it('says a pending category is still loading while the catalog loads', () => {
    renderPicker({ loading: true });
    fireEvent.click(catHead('Queues'));
    assert.ok(screen.getByText('Loading 2 registered services…'));
  });

  it('shows the loading line only while nothing is on screen yet', () => {
    renderPicker({ categories: [], loading: true });
    assert.ok(screen.getByText('Loading catalog…'));
  });

  it('narrows by search, forces matches open and counts only what shows', () => {
    renderPicker();
    fireEvent.change(screen.getByLabelText('Search for a service'), { target: { value: 'checkout-SVC' } });
    assert.equal(catHead('Applications').getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText('Checkout'));
    assert.equal(screen.queryByText('cart'), null);
    assert.equal(screen.queryByText('Databases'), null);
    assert.equal(within(catHead('Applications')).getByText('1').getAttribute('title'),
      '1 of 3 registered match the current filters');

    fireEvent.change(screen.getByLabelText('Search for a service'), { target: { value: 'applic' } });
    assert.ok(screen.getByText('cart'));

    fireEvent.change(screen.getByLabelText('Search for a service'), { target: { value: 'zzz' } });
    assert.ok(screen.getByText('No category or service matches “zzz”.'));
  });

  it('draws signal pills, a dash for a quiet signal, and "no telemetry" once discovery is ready', () => {
    const telemetry = new Map([['checkout-svc', { logs: 1500, traces: null }]]);
    renderPicker({
      telemetry, telemetryStatus: 'ready', logsStatus: 'ready', tracesStatus: 'unavailable', selectedId: 'r1',
    });
    const row = screen.getByText('Checkout').closest('label');
    const logs = row.querySelector('.awp-sig--logs');
    assert.match(logs.getAttribute('title'), /checkout-svc produced 1,500 logs in the last 24h/);
    const traces = row.querySelector('.awp-sig--traces');
    assert.equal(within(traces).getByText('—').className, 'awp-sig-count');
    assert.match(traces.getAttribute('title'), /traces discovery returned nothing/);

    const cart = screen.getByText('cart').closest('label');
    assert.ok(within(cart).getByText('no telemetry'));
    assert.match(cart.getAttribute('title'), /produced no logs and no traces/);
  });

  it('says a quiet signal produced nothing when that signal did answer', () => {
    const telemetry = new Map([['checkout-svc', { logs: 3, traces: null }]]);
    renderPicker({ telemetry, telemetryStatus: 'ready', logsStatus: 'ready', tracesStatus: 'ready', selectedId: 'r1' });
    const traces = screen.getByText('Checkout').closest('label').querySelector('.awp-sig--traces');
    assert.match(traces.getAttribute('title'), /checkout-svc produced no traces in the last 24h/);
  });

  it('draws no pills and no silence claim while discovery is still loading', () => {
    renderPicker({ selectedId: 'r1' });
    assert.equal(document.querySelector('.awp-sig'), null);
    assert.equal(screen.queryByText('no telemetry'), null);
    assert.equal(screen.queryByText('Only services with telemetry'), null);
  });

  it('"Only services with telemetry" hides silent rows and explains an emptied category', () => {
    const telemetry = new Map([['checkout-svc', { logs: 3, traces: 1 }]]);
    renderPicker({ telemetry, telemetryStatus: 'ready', logsStatus: 'ready', tracesStatus: 'ready' });
    fireEvent.click(screen.getByLabelText('Only services with telemetry'));
    fireEvent.click(catHead('Applications'));
    assert.ok(screen.getByText('Checkout'));
    assert.equal(screen.queryByText('cart'), null);
    assert.equal(within(catHead('Applications')).getByText('1').className, 'awp-count');

    cleanup();
    renderPicker({ telemetry: new Map([['other', { logs: 1 }]]), telemetryStatus: 'ready' });
    fireEvent.click(screen.getByLabelText('Only services with telemetry'));
    fireEvent.click(catHead('Applications'));
    assert.ok(screen.getByText('All 3 registered here produced no telemetry in the last 24h.'));
  });

  it('keeps a category whose own label matches, showing all of its rows', () => {
    renderPicker({ categories: [CATS[0], { code: 'X', label: 'Checkout tools', resources: [{ id: 'x', resourceName: 'z', status: 'ENABLED' }] }] });
    fireEvent.change(screen.getByLabelText('Search for a service'), { target: { value: 'checkout' } });
    // Both categories stay: one by resource name, one by its own label.
    assert.ok(screen.getByText('Checkout'));
    assert.ok(screen.getByText('z'));
  });

  it('warns when the catalog is unavailable or degraded, without emptying the tree', () => {
    renderPicker({ error: 'HTTP 502' });
    assert.ok(screen.getByText('Product Catalog unavailable — HTTP 502'));
    assert.ok(screen.getByText('Applications'));
    cleanup();
    renderPicker({ degraded: true });
    assert.ok(screen.getByText(/The registry read came back incomplete/));
  });
});
