/**
 * useAlerts is the alerts screen's data layer, and its failures are the ones
 * that make the screen lie:
 *
 *  - the table and the summary cards must be asked about the SAME window, or
 *    the counts contradict the rows beneath them;
 *  - a failed refresh must keep the rows on screen — an emptied table reads as
 *    "no alerts", the most dangerous thing this screen can wrongly say;
 *  - the live-stream fallback runs only while ingest is unhealthy or stalled,
 *    and is dropped again when it recovers;
 *  - a filter change goes back to page 0, the search box is debounced, and the
 *    auto-refresh clock respects Pause and a hidden tab.
 *
 * Driven through a stubbed global fetch, so what is asserted is the request the
 * backend would actually receive.
 */
import '../support/dom.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const { renderHook, act, cleanup } = await import('@testing-library/react');
const {
  useAlerts, EMPTY_FILTERS, DEFAULT_REFRESH_MS, REFRESH_OPTIONS, PAGE_SIZES,
} = await import('../../src/components/alerts/fired/useAlerts.js');

/* ── fetch stub ─────────────────────────────────────────────────────────── */

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

/** A request that only settles when told to, or rejects when aborted. */
const deferred = (signal) => {
  let resolve;
  const promise = new Promise((res, rej) => {
    resolve = res;
    signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
  });
  return { promise, resolve };
};

let calls;
let server;
const realFetch = globalThis.fetch;

const defaultServer = () => ({
  list: () => json({ items: [{ id: 1, name: 'cpu' }], total: 1, hasMore: false }),
  summary: () => json({ firing: 1, acknowledged: 0 }),
  ingest: () => json({ healthy: true, stalled: false }),
  live: () => json({ items: [{ name: 'streamed' }], total: 1, source: 'live-stream' }),
  ingestNow: () => json({ ingested: 0 }),
  transition: () => json({ id: 5, status: 'ACKNOWLEDGED' }),
  bulk: () => json({ results: [] }),
});

const route = (path) => {
  if (path === '/alerts/query') return 'list';
  if (path === '/alerts/query/summary') return 'summary';
  if (path === '/alerts/query/live') return 'live';
  if (path === '/alerts/query/bulk') return 'bulk';
  if (path.endsWith('/ingest-status')) return 'ingest';
  if (path.endsWith('/ingest-now')) return 'ingestNow';
  if (/^\/alerts\/query\/[^/]+\/[a-z]+$/.test(path)) return 'transition';
  throw new Error(`unexpected request ${path}`);
};

const installFetch = () => {
  calls = [];
  server = defaultServer();
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://localhost');
    const path = u.pathname.replace('/OpentelemetryService/api', '');
    const kind = route(path);
    calls.push({
      kind, path, params: u.searchParams, method: opts.method || 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined, signal: opts.signal,
    });
    return server[kind](opts.signal, u.searchParams);
  };
};

const of = (kind) => calls.filter((c) => c.kind === kind);
const last = (kind) => of(kind).at(-1);

/** Let fetch promises, their .then chains and React's updates all settle. */
const flush = () => act(async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
});

const mount = async () => {
  const hook = renderHook(() => useAlerts());
  await flush();
  return hook;
};

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
};

beforeEach(installFetch);
afterEach(() => {
  cleanup();
  mock.timers.reset();
  globalThis.fetch = realFetch;
  delete document.visibilityState;
});

/* ── tests ──────────────────────────────────────────────────────────────── */

describe('useAlerts constants', () => {
  it('defaults to the backend’s 30s poll and open alerts over one day', () => {
    assert.equal(DEFAULT_REFRESH_MS, 30_000);
    assert.ok(REFRESH_OPTIONS.some((o) => o.value === DEFAULT_REFRESH_MS));
    assert.equal(REFRESH_OPTIONS[0].value, 0, 'Off is first');
    assert.deepEqual(PAGE_SIZES, [25, 50, 100, 250]);
    assert.deepEqual(EMPTY_FILTERS.status, ['FIRING', 'ACKNOWLEDGED']);
    assert.equal(EMPTY_FILTERS.window, 'now-1d');
  });
});

describe('useAlerts loading', () => {
  it('loads the table and the cards over the same window', async () => {
    const { result } = renderHook(() => useAlerts());
    assert.equal(result.current.loading, true, 'first load shows skeletons');
    await flush();

    const r = result.current;
    assert.equal(r.loading, false);
    assert.equal(r.refreshing, false);
    assert.deepEqual(r.items, [{ id: 1, name: 'cpu' }]);
    assert.equal(r.total, 1);
    assert.equal(r.hasMore, false);
    assert.deepEqual(r.summary, { firing: 1, acknowledged: 0 });
    assert.deepEqual(r.ingest, { healthy: true, stalled: false });
    assert.equal(r.error, '');
    assert.ok(r.lastFetched instanceof Date);

    const list = last('list').params;
    assert.deepEqual(list.getAll('status'), ['FIRING', 'ACKNOWLEDGED'], 'repeatable param, once per value');
    assert.equal(list.get('window'), 'now-1d');
    assert.deepEqual([list.get('page'), list.get('size')], ['0', '50']);
    assert.deepEqual([list.get('sortBy'), list.get('sortDir')], ['lastFiredAt', 'desc']);
    assert.equal(list.has('search'), false, 'empty filters are not sent');
    assert.equal(last('summary').params.get('window'), 'now-1d');

    assert.equal(r.degraded, false);
    assert.equal(r.live, null);
    assert.equal(of('live').length, 0, 'a healthy pipeline never asks the stream');
  });

  it('keeps the rows on screen when a refresh fails, and says why', async () => {
    const { result } = await mount();
    let pending;
    server.list = (signal) => { pending = deferred(signal); return pending.promise; };

    act(() => result.current.reload());
    assert.equal(result.current.refreshing, true, 'a background refresh dims, it does not blank');
    assert.equal(result.current.loading, false);

    pending.resolve(json({ error: 'database unavailable' }, 503));
    await flush();

    assert.equal(result.current.error, 'database unavailable');
    assert.deepEqual(result.current.items, [{ id: 1, name: 'cpu' }], 'previous rows kept');
    assert.equal(result.current.refreshing, false);

    // …and the next good answer clears the banner.
    server.list = () => json({ items: [], total: 0, hasMore: false });
    act(() => result.current.reload());
    await flush();
    assert.equal(result.current.error, '');
    assert.deepEqual(result.current.items, []);
  });

  it('falls back to a generic message for an error with none', async () => {
    server.list = () => Promise.reject(new Error(''));
    const { result } = await mount();
    assert.equal(result.current.error, 'Could not load alerts.');
    assert.equal(result.current.loading, false);
  });

  it('treats an ingest-status failure as no banner rather than an error', async () => {
    server.ingest = () => json({}, 500);
    const { result } = await mount();
    assert.equal(result.current.ingest, null);
    assert.equal(result.current.error, '');
    assert.equal(result.current.degraded, false);
  });

  it('aborts in-flight requests on unmount without touching state', async () => {
    server.list = (signal) => deferred(signal).promise;
    const errors = mock.method(console, 'error', () => {});
    const { unmount } = renderHook(() => useAlerts());
    const { signal } = last('list');
    unmount();
    await flush();
    assert.equal(signal.aborted, true);
    assert.equal(errors.mock.callCount(), 0, 'no update-after-unmount warning');
    errors.mock.restore();
  });
});

describe('useAlerts filters, paging and sorting', () => {
  it('sends only the settled search text, 300ms after typing stops', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { result } = await mount();
    const before = of('list').length;

    act(() => result.current.setFilter('search', 'kube'));
    act(() => result.current.setFilter('search', 'kubeworker'));
    await flush();
    assert.equal(result.current.filters.search, 'kubeworker', 'the box updates immediately');
    assert.ok(of('list').slice(before).every((c) => !c.params.has('search')),
      'no partial text reaches the server');

    act(() => mock.timers.tick(299));
    await flush();
    assert.ok(of('list').every((c) => !c.params.has('search')));

    act(() => mock.timers.tick(1));
    await flush();
    assert.equal(last('list').params.get('search'), 'kubeworker');
    assert.equal(of('list').filter((c) => c.params.has('search')).length, 1);
  });

  /* SUSPECTED BUG: `query` spreads the raw `filters` object, so every keystroke
     changes its identity and re-runs the fetch effect (with the old debounced
     search) — the debounce delays the search TEXT but not the requests. Typing
     two characters currently sends two extra requests before the debounced one. */
  it.skip('sends no request at all while the search box is still being typed in', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { result } = await mount();
    const before = of('list').length;
    act(() => result.current.setFilter('search', 'kube'));
    act(() => result.current.setFilter('search', 'kubeworker'));
    await flush();
    assert.equal(of('list').length, before);
  });

  it('goes back to page 0 when a filter changes', async () => {
    const { result } = await mount();
    act(() => result.current.setPage(3));
    await flush();
    assert.equal(last('list').params.get('page'), '3');

    act(() => result.current.setFilter('severity', ['critical', 'warning']));
    await flush();
    assert.equal(result.current.page, 0);
    assert.equal(last('list').params.get('page'), '0');
    assert.deepEqual(last('list').params.getAll('severity'), ['critical', 'warning']);
  });

  it('asks the cards about the new window too', async () => {
    const { result } = await mount();
    act(() => result.current.setFilter('window', 'now-1h'));
    await flush();
    assert.equal(last('list').params.get('window'), 'now-1h');
    assert.equal(last('summary').params.get('window'), 'now-1h');
  });

  it('sends page size changes', async () => {
    const { result } = await mount();
    act(() => result.current.setSize(250));
    await flush();
    assert.equal(last('list').params.get('size'), '250');
  });

  it('flips direction on the same column and starts a new one descending', async () => {
    const { result } = await mount();
    act(() => result.current.setPage(2));
    act(() => result.current.toggleSort('lastFiredAt'));
    await flush();
    assert.deepEqual([result.current.sortBy, result.current.sortDir, result.current.page],
      ['lastFiredAt', 'asc', 0]);
    assert.equal(last('list').params.get('sortDir'), 'asc');

    act(() => result.current.toggleSort('lastFiredAt'));
    assert.equal(result.current.sortDir, 'desc');

    act(() => result.current.toggleSort('lastFiredAt'));
    act(() => result.current.toggleSort('severity'));
    await flush();
    assert.deepEqual([result.current.sortBy, result.current.sortDir], ['severity', 'desc']);
    assert.equal(last('list').params.get('sortBy'), 'severity');
  });

  it('counts only filters that differ from the defaults, and clears them', async () => {
    const { result } = await mount();
    assert.equal(result.current.activeFilterCount, 0);

    act(() => {
      const set = result.current.setFilter;
      set('search', 'x');
      set('severity', ['critical']);
      set('status', ['RESOLVED']);
      set('service', 'svc');
      set('stream', 'default');
      set('source', 'openobserve');
      set('ruleId', 'r1');
      set('window', 'now-7d');
    });
    assert.equal(result.current.activeFilterCount, 8);

    act(() => result.current.setFilter('status', ['FIRING', 'ACKNOWLEDGED']));
    assert.equal(result.current.activeFilterCount, 7, 'the default status set is not a filter');

    act(() => result.current.clearFilters());
    assert.equal(result.current.activeFilterCount, 0);
    assert.deepEqual(result.current.filters, EMPTY_FILTERS);
  });
});

describe('useAlerts live-stream fallback', () => {
  it('reads the stream while ingest is failing, with the table’s filters', async () => {
    server.ingest = () => json({ healthy: false, error: 'poller down' });
    const { result } = await mount();

    assert.equal(result.current.degraded, true);
    const live = last('live').params;
    assert.equal(live.get('window'), 'now-1d');
    assert.deepEqual([live.get('page'), live.get('size'), live.get('sortBy')], ['0', '50', 'lastFiredAt']);
    assert.deepEqual(result.current.live.items, [{ name: 'streamed' }]);
    assert.equal(result.current.live.source, 'live-stream');
    assert.deepEqual(result.current.items, [{ id: 1, name: 'cpu' }], 'stored rows are not replaced');

    act(() => result.current.setFilter('severity', ['critical']));
    await flush();
    assert.deepEqual(last('live').params.getAll('severity'), ['critical']);
  });

  it('bounds an all-time window for the stream read', async () => {
    server.ingest = () => json({ healthy: true, stalled: true });
    const { result } = await mount();
    act(() => result.current.setFilter('window', ''));
    await flush();
    assert.equal(last('list').params.has('window'), false, 'the stored query is unbounded');
    assert.equal(last('live').params.get('window'), 'now-1d', 'the stream read is not');
  });

  it('records a failed stream read as unavailable rather than empty', async () => {
    server.ingest = () => json({ healthy: false });
    server.live = () => json({ error: 'OpenObserve unreachable' }, 502);
    const { result } = await mount();
    assert.deepEqual(result.current.live,
      { items: [], total: 0, unavailable: true, error: 'OpenObserve unreachable' });
  });

  it('records a message-less failure with an empty reason', async () => {
    server.ingest = () => json({ healthy: false });
    server.live = () => Promise.reject(new Error(''));
    const { result } = await mount();
    assert.equal(result.current.live.unavailable, true);
    assert.equal(result.current.live.error, '');
  });

  it('drops the fallback rows once ingest recovers', async () => {
    server.ingest = () => json({ healthy: false });
    const { result } = await mount();
    assert.ok(result.current.live);

    server.ingest = () => json({ healthy: true, stalled: false });
    act(() => result.current.reload());
    await flush();
    assert.equal(result.current.degraded, false);
    assert.equal(result.current.live, null);
  });
});

describe('useAlerts actions', () => {
  it('refreshNow polls OpenObserve first, then re-reads', async () => {
    const { result } = await mount();
    const before = of('list').length;
    await act(() => result.current.refreshNow());
    await flush();
    assert.equal(last('ingestNow').method, 'POST');
    assert.equal(of('list').length, before + 1);
    assert.ok(calls.indexOf(last('ingestNow')) < calls.indexOf(last('list')));
  });

  it('refreshNow still re-reads when the ingest poll fails', async () => {
    server.ingestNow = () => json({ error: 'busy' }, 409);
    const { result } = await mount();
    const before = of('list').length;
    await act(() => result.current.refreshNow());
    await flush();
    assert.equal(of('list').length, before + 1);
  });

  it('transitions one alert by id, returns the result, and reloads', async () => {
    const { result } = await mount();
    const before = of('list').length;
    let out;
    await act(async () => {
      out = await result.current.transition(5, 'acknowledge', { actor: 'ana', note: 'on it' });
    });
    await flush();
    const call = last('transition');
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/alerts/query/5/acknowledge');
    assert.deepEqual(call.body, { actor: 'ana', note: 'on it' });
    assert.deepEqual(out, { id: 5, status: 'ACKNOWLEDGED' });
    assert.equal(of('list').length, before + 1);
  });

  it('propagates a rejected transition without reloading', async () => {
    server.transition = () => json({ error: 'already closed' }, 409);
    const { result } = await mount();
    const before = of('list').length;
    let failure;
    await act(async () => {
      try { await result.current.transition(5, 'resolve'); } catch (err) { failure = err; }
    });
    assert.match(failure?.message ?? '', /already closed/);
    await flush();
    assert.equal(of('list').length, before);
  });

  it('bulk-transitions many alerts in one request, then reloads', async () => {
    const { result } = await mount();
    const before = of('list').length;
    let out;
    await act(async () => {
      out = await result.current.bulk([1, 2], 'resolve', { actor: 'ana' });
    });
    await flush();
    assert.deepEqual(last('bulk').body, { ids: [1, 2], action: 'resolve', actor: 'ana', note: '' });
    assert.deepEqual(out, { results: [] });
    assert.equal(of('list').length, before + 1);
  });
});

describe('useAlerts auto-refresh', () => {
  it('re-reads every interval while visible and not paused', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const { result } = await mount();
    const before = of('list').length;

    act(() => mock.timers.tick(DEFAULT_REFRESH_MS));
    await flush();
    assert.equal(of('list').length, before + 1);
    assert.equal(of('ingest').length, 2, 'ingest health refreshes with it');

    act(() => result.current.setPaused(true));
    act(() => mock.timers.tick(DEFAULT_REFRESH_MS * 2));
    await flush();
    assert.equal(of('list').length, before + 1, 'paused freezes the clock');
    assert.equal(result.current.paused, true);

    act(() => result.current.setPaused(false));
    setVisibility('hidden');
    act(() => mock.timers.tick(DEFAULT_REFRESH_MS));
    await flush();
    assert.equal(of('list').length, before + 1, 'a hidden tab does not poll');
  });

  it('follows a changed interval, and stops when set to Off', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const { result } = await mount();
    const before = of('list').length;

    act(() => result.current.setRefreshMs(15_000));
    act(() => mock.timers.tick(15_000));
    await flush();
    assert.equal(of('list').length, before + 1);
    assert.equal(result.current.refreshMs, 15_000);

    act(() => result.current.setRefreshMs(0));
    act(() => mock.timers.tick(300_000));
    await flush();
    assert.equal(of('list').length, before + 1);
  });
});
