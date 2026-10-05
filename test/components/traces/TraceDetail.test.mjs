/**
 * TraceDetail is the full-page drill-down for one trace (Waterfall, Flame
 * Graph, Trace Graph + a span panel). Guarded here:
 *  - it asks GET /traces/spans for exactly this trace id, with no time window
 *    (a window would silently drop spans), and shows loading / error / empty;
 *  - the waterfall draws the parent→child tree the backend's flat span list
 *    implies, and the span search walks matches with Enter / arrows;
 *  - clicking a span opens the panel, whose tabs read the JSON-TEXT `events`
 *    and `links` columns OpenObserve stores, and whose View Logs hands the
 *    trace id back to the caller;
 *  - the flame graph and service graph summarise the same spans.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within, act } = await import('@testing-library/react');
const { default: TraceDetail } = await import('../../../src/components/traces/TraceDetail.jsx');
const { formatSpanClock, formatSpanTimestamp } = await import('../../../src/components/traces/traceTree.js');

const T0 = 1_700_000_000_000_000_000; // ns
const ms = (n) => n * 1_000_000; // ms → ns

const span = (id, parent, name, service, startMs, durMs, extra = {}) => ({
  traceId: 'trace-1',
  raw: {
    span_id: id,
    trace_id: 'trace-1',
    reference_parent_span_id: parent,
    operation_name: name,
    service_name: service,
    span_kind: extra.kind ?? '2',
    span_status: extra.status ?? 'OK',
    http_status_code: extra.http,
    start_time: T0 + ms(startMs),
    end_time: T0 + ms(startMs + durMs),
    duration: durMs * 1000,
    events: extra.events,
    links: extra.links,
    ...(extra.attrs || {}),
  },
});

const SPANS = [
  span('root1', null, 'GET /orders', 'gateway', 0, 100, { http: 200, attrs: { 'http.method': 'GET', retries: 2, cached: false, note: null } }),
  span('child1', 'root1', 'SELECT orders', 'orders-db', 10, 30, {
    kind: '3',
    status: 'ERROR',
    events: JSON.stringify([
      { name: 'exception', 'exception.message': 'timeout' },
      { name: 'retry', attempt: 1 },
    ]),
    links: JSON.stringify([{ trace_id: 'other-trace' }]),
  }),
  span('child2', 'root1', 'POST /billing', 'billing', 50, 40, { kind: '3', http: 502 }),
  span('grand1', 'child2', 'charge card', 'billing', 55, 20, { kind: '1' }),
];

const renderDetail = (props = {}) => {
  const back = [];
  const logs = [];
  const utils = render(React.createElement(TraceDetail, {
    traceId: 'trace-1',
    onBack: () => back.push(true),
    onViewLogs: (id) => logs.push(id),
    ...props,
  }));
  return { ...utils, back, logs };
};

const rowByName = (name) => screen.getAllByRole('button').find(
  (b) => b.classList.contains('td-row') && within(b).queryByTitle(name, { selector: '.td-row-name' }),
);

describe('TraceDetail', () => {
  let net;
  afterEach(() => { cleanup(); net?.restore(); net = null; });

  it('fetches the spans of this trace only, without a time window', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    renderDetail();
    assert.ok(screen.getByText('Loading trace…'));
    await screen.findByRole('heading', { name: 'GET /orders' });
    assert.equal(net.calls.length, 1);
    const url = new URL(net.calls[0].url, 'http://x');
    assert.match(url.pathname, /\/traces\/spans$/);
    assert.equal(url.searchParams.get('traceId'), 'trace-1');
    assert.equal(url.searchParams.get('size'), '1000');
    assert.equal(url.searchParams.get('startTime'), null);
    assert.equal(url.searchParams.get('endTime'), null);
  });

  it('shows the header counts and the span tree in depth-first order', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    assert.ok(screen.getByText('4 spans'));
    assert.ok(screen.getByText('1 error'));
    const names = [...container.querySelectorAll('.td-row-name')].map((n) => n.textContent);
    assert.deepEqual(names, ['GET /orders', 'SELECT orders', 'POST /billing', 'charge card']);
    // Child-count badge on the root, HTTP pill on the failing billing call.
    assert.equal(container.querySelector('.td-row-kids').textContent, '2');
    const bad = [...container.querySelectorAll('.td-http')].find((e) => e.textContent === '502');
    assert.ok(bad.classList.contains('is-bad'));
    // Kind letters: server, client, client, internal.
    assert.deepEqual([...container.querySelectorAll('.td-kind')].map((k) => k.textContent), ['s', 'c', 'c', 'i']);
    // Axis spans the whole 100ms trace.
    assert.deepEqual([...container.querySelectorAll('.td-wf-header .td-axis-tick')].map((t) => t.textContent),
      ['0.00ns', '25.00ms', '50.00ms', '75.00ms', '100.00ms']);
  });

  it('back and close both call onBack; head View Logs passes the trace id', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const { back, logs } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    assert.equal(back.length, 2);
    fireEvent.click(screen.getByRole('button', { name: 'View Logs' }));
    assert.deepEqual(logs, ['trace-1']);
  });

  it('hides View Logs when the caller gives no handler', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    renderDetail({ onViewLogs: undefined });
    await screen.findByRole('heading', { name: 'GET /orders' });
    assert.equal(screen.queryByRole('button', { name: 'View Logs' }), null);
  });

  it('reports a failed request with a way back', async () => {
    net = stubFetch([[/\/traces\/spans/, { status: 500, body: { message: 'boom' } }]]);
    const origError = console.error;
    console.error = () => {};
    try {
      const { back } = renderDetail();
      await screen.findByText('HTTP error! status: 500');
      fireEvent.click(screen.getByRole('button', { name: '← Back' }));
      assert.equal(back.length, 1);
    } finally { console.error = origError; }
  });

  it('says traces need OpenObserve when the backend does not support them', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: [], supported: false }]]);
    renderDetail();
    await screen.findByText('Traces require the OpenObserve backend.');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('says so when the trace has no spans', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: [] }]]);
    renderDetail();
    await screen.findByText('No spans found for this trace.');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('search counts matches and steps through them with Enter and the arrows', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    const box = screen.getByRole('textbox', { name: 'Search in spans' });
    assert.ok(screen.getByText('0 / 0'));
    assert.equal(screen.getByRole('button', { name: 'Next match' }).disabled, true);
    fireEvent.change(box, { target: { value: 'billing' } }); // service match on two spans
    assert.ok(screen.getByText('1 / 2'));
    assert.equal(container.querySelectorAll('.td-row.is-match').length, 2);

    fireEvent.keyDown(box, { key: 'Enter' });
    assert.ok(screen.getByText('2 / 2'));
    assert.ok(rowByName('charge card').classList.contains('is-selected'));

    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    assert.ok(screen.getByText('1 / 2'));
    assert.ok(rowByName('POST /billing').classList.contains('is-selected'));

    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    assert.ok(screen.getByText('2 / 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    assert.ok(screen.getByText('1 / 2'));

    // A span id is searchable too.
    fireEvent.change(box, { target: { value: 'GRAND1' } });
    assert.ok(screen.getByText('1 / 1'));
  });

  it('shows each span request and response time in front of its bar', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });

    const header = container.querySelector('.td-wf-header');
    assert.deepEqual(
      [...header.querySelectorAll('.td-wf-timelabel')].map((h) => h.textContent.trim()),
      ['Request', 'Response'],
    );

    // Every row carries both stamps, in the same grid as the header.
    const rows = container.querySelectorAll('.td-row');
    assert.equal(rows.length, SPANS.length);
    rows.forEach((r) => assert.equal(r.querySelectorAll('.td-row-time').length, 2));

    // charge card starts 55 ms into the trace and lasts 20 ms.
    const [req, res] = rowByName('charge card').querySelectorAll('.td-row-time');
    assert.equal(req.textContent.trim(), formatSpanClock(T0 + ms(55)));
    assert.equal(res.textContent.trim(), formatSpanClock(T0 + ms(75)));
    assert.notEqual(req.textContent, res.textContent);
    // The tooltip keeps the date and microseconds the short clock drops.
    assert.equal(req.title, `Request: ${formatSpanTimestamp(T0 + ms(55))}`);
    assert.equal(res.title, `Response: ${formatSpanTimestamp(T0 + ms(75))}`);
  });

  it('opens the span panel on click / keyboard and closes it again', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const { container, logs } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    fireEvent.click(rowByName('GET /orders'));
    const panel = container.querySelector('.td-span');
    assert.ok(panel);
    assert.equal(panel.querySelector('.td-span-title').textContent, 'GET /orders');
    const chips = [...panel.querySelectorAll('.td-chip')].map((c) => c.textContent);
    // Request/Response are wall-clock and so time-zone dependent: derive them.
    assert.deepEqual(chips, [
      'Servicegateway', 'Duration100.00ms', 'Start0.00ns', 'KindServer',
      `Request${formatSpanTimestamp(T0)}`, `Response${formatSpanTimestamp(T0 + ms(100))}`,
    ]);

    // JSON mode lists scalar attributes sorted by key, typed by class.
    const keys = [...panel.querySelectorAll('.oo-json-key')].map((k) => k.textContent);
    assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)));
    assert.ok(keys.includes('http.method'));
    const retries = [...panel.querySelectorAll('.td-json-line')].find((l) => l.textContent.startsWith('▾retries'));
    assert.ok(retries.querySelector('.oo-json-num'));
    const cached = [...panel.querySelectorAll('.td-json-line')].find((l) => l.textContent.startsWith('▾cached'));
    assert.ok(cached.querySelector('.oo-json-bool'));
    const noteLine = [...panel.querySelectorAll('.td-json-line')].find((l) => l.textContent.startsWith('▾note'));
    assert.ok(noteLine.querySelector('.oo-json-null'));

    // Table mode shows the same attributes as rows with a copy button each.
    fireEvent.click(within(panel).getByRole('button', { name: 'Table' }));
    assert.ok(within(panel).getByRole('button', { name: 'Copy http.method' }));
    const methodRow = [...panel.querySelectorAll('.td-kv-row')].find((r) => r.querySelector('.td-kv-key').textContent === 'http.method');
    assert.equal(methodRow.querySelector('.td-kv-val').textContent, 'GET');

    // No events / exceptions / links on the root.
    fireEvent.click(within(panel).getByRole('tab', { name: 'Events' }));
    assert.ok(within(panel).getByText('No events on this span.'));
    fireEvent.click(within(panel).getByRole('tab', { name: 'Exceptions' }));
    assert.ok(within(panel).getByText('No exceptions on this span.'));
    fireEvent.click(within(panel).getByRole('tab', { name: 'Links' }));
    assert.ok(within(panel).getByText('No links on this span.'));

    // Panel View Logs sends the span's trace id.
    fireEvent.click(within(panel).getByRole('button', { name: 'View Logs' }));
    assert.deepEqual(logs, ['trace-1']);

    fireEvent.click(screen.getByRole('button', { name: 'Close span' }));
    assert.equal(container.querySelector('.td-span'), null);

    // Keyboard: Enter selects, Space toggles it off again.
    fireEvent.keyDown(rowByName('SELECT orders'), { key: 'Enter' });
    assert.equal(container.querySelector('.td-span-title').textContent, 'SELECT orders');
    fireEvent.keyDown(rowByName('SELECT orders'), { key: ' ' });
    assert.equal(container.querySelector('.td-span'), null);
    fireEvent.keyDown(rowByName('SELECT orders'), { key: 'a' });
    assert.equal(container.querySelector('.td-span'), null);
    // Clicking the selected row again deselects it.
    fireEvent.click(rowByName('POST /billing'));
    fireEvent.click(rowByName('POST /billing'));
    assert.equal(container.querySelector('.td-span'), null);
  });

  it('parses the JSON-text events and links into their tabs, exceptions filtered out', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    fireEvent.click(rowByName('SELECT orders'));
    const panel = container.querySelector('.td-span');
    assert.equal(within(panel).getByRole('tab', { name: /Events/ }).textContent, 'Events2');
    assert.equal(within(panel).getByRole('tab', { name: /Exceptions/ }).textContent, 'Exceptions1');
    assert.equal(within(panel).getByRole('tab', { name: /Links/ }).textContent, 'Links1');

    fireEvent.click(within(panel).getByRole('tab', { name: /Events/ }));
    assert.deepEqual([...panel.querySelectorAll('.td-sub-head')].map((h) => h.textContent), ['exception', 'retry']);
    assert.ok(within(panel).getByText('timeout'));

    fireEvent.click(within(panel).getByRole('tab', { name: /Exceptions/ }));
    const heads = [...panel.querySelectorAll('.td-sub-head')];
    assert.deepEqual(heads.map((h) => h.textContent), ['exception']);
    assert.ok(heads[0].classList.contains('td-sub-head--error'));

    fireEvent.click(within(panel).getByRole('tab', { name: /Links/ }));
    assert.ok(within(panel).getByText('link 1'));
    assert.ok(within(panel).getByText('other-trace'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Table' }));
    assert.ok(within(panel).getByRole('button', { name: 'Copy trace_id' }));
  });

  it('copy buttons write to the clipboard and confirm with a tick', async (t) => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const written = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (s) => { written.push(s); } },
    });
    t.after(() => { delete window.navigator.clipboard; });
    renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const btn = screen.getByRole('button', { name: 'Copy trace id' });
    await act(async () => { fireEvent.click(btn); });
    assert.deepEqual(written, ['trace-1']);
    assert.equal(btn.textContent, '✓');
    await act(async () => { t.mock.timers.tick(1800); });
    assert.equal(btn.textContent, '⧉');
    t.mock.timers.reset();
  });

  it('a blocked clipboard leaves the copy button unchanged', async (t) => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
    t.after(() => { delete window.navigator.clipboard; });
    renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    const btn = screen.getByRole('button', { name: 'Copy trace id' });
    await act(async () => { fireEvent.click(btn); });
    assert.equal(btn.textContent, '⧉');
  });

  it('flame graph stacks spans by depth; clicking a bar selects it back in the waterfall', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    fireEvent.click(screen.getByRole('tab', { name: 'Flame Graph' }));
    assert.equal(screen.queryByRole('textbox', { name: 'Search in spans' }), null);
    assert.ok(screen.getByText('3 depth'));
    const rows = [...container.querySelectorAll('.td-flame-row')].map((r) => [...r.querySelectorAll('.td-flame-label')].map((l) => l.textContent));
    assert.deepEqual(rows, [['GET /orders'], ['SELECT orders', 'POST /billing'], ['charge card']]);
    fireEvent.click(screen.getByTitle('billing · charge card — 20.00ms'));
    assert.equal(screen.getByRole('tab', { name: 'Waterfall' }).getAttribute('aria-selected'), 'true');
    assert.equal(container.querySelector('.td-span-title').textContent, 'charge card');
  });

  it('trace graph lists services by time and the calls between them', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: SPANS }]]);
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    fireEvent.click(screen.getByRole('tab', { name: 'Trace Graph' }));
    const services = [...container.querySelectorAll('.td-node')].map((n) => n.textContent);
    assert.deepEqual(services, [
      'gateway1 span · 100.00ms',
      'billing2 spans · 60.00ms',
      'orders-db1 span · 30.00ms · 1 error',
    ]);
    const edges = [...container.querySelectorAll('.td-edge')].map((e) => e.textContent);
    assert.deepEqual(edges.sort(), ['gateway→billing1 call', 'gateway→orders-db1 call']);
  });

  it('trace graph explains a single-service trace has no edges', async () => {
    net = stubFetch([[/\/traces\/spans/, { items: [SPANS[0]] }]]);
    renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    assert.ok(screen.getByText('1 span'));
    assert.ok(screen.getByText('0 errors'));
    fireEvent.click(screen.getByRole('tab', { name: 'Trace Graph' }));
    assert.ok(screen.getByText(/no\s+cross-service calls to draw/));
  });

  it('refetches when the trace id changes', async () => {
    net = stubFetch([[/\/traces\/spans/, (url) => ({
      items: url.includes('trace-2') ? [span('x', null, 'other root', 'svc', 0, 5)] : SPANS,
    })]]);
    const { rerender } = renderDetail();
    await screen.findByRole('heading', { name: 'GET /orders' });
    rerender(React.createElement(TraceDetail, { traceId: 'trace-2', onBack: () => {} }));
    await screen.findByRole('heading', { name: 'other root' });
    assert.equal(net.calls.length, 2);
    await waitFor(() => assert.ok(net.calls[1].url.includes('traceId=trace-2')));
  });
});
