/**
 * useServiceTelemetry tells step 1 of the alert wizard which registered services
 * are actually emitting, per signal. The rules it has to keep:
 *
 *  - logs and traces are counted SEPARATELY — a service that logs but emits no
 *    spans can never satisfy a trace query, and a merged flag would promise it can;
 *  - names are compared exactly (`IoTOpsApiSvc` and `iotopsapisvc` are two real
 *    services here), and trace discovery's placeholders are not services;
 *  - one signal failing must not blank the other;
 *  - "not told yet / failed" (loading) and "asked, nothing there" (unavailable)
 *    are different answers, and only the latter lets the UI say "absent";
 *  - a parked hook (enabled: false) neither fetches nor polls.
 *
 * Requests go to a stubbed global fetch; polling uses node:test mock timers.
 */
import '../support/dom.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const { renderHook, act, cleanup } = await import('@testing-library/react');
const {
  default: useServiceTelemetry, TELEMETRY_WINDOW, TELEMETRY_WINDOW_LABEL,
} = await import('../../src/components/alerts/wizard/useServiceTelemetry.js');

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

let calls;
let server;
const realFetch = globalThis.fetch;
let consoleError;

beforeEach(() => {
  calls = [];
  server = {
    logs: () => json({
      services: [
        { name: 'IoTOpsApiSvc', count: 10 },
        { name: 'iotopsapisvc', count: 2 },
        { name: 'unknown-service', count: 5 },
      ],
      supported: true,
    }),
    traces: () => json({
      items: [
        { serviceName: ' IoTOpsApiSvc ', requests: 40 },
        { serviceName: '-', requests: 7 },
        { serviceName: 'unknown-service', requests: 3 },
        { serviceName: '', requests: 1 },
        { serviceName: 'spanOnly' },
      ],
    }),
  };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://localhost');
    const path = u.pathname.replace('/OpentelemetryService/api', '');
    const kind = path === '/logs/services' ? 'logs' : path === '/traces/catalog' ? 'traces' : null;
    if (!kind) throw new Error(`unexpected request ${path}`);
    calls.push({ kind, params: u.searchParams, signal: opts.signal });
    return server[kind](opts.signal);
  };
  consoleError = mock.method(console, 'error', () => {});
});

afterEach(() => {
  cleanup();
  mock.timers.reset();
  consoleError.mock.restore();
  globalThis.fetch = realFetch;
  delete document.visibilityState;
});

const flush = () => act(async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
});
const count = (kind) => calls.filter((c) => c.kind === kind).length;
const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new window.Event('visibilitychange'));
};
const entries = (map) => Object.fromEntries(map);

describe('useServiceTelemetry', () => {
  it('asks both signals over the fixed 24h window', async () => {
    assert.equal(TELEMETRY_WINDOW, 'now-24h');
    assert.equal(TELEMETRY_WINDOW_LABEL, 'last 24h');
    renderHook(() => useServiceTelemetry());
    await flush();
    const logs = calls.find((c) => c.kind === 'logs').params;
    const traces = calls.find((c) => c.kind === 'traces').params;
    assert.equal(logs.get('startTime'), 'now-24h');
    assert.equal(logs.has('window'), false, 'an explicit start wins over the window');
    assert.equal(traces.get('startTime'), 'now-24h');
    assert.equal(traces.get('size'), '1000');
  });

  it('keeps per-signal counts under exact names, skipping placeholders', async () => {
    const { result } = renderHook(() => useServiceTelemetry());
    assert.equal(result.current.status, 'loading');
    await flush();

    assert.deepEqual(entries(result.current.byName), {
      IoTOpsApiSvc: { logs: 10, traces: 40 },
      iotopsapisvc: { logs: 2, traces: null },
      spanOnly: { logs: null, traces: null },
    });
    assert.deepEqual(
      [result.current.status, result.current.logsStatus, result.current.tracesStatus],
      ['ready', 'ready', 'ready'],
    );
  });

  it('reads a bare-name logs answer without counts', async () => {
    server.logs = () => json({ services: [], items: ['checkout'] });
    const { result } = renderHook(() => useServiceTelemetry());
    await flush();
    assert.deepEqual(result.current.byName.get('checkout'), { logs: null, traces: null });
  });

  it('does not let a failed trace query blank the logs answer', async () => {
    server.traces = () => json({}, 500);
    const { result } = renderHook(() => useServiceTelemetry());
    await flush();
    assert.equal(result.current.logsStatus, 'ready');
    assert.equal(result.current.tracesStatus, 'loading', 'a rejection is "not told", not "absent"');
    assert.equal(result.current.status, 'ready', 'one answer is enough to conclude');
    assert.deepEqual(result.current.byName.get('IoTOpsApiSvc'), { logs: 10, traces: null });
  });

  it('reports "unavailable" only when both signals answered with nothing', async () => {
    server.logs = () => json({ services: [] });
    server.traces = () => json({ items: [] });
    const { result } = renderHook(() => useServiceTelemetry());
    await flush();
    assert.deepEqual(
      [result.current.status, result.current.logsStatus, result.current.tracesStatus],
      ['unavailable', 'unavailable', 'unavailable'],
    );
    assert.equal(result.current.byName.size, 0);
  });

  it('stays "loading" while one signal is unanswered and the other is empty', async () => {
    server.logs = () => json({}, 503);
    server.traces = () => json({});
    const { result } = renderHook(() => useServiceTelemetry());
    await flush();
    assert.equal(result.current.logsStatus, 'loading');
    assert.equal(result.current.tracesStatus, 'unavailable');
    assert.equal(result.current.status, 'loading');
  });

  it('re-asks on reload', async () => {
    const { result } = renderHook(() => useServiceTelemetry());
    await flush();
    server.traces = () => json({ items: [{ serviceName: 'newcomer', requests: 1 }] });
    act(() => result.current.reload());
    await flush();
    assert.equal(count('logs'), 2);
    assert.deepEqual(result.current.byName.get('newcomer'), { logs: null, traces: 1 });
  });

  it('a parked hook neither fetches nor polls', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const { result } = renderHook(() => useServiceTelemetry({ enabled: false }));
    await flush();
    act(() => mock.timers.tick(300_000));
    act(() => setVisibility('visible'));
    await flush();
    assert.equal(calls.length, 0);
    assert.equal(result.current.status, 'loading');
  });

  it('polls every minute while visible, stops when hidden, re-reads on return', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    renderHook(() => useServiceTelemetry());
    await flush();
    assert.equal(count('logs'), 1);

    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(count('logs'), 2);
    assert.equal(count('traces'), 2);

    act(() => setVisibility('hidden'));
    act(() => mock.timers.tick(180_000));
    await flush();
    assert.equal(count('logs'), 2);

    act(() => setVisibility('visible'));
    await flush();
    assert.equal(count('logs'), 3, 'immediate re-read on return');
    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(count('logs'), 4);
  });

  it('does not poll when mounted in a hidden tab', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    renderHook(() => useServiceTelemetry());
    await flush();
    act(() => mock.timers.tick(120_000));
    await flush();
    assert.equal(count('logs'), 1);
  });

  it('parking an active hook aborts its request and ignores the late answer', async () => {
    let release;
    server.logs = () => new Promise((res) => { release = res; });
    const { result, rerender } = renderHook((props) => useServiceTelemetry(props), {
      initialProps: { enabled: true },
    });
    const { signal } = calls.find((c) => c.kind === 'logs');
    rerender({ enabled: false });
    assert.equal(signal.aborted, true);

    release(json({ services: [{ name: 'late', count: 1 }] }));
    await flush();
    assert.equal(result.current.byName.has('late'), false);
  });
});
