/**
 * TraceView is the legacy trace drill-down built on GET /traces (the lib's
 * assembled span tree). It is the screen people land on from a log's "open
 * trace", so the flows guarded here are the ones they use to find a cause:
 *  - it asks for this trace id, shows loading, then the header (root name,
 *    status, duration) and a per-type summary that sees through the lib's
 *    mis-typing (SELECT/find/MATCH/HGET spans typed INTERNAL);
 *  - the error banner names the DEEPEST failing span, and "Jump to span"
 *    reveals it in the tree and opens the inspector;
 *  - expand/collapse all, row click → inspector, Esc / × to dismiss;
 *  - type chips, search and the severity select filter the tree while keeping
 *    matching descendants' ancestors;
 *  - Group by type buckets every descendant; Logs by span rebuilds the real
 *    span tree per thread with logs nested under their span;
 *  - the waterfall starts collapsed for big traces, remembers the choice, and
 *    its bars and segments drive selection and the type filter;
 *  - an empty or failed fetch says there is no trace data.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { default: TraceView } = await import('../../../src/components/TraceView.jsx');

// jsdom has no CSS.escape; TraceView uses it to find the row to scroll to.
globalThis.CSS ??= { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };

const BASE = Date.parse('2026-03-04T05:00:00.000Z');
const at = (ms) => new Date(BASE + ms).toISOString();

const ROOT = {
  spanId: 'r', name: 'POST /api/orders', type: 'HTTP', status: 'ERROR', durationMs: 120,
  timestamp: at(0), serviceName: 'gateway', threadName: 'http-1', httpMethod: 'POST', httpStatus: 500,
  endpoint: '/api/orders',
  children: [
    {
      name: 'SQL Queries', count: 2, children: [
        { spanId: 's1', parentId: 'r', name: 'SELECT * FROM orders', type: 'INTERNAL', status: 'SUCCESS', durationMs: 20, timestamp: at(10), threadName: 'http-1', serviceName: 'orders' },
        { spanId: 's2', parentId: 's1', name: 'exec proc', type: 'MSSQL', durationMs: 3, timestamp: at(12), status: 'SUCCESS' },
      ],
    },
    { spanId: 'm1', parentId: 'r', name: 'find orders', type: 'INTERNAL', durationMs: 15, startTime: at(40), threadName: 'pool-1', status: 'SUCCESS' },
    {
      spanId: 'i1', parentId: 'r', name: 'process', type: 'INTERNAL', durationMs: 30, timestamp: at(60), threadName: 'pool-1',
      className: 'OrderSvc', methodName: 'process', status: 'SUCCESS',
      children: [
        { spanId: 'e1', parentId: 'i1', name: 'charge', type: 'INTERNAL', status: 'ERROR', durationMs: 5, timestamp: at(70), fullMessage: 'card declined', className: 'Pay', methodName: 'charge', relativeTimeMs: 70 },
        { type: 'LOG', spanId: 'i1', severity: 'WARN', fullMessage: 'slow path', actualOperation: '{"retry":2}', time: at(65), durationMs: 65 },
      ],
    },
    { type: 'LOG', spanId: 'zz', severity: 'INFO', message: 'orphan log', timestamp: at(5), threadName: 'http-1' },
    { spanId: 'h1', parentId: 'r', name: 'GET /health', type: 'INTERNAL', timestamp: at(90), durationMs: 1, status: 'SUCCESS' },
    { spanId: 'n1', parentId: 'i1', name: 'MATCH (n) RETURN n', type: 'DATABASE', timestamp: at(80), durationMs: 2, threadName: 'neo-1', status: 'SUCCESS' },
    { spanId: 'rd1', parentId: 'r', name: 'HGET key', type: 'INTERNAL', timestamp: at(95), durationMs: 1, status: 'SUCCESS' },
    { spanId: 'db1', parentId: 'r', name: 'db call', type: 'DATABASE', timestamp: at(100), durationMs: 1, status: 'WARN' },
    { spanId: 'ex1', parentId: 'missing', name: 'stripe', type: 'EXTERNAL', timestamp: at(105), durationMs: 1, status: 'SUCCESS' },
    { spanId: 'mg1', parentId: 'r', name: 'agg', type: 'MONGODB', timestamp: at(108), durationMs: 1, status: 'SUCCESS' },
    { spanId: 'o1', parentId: 'r', name: 'mystery', type: 'CUSTOM', timestamp: at(110), durationMs: 1, status: 'DEBUG' },
    { spanId: 'st', name: 'weird', type: 'INTERNAL', dbStatement: '{"q":1}', status: 'SUCCESS' },
  ],
};

const traceRoute = (root = ROOT) => [/\/traces\?/, (url) => [{ traceId: new URL(url, 'http://x').searchParams.get('traceId'), rootOperation: root, spans: [{ spanId: 'r' }] }]];

/** Visible tree rows, as their operation title (spans) or message (logs). */
const treeRows = (container) => [...container.querySelectorAll('.tv-tree-card [data-uid]')]
  .map((el) => el.querySelector('.tv-op-name')?.title ?? el.querySelector('.tv-log-message').textContent);

const rowFor = (container, title) => [...container.querySelectorAll('.tv-tree-card [data-uid]')]
  .find((el) => el.querySelector('.tv-op-name')?.title === title);

let net;
const renderView = async (props = {}, routes = [traceRoute()]) => {
  net = stubFetch(routes);
  const back = [];
  const utils = render(React.createElement(TraceView, { traceId: 'trace-1', onBack: () => back.push(1), ...props }));
  await screen.findByText('Trace ID: trace-1');
  return { ...utils, back };
};

describe('TraceView', () => {
  afterEach(() => {
    cleanup();
    net?.restore();
    net = null;
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('loads this trace, then shows the header and a summary by effective type', async () => {
    net = stubFetch([traceRoute()]);
    render(React.createElement(TraceView, { traceId: 'trace-1', onBack: () => {} }));
    assert.ok(screen.getByText('Loading trace data…'));
    await screen.findByText('Trace ID: trace-1');
    const url = new URL(net.calls[0].url, 'http://x');
    assert.match(url.pathname, /\/traces$/);
    assert.deepEqual([url.searchParams.get('traceId'), url.searchParams.get('page'), url.searchParams.get('size')], ['trace-1', '0', '100']);

    assert.equal(screen.getByRole('heading', { level: 1 }).textContent, 'POST /api/orders');
    assert.equal(document.querySelector('.tv-meta-badge-value').textContent, '120 ms');
    const chips = [...document.querySelectorAll('.tv-summary-chip')].map((c) => c.textContent);
    assert.deepEqual(chips.sort(), [
      'CUSTOM (1)', 'DATABASE (1)', 'EXTERNAL (1)', 'HTTP (2)', 'INTERNAL (2)', 'LOG (2)',
      'MONGODB (3)', 'MSSQL (1)', 'NEO4J (1)', 'REDIS (1)', 'SQL (1)',
    ]);
  });

  it('says there is no trace data for an empty or failed response', async () => {
    net = stubFetch([[/\/traces\?/, []]]);
    const { rerender } = render(React.createElement(TraceView, { traceId: 'trace-1', onBack: () => {} }));
    await screen.findByText('No trace data found.');
    net.restore();
    net = stubFetch([[/\/traces\?/, { status: 500, body: {} }]]);
    const origError = console.error;
    console.error = () => {};
    try {
      rerender(React.createElement(TraceView, { traceId: 'trace-2', onBack: () => {} }));
      await waitFor(() => assert.equal(net.calls.length, 1));
      await screen.findByText('No trace data found.');
    } finally { console.error = origError; }
  });

  it('back returns to discovery', async () => {
    const { back } = await renderView();
    fireEvent.click(screen.getByRole('button', { name: '← Back to Discovery' }));
    assert.equal(back.length, 1);
  });

  it('the error banner names the deepest failing span and Jump reveals it in the inspector', async (t) => {
    const scrolled = [];
    const proto = window.HTMLElement.prototype;
    const orig = proto.scrollIntoView;
    proto.scrollIntoView = function scrollIntoView() { scrolled.push(this.getAttribute('data-uid')); };
    t.after(() => { proto.scrollIntoView = orig; });
    const { container } = await renderView();
    const banner = container.querySelector('.tv-error-banner');
    assert.ok(within(banner).getByText('card declined'));
    assert.ok(within(banner).getByText('Pay.charge()'));
    assert.ok(within(banner).getByText('+70.000 ms'));
    assert.deepEqual(treeRows(container), ['POST /api/orders']);

    fireEvent.click(within(banner).getByRole('button', { name: 'Jump to span →' }));
    await waitFor(() => assert.ok(treeRows(container).includes('charge')));
    assert.deepEqual(treeRows(container).slice(0, 1), ['POST /api/orders']);
    assert.ok(treeRows(container).includes('process'));
    const pane = container.querySelector('.tv-inspector-pane');
    assert.equal(within(pane).getByRole('heading').textContent, 'charge');
    assert.ok(rowFor(container, 'charge').classList.contains('tv-row-selected'));
    // The revealed row is scrolled into view (next animation frame).
    await waitFor(() => assert.deepEqual(scrolled, [rowFor(container, 'charge').getAttribute('data-uid')]));

    // Esc dismisses the inspector; the tree stays expanded.
    fireEvent.keyDown(window, { key: 'Escape' });
    assert.equal(container.querySelector('.tv-inspector-pane'), null);
    assert.ok(treeRows(container).includes('charge'));
  });

  it('expand all / collapse all, and a row click opens the inspector until ×', async () => {
    const { container } = await renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const rows = treeRows(container);
    // Virtual "SQL Queries" wrapper is unwrapped; siblings sorted by start, undated last.
    assert.deepEqual(rows, [
      'POST /api/orders', 'orphan log', 'SELECT * FROM orders', 'exec proc', 'find orders', 'process',
      'slow path', 'charge', 'MATCH (n) RETURN n', 'GET /health', 'HGET key', 'db call', 'stripe', 'agg', 'mystery', 'weird',
    ]);
    fireEvent.click(rowFor(container, 'find orders'));
    const pane = container.querySelector('.tv-inspector-pane');
    assert.equal(within(pane).getByRole('heading').textContent, 'find orders');
    assert.ok(container.querySelector('.tv-body').classList.contains('tv-body--with-pane'));
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    assert.equal(container.querySelector('.tv-inspector-pane'), null);

    // A log row with no extra payload still selects, and the pane shows it.
    fireEvent.click(container.querySelector('.tv-log-row'));
    assert.ok(container.querySelector('.tv-inspector-pane'));
    // A log with a separate payload opens it inline on click, and closes it again.
    const slow = () => [...container.querySelectorAll('.tv-log-row')].find((r) => r.textContent.includes('slow path'));
    fireEvent.click(slow());
    assert.equal(container.querySelector('.tv-log-payload').textContent, '{\n  "retry": 2\n}');
    fireEvent.click(slow());
    assert.equal(container.querySelector('.tv-log-payload'), null);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    assert.deepEqual(treeRows(container), ['POST /api/orders']);
    // Clicking the root toggles it open and closed.
    fireEvent.click(rowFor(container, 'POST /api/orders'));
    assert.ok(treeRows(container).length > 1);
    fireEvent.click(rowFor(container, 'POST /api/orders'));
    assert.deepEqual(treeRows(container), ['POST /api/orders']);
  });

  it('type chips filter the tree (multi-select) and Clear resets', async () => {
    const { container } = await renderView();
    const chip = (label) => [...container.querySelectorAll('.tv-summary-chip')].find((c) => c.textContent === label);
    fireEvent.click(chip('MONGODB (3)'));
    fireEvent.click(chip('NEO4J (1)'));
    assert.ok(chip('MONGODB (3)').classList.contains('tv-chip-active'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    // Root is kept only as the ancestor of matches.
    assert.deepEqual(treeRows(container), ['POST /api/orders', 'find orders', 'MATCH (n) RETURN n', 'agg', 'weird']);
    fireEvent.click(chip('NEO4J (1)'));
    assert.ok(!treeRows(container).includes('MATCH (n) RETURN n'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear (1)' }));
    assert.equal(screen.queryByRole('button', { name: /^Clear \(/ }), null);
    // Expand-all only opened what was expandable under the filter, so
    // `process` (whose children were all filtered out) stays closed.
    assert.equal(treeRows(container).length, 14);
    assert.ok(!treeRows(container).includes('charge'));
  });

  it('search auto-expands to matches, clears with ×, and says when nothing matches', async () => {
    const { container } = await renderView();
    const box = screen.getByPlaceholderText('Search spans, log messages, queries, services…');
    fireEvent.change(box, { target: { value: 'declined' } });
    assert.deepEqual(treeRows(container), ['POST /api/orders', 'process', 'charge']);
    fireEvent.change(box, { target: { value: 'nothing-like-this' } });
    assert.ok(screen.getByText('No spans match the current filters.'));
    fireEvent.click(screen.getByTitle('Clear search'));
    assert.equal(box.value, '');
    assert.deepEqual(treeRows(container), ['POST /api/orders']);
  });

  it('the severity select keeps spans at or above the level', async () => {
    const { container } = await renderView();
    const select = screen.getByLabelText('SEVERITY:');
    assert.deepEqual([...select.options].map((o) => o.textContent),
      ['All levels', '≥ TRACE', '≥ DEBUG', '≥ INFO', '≥ WARN', '≥ ERROR']);
    fireEvent.change(select, { target: { value: 'ERROR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    assert.deepEqual(treeRows(container), ['POST /api/orders', 'process', 'charge']);
    fireEvent.change(select, { target: { value: 'WARN' } });
    assert.deepEqual(treeRows(container), ['POST /api/orders', 'process', 'slow path', 'charge', 'db call']);
    fireEvent.change(select, { target: { value: 'TRACE' } });
    assert.equal(treeRows(container).length, 16);
  });

  it('Group by type buckets every descendant under its type', async () => {
    const { container } = await renderView();
    fireEvent.click(screen.getByLabelText('Group by type'));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const groups = [...container.querySelectorAll('.tv-row-group')].map((r) => r.querySelector('.tv-op-name').title);
    assert.deepEqual(groups.sort(), [
      'Database Queries', 'Direct Logs', 'External API Calls', 'HTTP Requests', 'Internal Processing',
      'MongoDB Queries', 'Neo4j (Cypher)', 'Other Operations', 'Redis Operations', 'SQL Queries',
    ]);
    const sqlGroup = rowFor(container, 'SQL Queries');
    assert.equal(sqlGroup.querySelector('.tv-group-count').textContent, ' (2)');
    assert.equal(sqlGroup.querySelector('.tv-op-sub').textContent, 'Total Duration: 23.000 ms');
    // Worst status of each bucket bubbles up.
    assert.equal(rowFor(container, 'Internal Processing').querySelector('.tv-cell-status').textContent, 'ERROR');
    assert.equal(rowFor(container, 'Database Queries').querySelector('.tv-cell-status').textContent, 'WARN');
    // Collapsing one bucket hides only its spans.
    fireEvent.click(sqlGroup);
    assert.ok(!treeRows(container).includes('exec proc'));
    assert.ok(treeRows(container).includes('agg'));
    // Search opens matching buckets without Expand all.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'stripe' } });
    assert.deepEqual(treeRows(container), ['POST /api/orders', 'External API Calls', 'stripe']);
  });

  it('Logs by span rebuilds the span tree per thread with logs under their span', async () => {
    const { container } = await renderView();
    fireEvent.click(screen.getByLabelText('Logs by span'));
    assert.ok(screen.getByText('SPAN ID'));
    await waitFor(() => assert.ok(treeRows(container).includes('charge')));
    const threads = [...container.querySelectorAll('.tv-row-group')].map((r) => r.querySelector('.tv-op-name').title);
    assert.deepEqual(threads, ['thread: http-1', 'thread: pool-1', 'thread: neo-1', 'thread: (unknown thread)']);
    const rows = treeRows(container);
    // `slow path` (spanId i1) sits under `process`, together with its child span.
    assert.deepEqual(rows.slice(rows.indexOf('thread: pool-1'), rows.indexOf('thread: neo-1')),
      ['thread: pool-1', 'find orders', 'process', 'slow path', 'charge']);
    // s2 inherits its thread from its parent s1 and nests under it.
    assert.ok(rows.indexOf('exec proc') === rows.indexOf('SELECT * FROM orders') + 1);
    // Cross-thread parent is spelled out; root parent is named.
    const chip = (title) => rowFor(container, title).querySelector('.tv-parent-chip')?.textContent;
    assert.equal(chip('MATCH (n) RETURN n'), '↳ process (on pool-1)');
    assert.equal(chip('find orders'), '↳ POST /api/orders');
    assert.equal(chip('exec proc'), '↳ SELECT * FROM orders');
    assert.equal(chip('stripe'), undefined);
    assert.equal(rowFor(container, 'find orders').querySelector('.tv-span-id').textContent, 'm1');

    // Manual collapse sticks (auto-expand runs once per trace + mode).
    fireEvent.click(rowFor(container, 'thread: pool-1'));
    assert.ok(!treeRows(container).includes('find orders'));
    // Switching back to List restores the lib hierarchy.
    fireEvent.click(screen.getByLabelText('List'));
    assert.equal(screen.queryByText('SPAN ID'), null);
  });

  it('Logs by span on a trace with only a root span returns the root unchanged', async () => {
    const lone = { name: 'lonely', type: 'INTERNAL', status: 'SUCCESS', timestamp: at(0), durationMs: 1 };
    const { container } = await renderView({}, [traceRoute(lone)]);
    fireEvent.click(screen.getByLabelText('Logs by span'));
    assert.deepEqual(treeRows(container), ['lonely']);
    assert.equal(container.querySelector('.tv-error-banner'), null);
  });

  it('the waterfall starts collapsed for a big trace, remembers expand, and drives selection', async () => {
    const { container } = await renderView();
    assert.ok(container.querySelector('.tv-waterfall-collapsed'));
    // A strip segment applies its type as a filter.
    const seg = [...container.querySelectorAll('.tv-waterfall-strip-seg')].find((s) => s.title.startsWith('MONGODB'));
    fireEvent.click(seg);
    assert.ok(screen.getByRole('button', { name: 'Clear (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear (1)' }));

    fireEvent.click(screen.getByRole('button', { name: '▾ expand' }));
    assert.equal(localStorage.getItem('tv-waterfall-expanded'), '1');
    const bar = container.querySelector('.tv-wf-row[title^="find orders"]');
    assert.ok(bar);
    fireEvent.click(bar);
    const pane = await waitFor(() => {
      const p = container.querySelector('.tv-inspector-pane');
      assert.ok(p);
      return p;
    });
    assert.equal(within(pane).getByRole('heading').textContent, 'find orders');
    assert.ok(rowFor(container, 'find orders'), 'tree row revealed');
    assert.ok(container.querySelector('.tv-wf-row-selected[title^="find orders"]'));

    fireEvent.click(screen.getByRole('button', { name: '▴ collapse' }));
    assert.equal(localStorage.getItem('tv-waterfall-expanded'), '0');
  });

  it('opens the waterfall expanded when that was the saved preference', async () => {
    localStorage.setItem('tv-waterfall-expanded', '1');
    const { container } = await renderView();
    assert.equal(container.querySelector('.tv-waterfall-collapsed'), null);
    assert.ok(container.querySelectorAll('.tv-wf-row').length > 8);
  });

  it('loads the new trace and resets filters when the trace id changes', async () => {
    const { container, rerender } = await renderView();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'declined' } });
    const other = { ...ROOT, name: 'GET /other', status: 'SUCCESS' };
    net.restore();
    net = stubFetch([traceRoute(other)]);
    rerender(React.createElement(TraceView, { traceId: 'trace-9', onBack: () => {} }));
    await screen.findByText('Trace ID: trace-9');
    assert.equal(screen.getByRole('heading', { level: 1 }).textContent, 'GET /other');
    assert.equal(screen.getByRole('searchbox').value, '');
    assert.equal(container.querySelector('.tv-error-banner'), null);
    assert.ok(container.querySelector('.tv-badge-success'));
  });
});
