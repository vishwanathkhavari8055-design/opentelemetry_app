/**
 * TracesToolbar is the tab strip plus every control above the Traces editor.
 * Guarded here: the three tabs report which one is selected and switch on
 * click; the listing-only controls (charts, fields, editor, SQL, errors-only)
 * are HIDDEN on the Service Catalog rather than left inert; each toggle
 * reports its pressed/checked state and calls back; Run query explains why it
 * is disabled, flags unrun edits, and reads "Running…" in flight; and the
 * shared time-range and auto-refresh pickers hand their choice back up.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: TracesToolbar, TABS } = await import('../../../src/components/traces/TracesToolbar.jsx');

const renderToolbar = (props = {}) => {
  const calls = [];
  const cb = (name) => (...args) => calls.push([name, ...args]);
  const all = {
    tab: 'spans', onTabChange: cb('tab'),
    chartsVisible: true, onToggleCharts: cb('charts'),
    fieldsCollapsed: false, onToggleFields: cb('fields'),
    editorCollapsed: false, onToggleEditor: cb('editor'),
    errorsOnly: false, onToggleErrorsOnly: cb('errors'),
    sqlMode: false, onToggleSqlMode: cb('sql'),
    timeRange: { mode: 'relative', relative: '15m', from: '', to: '' }, onTimeRangeChange: cb('range'),
    refreshSecs: 0, onRefreshSecsChange: cb('refresh'),
    onRun: cb('run'), isRunning: false, isDirty: false, runDisabled: false,
    onDownload: cb('download'),
    ...props,
  };
  const utils = render(React.createElement(TracesToolbar, all));
  const rerenderWith = (p) => utils.rerender(React.createElement(TracesToolbar, { ...all, ...p }));
  return { ...utils, calls, rerenderWith };
};

const runButton = () => screen.getByRole('button', { name: /Run query|Running…/ });

describe('TracesToolbar', () => {
  afterEach(cleanup);

  it('renders the three tabs and switches on click', () => {
    const { calls } = renderToolbar({ tab: 'traces' });
    const tabs = screen.getAllByRole('tab');
    assert.deepEqual(tabs.map((t) => t.textContent), TABS.map((t) => t.label));
    assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['false', 'true', 'false']);
    fireEvent.click(screen.getByRole('tab', { name: 'Service Catalog' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Spans' }));
    assert.deepEqual(calls, [['tab', 'catalog'], ['tab', 'spans']]);
  });

  it('calls back from every listing toggle and reflects its state', () => {
    const { calls, rerenderWith } = renderToolbar();
    fireEvent.click(screen.getByTitle('Hide the Rate / Errors / Duration charts'));
    fireEvent.click(screen.getByTitle('Hide the field list'));
    fireEvent.click(screen.getByTitle('Hide the query editor'));
    fireEvent.click(screen.getByRole('switch', { name: 'SQL' }));
    fireEvent.click(screen.getByTitle('Show only errors'));
    fireEvent.click(screen.getByRole('button', { name: 'Download this page as JSON' }));
    assert.deepEqual(calls.map((c) => c[0]), ['charts', 'fields', 'editor', 'sql', 'errors', 'download']);

    assert.equal(screen.getByTitle('Hide the Rate / Errors / Duration charts').getAttribute('aria-pressed'), 'true');
    assert.equal(screen.getByRole('switch', { name: 'SQL' }).getAttribute('aria-checked'), 'false');

    rerenderWith({
      chartsVisible: false, fieldsCollapsed: true, editorCollapsed: true, sqlMode: true, errorsOnly: true,
    });
    assert.equal(screen.getByTitle('Show the charts').getAttribute('aria-pressed'), 'false');
    assert.equal(screen.getByTitle('Show the field list').getAttribute('aria-pressed'), 'false');
    assert.equal(screen.getByTitle('Show the query editor').getAttribute('aria-pressed'), 'false');
    assert.equal(screen.getByRole('switch', { name: 'SQL' }).getAttribute('aria-checked'), 'true');
    assert.match(screen.getByRole('switch', { name: 'SQL' }).title, /^SQL mode on/);
    const errors = screen.getByTitle('Showing errors only — click to show everything');
    assert.equal(errors.getAttribute('aria-checked'), 'true');
    assert.ok(errors.classList.contains('is-on'));
  });

  it('hides the listing-only controls on the Service Catalog', () => {
    renderToolbar({ tab: 'catalog' });
    assert.equal(screen.queryByRole('switch'), null);
    assert.equal(screen.queryByTitle('Hide the field list'), null);
    assert.equal(screen.queryByTitle('Hide the query editor'), null);
    // Range, run, refresh and download still apply to the catalog.
    assert.ok(runButton());
    assert.ok(screen.getByTitle('Change the time range'));
    assert.ok(screen.getByRole('button', { name: 'Download this page as JSON' }));
  });

  it('explains the Run query state: idle, dirty, unparseable, running', () => {
    const { calls, rerenderWith } = renderToolbar();
    assert.equal(runButton().title, 'Re-run the query');
    fireEvent.click(runButton());
    assert.deepEqual(calls.map((c) => c[0]), ['run']);

    rerenderWith({ isDirty: true });
    assert.equal(runButton().title, 'Unrun changes — click to apply');
    assert.ok(runButton().classList.contains('is-dirty'));

    rerenderWith({ isDirty: true, runDisabled: true });
    assert.equal(runButton().title, "The query doesn't parse — see the message under the editor");
    assert.ok(runButton().disabled);
    assert.ok(!runButton().classList.contains('is-dirty'));

    rerenderWith({ isRunning: true, runDisabled: false });
    assert.equal(runButton().textContent, 'Running…');
    assert.ok(runButton().disabled);
  });

  it('hands relative and absolute ranges back from the time picker', () => {
    const { calls } = renderToolbar();
    const trigger = screen.getByTitle('Change the time range');
    assert.match(trigger.textContent, /Past 15 Minutes/);

    fireEvent.click(trigger);
    // The Hours group's "1" preset.
    const hours = screen.getByText('Hours').parentElement;
    fireEvent.click(hours.querySelector('button'));
    assert.deepEqual(calls.at(-1), ['range', { mode: 'relative', relative: '1h', from: '', to: '' }]);
    assert.equal(screen.queryByRole('dialog', { name: 'Time range' }), null);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('tab', { name: 'Absolute' }));
    const [from, to] = document.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(from, { target: { value: '2026-08-03T12:45' } });
    fireEvent.change(to, { target: { value: '2026-08-03T13:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    assert.deepEqual(calls.at(-1), ['range', {
      mode: 'absolute', relative: '15m', from: '2026-08-03T12:45', to: '2026-08-03T13:00',
    }]);
  });

  it('hands the auto-refresh interval back and shows it on the button', () => {
    const { calls, rerenderWith } = renderToolbar();
    fireEvent.click(screen.getByTitle('Auto-refresh is off'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '30 sec' }));
    assert.deepEqual(calls, [['refresh', 30]]);
    rerenderWith({ refreshSecs: 30 });
    assert.match(screen.getByTitle('Auto-refreshing every 30s').textContent, /30s/);
  });
});
