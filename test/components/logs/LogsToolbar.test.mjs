/**
 * The logs toolbar: view toggles, the SQL switch, saved views (save / load /
 * delete), "Run query" states, and the overflow menu (share link, downloads).
 *
 * Guarded because each control maps one-to-one onto a container action, and
 * the Run button's disabled/dirty states are how a user learns their draft
 * query doesn't parse or hasn't been applied yet.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const { default: LogsToolbar } = await import('../../../src/components/logs/LogsToolbar.jsx');

const h = React.createElement;

const setup = (over = {}) => {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const props = {
    sqlMode: false, onToggleSqlMode: rec('sql'),
    histogramVisible: true, onToggleHistogram: rec('histogram'),
    fieldsCollapsed: false, onToggleFields: rec('fields'),
    editorCollapsed: false, onToggleEditor: rec('editor'),
    timeRange: { mode: 'relative', relative: '15m', from: '', to: '' }, onTimeRangeChange: rec('range'),
    refreshSecs: 0, onRefreshSecsChange: rec('refresh'), refreshPausedReason: '',
    onRun: rec('run'), isRunning: false, isDirty: false, runDisabled: false,
    savedViews: [], onSaveView: rec('save'), onLoadView: rec('load'), onDeleteView: rec('delete'),
    onShare: rec('share'), shareState: '', onDownload: rec('download'),
    ...over,
  };
  const utils = render(h(LogsToolbar, props));
  return { ...utils, calls, props };
};

describe('LogsToolbar', () => {
  afterEach(cleanup);

  it('toggles the chart, field list, editor and SQL mode', () => {
    const { calls } = setup();
    fireEvent.click(screen.getByTitle('Hide the event-volume chart'));
    fireEvent.click(screen.getByTitle('Hide the field list'));
    fireEvent.click(screen.getByTitle('Hide the query editor'));
    fireEvent.click(screen.getByRole('switch'));
    assert.deepEqual(calls.map((c) => c[0]), ['histogram', 'fields', 'editor', 'sql']);
  });

  it('reflects the collapsed / SQL states in titles and aria', () => {
    setup({ histogramVisible: false, fieldsCollapsed: true, editorCollapsed: true, sqlMode: true });
    assert.equal(screen.getByTitle('Show the event-volume chart').getAttribute('aria-pressed'), 'false');
    assert.equal(screen.getByTitle('Show the field list').getAttribute('aria-pressed'), 'false');
    assert.equal(screen.getByTitle('Show the query editor').getAttribute('aria-pressed'), 'false');
    assert.equal(screen.getByRole('switch').getAttribute('aria-checked'), 'true');
  });

  it('runs the query, and explains dirty / running / unparseable states', () => {
    const { calls, rerender, props } = setup();
    const run = () => screen.getByRole('button', { name: /Run query|Running…/ });
    assert.equal(run().title, 'Re-run the query');
    fireEvent.click(run());
    assert.deepEqual(calls.map((c) => c[0]), ['run']);

    rerender(h(LogsToolbar, { ...props, isDirty: true }));
    assert.equal(run().title, 'Unrun changes — click to apply');
    assert.match(run().className, /is-dirty/);

    rerender(h(LogsToolbar, { ...props, isDirty: true, runDisabled: true }));
    assert.equal(run().disabled, true);
    assert.match(run().title, /doesn't parse/);

    rerender(h(LogsToolbar, { ...props, isRunning: true }));
    assert.equal(run().textContent, 'Running…');
    assert.equal(run().disabled, true);
  });

  it('saves a named view with the button or Enter, ignoring blank names', () => {
    const { calls } = setup();
    fireEvent.click(screen.getByTitle('Saved views'));
    assert.ok(screen.getByText('Nothing saved yet.'));
    const input = screen.getByRole('textbox', { name: 'Saved view name' });
    const save = screen.getByRole('button', { name: 'Save' });
    assert.equal(save.disabled, true);
    fireEvent.keyDown(input, { key: 'Enter' });
    assert.equal(calls.length, 0);

    fireEvent.change(input, { target: { value: '  errors  ' } });
    fireEvent.click(save);
    assert.deepEqual(calls, [['save', 'errors']]);
    assert.equal(screen.queryByRole('menu'), null);

    fireEvent.click(screen.getByTitle('Saved views'));
    const input2 = screen.getByRole('textbox', { name: 'Saved view name' });
    assert.equal(input2.value, '');
    fireEvent.change(input2, { target: { value: 'second' } });
    fireEvent.keyDown(input2, { key: 'a' });
    fireEvent.keyDown(input2, { key: 'Enter' });
    assert.deepEqual(calls[1], ['save', 'second']);
  });

  it('loads and deletes saved views', () => {
    const views = [{ name: 'errs', query: "severity_text='ERROR'" }, { name: 'blank', query: '' }];
    const { calls } = setup({ savedViews: views });
    fireEvent.click(screen.getByTitle('Saved views'));
    assert.equal(screen.getByRole('button', { name: 'blank' }).title, '(empty query)');
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved view blank' }));
    assert.deepEqual(calls[0], ['delete', 'blank']);
    fireEvent.click(screen.getByRole('button', { name: 'errs' }));
    assert.deepEqual(calls[1], ['load', views[0]]);
    assert.equal(screen.queryByRole('menu'), null);
  });

  it('closes the saved-views popover on Escape or an outside click', () => {
    setup();
    fireEvent.click(screen.getByTitle('Saved views'));
    fireEvent.mouseDown(screen.getByRole('menu'));
    assert.ok(screen.getByRole('menu'));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('menu'), null);
    fireEvent.click(screen.getByTitle('Saved views'));
    fireEvent.keyDown(document, { key: 'x' });
    fireEvent.mouseDown(document.body);
    assert.equal(screen.queryByRole('menu'), null);
  });

  it('shares and downloads from the overflow menu', () => {
    const { calls, rerender, props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = within(screen.getByRole('menu'));
    fireEvent.click(menu.getByRole('menuitem', { name: 'Copy share link' }));
    assert.equal(calls[0][0], 'share');
    rerender(h(LogsToolbar, { ...props, shareState: 'copied' }));
    assert.ok(screen.getByRole('menuitem', { name: 'Link copied ✓' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download this page (CSV)' }));
    assert.deepEqual(calls[1], ['download', 'csv']);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download this page (JSON)' }));
    assert.deepEqual(calls[2], ['download', 'json']);
  });

  it('passes time-range and refresh picks through', () => {
    const { calls } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Past 15 Minutes/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '5' })[0]);
    assert.deepEqual(calls[0], ['range', { mode: 'relative', relative: '5m', from: '', to: '' }]);
    fireEvent.click(screen.getByTitle('Auto-refresh is off'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '10 sec' }));
    assert.deepEqual(calls[1], ['refresh', 10]);
  });
});
