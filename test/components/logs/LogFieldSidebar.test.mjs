/**
 * The left-hand field explorer and the Product Catalog tree inside it.
 *
 * Field list: fields are derived from the sample rows (aliases, nulls and
 * nested values skipped), searchable, paged 25 at a time, and expanding one
 * lists its top values — clicking a value hands `(field, value)` back so the
 * container can add the clause. `service.name` instead lists every
 * DISCOVERED service as checkboxes.
 *
 * Product tree: categories expand to their registered resources, grouped by
 * product; disabled resources are shown greyed and unselectable; a resource
 * absent from discovery is unselectable; the category checkbox selects every
 * enabled resource; the search box narrows both categories and resources.
 *
 * Guarded because both are the no-typing way to build a query, and the tree's
 * checkboxes must reflect exactly what the query applies.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const { default: LogFieldSidebar } = await import('../../../src/components/logs/LogFieldSidebar.jsx');
const { default: ProductTree } = await import('../../../src/components/logs/ProductTree.jsx');

const h = React.createElement;

const ROWS = [
  { 'service.name': 'orders', host: 'h1', level: 'info', message: 'hidden', traceId: 't', nested: { a: 1 }, blank: '', nil: null },
  { 'service.name': 'billing', host: 'h1', level: 'warn' },
  { 'service.name': 'orders', host: 'h2' },
];

const SERVICES = [{ name: 'orders', count: 1500 }, { name: 'billing', count: 20 }, { name: 'quiet', count: null }];

const sidebar = (over = {}) => {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const props = {
    rows: ROWS, collapsed: false, onToggleCollapsed: rec('collapse'),
    streams: ['default'], stream: 'default', onStreamChange: rec('stream'),
    onValueClick: rec('value'), onRefresh: rec('refresh'), ...over,
  };
  const utils = render(h(LogFieldSidebar, props));
  return { ...utils, calls, props };
};

const fieldNames = () => [...document.querySelectorAll('.fieldbar-field-head .fieldbar-field-name')]
  .map((n) => n.textContent);

describe('LogFieldSidebar', () => {
  afterEach(cleanup);

  it('lists the populated, scalar, non-alias fields with distinct counts', () => {
    sidebar();
    assert.deepEqual(fieldNames(), ['host', 'level', 'service.name']);
    const host = screen.getByRole('button', { name: /host/ });
    assert.equal(host.querySelector('.fieldbar-field-count').textContent, '2');
    assert.match(host.title, /2 distinct values/);
  });

  it('expands a field to its top values and adds a clause on click', () => {
    const { calls } = sidebar();
    fireEvent.click(screen.getByRole('button', { name: /host/ }));
    const values = [...document.querySelectorAll('.fieldbar-value')];
    assert.deepEqual(values.map((v) => v.querySelector('.fieldbar-value-text').textContent), ['h1', 'h2']);
    assert.equal(values[0].querySelector('.fieldbar-value-n').textContent, '2');
    fireEvent.click(values[1]);
    assert.deepEqual(calls, [['value', 'host', 'h2']]);
    fireEvent.click(screen.getByRole('button', { name: /host/ }));
    assert.equal(document.querySelector('.fieldbar-value'), null);
  });

  it('says how many values are hidden past the top eight and truncates long ones', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ k: i === 0 ? 'L'.repeat(80) : `v${i}` }));
    sidebar({ rows });
    fireEvent.click(screen.getByTitle(/^k — 10 distinct values/));
    assert.equal(document.querySelectorAll('.fieldbar-value').length, 8);
    assert.match(document.querySelector('.fieldbar-values-more').textContent, /\+2 more values/);
    assert.ok([...document.querySelectorAll('.fieldbar-value-text')].some((t) => t.textContent === `${'L'.repeat(60)}…`));
  });

  it('filters fields by name and says when nothing matches', () => {
    sidebar();
    const search = screen.getByRole('textbox', { name: 'Search for a field' });
    fireEvent.change(search, { target: { value: 'LEV' } });
    assert.deepEqual(fieldNames(), ['level']);
    fireEvent.change(search, { target: { value: 'nope' } });
    assert.ok(screen.getByText('No field matches “nope”.'));
  });

  it('shows loading and empty states', () => {
    const { rerender, props } = sidebar({ rows: [], loading: true });
    assert.ok(screen.getByText('Loading fields…'));
    rerender(h(LogFieldSidebar, { ...props, loading: false }));
    assert.ok(screen.getByText('No fields — no matching logs in this window.'));
  });

  it('pages 25 fields at a time', () => {
    const one = {};
    for (let i = 0; i < 30; i += 1) one[`f${String(i).padStart(2, '0')}`] = 'x';
    const { calls } = sidebar({ rows: [one] });
    assert.equal(fieldNames().length, 25);
    const first = screen.getByRole('button', { name: 'First page of fields' });
    const next = screen.getByRole('button', { name: 'Next page of fields' });
    assert.equal(first.disabled, true);
    fireEvent.click(next);
    assert.deepEqual(fieldNames(), ['f25', 'f26', 'f27', 'f28', 'f29']);
    assert.equal(next.disabled, true);
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    assert.equal(fieldNames()[0], 'f00');
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    fireEvent.click(first);
    assert.equal(fieldNames()[0], 'f00');
    // Narrowing the search while on page 2 returns to page 1.
    fireEvent.click(next);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search for a field' }), { target: { value: 'f2' } });
    assert.equal(fieldNames()[0], 'f20');
    fireEvent.click(screen.getByRole('button', { name: 'Re-sample the field list' }));
    assert.deepEqual(calls.map((c) => c[0]), ['refresh']);
  });

  it('clamps the pager when the sample shrinks', () => {
    const one = {};
    for (let i = 0; i < 30; i += 1) one[`f${String(i).padStart(2, '0')}`] = 'x';
    const { rerender, props } = sidebar({ rows: [one] });
    fireEvent.click(screen.getByRole('button', { name: 'Next page of fields' }));
    rerender(h(LogFieldSidebar, { ...props, rows: [{ only: 'x' }] }));
    assert.deepEqual(fieldNames(), ['only']);
  });

  it('collapses to a rail and back; changes stream', () => {
    const { calls, rerender, props } = sidebar({ streams: ['default', 'audit'] });
    assert.equal(screen.getByRole('combobox', { name: 'Stream' }).title, 'Stream to query');
    fireEvent.change(screen.getByRole('combobox', { name: 'Stream' }), { target: { value: 'audit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide fields' }));
    rerender(h(LogFieldSidebar, { ...props, collapsed: true }));
    assert.equal(screen.queryByRole('combobox'), null);
    fireEvent.click(screen.getByRole('button', { name: 'Show fields' }));
    assert.deepEqual(calls.map((c) => c[0]), ['stream', 'collapse', 'collapse']);
    assert.equal(calls[0][1], 'audit');
  });

  it('honours a caller-supplied hidden-field set', () => {
    // It REPLACES the default alias set, so `message` / `traceId` now appear.
    sidebar({ hiddenFields: new Set(['host']) });
    assert.deepEqual(fieldNames(), ['level', 'message', 'service.name', 'traceId']);
  });

  it('lists every discovered service as checkboxes under service.name', () => {
    const toggled = [];
    sidebar({
      services: SERVICES, selectedServices: ['billing'],
      onToggleService: (n) => toggled.push(n), onToggleCategory: () => {},
    });
    const svcHead = screen.getByRole('button', { name: /service\.name/ });
    assert.equal(svcHead.querySelector('.fieldbar-field-count').textContent, '3');
    fireEvent.click(svcHead);
    const labels = [...document.querySelectorAll('.fb-svc')];
    // Ticked first, then by count.
    assert.deepEqual(labels.map((l) => l.querySelector('.fb-svc-name').textContent), ['billing', 'orders', 'quiet']);
    assert.equal(labels[1].querySelector('.fb-svc-n').textContent, '1.5K');
    assert.equal(labels[2].querySelector('.fb-svc-n').textContent, '');
    assert.equal(labels[0].querySelector('input').checked, true);
    fireEvent.click(labels[1].querySelector('input'));
    assert.deepEqual(toggled, ['orders']);

    const filter = screen.getByRole('textbox', { name: 'Filter services' });
    assert.equal(filter.placeholder, 'Filter 3 services…');
    fireEvent.change(filter, { target: { value: 'qui' } });
    assert.equal(document.querySelectorAll('.fb-svc').length, 1);
    fireEvent.change(filter, { target: { value: 'zzz' } });
    assert.ok(screen.getByText('No service matches “zzz”.'));
  });

  it('service list says loading / none discovered', () => {
    const { rerender, props } = sidebar({
      services: [], servicesLoading: true, onToggleService: () => {}, onToggleCategory: () => {},
    });
    fireEvent.click(screen.getByRole('button', { name: /service\.name/ }));
    assert.ok(screen.getByText('Loading services…'));
    rerender(h(LogFieldSidebar, { ...props, servicesLoading: false }));
    assert.ok(screen.getByText('No services discovered.'));
  });
});

const res = (over) => ({
  id: over.resourceName, resourceName: over.resourceName, status: 'ENABLED', ...over,
});

const CATS = () => {
  const apps = [
    res({ resourceName: 'orders', product: 'Shop' }),
    res({ resourceName: 'Billing', resolvedName: 'billing', productLabel: 'Shop' }),
    res({ resourceName: 'legacy', status: 'DISABLED' }),
    res({ resourceName: 'ghost' }),
  ];
  return [
    { code: 'APP', label: 'Applications', description: 'apps', resources: apps, enabled: apps.filter((r) => r.status === 'ENABLED') },
    { code: 'PLAT', label: 'Platform', resources: [], enabled: [] },
  ];
};

const tree = (over = {}) => {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const props = {
    categories: CATS(), services: SERVICES, selected: [],
    onToggleService: rec('svc'), onToggleCategory: rec('cat'), ...over,
  };
  const utils = render(h(ProductTree, props));
  return { ...utils, calls, props };
};

const catHead = (label) => screen.getByRole('button', { name: new RegExp(label) });

describe('ProductTree', () => {
  afterEach(cleanup);

  it('lists categories collapsed with resource counts, and expands one', () => {
    tree();
    const apps = catHead('Applications');
    assert.equal(apps.getAttribute('aria-expanded'), 'false');
    assert.equal(apps.querySelector('.fieldbar-field-count').textContent, '4');
    assert.equal(screen.queryByText('orders'), null);
    fireEvent.click(apps);
    assert.equal(apps.getAttribute('aria-expanded'), 'true');
    // Product-less resources first, then the product group.
    assert.ok(screen.getByText('Shop'));
    const names = [...document.querySelectorAll('.pt-service-name')].map((n) => n.textContent);
    assert.deepEqual(names, ['legacy', 'ghost', 'orders', 'Billing']);
    fireEvent.click(apps);
    assert.equal(document.querySelector('.pt-service'), null);
  });

  it('ticks a present resource, and leaves disabled / absent ones unselectable', () => {
    const { calls } = tree({ selected: ['billing'] });
    fireEvent.click(catHead('Applications'));
    const row = (name) => [...document.querySelectorAll('.pt-service')]
      .find((l) => l.querySelector('.pt-service-name').textContent === name);

    const orders = row('orders');
    assert.equal(orders.querySelector('.pt-service-count').textContent, '1.5K');
    assert.match(orders.title, /1,500 logs in this time range/);
    fireEvent.click(orders.querySelector('input'));
    assert.deepEqual(calls, [['svc', 'orders']]);

    const billing = row('Billing');
    assert.equal(billing.querySelector('input').checked, true);
    assert.equal(billing.querySelector('.pt-env').textContent, 'billing');

    const legacy = row('legacy');
    assert.equal(legacy.querySelector('input').disabled, true);
    assert.ok(legacy.querySelector('.pt-off-tag'));
    assert.match(legacy.title, /DISABLED/);

    const ghost = row('ghost');
    assert.equal(ghost.querySelector('input').disabled, true);
    assert.equal(ghost.querySelector('.pt-service-count').textContent, '—');
    assert.match(ghost.title, /reported nothing in the selected time range/);
    assert.match(ghost.className, /is-missing/);
  });

  it('category checkbox selects or clears every enabled resource, and is indeterminate when partial', () => {
    const { calls, rerender, props } = tree({ selected: ['orders'] });
    const box = screen.getByRole('checkbox', { name: 'Select all resources in Applications' });
    assert.equal(box.indeterminate, true);
    fireEvent.click(box);
    assert.deepEqual(calls, [['cat', 'APP', true]]);
    rerender(h(ProductTree, { ...props, selected: ['orders', 'billing', 'ghost'] }));
    const all = screen.getByRole('checkbox', { name: 'Clear all resources in Applications' });
    assert.equal(all.checked, true);
    fireEvent.click(all);
    assert.deepEqual(calls[1], ['cat', 'APP', false]);
    assert.equal(screen.getByRole('checkbox', { name: /resources in Platform/ }).disabled, true);
  });

  it('an empty category offers the catalog link; loading says so', () => {
    const navs = [];
    const { rerender, props } = tree({ onNavigateToCatalog: () => navs.push(1) });
    fireEvent.click(catHead('Platform'));
    assert.match(document.querySelector('.pt-note').textContent, /No resources registered under Platform yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Product Catalog' }));
    assert.equal(navs.length, 1);
    rerender(h(ProductTree, { ...props, catalogLoading: true }));
    assert.ok(screen.getByText('Loading catalog…'));
  });

  it('warns when discovery returned nothing or is still loading', () => {
    const { rerender, props } = tree({ services: [] });
    fireEvent.click(catHead('Applications'));
    assert.ok(screen.getByText(/Service discovery returned nothing/));
    const orders = [...document.querySelectorAll('.pt-service')][2];
    assert.match(orders.title, /is unavailable, so its status is unknown/);
    assert.match(orders.className, /is-unknown/);
    rerender(h(ProductTree, { ...props, services: [], loading: true }));
    assert.match([...document.querySelectorAll('.pt-service')][2].title, /is still loading/);
  });

  it('accepts bare-string services (no counts)', () => {
    tree({ services: ['orders'] });
    fireEvent.click(catHead('Applications'));
    const orders = [...document.querySelectorAll('.pt-service')][2];
    assert.equal(orders.querySelector('input').disabled, false);
    assert.match(orders.title, /0 logs/);
  });

  it('shows the catalog error', () => {
    tree({ catalogError: 'HTTP 503' });
    assert.ok(screen.getByText('Product Catalog unavailable — HTTP 503'));
  });

  it('the search term opens and narrows categories', () => {
    const { rerender, props } = tree({ filter: 'bill' });
    assert.equal(catHead('Applications').getAttribute('aria-expanded'), 'true');
    assert.equal(screen.queryByRole('button', { name: /Platform/ }), null);
    assert.deepEqual([...document.querySelectorAll('.pt-service-name')].map((n) => n.textContent), ['Billing']);
    rerender(h(ProductTree, { ...props, filter: 'plat' }));
    assert.ok(catHead('Platform'));
    rerender(h(ProductTree, { ...props, filter: 'zzz' }));
    assert.ok(screen.getByText('No category or resource matches “zzz”.'));
  });

  it('renders inside the sidebar when a service toggle is supplied', () => {
    sidebar({
      services: SERVICES, catalogCategories: CATS(), onToggleService: () => {}, onToggleCategory: () => {},
    });
    assert.ok(within(document.querySelector('.fieldbar-list')).getByRole('button', { name: /Applications/ }));
  });
});
