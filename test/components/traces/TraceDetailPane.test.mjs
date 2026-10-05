/**
 * TraceDetailPane is the inspector on the right of the trace tree. Guarded:
 *  - with nothing selected it invites a click instead of rendering blank;
 *  - it shows the span's real payload (full SQL / URL), pretty-printed bodies,
 *    an HTTP-derived status, attributes, and a per-type children summary;
 *  - the exception stack stays collapsed until asked for;
 *  - "copy as cURL" appears only for HTTP spans and copies a runnable command,
 *    through the Clipboard API or the textarea fallback;
 *  - × dismisses the pane.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, act, within } = await import('@testing-library/react');
const { default: TraceDetailPane } = await import('../../../src/components/TraceDetailPane.jsx');

const HTTP_NODE = {
  name: 'POST /api/orders',
  type: 'http',
  direction: 'OUTGOING',
  httpMethod: 'POST',
  httpStatus: 503,
  endpoint: 'http://svc/api/orders?x=1',
  httpRequestBody: '{"id":1}',
  httpResponseBody: '[1,2]',
  serviceName: 'ORDERSERVICE',
  spanId: 'abc123',
  durationMs: 12.3456,
  timestamp: '2026-01-02T03:04:05.678Z',
  children: [
    { type: 'SQL', durationMs: 5, children: [{ type: 'LOG', durationMs: 0 }] },
    { isGroup: true, children: [{ type: 'SQL', durationMs: 2 }] },
    { type: 'HTTP', durationMs: 1 },
  ],
};

describe('TraceDetailPane', () => {
  afterEach(cleanup);

  it('invites a click when no span is selected', () => {
    render(React.createElement(TraceDetailPane, { node: null }));
    assert.ok(screen.getByText('Click a span to inspect'));
  });

  it('shows payload, bodies, status, attributes and a children summary for an HTTP span', () => {
    const { container } = render(React.createElement(TraceDetailPane, { node: HTTP_NODE }));
    assert.equal(screen.getByRole('heading').textContent, 'POST /api/orders');
    assert.equal(container.querySelector('.tv-inspector-type-badge').textContent, 'HTTP');
    assert.ok(screen.getByText('↑ OUT'));
    assert.ok(screen.getByText('ERROR')); // 503 → ERROR even without span status
    assert.ok(screen.getByText('12.35 ms'));
    assert.ok(screen.getByTitle('Start time').textContent.endsWith('.678'));

    const codes = [...container.querySelectorAll('.tv-inspector-code')].map((c) => c.textContent);
    assert.equal(codes[0], 'http://svc/api/orders?x=1');
    assert.equal(codes[1], '{\n  "id": 1\n}');
    assert.equal(codes[2], '[\n  1,\n  2\n]');

    const dts = [...container.querySelectorAll('dt')].map((d) => d.textContent);
    assert.deepEqual(dts, ['Span ID', 'Service', 'Direction', 'HTTP Method', 'HTTP Status', 'Endpoint']);
    assert.notEqual(within(container.querySelector('dl')).getByTitle('ORDERSERVICE').textContent, 'ORDERSERVICE');

    assert.ok(screen.getByText('Children (4)'));
    const kids = [...container.querySelectorAll('.tv-inspector-children li')].map((li) => li.textContent);
    assert.deepEqual(kids, ['SQL×27.00 ms', 'HTTP×11.00 ms', 'LOG×10.00 ms']);
  });

  it('labels inbound and unknown directions, and hides payload equal to the title', () => {
    const { rerender } = render(React.createElement(TraceDetailPane, {
      node: { name: 'doWork', operation: 'doWork', direction: 'INCOMING', status: 'warn' },
    }));
    assert.ok(screen.getByText('↓ IN'));
    assert.ok(screen.getByText('WARN'));
    assert.equal(screen.queryByText('Actual Operation'), null);
    assert.equal(screen.queryByRole('button', { name: /cURL/ }), null);
    rerender(React.createElement(TraceDetailPane, { node: { operation: 'x', direction: 'SIDEWAYS' } }));
    assert.ok(screen.getByText('?'));
    rerender(React.createElement(TraceDetailPane, { node: { direction: 'SIDEWAYS', timestamp: 'bogus' } }));
    assert.ok(screen.getByText('(unnamed)'));
    assert.equal(screen.getByTitle('Start time').textContent, '-');
  });

  it('formats epoch-microsecond timestamps and SQL payloads', () => {
    render(React.createElement(TraceDetailPane, {
      node: { name: 'SELECT', type: 'SQL', dbStatement: 'SELECT * FROM t', timestamp: 1_767_323_045_678_000, status: 'debug' },
    }));
    assert.ok(screen.getByText('Actual Operation'));
    assert.ok(screen.getAllByText('SELECT * FROM t').length >= 1);
    assert.match(screen.getByTitle('Start time').textContent, /\.678$/);
    assert.ok(screen.getByText('DEBUG'));
  });

  it('keeps the stack trace collapsed until asked for', () => {
    render(React.createElement(TraceDetailPane, {
      node: {
        name: 'boom', exceptionType: 'java.lang.IllegalStateException', exceptionMessage: 'bad',
        stackTrace: 'at A.b(A.java:1)', status: 'info',
      },
    }));
    assert.ok(screen.getByText('java.lang.IllegalStateException'));
    assert.ok(screen.getByText(': bad'));
    const toggle = screen.getByRole('button', { name: '▸ Show stack trace' });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(screen.queryByText('at A.b(A.java:1)'), null);
    fireEvent.click(toggle);
    assert.ok(screen.getByText('at A.b(A.java:1)'));
    fireEvent.click(screen.getByRole('button', { name: '▾ Hide stack trace' }));
    assert.equal(screen.queryByText('at A.b(A.java:1)'), null);
  });

  it('shows a stack trace section without an exception type', () => {
    render(React.createElement(TraceDetailPane, { node: { name: 'x', stackTrace: 'trace', status: 'success' } }));
    assert.ok(screen.getByRole('button', { name: '▸ Show stack trace' }));
    assert.ok(screen.getByText('SUCCESS'));
  });

  it('× dismisses the pane', () => {
    const dismissed = [];
    render(React.createElement(TraceDetailPane, { node: { name: 'x', status: 'fatal' }, onDismiss: () => dismissed.push(1) }));
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    assert.equal(dismissed.length, 1);
    cleanup();
    render(React.createElement(TraceDetailPane, { node: { name: 'x', status: 'odd' } }));
    assert.equal(screen.queryByRole('button', { name: 'Close inspector' }), null);
    assert.ok(screen.getByText('ODD').classList.contains('tv-badge-unknown'));
  });

  it('copies a runnable curl via the Clipboard API, then resets the label', async (t) => {
    const written = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true, value: { writeText: async (s) => { written.push(s); } },
    });
    window.isSecureContext = true;
    t.after(() => { delete window.navigator.clipboard; delete window.isSecureContext; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    render(React.createElement(TraceDetailPane, { node: HTTP_NODE }));
    const btn = screen.getByRole('button', { name: '⧉ copy as cURL' });
    await act(async () => { fireEvent.click(btn); });
    assert.deepEqual(written, [
      "curl -X POST 'http://svc/api/orders?x=1' -H 'Content-Type: application/json' --data-raw '{\"id\":1}'",
    ]);
    assert.equal(btn.textContent, '✓ copied');
    act(() => { t.mock.timers.tick(1400); });
    assert.equal(btn.textContent, '⧉ copy as cURL');
    t.mock.timers.reset();
  });

  it('falls back to a hidden textarea when the Clipboard API is unavailable', (t) => {
    let copied = null;
    document.execCommand = () => { copied = document.querySelector('textarea').value; return true; };
    t.after(() => { delete document.execCommand; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    render(React.createElement(TraceDetailPane, { node: { ...HTTP_NODE, httpRequestBody: null } }));
    fireEvent.click(screen.getByRole('button', { name: '⧉ copy as cURL' }));
    assert.equal(copied, "curl -X POST 'http://svc/api/orders?x=1'");
    assert.equal(document.querySelector('textarea'), null);
    assert.ok(screen.getByRole('button', { name: '✓ copied' }));
    act(() => { t.mock.timers.tick(1400); });
    t.mock.timers.reset();
  });
});
