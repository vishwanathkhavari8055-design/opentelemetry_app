/**
 * useResourceUsage backs Settings → Resource: one call to
 * /api/infrastructure/utilization, normalised and polled.
 *
 * What is guarded:
 *  - a missing reading stays null (rendered as an em dash), never a zero;
 *  - the header's "as of" is the FRESHEST available tile, so one slow collector
 *    does not report the whole screen as stale;
 *  - the refresh button bypasses the backend cache and the automatic poll does
 *    not — otherwise the button returns a cached answer and reads as broken;
 *  - only the first load shows "Loading…"; polls replace numbers in place;
 *  - no polling in a hidden tab, and an immediate re-read on return.
 *
 * Requests go to a stubbed global fetch; the clock is node:test's mock timers.
 */
import '../support/dom.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const { renderHook, act, cleanup } = await import('@testing-library/react');
const {
  default: useResourceUsage, toGb, formatGb, formatCores, formatPct,
} = await import('../../src/components/resources/useResourceUsage.js');

/* ── fetch stub ─────────────────────────────────────────────────────────── */

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

const GB = 1024 ** 3;
const PAYLOAD = {
  capturedAt: '2026-09-25T10:00:00Z',
  cached: true,
  supported: true,
  items: [
    {
      kind: 'CPU', label: 'CPU', unit: 'CORES', available: true, usedPercent: 46.7,
      detail: '1.59 / 5 cores', scope: 'pods: iotops-*', window: '5m', lastSeen: '2026-09-25T09:59:30Z',
      lastSeenAgoSec: 30,
    },
    { kind: 'MEMORY', available: true, usedPercent: 12, lastSeenAgoSec: 90 },
    {
      kind: 'DISK', available: true, usedBytes: 10 * GB, freeBytes: 5 * GB, totalBytes: 15 * GB,
      lastSeenAgoSec: 5,
    },
    // Unavailable tiles do not count toward "as of", however fresh they claim to be.
    { kind: 'NFS_STORAGE', available: false, message: 'volume scraper missing', lastSeenAgoSec: 1 },
  ],
};

let calls;
let respond;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  respond = () => json(PAYLOAD);
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://localhost');
    assert.equal(u.pathname, '/OpentelemetryService/api/infrastructure/utilization');
    calls.push({ params: u.searchParams, signal: opts.signal });
    return respond(opts.signal);
  };
});

let consoleError;
beforeEach(() => { consoleError = mock.method(console, 'error', () => {}); });

afterEach(() => {
  cleanup();
  mock.timers.reset();
  consoleError.mock.restore();
  globalThis.fetch = realFetch;
  delete document.hidden;
});

const flush = () => act(async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
});

const setHidden = (hidden) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new window.Event('visibilitychange'));
};

/* ── formatters ─────────────────────────────────────────────────────────── */

describe('resource formatters', () => {
  it('converts bytes to 1024-based GB, or null without a reading', () => {
    assert.equal(toGb(2 * GB), 2);
    assert.equal(toGb(null), null);
    assert.equal(toGb(NaN), null);
    assert.equal(formatGb(10.92 * GB), '10.92 GB');
    assert.equal(formatGb(1.5 * GB, 0), '2 GB');
    assert.equal(formatGb(undefined), '—');
  });

  it('formats cores with the right plural', () => {
    assert.equal(formatCores(1), '1.00 core');
    assert.equal(formatCores(2.345), '2.35 cores');
    assert.equal(formatCores(0.5, 1), '0.5 cores');
    assert.equal(formatCores(null), '—');
  });

  it('formats a finished percentage, and a dash rather than 0% for none', () => {
    assert.equal(formatPct(46.66), '46.7%');
    assert.equal(formatPct(0), '0.0%');
    assert.equal(formatPct(12.345, 2), '12.35%');
    assert.equal(formatPct(null), '—');
  });
});

/* ── the hook ───────────────────────────────────────────────────────────── */

describe('useResourceUsage', () => {
  it('loads the four tiles, normalised and keyed by kind', async () => {
    mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
    const { result } = renderHook(() => useResourceUsage({ activeOrg: 'default' }));
    assert.equal(result.current.loading, true);
    await flush();

    const r = result.current;
    assert.equal(r.loading, false);
    assert.equal(r.error, '');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.has('refresh'), false, 'the first load may use the backend cache');

    assert.deepEqual(r.cpu, {
      kind: 'CPU', label: 'CPU', unit: 'CORES', available: true, pct: 46.7,
      used: null, free: null, total: null, detail: '1.59 / 5 cores', scope: 'pods: iotops-*',
      message: '', window: '5m', lastSeen: '2026-09-25T09:59:30Z', lastSeenAgoSec: 30,
    });
    assert.equal(r.memory.pct, 12);
    assert.equal(r.memory.unit, 'PERCENT', 'unit defaults to a percentage');
    assert.deepEqual([r.disk.used, r.disk.free, r.disk.total], [10 * GB, 5 * GB, 15 * GB]);
    assert.equal(r.disk.pct, null, 'no reading is null, not zero');
    assert.deepEqual([r.nfs.available, r.nfs.message], [false, 'volume scraper missing']);
    assert.equal(r.tiles.length, 4);

    assert.equal(r.asOf, 1_000_000 - 5_000, 'freshest AVAILABLE tile');
    assert.equal(r.fetchedAt, 1_000_000);
    assert.equal(r.pollMs, 20_000);
    assert.equal(r.cached, true);
    assert.equal(r.supported, true);
  });

  it('gives null tiles and no "as of" when nothing was returned', async () => {
    respond = () => json({ items: [{}], supported: false });
    const { result } = renderHook(() => useResourceUsage());
    await flush();
    const r = result.current;
    assert.deepEqual([r.cpu, r.memory, r.disk, r.nfs], [null, null, null, null]);
    assert.equal(r.tiles[0].kind, '');
    assert.equal(r.tiles[0].available, false);
    assert.equal(r.tiles[0].lastSeen, null);
    assert.equal(r.asOf, null);
    assert.equal(r.supported, false, 'OpenObserve switched off is carried through');
    assert.equal(r.error, '', 'and is not a banner');
    assert.equal(r.cached, false);
  });

  it('banners a transport failure and stops loading', async () => {
    respond = () => json({}, 502);
    const { result } = renderHook(() => useResourceUsage());
    await flush();
    assert.equal(result.current.loading, false);
    assert.equal(result.current.error, 'HTTP error! status: 502');
  });

  it('bypasses the backend cache when the user refreshes, without a loading flash', async () => {
    const { result } = renderHook(() => useResourceUsage());
    await flush();

    let release;
    respond = () => new Promise((res) => { release = res; });
    act(() => result.current.refresh());
    assert.equal(calls.at(-1).params.get('refresh'), 'true');
    assert.equal(result.current.loading, false, 'numbers stay while re-reading');
    assert.equal(result.current.tiles.length, 4);

    release(json({ ...PAYLOAD, cached: false }));
    await flush();
    assert.equal(result.current.cached, false);
  });

  it('re-reads when the organization changes', async () => {
    const { rerender } = renderHook((props) => useResourceUsage(props), {
      initialProps: { activeOrg: 'default' },
    });
    await flush();
    rerender({ activeOrg: 'DLH' });
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true, 'the old org’s request is abandoned');
    assert.equal(calls[1].params.has('refresh'), false);
  });

  it('polls every 20s from the cache, pauses when hidden, re-reads on return', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    renderHook(() => useResourceUsage());
    await flush();
    assert.equal(calls.length, 1);

    act(() => mock.timers.tick(20_000));
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.has('refresh'), false, 'the poll lets the server cache absorb it');

    act(() => setHidden(true));
    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(calls.length, 2, 'no polling in a hidden tab');

    act(() => setHidden(false));
    await flush();
    assert.equal(calls.length, 3, 'immediate re-read on return');
  });

  it('aborts and stops polling on unmount', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    respond = (signal) => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
    });
    const { unmount } = renderHook(() => useResourceUsage());
    const { signal } = calls[0];
    unmount();
    await flush();
    assert.equal(signal.aborted, true);

    act(() => mock.timers.tick(60_000));
    setHidden(false);
    await flush();
    assert.equal(calls.length, 1, 'no timer or listener left behind');
    assert.equal(consoleError.mock.callCount(), 0);
  });
});
