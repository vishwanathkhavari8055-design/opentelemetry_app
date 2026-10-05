/**
 * useCatalog feeds the Logs/Traces sidebars and the alert wizard's service
 * picker from the Product Catalog registry. What it must never do is claim that
 * nothing is registered when it merely could not ask:
 *
 *  - a self-contradictory pair (categories count rows, the list has none) is the
 *    backend's disguised upstream timeout, and the rows on screen are kept;
 *  - emptiness straight after a non-empty answer is believed only the SECOND
 *    time it is seen;
 *  - a failed load keeps the tree and surfaces the reason;
 *  - a fresh mount paints from the last good answer while it revalidates.
 *
 * The hook keeps that last good answer at MODULE level, so the cases below are
 * ordered and build on each other — they run sequentially, as node:test does.
 * Requests go to a stubbed global fetch.
 */
import '../support/dom.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const { renderHook, act, cleanup } = await import('@testing-library/react');
const { default: useCatalog, categoryServiceNames } = await import('../../src/components/common/useCatalog.js');

/* ── fetch stub ─────────────────────────────────────────────────────────── */

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

let calls;
let server;
const realFetch = globalThis.fetch;

const CATEGORIES = [
  { code: 'APPLICATIONS', label: 'Applications', registeredCount: 2 },
  { code: 'DATABASES', label: 'Databases' },
];
const RESOURCES = [
  { resourceName: 'zeta', resolvedName: 'ZetaSvc', category: 'APPLICATIONS', status: 'ENABLED' },
  { resourceName: 'Alpha', category: 'APPLICATIONS', status: 'DISABLED' },
  { resourceName: 'beta', resolvedName: '', category: 'APPLICATIONS', status: 'ENABLED' },
  { resourceName: 'orphan', resolvedName: 'ZetaSvc', category: 'LEGACY', status: 'ENABLED' },
];

const installFetch = () => {
  calls = [];
  server = {
    list: () => json({ items: RESOURCES, total: RESOURCES.length, supported: true }),
    categories: () => json({ items: CATEGORIES }),
  };
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url, 'http://localhost').pathname.replace('/OpentelemetryService/api', '');
    const kind = path === '/product-catalog' ? 'list'
      : path === '/product-catalog/categories' ? 'categories'
        : null;
    if (!kind) throw new Error(`unexpected request ${path}`);
    calls.push({ kind, signal: opts.signal });
    return server[kind](opts.signal);
  };
};

const count = (kind) => calls.filter((c) => c.kind === kind).length;

const flush = () => act(async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
});

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new window.Event('visibilitychange'));
};

let consoleError;
beforeEach(() => {
  installFetch();
  consoleError = mock.method(console, 'error', () => {});
});
afterEach(() => {
  cleanup();
  mock.timers.reset();
  consoleError.mock.restore();
  globalThis.fetch = realFetch;
  delete document.visibilityState;
});

/* ── tests (ordered: module-level cache carries between them) ───────────── */

describe('useCatalog', () => {
  it('cold mount: loads, groups by category, sorts, and lists enabled names', async () => {
    const { result } = renderHook(() => useCatalog());
    assert.equal(result.current.loading, true, 'nothing to show yet');
    assert.deepEqual(result.current.resources, []);
    await flush();

    const r = result.current;
    assert.equal(r.loading, false);
    assert.equal(r.error, '');
    assert.equal(r.degraded, false);
    assert.equal(r.supported, true);
    assert.equal(count('list'), 1);
    assert.equal(count('categories'), 1);

    assert.deepEqual(r.categories.map((c) => c.code), ['APPLICATIONS', 'DATABASES'], 'server order, empties kept');
    const [apps, dbs] = r.categories;
    assert.deepEqual(apps.resources.map((x) => x.resourceName), ['Alpha', 'beta', 'zeta'], 'case-insensitive A→Z');
    assert.deepEqual(apps.enabled.map((x) => x.resourceName), ['beta', 'zeta']);
    assert.equal(apps.registeredCount, 2, 'server count preferred');
    assert.equal(dbs.registeredCount, 0, 'falls back to what is visible');
    assert.equal(dbs.label, 'Databases');

    assert.deepEqual(r.byCategory.get('LEGACY').map((x) => x.resourceName), ['orphan'],
      'a resource in an unlisted category is bucketed, not dropped');
    assert.deepEqual(r.enabledNames, ['ZetaSvc', 'beta'], 'resolved spelling, de-duplicated');
  });

  it('warm mount: paints from the last good answer while it revalidates', async () => {
    let release;
    server.list = () => new Promise((res) => { release = res; });
    const { result } = renderHook(() => useCatalog());
    assert.equal(result.current.loading, false, 'no spinner over a painted tree');
    assert.equal(result.current.resources.length, 4);
    assert.equal(result.current.categories.length, 2);
    assert.equal(count('list'), 1, 'it still asks');

    release(json({ items: RESOURCES.slice(0, 1), supported: true }));
    await flush();
    assert.deepEqual(result.current.resources.map((x) => x.resourceName), ['zeta']);
  });

  it('keeps the rows and flags degraded when the two halves contradict', async () => {
    const { result } = renderHook(() => useCatalog());
    await flush();
    assert.equal(result.current.resources.length, 4);

    server.list = () => json({ items: [], supported: true });
    server.categories = () => json({ items: [{ code: 'APPLICATIONS', registeredCount: 15 }] });
    act(() => result.current.reload());
    await flush();

    assert.equal(result.current.degraded, true);
    assert.equal(result.current.resources.length, 4, 'rows kept');
    assert.equal(result.current.categories[0].registeredCount, 15, 'categories still applied');
  });

  it('believes emptiness after a non-empty answer only the second time', async () => {
    server.list = () => json({ items: [], supported: true });
    server.categories = () => json({ items: [{ code: 'APPLICATIONS', registeredCount: 0 }] });
    const { result } = renderHook(() => useCatalog());
    await flush();

    assert.equal(result.current.degraded, true, 'first empty answer is held');
    assert.equal(result.current.resources.length, 4, 'the cached rows stay up');

    act(() => result.current.reload());
    await flush();
    assert.equal(result.current.degraded, false);
    assert.deepEqual(result.current.resources, [], 'second opinion agrees: it is empty');
    assert.deepEqual(result.current.enabledNames, []);
  });

  it('an empty answer after an empty one is trusted at once', async () => {
    server.list = () => json({ items: [], supported: true });
    server.categories = () => json({ items: [] });
    const { result } = renderHook(() => useCatalog());
    await flush();
    assert.equal(result.current.degraded, false);
    assert.deepEqual(result.current.resources, []);
  });

  it('resets the empty streak once rows return', async () => {
    const { result } = renderHook(() => useCatalog());
    await flush();
    assert.equal(result.current.resources.length, 4);

    // One empty answer after that is held again — the streak started over.
    server.list = () => json({ items: [], supported: true });
    server.categories = () => json({ items: [] });
    act(() => result.current.reload());
    await flush();
    assert.equal(result.current.degraded, true);
    assert.equal(result.current.resources.length, 4);
  });

  it('keeps the tree on a failed load and surfaces the reason', async () => {
    const { result } = renderHook(() => useCatalog());
    await flush();
    assert.equal(result.current.resources.length, 4);

    server.list = () => json({ error: 'OpenObserve timed out' }, 504);
    act(() => result.current.reload());
    await flush();
    assert.equal(result.current.error, 'OpenObserve timed out');
    assert.equal(result.current.loading, false);
    assert.equal(result.current.resources.length, 4);
    assert.equal(consoleError.mock.callCount(), 1);

    server.list = () => Promise.reject(new Error(''));
    act(() => result.current.reload());
    await flush();
    assert.equal(result.current.error, 'The Product Catalog is unavailable.');

    server.list = () => json({ items: RESOURCES, supported: true });
    act(() => result.current.reload());
    await flush();
    assert.equal(result.current.error, '', 'a good answer clears it');
  });

  it('reports an unsupported backend', async () => {
    server.list = () => json({ items: RESOURCES, supported: false });
    const { result } = renderHook(() => useCatalog());
    await flush();
    assert.equal(result.current.supported, false);
  });

  it('polls every minute while visible, pauses when hidden, re-reads on return', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    renderHook(() => useCatalog());
    await flush();
    assert.equal(count('list'), 1);

    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(count('list'), 2);
    assert.equal(count('categories'), 2);

    act(() => setVisibility('hidden'));
    act(() => mock.timers.tick(180_000));
    await flush();
    assert.equal(count('list'), 2, 'no polling in a hidden tab');

    act(() => setVisibility('visible'));
    await flush();
    assert.equal(count('list'), 3, 'immediate re-read on return');
    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(count('list'), 4, 'and the poll resumes');
  });

  it('a failed poll keeps what is on screen', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const { result } = renderHook(() => useCatalog());
    await flush();
    server.list = () => Promise.reject(new Error('down'));
    act(() => mock.timers.tick(60_000));
    await flush();
    assert.equal(result.current.resources.length, 4);
    assert.equal(result.current.error, '', 'the poll failure is swallowed, not bannered');
  });

  it('does not start polling when mounted in a hidden tab', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    renderHook(() => useCatalog());
    await flush();
    act(() => mock.timers.tick(120_000));
    await flush();
    assert.equal(count('list'), 1, 'only the mount load');
  });

  it('aborts the in-flight load on unmount', async () => {
    server.list = (signal) => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
    });
    const { unmount } = renderHook(() => useCatalog());
    const { signal } = calls.find((c) => c.kind === 'list');
    unmount();
    await flush();
    assert.equal(signal.aborted, true);
    assert.equal(consoleError.mock.callCount(), 0);
  });
});

describe('categoryServiceNames', () => {
  const categories = [
    {
      code: 'APPLICATIONS',
      enabled: [
        { resourceName: 'a', resolvedName: 'A-svc' },
        { resourceName: 'b' },
        { resourceName: 'dup', resolvedName: 'A-svc' },
        { resourceName: '', resolvedName: '' },
      ],
    },
  ];

  it('returns the enabled identifiers of one category, resolved and unique', () => {
    assert.deepEqual(categoryServiceNames(categories, 'APPLICATIONS'), ['A-svc', 'b']);
  });

  it('returns nothing for an unknown category or no categories', () => {
    assert.deepEqual(categoryServiceNames(categories, 'NOPE'), []);
    assert.deepEqual(categoryServiceNames(null, 'APPLICATIONS'), []);
  });
});
