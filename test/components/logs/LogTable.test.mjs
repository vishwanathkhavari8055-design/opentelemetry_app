/**
 * The logs table body: the row list and its empty / loading / error wording,
 * and each source row's inline expander (field table, JSON tab, `=` filter
 * buttons, copy, "Open trace").
 *
 * Guarded because this is where a user reads every log: the empty-state text
 * is how they tell "nothing matched" from "the backend is down", the source
 * column must show the untouched wire record (not the aliases api.js adds),
 * and the `=` button is the one-click way to narrow a query.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, act, within } = await import('@testing-library/react');
const { default: LogTable } = await import('../../../src/components/logs/LogTable.jsx');
const { default: LogSourceRow } = await import('../../../src/components/logs/LogSourceRow.jsx');
const { HighlightedText } = await import('../../../src/components/logs/HighlightedText.jsx');
const { sourceRecord } = await import('../../../src/components/logs/sourceRecord.js');

const h = React.createElement;

const TRACE = 'a'.repeat(32);
const row = (over = {}) => {
  const raw = {
    '@timestamp': '2026-09-25T10:00:00.000Z',
    'service.name': 'orders',
    severity_text: 'ERROR',
    body: 'payment timeout',
    count: 3,
    ok: true,
    nothing: null,
    ...over.raw,
  };
  return {
    _raw: raw,
    id: 'x',
    timestamp: raw['@timestamp'],
    serviceName: raw['service.name'],
    severity: 'ERROR',
    traceId: TRACE,
    message: raw.body,
    ...over.row,
  };
};

const tableProps = (over = {}) => ({
  rows: [], setHoveredTraceId: () => {}, onTraceClick: () => {},
  isLoading: false, isError: false, ...over,
});

const installClipboard = () => {
  const written = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t) => { written.push(t); } },
  });
  return written;
};

describe('sourceRecord', () => {
  it('prefers the untouched wire record', () => {
    const r = row();
    assert.equal(sourceRecord(r), r._raw);
  });
  it('strips api.js aliases when no wire record was kept', () => {
    assert.deepEqual(
      sourceRecord({ id: 1, timestamp: 't', serviceName: 's', severity: 'x', traceId: 't', message: 'm', host: 'h' }),
      { host: 'h' },
    );
    assert.deepEqual(sourceRecord(null), {});
  });
});

describe('HighlightedText', () => {
  afterEach(cleanup);
  it('wraps every case-insensitive match in <mark>, regex characters included', () => {
    const { container } = render(h('div', null, h(HighlightedText, { text: 'a.b A.B c', highlight: 'a.b' })));
    const marks = container.querySelectorAll('mark');
    assert.deepEqual([...marks].map((m) => m.textContent), ['a.b', 'A.B']);
    assert.equal(container.textContent, 'a.b A.B c');
  });
  it('renders plain text with no highlight', () => {
    const { container } = render(h('div', null, h(HighlightedText, { text: 'plain' })));
    assert.equal(container.querySelector('mark'), null);
    assert.equal(container.textContent, 'plain');
  });
  it('falls back to the plain text when the highlight is not a string', () => {
    // The prop-type warning is expected here; keep it out of the test output.
    const quiet = mock.method(console, 'error', () => {});
    try {
      const { container } = render(h('div', null, h(HighlightedText, { text: 'v 5', highlight: 5 })));
      assert.equal(container.querySelector('mark'), null);
      assert.equal(container.textContent, 'v 5');
    } finally {
      quiet.mock.restore();
    }
  });
});

describe('LogTable empty states', () => {
  afterEach(cleanup);

  it('shows the zone-labelled header and the no-events wording', () => {
    render(h(LogTable, tableProps()));
    assert.ok(screen.getByText(/^timestamp \(/));
    assert.ok(screen.getByText('No events in the selected time range.'));
  });

  it('says the query matched nothing when a query is active', () => {
    render(h(LogTable, tableProps({ hasQuery: true })));
    assert.ok(screen.getByText('No events matched this query in the selected time range.'));
  });

  it('shows a progress bar and "Running query…" while loading', () => {
    render(h(LogTable, tableProps({ isLoading: true })));
    assert.ok(screen.getByRole('progressbar', { name: 'Running query' }));
    assert.ok(screen.getByText('Running query…'));
  });

  it('shows the error message, or a generic one', () => {
    const { rerender } = render(h(LogTable, tableProps({ isError: true, errorMessage: 'HTTP 500' })));
    assert.ok(screen.getByText('Query failed'));
    assert.ok(screen.getByText('HTTP 500'));
    rerender(h(LogTable, tableProps({ isError: true })));
    assert.ok(screen.getByText(/did not return results/));
  });

  it('clears the hovered trace when the pointer leaves the list', () => {
    const hovered = [];
    const { container } = render(h(LogTable, tableProps({ rows: [row()], setHoveredTraceId: (v) => hovered.push(v) })));
    fireEvent.mouseLeave(container.querySelector('.log-list'));
    assert.deepEqual(hovered, [null]);
  });
});

describe('LogSourceRow', () => {
  afterEach(() => { cleanup(); mock.timers.reset(); });

  it('renders the wire record as JSON and highlights the search term', () => {
    const { container } = render(h(LogTable, tableProps({ rows: [row()], highlight: 'timeout' })));
    const src = container.querySelector('.oo-row-src').textContent;
    assert.match(src, /"service\.name":"orders"/);
    assert.match(src, /"count":3/);
    assert.match(src, /"ok":true/);
    assert.match(src, /"nothing":null/);
    assert.doesNotMatch(src, /serviceName/);
    assert.equal(container.querySelector('mark').textContent, 'timeout');
  });

  it('opens the details on row click and on Enter / Space', () => {
    const opened = [];
    const log = row();
    render(h(LogTable, tableProps({ rows: [log], onOpenDetails: (l) => opened.push(l) })));
    const r = screen.getByTitle('Open source details');
    fireEvent.click(r);
    fireEvent.keyDown(r, { key: 'Enter' });
    fireEvent.keyDown(r, { key: ' ' });
    fireEvent.keyDown(r, { key: 'a' });
    assert.equal(opened.length, 3);
    assert.equal(opened[0], log);
  });

  it('expands inline with the caret without opening details, and lists fields with filters', () => {
    const opened = [];
    const filters = [];
    const log = row({ raw: { stack: 'line1\nline2', long: 'x'.repeat(200), empty: '' } });
    render(h(LogTable, tableProps({
      rows: [log], onOpenDetails: (l) => opened.push(l), onFieldFilter: (k, v) => filters.push([k, v]),
    })));
    fireEvent.click(screen.getByRole('button', { name: 'Expand record' }));
    assert.equal(opened.length, 0);
    assert.ok(screen.getByRole('button', { name: 'Collapse record' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add service.name equals orders to the query' }));
    assert.deepEqual(filters, [['service.name', 'orders']]);
    // Multi-line, over-long, empty and null values get no `=` button.
    assert.equal(screen.queryByRole('button', { name: /Add stack equals/ }), null);
    assert.equal(screen.queryByRole('button', { name: /Add long equals/ }), null);
    assert.equal(screen.queryByRole('button', { name: /Add empty equals/ }), null);
    assert.equal(screen.queryByRole('button', { name: /Add nothing equals/ }), null);
    assert.ok(screen.getByRole('button', { name: 'Copy stack' }));

    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    assert.match(document.querySelector('.oo-detail-json').textContent, /"body": "payment timeout"/);
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    assert.ok(document.querySelector('.oo-detail-table'));

    fireEvent.click(screen.getByRole('button', { name: 'Collapse record' }));
    assert.equal(document.querySelector('.oo-detail'), null);
  });

  it('offers "Open trace" only for a real trace id, and hovering it highlights the trace', () => {
    const traces = [];
    const hovered = [];
    const { rerender } = render(h(LogTable, tableProps({
      rows: [row()], expandedAll: true,
      onTraceClick: (t) => traces.push(t), setHoveredTraceId: (t) => hovered.push(t),
    })));
    const btn = screen.getByRole('button', { name: 'Open trace →' });
    fireEvent.mouseEnter(btn);
    fireEvent.click(btn);
    assert.deepEqual(traces, [TRACE]);
    assert.deepEqual(hovered, [TRACE]);

    rerender(h(LogTable, tableProps({ rows: [row({ row: { traceId: 'no-trace' } })], expandedAll: true })));
    assert.equal(screen.queryByRole('button', { name: 'Open trace →' }), null);
  });

  it('dims rows of other traces and highlights rows of the hovered one', () => {
    const other = row({ row: { traceId: 'b'.repeat(32) } });
    const { container } = render(h(LogTable, tableProps({ rows: [row(), other], hoveredTraceId: TRACE })));
    const wraps = container.querySelectorAll('.oo-row-wrap');
    assert.match(wraps[0].className, /highlighted/);
    assert.match(wraps[1].className, /dimmed/);
  });

  it('expand-all opens every row and the caret still works afterwards', () => {
    const { rerender } = render(h(LogTable, tableProps({ rows: [row(), row()], expandedAll: false })));
    assert.equal(document.querySelectorAll('.oo-detail').length, 0);
    rerender(h(LogTable, tableProps({ rows: [row(), row()], expandedAll: true })));
    assert.equal(document.querySelectorAll('.oo-detail').length, 2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse record' })[0]);
    assert.equal(document.querySelectorAll('.oo-detail').length, 1);
  });

  it('copies the record, shows a tick, then reverts after two seconds', async () => {
    const written = installClipboard();
    mock.timers.enable({ apis: ['setTimeout'] });
    render(h(LogSourceRow, {
      log: row(), setHoveredTraceId: () => {}, onTraceClick: () => {}, expandedAll: true,
    }));
    const copy = screen.getByRole('button', { name: 'Copy the whole record as JSON' });
    await act(async () => { fireEvent.click(copy); });
    assert.equal(JSON.parse(written[0]).body, 'payment timeout');
    assert.equal(copy.textContent, '✓');
    act(() => { mock.timers.tick(2000); });
    assert.equal(copy.textContent, '⧉');

    // A value-level copy writes just that value.
    const table = within(document.querySelector('.oo-detail-table'));
    await act(async () => { fireEvent.click(table.getByRole('button', { name: 'Copy body' })); });
    assert.equal(written[1], 'payment timeout');
    act(() => { mock.timers.tick(2000); });
  });

  it('swallows a clipboard rejection', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')) },
    });
    render(h(LogSourceRow, { log: row(), setHoveredTraceId: () => {}, onTraceClick: () => {}, expandedAll: true }));
    const copy = screen.getByRole('button', { name: 'Copy the whole record as JSON' });
    await act(async () => { fireEvent.click(copy); });
    assert.equal(copy.textContent, '⧉');
  });
});
