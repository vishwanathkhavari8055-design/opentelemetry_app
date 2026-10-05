/**
 * ServiceCatalogTable sorts and filters client-side over one aggregation.
 * Guarded here: the default order is by status, worst first, busiest first
 * within a band — the tab exists to find what is broken; clicking a header
 * sorts by it (names/status ascending first, numbers descending first) and a
 * second click flips it; the name filter is case-insensitive and says when
 * nothing matches; the summary chips count services and each severity band;
 * a row click or Enter narrows the query to that service; and the empty body
 * separates loading, error and a genuinely quiet window.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: ServiceCatalogTable } = await import('../../../src/components/traces/ServiceCatalogTable.jsx');

const DATA = {
  items: [
    { serviceName: 'billing', status: 'HEALTHY', requests: 5000, errorRate: 0, errors: 0, p50Us: 800, p95Us: 1200, p99Us: 1500, avgUs: 900, maxUs: 3000 },
    { serviceName: 'Auth', status: 'CRITICAL', requests: 3, errorRate: 0.6667, errors: 2, p50Us: 2_000_000, p95Us: 3_000_000, p99Us: 3_500_000, avgUs: 2_100_000, maxUs: 4_000_000 },
    { serviceName: 'cart', status: 'CRITICAL', requests: 1500, errorRate: 0.1946, errors: 292, p50Us: 26, p95Us: 90, p99Us: 120, avgUs: 40, maxUs: 200 },
    { serviceName: 'search', status: 'WARNING', requests: 70, errorRate: 0.05, errors: 3, p50Us: 1000, p95Us: 2000, p99Us: 2500, avgUs: 1100, maxUs: 9000 },
    { serviceName: 'mystery', requests: 1, errorRate: null, errors: null },
  ],
  criticalCount: 2,
  warningCount: 1,
  degradedCount: 0,
};

const renderTable = (props = {}) => {
  const clicks = [];
  const filters = [];
  const all = {
    data: DATA, filter: '', onFilterChange: (v) => filters.push(v), onServiceClick: (n) => clicks.push(n), ...props,
  };
  const utils = render(React.createElement(ServiceCatalogTable, all));
  const rerenderWith = (p) => utils.rerender(React.createElement(ServiceCatalogTable, { ...all, ...p }));
  return { ...utils, clicks, filters, rerenderWith };
};

const names = () => Array.from(document.querySelectorAll('.sc-row .tt-svc-name')).map((n) => n.textContent);
const header = (label) => screen.getByRole('button', { name: new RegExp(`^${label}`) });

describe('ServiceCatalogTable', () => {
  afterEach(cleanup);

  it('orders by status worst-first, busiest first within a band', () => {
    renderTable();
    assert.deepEqual(names(), ['cart', 'Auth', 'search', 'billing', 'mystery']);
    assert.equal(header('Status').textContent, 'Status↑');
    assert.ok(header('Status').classList.contains('is-sorted'));
    assert.equal(header('Requests').textContent, 'Requests⇅');
  });

  it('formats each row, with Healthy as the default status', () => {
    renderTable();
    const cart = screen.getByText('cart').closest('.sc-row');
    const cells = Array.from(cart.querySelectorAll('.sc-cell')).map((c) => c.textContent);
    assert.deepEqual(cells, ['Ccart', 'Critical', '1.5K', '19.46%', '292', '26.00us', '90.00us', '120.00us', '40.00us', '200.00us']);
    assert.ok(cart.querySelectorAll('.sc-cell')[3].classList.contains('is-warn'));
    assert.equal(cart.querySelectorAll('.sc-cell')[2].title, (1500).toLocaleString());

    const mystery = screen.getByText('mystery').closest('.sc-row');
    assert.match(mystery.textContent, /Healthy/);
    assert.equal(mystery.querySelectorAll('.sc-cell')[3].textContent, '—');
    assert.ok(!mystery.querySelectorAll('.sc-cell')[3].classList.contains('is-warn'));
  });

  it('sorts by a clicked column and flips on the second click', () => {
    renderTable();
    fireEvent.click(header('Requests'));
    assert.deepEqual(names(), ['billing', 'cart', 'search', 'Auth', 'mystery']);
    assert.equal(header('Requests').textContent, 'Requests↓');
    fireEvent.click(header('Requests'));
    assert.deepEqual(names(), ['mystery', 'Auth', 'search', 'cart', 'billing']);
    assert.equal(header('Requests').textContent, 'Requests↑');

    fireEvent.click(header('Service'));
    assert.deepEqual(names(), ['Auth', 'billing', 'cart', 'mystery', 'search']);
    fireEvent.click(header('Service'));
    assert.deepEqual(names(), ['search', 'mystery', 'cart', 'billing', 'Auth']);

    fireEvent.click(header('P95'));
    assert.deepEqual(names().slice(0, 2), ['Auth', 'search']);

    fireEvent.click(header('Status'));
    assert.deepEqual(names(), ['cart', 'Auth', 'search', 'billing', 'mystery']);
    fireEvent.click(header('Status'));
    // Descending puts the unknown band first; ties still busiest-first.
    assert.deepEqual(names(), ['mystery', 'billing', 'search', 'cart', 'Auth']);
  });

  it('shows service and severity chips, omitting empty bands', () => {
    const { rerenderWith } = renderTable();
    assert.ok(screen.getByText('5 services'));
    assert.ok(screen.getByText('2 Critical'));
    assert.ok(screen.getByText('1 Warning'));
    assert.equal(screen.queryByText(/Degraded$/), null);

    rerenderWith({ data: { items: [DATA.items[0]], degradedCount: 4 } });
    assert.ok(screen.getByText('1 service'));
    assert.ok(screen.getByText('4 Degraded'));
    assert.equal(screen.queryByText(/Critical$/), null);
  });

  it('filters case-insensitively and reports typing upwards', () => {
    const { filters, rerenderWith } = renderTable();
    const input = screen.getByRole('textbox', { name: 'Filter by service name' });
    fireEvent.change(input, { target: { value: 'AR' } });
    assert.deepEqual(filters, ['AR']);

    rerenderWith({ filter: '  AR ' });
    assert.deepEqual(names(), ['cart', 'search']);

    rerenderWith({ filter: 'zzz' });
    assert.deepEqual(names(), []);
    assert.ok(screen.getByText('No service matches “zzz”.'));
  });

  it('narrows the query to a service on click, Enter or Space', () => {
    const { clicks } = renderTable();
    const row = screen.getByText('search').closest('.sc-row');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.keyDown(row, { key: 'Tab' });
    assert.deepEqual(clicks, ['search', 'search', 'search']);
    assert.equal(row.title, 'Filter the query to search');
  });

  it('separates loading, error and an empty window', () => {
    const { rerenderWith } = renderTable({ data: null, loading: true });
    assert.ok(screen.getByText('Loading service catalog…'));
    assert.ok(screen.getByRole('progressbar', { name: 'Loading catalog' }));
    assert.ok(screen.getByText('0 services'));

    rerenderWith({ data: null, loading: false, error: 'Traces analytics requires the OpenObserve backend.' });
    assert.ok(screen.getByText('Traces analytics requires the OpenObserve backend.'));

    rerenderWith({ data: { items: [] }, loading: false, error: '' });
    assert.ok(screen.getByText('No services produced spans in the selected time range.'));
  });
});
