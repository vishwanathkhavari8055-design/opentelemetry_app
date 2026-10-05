/**
 * The results bar: "Showing X to Y [out of N] events", took-ms and
 * last-fetched wording, rows-per-page, and the pager.
 *
 * Guarded because the backend usually sends no total: the bar must then show
 * the range without a denominator and page forward off `hasMore` instead of
 * inventing a last page — a page button that lands on nothing reads as data
 * loss.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: LogResultsBar } = await import('../../../src/components/logs/LogResultsBar.jsx');

const h = React.createElement;

const setup = (over = {}) => {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const props = {
    page: 0, setPage: rec('page'), pageSize: 50, setPageSize: rec('size'),
    rowCount: 50, total: null, tookMs: null, fetchedAt: null, unit: 'events',
    loading: false, onRefresh: rec('refresh'), histogramVisible: true, onToggleHistogram: rec('histogram'),
    hasMore: false, ...over,
  };
  const utils = render(h(LogResultsBar, props));
  return { ...utils, calls, props };
};

const pageButtons = () => [...document.querySelectorAll('.results-bar-page-btn')].map((b) => b.textContent);

describe('LogResultsBar', () => {
  afterEach(cleanup);

  it('shows the range without a denominator when the total is unknown', () => {
    setup({ page: 2, rowCount: 50, tookMs: 123 });
    const count = document.querySelector('.results-bar-count').textContent;
    assert.match(count, /Showing 101 to 150 events/);
    assert.doesNotMatch(count, /out of/);
    assert.match(count, /in 123 ms/);
  });

  it('shows the total and a real last page when the server counted', () => {
    const { calls } = setup({ page: 0, rowCount: 50, total: 1000 });
    assert.match(document.querySelector('.results-bar-count').textContent, /out of 1,000 events/);
    assert.deepEqual(pageButtons(), ['1', '2', '3', '4', '5']);
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    assert.deepEqual(calls[0], ['page', 19]);
  });

  it('keeps the page window centred and clamped to the last page', () => {
    setup({ page: 18, rowCount: 50, total: 1000 });
    assert.deepEqual(pageButtons(), ['16', '17', '18', '19', '20']);
    assert.equal(document.querySelector('[aria-current="page"]').textContent, '19');
  });

  it('with no total, offers exactly one more page when hasMore', () => {
    const { calls, rerender, props } = setup({ page: 1, hasMore: true });
    assert.deepEqual(pageButtons(), ['1', '2', '3']);
    const next = screen.getByRole('button', { name: 'Next page' });
    assert.equal(next.disabled, false);
    fireEvent.click(next);
    assert.deepEqual(calls[0], ['page', 2]);
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    assert.deepEqual(calls[1], ['page', 0]);
    fireEvent.click(screen.getByRole('button', { name: 'First page' }));
    assert.deepEqual(calls[2], ['page', 0]);

    rerender(h(LogResultsBar, { ...props, page: 1, hasMore: false }));
    assert.equal(screen.getByRole('button', { name: 'Next page' }).disabled, true);
    rerender(h(LogResultsBar, { ...props, page: 0, hasMore: false }));
    assert.equal(screen.getByRole('button', { name: 'First page' }).disabled, true);
  });

  it('describes an empty result, and "Running query…" while loading', () => {
    const { rerender, props } = setup({ rowCount: 0, unit: 'traces' });
    assert.equal(document.querySelector('.results-bar-count').textContent, 'No traces matched');
    rerender(h(LogResultsBar, { ...props, rowCount: 0, loading: true }));
    assert.equal(document.querySelector('.results-bar-count').textContent, 'Running query…');
  });

  it('changing the page size resets to page 0', () => {
    const { calls } = setup({ page: 3 });
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '250' } });
    assert.deepEqual(calls, [['size', 250], ['page', 0]]);
  });

  it('says how long ago the results landed, or "refreshing…"', () => {
    const now = Date.now();
    const { rerender, props } = setup({ fetchedAt: now });
    assert.match(document.querySelector('.results-bar-when').textContent, /just now/);
    rerender(h(LogResultsBar, { ...props, fetchedAt: now - 30_000 }));
    assert.match(document.querySelector('.results-bar-when').textContent, /30s ago/);
    rerender(h(LogResultsBar, { ...props, fetchedAt: now - 5 * 60_000 }));
    assert.match(document.querySelector('.results-bar-when').textContent, /5m ago/);
    rerender(h(LogResultsBar, { ...props, fetchedAt: now - 2 * 3600_000 }));
    assert.match(document.querySelector('.results-bar-when').textContent, /2h ago/);
    rerender(h(LogResultsBar, { ...props, fetchedAt: now, loading: true }));
    assert.match(document.querySelector('.results-bar-when').textContent, /refreshing…/);
  });

  it('re-runs, toggles the chart and expand-all', () => {
    const { calls } = setup({ showExpandAll: true, onToggleExpandedAll: () => calls.push(['expand']) });
    fireEvent.click(screen.getByRole('button', { name: 'Re-run the query' }));
    fireEvent.click(screen.getByTitle('Hide the event-volume chart'));
    fireEvent.click(screen.getByTitle('Expand every record'));
    assert.deepEqual(calls.map((c) => c[0]), ['refresh', 'histogram', 'expand']);
  });

  it('show-all mode (-1) renders no page numbers', () => {
    setup({ pageSize: -1, rowCount: 7 });
    assert.deepEqual(pageButtons(), []);
    assert.match(document.querySelector('.results-bar-count').textContent, /Showing 1 to 7/);
  });
});
