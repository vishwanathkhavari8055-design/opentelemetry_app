/**
 * TraceTreeNode renders one row of the trace tree (and, recursively, its
 * children). Guarded here, because each is what a user reads the tree for:
 *  - span rows: HTTP direction / method / status pills (method not repeated in
 *    the name), the type-aware inline preview (SQL text, Cypher on one line,
 *    Redis command, Class.method(), full URL), HTTP-derived status, duration;
 *  - group and thread rows: count, total duration, expand chevron;
 *  - a click selects the row, expands a row with children, and — for log rows
 *    only — toggles the inline message/payload;
 *  - log rows: severity, service, repeat count, offset, abbreviated source,
 *    clamping of long messages, and "copy" (Clipboard API or fallback);
 *  - Logs-by-span mode adds the span-id column and the parent chip.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react');
const { default: TraceTreeNode } = await import('../../../src/components/TraceTreeNode.jsx');

const renderNode = (node, props = {}) => {
  const calls = { select: [], expand: [], detail: [] };
  const utils = render(React.createElement(TraceTreeNode, {
    node,
    level: 0,
    isExpanded: node.isExpanded,
    isDetailOpen: node.isDetailOpen,
    onSelectNode: (u) => calls.select.push(u),
    onToggleExpanded: (u) => calls.expand.push(u),
    onToggleDetail: (u) => calls.detail.push(u),
    selectedNodeUid: null,
    openDetailIds: new Set(),
    index: 0,
    ...props,
  }));
  return { ...utils, calls };
};

const TS = '2026-03-04T05:06:07.089Z';

describe('TraceTreeNode — span rows', () => {
  afterEach(cleanup);

  it('shows an HTTP span with direction, method and status pills, name without the method', () => {
    const { container } = renderNode({
      uid: 'h', type: 'HTTP', name: 'POST /api/orders', httpMethod: 'post', httpStatus: 404,
      direction: 'INCOMING', endpoint: 'http://svc/api/orders?id=9', serviceName: 'ORDERSERVICE',
      durationMs: 12, timestamp: TS, children: [],
    });
    const op = container.querySelector('.tv-op-name');
    assert.equal(op.querySelector('.tv-http-dir').textContent, '↓ IN');
    assert.equal(op.querySelector('.tv-http-method').textContent, 'POST');
    assert.ok(op.querySelector('.tv-http-method').classList.contains('tv-http-method-post'));
    assert.equal(op.querySelector('.tv-http-status').textContent, '404');
    assert.ok(op.querySelector('.tv-http-status').classList.contains('tv-http-status-warn'));
    assert.ok(op.textContent.includes('/api/orders') && !op.textContent.includes('POST /api'));
    // URL not already in the name → shown as the inline preview.
    assert.equal(container.querySelector('.tv-op-sub').textContent, 'http://svc/api/orders?id=9');
    assert.equal(container.querySelector('.tv-cell-status').textContent, 'WARN');
    assert.equal(container.querySelector('.tv-cell-dur').textContent, '12 ms');
    assert.equal(container.querySelector('.tv-cell-type').textContent, 'HTTP');
    assert.notEqual(container.querySelector('.tv-cell-service').textContent, '-');
    assert.match(container.querySelector('.tv-cell-time').textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.089$/);
    // A leaf span shows a dot, not a chevron, and has no SPAN ID column.
    assert.equal(container.querySelector('.tv-chevron').textContent, '·');
    assert.equal(container.querySelector('.tv-cell-span'), null);
  });

  it('colours each HTTP method and status bucket', () => {
    const cases = [
      ['GET', 200, 'OUTGOING', 'tv-http-method-get', 'tv-http-status-success', '↑ OUT'],
      ['PUT', 302, 'OUTGOING', 'tv-http-method-put', 'tv-http-status-info', '↑ OUT'],
      ['DELETE', 500, 'X', 'tv-http-method-delete', 'tv-http-status-error', '?'],
      ['TRACE', 'abc', 'X', 'tv-http-method-other', 'tv-http-status-unknown', '?'],
    ];
    for (const [m, s, dir, mCls, sCls, dirText] of cases) {
      const { container } = renderNode({ uid: m, type: 'http', name: `${m} /x`, httpMethod: m, httpStatus: s, direction: dir, url: '/x' });
      assert.ok(container.querySelector('.tv-http-method').classList.contains(mCls), m);
      assert.ok(container.querySelector('.tv-http-status').classList.contains(sCls), m);
      assert.equal(container.querySelector('.tv-http-dir').textContent, dirText);
      // name already contains the URL → no duplicate preview
      assert.equal(container.querySelector('.tv-op-sub'), null);
      cleanup();
    }
  });

  it('previews the query or command inline for each data-store type', () => {
    const cases = [
      [{ type: 'SQL', name: 'SELECT', dbStatement: 'SELECT * FROM orders' }, 'SELECT * FROM orders'],
      [{ type: 'MONGODB', name: 'find', query: '{"a":1}' }, '{"a":1}'],
      [{ type: 'NEO4J', name: 'MATCH', statement: 'MATCH (n)\n  RETURN n\n' }, 'MATCH (n) RETURN n'],
      [{ type: 'REDIS', name: 'GET', command: 'GET user:1' }, 'GET user:1'],
      [{ type: 'INTERNAL', name: 'work', className: 'OrderService', methodName: 'place' }, 'OrderService.place()'],
      [{ type: 'OTHER', name: 'x', target: 'db.orders' }, 'db.orders'],
      [{ type: 'OTHER', name: 'x', description: 'described' }, 'described'],
    ];
    for (const [node, text] of cases) {
      const { container } = renderNode({ uid: node.type, ...node });
      assert.equal(container.querySelector('.tv-op-sub').textContent, text, node.type);
      cleanup();
    }
    // Suppressed when it would repeat the title, or has nothing to show.
    for (const node of [
      { type: 'INTERNAL', name: 'OrderService.place()', className: 'OrderService', methodName: 'place' },
      { type: 'NEO4J', name: 'MATCH' },
      { type: 'INTERNAL', name: 'work' },
    ]) {
      const { container } = renderNode({ uid: 'n', ...node });
      assert.equal(container.querySelector('.tv-op-sub'), null, node.name);
      cleanup();
    }
  });

  it('a span row with children: click selects and expands; children render when expanded', () => {
    const child = { uid: 'c1', type: 'SQL', name: 'SELECT 1', status: 'ERROR', durationMs: 2 };
    const parent = {
      uid: 'p', type: 'INTERNAL', name: 'handle', status: 'SUCCESS', children: [child], isExpanded: false,
    };
    const { container, calls, rerender } = renderNode(parent);
    assert.equal(container.querySelector('.tv-chevron').textContent, '▶');
    assert.ok(container.querySelector('.tv-row').classList.contains('tv-row-clickable'));
    assert.equal(screen.queryByText('SELECT 1'), null);
    fireEvent.click(container.querySelector('.tv-row'));
    assert.deepEqual(calls.select, ['p']);
    assert.deepEqual(calls.expand, ['p']);
    assert.deepEqual(calls.detail, []); // span detail lives in the inspector, not inline

    rerender(React.createElement(TraceTreeNode, {
      node: parent, level: 0, isExpanded: true, onSelectNode: () => {}, onToggleExpanded: () => {},
      onToggleDetail: () => {}, selectedNodeUid: 'c1', openDetailIds: new Set(),
    }));
    assert.equal(container.querySelector('.tv-chevron').textContent, '▼');
    const rows = container.querySelectorAll('.tv-row');
    assert.equal(rows.length, 2);
    assert.ok(rows[1].classList.contains('tv-row-selected'));
    assert.ok(container.querySelector('.tv-connector'));
    assert.equal(rows[1].querySelector('.tv-cell-status').textContent, 'ERROR');
  });

  it('a group row shows its type, count and total duration', () => {
    const { container, calls } = renderNode({
      uid: 'g', isGroup: true, type: 'SQL', name: 'SQL Queries', count: 3, durationMs: 4.5,
      status: 'WARN', children: [],
    });
    assert.equal(container.querySelector('.tv-op-text .tv-group-count').textContent, ' (3)');
    assert.equal(container.querySelector('.tv-op-sub').textContent, 'Total Duration: 4.500 ms');
    assert.equal(container.querySelector('.tv-cell-op .tv-type-badge').textContent, 'SQL');
    assert.equal(container.querySelector('.tv-cell-type').textContent, '');
    assert.equal(container.querySelector('.tv-sev-dot'), null);
    fireEvent.click(container.querySelector('.tv-row'));
    assert.deepEqual(calls.expand, ['g']); // groups toggle even when empty
  });

  it('a thread row names its service; Logs-by-span adds span id and parent chip', () => {
    const { container } = renderNode({
      uid: 't', isGroup: true, type: 'THREAD', name: 'thread: exec-1', serviceName: 'ORDERSERVICE',
      count: 1, children: [], timestamp: null,
    }, { showSpanId: true });
    assert.ok(container.querySelector('.tv-thread-service-inline').textContent.startsWith('('));
    assert.equal(container.querySelector('.tv-cell-time').textContent, '-');
    assert.equal(container.querySelector('.tv-cell-span').textContent, '-');
    cleanup();

    const again = renderNode({
      uid: 's', type: 'INTERNAL', name: 'work', spanId: '0123456789abcdef0123', _parentName: 'root op',
      timestamp: 1_767_323_045_678_000,
    }, { showSpanId: true });
    assert.equal(again.container.querySelector('.tv-span-id').textContent, '0123456789abcdef');
    assert.equal(again.container.querySelector('.tv-parent-chip').textContent, '↳ root op');
    assert.match(again.container.querySelector('.tv-cell-time').textContent, /\.678$/);
    assert.equal(again.container.querySelector('.tv-cell-status').textContent, '-');
    assert.equal(again.container.querySelector('.tv-cell-dur').textContent, '-');
    assert.equal(again.container.querySelector('.tv-cell-service').textContent, '-');
  });

  it('shows "-" for timestamps it cannot parse', () => {
    for (const ts of ['not-a-date', 'Tgarbage']) {
      const { container } = renderNode({ uid: ts, type: 'INTERNAL', name: 'x', timestamp: ts });
      assert.equal(container.querySelector('.tv-cell-time').textContent, '-');
      cleanup();
    }
  });
});

describe('TraceTreeNode — log rows', () => {
  afterEach(cleanup);

  const LOG = {
    uid: 'log1', type: 'LOG', severity: 'warn', serviceName: 'ORDERSERVICE',
    fullMessage: 'order placed', actualOperation: '{"orderId":7}', count: 3,
    relativeTimeMs: 4.25, className: 'com.trinity.orders.OrderService', methodName: 'place',
    lineNumber: 42, timestamp: TS, spanId: 'span-1',
  };

  it('shows severity, service, repeat count, offset and the abbreviated source', () => {
    const { container } = renderNode(LOG);
    assert.equal(container.querySelector('.tv-badge').textContent, 'WARN');
    assert.ok(container.querySelector('.tv-badge').classList.contains('tv-badge-warn'));
    assert.ok(container.querySelector('.tv-log-service'));
    assert.equal(container.querySelector('.tv-log-repeat').textContent, '×3');
    assert.equal(container.querySelector('.tv-log-offset').textContent, '+4.25 ms');
    const src = container.querySelector('.tv-log-source');
    assert.equal(src.textContent, 'c.t.o.OrderService.place():42');
    assert.equal(src.title, 'com.trinity.orders.OrderService.place():42');
    assert.equal(container.querySelector('.tv-log-message').textContent, 'order placed');
    // Payload differs from the message → row is expandable.
    assert.equal(container.querySelector('.tv-log-expand-hint').textContent, '▶ expand');
    assert.equal(container.querySelector('.tv-log-payload'), null);
  });

  it('click selects the log and toggles its inline detail; open detail shows the payload', () => {
    const { container, calls, rerender } = renderNode(LOG);
    fireEvent.click(container.querySelector('.tv-log-row'));
    assert.deepEqual(calls.select, ['log1']);
    assert.deepEqual(calls.detail, ['log1']);
    assert.deepEqual(calls.expand, []);
    rerender(React.createElement(TraceTreeNode, {
      node: LOG, level: 1, isDetailOpen: true, selectedNodeUid: 'log1', showSpanId: true,
      onSelectNode: () => {}, onToggleExpanded: () => {}, onToggleDetail: () => {}, openDetailIds: new Set(['log1']),
    }));
    const row = container.querySelector('.tv-log-row');
    assert.ok(row.classList.contains('tv-log-row-selected'));
    assert.ok(row.classList.contains('tv-log-row-focused'));
    assert.equal(container.querySelector('.tv-log-payload').textContent, '{\n  "orderId": 7\n}');
    assert.equal(container.querySelector('.tv-log-expand-hint').textContent, '▼ collapse');
    assert.equal(container.querySelector('.tv-span-id').textContent, 'span-1');
  });

  it('clamps a long message until opened, with a looser limit in Logs-by-span mode', () => {
    const multi = { uid: 'l2', type: 'LOG', status: 'error', message: 'line one\nline two', children: [] };
    const { container } = renderNode(multi);
    assert.ok(container.querySelector('.tv-log-message').classList.contains('tv-log-message-clamped'));
    assert.equal(container.querySelector('.tv-badge').textContent, 'ERROR');
    cleanup();
    const inSpanMode = renderNode(multi, { showSpanId: true });
    assert.ok(!inSpanMode.container.querySelector('.tv-log-message').classList.contains('tv-log-message-clamped'));
    assert.equal(inSpanMode.container.querySelector('.tv-log-expand-hint'), null);
    cleanup();
    const huge = renderNode({ ...multi, message: 'x'.repeat(700) }, { showSpanId: true });
    assert.ok(huge.container.querySelector('.tv-log-message').classList.contains('tv-log-message-clamped'));
  });

  it('renders a log with no fields as a bare LOG entry, and its children when expanded', () => {
    const { container } = renderNode({
      uid: 'l3', type: 'LOG', lineNumber: 0, isExpanded: true,
      children: [{ uid: 'l3c', type: 'LOG', severity: 'debug', message: 'nested' }],
    });
    const badges = [...container.querySelectorAll('.tv-badge')].map((b) => b.textContent);
    assert.deepEqual(badges, ['LOG', 'DEBUG']);
    assert.equal(container.querySelector('.tv-log-source').textContent, ':0');
    assert.ok(screen.getByText('nested'));
  });

  it('copy writes a header + message + payload block via the fallback, and confirms', (t) => {
    let copied = null;
    document.execCommand = () => { copied = document.querySelector('textarea').value; return true; };
    t.after(() => { delete document.execCommand; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { calls } = renderNode(LOG);
    fireEvent.click(screen.getByRole('button', { name: '⧉ copy' }));
    const lines = copied.split('\n');
    assert.match(lines[0], /\.089 {2}WARN {2}\S/);
    assert.deepEqual(lines.slice(1), ['order placed', '{"orderId":7}']);
    assert.deepEqual(calls.select, [], 'copy must not select or expand the row');
    assert.ok(screen.getByRole('button', { name: '✓ copied' }));
    act(() => { t.mock.timers.tick(1400); });
    assert.ok(screen.getByRole('button', { name: '⧉ copy' }));
    t.mock.timers.reset();
  });

  it('copy uses the Clipboard API on a secure origin', async (t) => {
    const written = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true, value: { writeText: async (s) => { written.push(s); } },
    });
    window.isSecureContext = true;
    t.after(() => { delete window.navigator.clipboard; delete window.isSecureContext; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    renderNode({ uid: 'l4', type: 'LOG', message: 'hello', severity: 'info' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '⧉ copy' })); });
    assert.equal(written.length, 1);
    assert.match(written[0], /INFO\nhello$/);
    assert.ok(screen.getByRole('button', { name: '✓ copied' }));
    act(() => { t.mock.timers.tick(1400); });
    t.mock.timers.reset();
  });
});
