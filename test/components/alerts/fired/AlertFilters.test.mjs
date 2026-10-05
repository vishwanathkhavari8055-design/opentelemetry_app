/**
 * AlertFilters: the toolbar's controls all write through setFilter. Guarded —
 * choosing "All time" also clears the status filter (otherwise the option hides
 * every resolved episode and its label lies) while bounded windows leave status
 * alone; severity is additive; the search clear button only appears with text;
 * Clear shows the right count and only when there is something to clear; the
 * auto-refresh, pause and refresh controls call back with the right values.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const { default: AlertFilters } = await import('../../../../src/components/alerts/fired/AlertFilters.jsx');
const { EMPTY_FILTERS } = await import('../../../../src/components/alerts/fired/useAlerts.js');

const baseProps = (log, overrides = {}) => {
  const rec = (name) => (...args) => log.push([name, ...args]);
  return {
    filters: EMPTY_FILTERS,
    setFilter: rec('setFilter'),
    clearFilters: () => log.push(['clearFilters']),
    activeFilterCount: 0,
    refreshMs: 30000,
    setRefreshMs: rec('setRefreshMs'),
    paused: false,
    setPaused: rec('setPaused'),
    onRefresh: () => log.push(['onRefresh']),
    refreshing: false,
    ...overrides,
  };
};

const renderFilters = (overrides = {}) => {
  const log = [];
  const utils = render(React.createElement(AlertFilters, baseProps(log, overrides)));
  const rerenderWith = (more) => utils.rerender(React.createElement(AlertFilters, baseProps(log, more)));
  return { ...utils, log, rerenderWith };
};

describe('AlertFilters', () => {
  afterEach(cleanup);

  it('hides Clear with nothing to clear, and shows a singular count for one', () => {
    const { log, rerenderWith } = renderFilters();
    assert.equal(screen.queryByRole('button', { name: /^Clear \d/ }), null);
    rerenderWith({ activeFilterCount: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Clear 1 filter' }));
    assert.deepEqual(log, [['clearFilters']]);
  });

  it('pluralises the Clear count', () => {
    renderFilters({ activeFilterCount: 3 });
    assert.ok(screen.getByRole('button', { name: 'Clear 3 filters' }));
  });

  it('a bounded window sets only the window', () => {
    const { log } = renderFilters();
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'now-7d' } });
    assert.deepEqual(log, [['setFilter', 'window', 'now-7d']]);
  });

  it('"All time" also clears the status filter', () => {
    const { log } = renderFilters();
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: '' } });
    assert.deepEqual(log, [['setFilter', 'window', ''], ['setFilter', 'status', []]]);
  });

  it('severity checkboxes write the selection worst-first', () => {
    const { log } = renderFilters({ filters: { ...EMPTY_FILTERS, severity: ['warning'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter by severity' }));
    fireEvent.click(within(screen.getByRole('menu')).getByLabelText('Disaster'));
    assert.deepEqual(log, [['setFilter', 'severity', ['disaster', 'warning']]]);
  });

  it('search types through, and the × appears with text and clears it', () => {
    const { log, rerenderWith } = renderFilters();
    assert.equal(screen.queryByRole('button', { name: 'Clear search' }), null);
    fireEvent.change(screen.getByPlaceholderText('Search Alerts'), { target: { value: 'cpu' } });
    assert.deepEqual(log.at(-1), ['setFilter', 'search', 'cpu']);

    rerenderWith({ filters: { ...EMPTY_FILTERS, search: 'cpu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    assert.deepEqual(log.at(-1), ['setFilter', 'search', '']);
  });

  it('passes the auto-refresh interval as a number', () => {
    const { log } = renderFilters();
    fireEvent.change(screen.getByLabelText('Auto-refresh interval'), { target: { value: '60000' } });
    assert.deepEqual(log, [['setRefreshMs', 60000]]);
  });

  it('pause toggles, and its title says what the next click does', () => {
    const { log, rerenderWith } = renderFilters();
    const pause = screen.getByTitle('Pause auto-refresh while you read');
    assert.equal(pause.getAttribute('aria-pressed'), 'false');
    fireEvent.click(pause);
    assert.deepEqual(log, [['setPaused', true]]);

    rerenderWith({ paused: true });
    fireEvent.click(screen.getByTitle('Resume auto-refresh'));
    assert.deepEqual(log.at(-1), ['setPaused', false]);
  });

  it('refresh calls back, and is disabled while refreshing', () => {
    const { log, rerenderWith } = renderFilters();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    assert.deepEqual(log, [['onRefresh']]);
    rerenderWith({ refreshing: true });
    assert.equal(screen.getByRole('button', { name: 'Refresh' }).disabled, true);
  });
});
