/**
 * The three filter pickers the Logs, Traces, Metrics and Alerts screens share:
 * SearchableSelect (one of thousands), ServiceMultiSelect (any number of
 * services) and ProductSelect (a product that stands for a set of services).
 *
 * What is guarded, and why:
 *  - SearchableSelect keeps a saved value that has left the option list, pinned
 *    and marked, instead of silently blanking it — an alert naming a deleted
 *    stream must not be repointed by accident. Keyboard: arrows move, Enter
 *    picks, Escape/Tab close.
 *  - ServiceMultiSelect is additive (a second tick never drops the first),
 *    floats the selection to the top, and "Select all" means the VISIBLE rows
 *    when a filter is typed.
 *  - ProductSelect reports the product key, shows coverage (n of m services
 *    found, total logs) and lists a declared service telemetry does not have as
 *    "not found" rather than hiding it.
 */
import '../../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { default: SearchableSelect } = await import('../../../../../src/components/common/SearchableSelect.jsx');
const { default: ServiceMultiSelect } = await import('../../../../../src/components/common/ServiceMultiSelect.jsx');
const { default: ProductSelect } = await import('../../../../../src/components/common/ProductSelect.jsx');
const { PRODUCTS } = await import('../../../../../src/config/products.js');

const h = React.createElement;

afterEach(cleanup);

/** A controlled wrapper so picks show up on the face, like a real caller. */
function Controlled({ Comp, initial, onChangeSpy, ...rest }) {
  const [value, setValue] = React.useState(initial);
  return h(Comp, {
    ...rest,
    value,
    onChange: (v) => { onChangeSpy?.(v); setValue(v); },
  });
}

describe('SearchableSelect', () => {
  const OPTIONS = ['alpha_stream', { value: 'beta', label: 'Beta stream' }, 'gamma_stream', '', { value: null }];

  it('opens a filterable list, counts the matches and picks on click', async () => {
    const picks = [];
    render(h(Controlled, {
      Comp: SearchableSelect, initial: '', onChangeSpy: (v) => picks.push(v),
      options: OPTIONS, placeholder: 'Pick a stream', ariaLabel: 'Stream',
    }));
    const face = screen.getByRole('button', { name: 'Stream' });
    assert.match(face.textContent, /Pick a stream/);
    fireEvent.click(face);
    const list = screen.getByRole('listbox', { name: 'Stream' });
    assert.ok(within(list).getByText('3 available'));
    assert.equal(within(list).getAllByRole('option').length, 3);

    const search = within(list).getByRole('textbox', { name: 'Search options' });
    fireEvent.change(search, { target: { value: 'STREAM' } });
    assert.ok(within(list).getByText('3 of 3'));
    fireEvent.change(search, { target: { value: 'gam' } });
    assert.ok(within(list).getByText('1 of 3'));
    fireEvent.change(search, { target: { value: 'zzz' } });
    assert.ok(within(list).getByText('No match for “zzz”.'));
    fireEvent.change(search, { target: { value: '' } });

    fireEvent.mouseEnter(within(list).getByRole('option', { name: 'Beta stream' }));
    fireEvent.click(within(list).getByRole('option', { name: 'Beta stream' }));
    assert.deepEqual(picks, ['beta']);
    assert.equal(screen.queryByRole('listbox'), null);
    assert.match(screen.getByRole('button', { name: 'Stream' }).textContent, /Beta stream/);
    await new Promise((r) => { requestAnimationFrame(r); });
  });

  it('moves with the arrow keys, wraps, and picks on Enter', () => {
    const picks = [];
    render(h(Controlled, {
      Comp: SearchableSelect, initial: '', onChangeSpy: (v) => picks.push(v),
      options: OPTIONS, ariaLabel: 'Stream', searchPlaceholder: 'Find stream',
    }));
    const face = screen.getByRole('button', { name: 'Stream' });
    assert.match(face.textContent, /Select…/);
    fireEvent.keyDown(face, { key: 'ArrowDown' });
    const search = screen.getByRole('textbox', { name: 'Find stream' });
    assert.equal(search.getAttribute('placeholder'), 'Find stream');
    fireEvent.keyDown(search, { key: 'ArrowUp' }); // wraps from 0 to the last row
    fireEvent.keyDown(search, { key: 'ArrowDown' }); // back to the first
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    assert.deepEqual(picks, ['beta']);
  });

  it('closes on Escape, Tab and a click outside without picking', () => {
    const picks = [];
    render(h('div', null, h('p', null, 'elsewhere'), h(SearchableSelect, {
      options: OPTIONS, value: '', onChange: (v) => picks.push(v), ariaLabel: 'Stream',
    })));
    const face = screen.getByRole('button', { name: 'Stream' });
    fireEvent.keyDown(face, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    assert.equal(screen.queryByRole('listbox'), null);
    fireEvent.keyDown(face, { key: ' ' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
    assert.equal(screen.queryByRole('listbox'), null);
    fireEvent.keyDown(face, { key: 'x' }); // not an opening key
    assert.equal(screen.queryByRole('listbox'), null);
    fireEvent.click(face);
    fireEvent.scroll(window);
    fireEvent(window, new window.Event('resize'));
    fireEvent.mouseDown(screen.getByText('elsewhere'));
    assert.equal(screen.queryByRole('listbox'), null);
    assert.deepEqual(picks, []);
  });

  it('keeps a value that left the list, pinned and marked', () => {
    render(h(SearchableSelect, {
      options: ['a', 'b'], value: 'deleted_stream', onChange: () => {}, ariaLabel: 'Stream',
    }));
    const face = screen.getByRole('button', { name: 'Stream' });
    assert.match(face.textContent, /deleted_stream \(not in list\)/);
    assert.match(face.className, /is-missing/);
    fireEvent.click(face);
    const options = screen.getAllByRole('option');
    assert.equal(options[0].textContent, 'deleted_stream (not in list)');
    assert.equal(options[0].getAttribute('aria-selected'), 'true');
    // A filter that doesn't match the missing value drops it with the rest.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'b' } });
    assert.deepEqual(screen.getAllByRole('option').map((o) => o.textContent), ['b']);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'nothing' } });
    assert.ok(screen.getByText('No match for “nothing”.'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' }); // no rows: no-op
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }); // nothing to pick
  });

  it('clears with the × by click or keyboard, and not when disabled', () => {
    const picks = [];
    const { rerender } = render(h(SearchableSelect, {
      options: ['a'], value: 'a', onChange: (v) => picks.push(v), allowClear: true, ariaLabel: 'S',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Clear selection' }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Clear selection' }), { key: 'a' });
    assert.deepEqual(picks, ['', '']);
    assert.equal(screen.queryByRole('listbox'), null, 'clearing does not open the menu');
    rerender(h(SearchableSelect, {
      options: ['a'], value: 'a', onChange: () => {}, allowClear: true, disabled: true, ariaLabel: 'S',
    }));
    assert.equal(screen.queryByRole('button', { name: 'Clear selection' }), null);
    assert.equal(screen.getByRole('button', { name: 'S' }).disabled, true);
  });

  it('says loading, or the empty label, when there is nothing to list', () => {
    const { rerender } = render(h(SearchableSelect, {
      options: [], value: '', onChange: () => {}, loading: true, ariaLabel: 'S',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'S' }));
    assert.equal(screen.getAllByText('Loading…').length, 2);
    rerender(h(SearchableSelect, {
      options: [], value: '', onChange: () => {}, emptyLabel: 'No streams yet.', ariaLabel: 'S',
    }));
    assert.ok(screen.getByText('No streams yet.'));
    rerender(h(SearchableSelect, { options: undefined, value: '', onChange: () => {}, ariaLabel: 'S' }));
    assert.ok(screen.getByText('Nothing available.'));
  });

  it('opens upward when the trigger sits near the bottom of the viewport', () => {
    render(h(SearchableSelect, { options: ['a'], value: '', onChange: () => {}, ariaLabel: 'S' }));
    const face = screen.getByRole('button', { name: 'S' });
    face.getBoundingClientRect = () => ({ left: 10, width: 200, top: window.innerHeight - 40, bottom: window.innerHeight - 10 });
    fireEvent.click(face);
    const menu = screen.getByRole('listbox');
    assert.equal(menu.style.top, '');
    assert.notEqual(menu.style.bottom, '');
  });
});

describe('ServiceMultiSelect', () => {
  const OPTIONS = [{ name: 'orders', count: 1500 }, { name: 'Billing', count: 12 }, 'auth', { name: '' }];

  it('adds each tick to the selection and floats picks to the top', () => {
    const changes = [];
    render(h(Controlled, {
      Comp: ServiceMultiSelect, initial: [], onChangeSpy: (v) => changes.push(v),
      options: OPTIONS, label: 'Service',
    }));
    assert.ok(screen.getByText('Service'));
    const face = screen.getByRole('button', { name: /All services/ });
    fireEvent.click(face);
    assert.ok(screen.getByText('3 available'));
    // Alphabetical, case-insensitive; counts shown compactly.
    const names = () => screen.getAllByRole('checkbox').map((c) => c.closest('label').textContent);
    assert.deepEqual(names(), ['auth', 'Billing12', 'orders1.5K']);

    fireEvent.click(screen.getByRole('checkbox', { name: /orders/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /auth/ }));
    assert.deepEqual(changes, [['orders'], ['orders', 'auth']]);
    assert.deepEqual(names(), ['auth', 'orders1.5K', 'Billing12']);
    assert.match(screen.getByText(/2 selected/).textContent, /3 available · 2 selected/);
    assert.match(screen.getByRole('button', { expanded: true }).textContent, /2 services/);

    // Untick one: face names the survivor.
    fireEvent.click(screen.getByRole('checkbox', { name: /auth/ }));
    assert.match(screen.getByRole('button', { expanded: true }).textContent, /^orders/);
  });

  it('"Select matches" takes only what the filter shows; "Clear all" empties', () => {
    const changes = [];
    render(h(Controlled, {
      Comp: ServiceMultiSelect, initial: [], onChangeSpy: (v) => changes.push(v), options: OPTIONS,
    }));
    fireEvent.click(screen.getByRole('button', { name: /All services/ }));
    const search = screen.getByRole('textbox', { name: 'Filter services' });
    fireEvent.change(search, { target: { value: 'or' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select matches' }));
    assert.deepEqual(changes.at(-1), ['orders']);
    fireEvent.change(search, { target: { value: 'nope' } });
    assert.ok(screen.getByText('No service matches “nope”.'));
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    assert.deepEqual([...changes.at(-1)].sort(), ['Billing', 'auth', 'orders']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    assert.deepEqual(changes.at(-1), []);
  });

  it('toggles the highlighted row from the keyboard and closes on Escape', () => {
    const changes = [];
    render(h(Controlled, {
      Comp: ServiceMultiSelect, initial: [], onChangeSpy: (v) => changes.push(v), options: OPTIONS,
    }));
    fireEvent.click(screen.getByRole('button', { name: /All services/ }));
    const search = screen.getByRole('textbox');
    fireEvent.keyDown(search, { key: 'ArrowUp' }); // wraps to the last: orders
    fireEvent.keyDown(search, { key: 'ArrowDown' }); // back to the first: auth
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.mouseEnter(screen.getByRole('checkbox', { name: /Billing/ }).closest('label'));
    fireEvent.keyDown(search, { key: 'Enter' });
    assert.deepEqual(changes, [['Billing']]);
    fireEvent.keyDown(search, { key: 'Escape' });
    assert.equal(screen.queryByRole('listbox'), null);
  });

  it('clears from the face × without opening, and closes on outside click', () => {
    const changes = [];
    render(h('div', null, h('p', null, 'away'), h(Controlled, {
      Comp: ServiceMultiSelect, initial: ['auth'], onChangeSpy: (v) => changes.push(v), options: OPTIONS,
    })));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Clear service filter' }), { key: 'x' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Clear service filter' }), { key: ' ' });
    assert.deepEqual(changes, [[]]);
    assert.equal(screen.queryByRole('listbox'), null);
    fireEvent.click(screen.getByRole('button', { name: /All services/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('listbox'), null);
    fireEvent.click(screen.getByRole('button', { name: /All services/ }));
    fireEvent.mouseDown(screen.getByText('away'));
    assert.equal(screen.queryByRole('listbox'), null);
  });

  it('says loading, or that nothing was discovered, and stays shut when disabled', () => {
    const { rerender } = render(h(ServiceMultiSelect, { options: [], value: [], onChange: () => {}, loading: true, placeholder: 'Any' }));
    fireEvent.click(screen.getByRole('button', { name: /Any/ }));
    assert.ok(screen.getByText('Loading services…'));
    rerender(h(ServiceMultiSelect, { options: [], value: [], onChange: () => {} }));
    assert.ok(screen.getByText('No services discovered in the window.'));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
    cleanup();
    render(h(ServiceMultiSelect, { options: ['a'], value: ['a'], onChange: () => {}, disabled: true }));
    fireEvent.click(screen.getByRole('button', { name: /^a/ }));
    assert.equal(screen.queryByRole('listbox'), null);
  });
});

describe('ProductSelect', () => {
  const HUB = PRODUCTS.find((p) => p.key === 'trinity-iot-hub');
  const SERVICES = [
    { name: 'StreamMonitorService', count: 2_000_000 },
    { name: 'dataflowsvc', count: 500 },
    { name: 'stray-service', count: 3 },
  ];

  it('lists every product with its coverage and reports the key picked', () => {
    const picks = [];
    render(h(ProductSelect, { services: SERVICES, value: null, onChange: (v) => picks.push(v) }));
    const face = screen.getByRole('button', { name: /All products/ });
    assert.equal(face.getAttribute('title'), 'Filter by product');
    fireEvent.click(face);
    assert.equal(screen.getAllByRole('option').length, PRODUCTS.length + 1);
    assert.match(screen.getByRole('option', { name: /All products/ }).textContent, /3 services/);
    const hub = screen.getByRole('option', { name: new RegExp(HUB.name) });
    assert.match(hub.textContent, new RegExp(`2 of ${HUB.services.length} services · 2\\.0M logs`));
    assert.ok(screen.getByText(/1 service not mapped to any/));
    fireEvent.click(hub);
    assert.deepEqual(picks, [HUB.key]);
    assert.equal(screen.queryByRole('listbox'), null);
  });

  it('shows the active product and marks declared services telemetry lacks', () => {
    const picks = [];
    render(h(ProductSelect, { services: SERVICES, value: HUB.key, onChange: (v) => picks.push(v) }));
    const face = screen.getByRole('button', { name: new RegExp(HUB.name) });
    assert.match(face.getAttribute('title'), new RegExp(`${HUB.family} · ${HUB.name}`));
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    assert.ok(rows.includes('StreamMonitorService2.0M'));
    assert.ok(rows.includes('DataFlowSvc500'));
    assert.ok(rows.includes('HttpProtAdapterSvcnot found'));

    fireEvent.keyDown(screen.getByRole('button', { name: 'Clear product filter' }), { key: 'q' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Clear product filter' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear product filter' }));
    assert.deepEqual(picks, [null, null]);
    assert.equal(screen.queryByRole('listbox'), null);

    fireEvent.click(face);
    fireEvent.click(screen.getByRole('option', { name: /All products/ }));
    assert.deepEqual(picks, [null, null, null]);
  });

  it('says loading and closes on Escape or an outside click', () => {
    render(h('div', null, h('p', null, 'out'), h(ProductSelect, {
      services: undefined, value: null, onChange: () => {}, loading: true,
    })));
    fireEvent.click(screen.getByRole('button', { name: /All products/ }));
    assert.match(screen.getByRole('option', { name: /All products/ }).textContent, /loading…/);
    assert.equal(screen.queryByText(/not mapped to any/), null);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('listbox'), null);
    fireEvent.click(screen.getByRole('button', { name: /All products/ }));
    fireEvent.mouseDown(screen.getByText('out'));
    assert.equal(screen.queryByRole('listbox'), null);
  });

  it('counts unclaimed services in the plural and shows a dash for an unknown count', async () => {
    render(h(ProductSelect, {
      services: ['StreamMonitorService', 'x1', 'x2'], value: HUB.key, onChange: () => {},
    }));
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    assert.ok(rows.includes('StreamMonitorService—'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(HUB.name) }));
    await waitFor(() => assert.ok(screen.getByText(/2 services not mapped/)));
  });
});
