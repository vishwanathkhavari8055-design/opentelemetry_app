import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchCatalogCategories, fetchCatalogResources } from '../../services/api';

/**
 * The Product Catalog, grouped by category, for the screens that scope by it.
 *
 * ─── Why this replaced a static table ──────────────────────────────────────
 *
 * The Logs and Traces sidebars used to render `src/config/products.js` — a
 * hand-maintained Category → Product → Service tree. It had two problems that
 * only a registry can fix: the mapping went stale the moment a service was
 * renamed or deployed, and it described what someone BELIEVED was monitored
 * rather than what is. Worse, it was purely cosmetic — ticking a box there did
 * not change what the backend would return, so a service missing from the table
 * was still fully visible everywhere else.
 *
 * Now the tree is the registry: register a resource and it appears under its
 * category; the backend simultaneously starts scoping every Logs, Traces and
 * Metrics query to the registered set. One source of truth, and the sidebar
 * finally shows the thing that is actually being enforced.
 *
 * ─── Shape ─────────────────────────────────────────────────────────────────
 *
 * Two levels, not three. A category holds resources directly, because a
 * "product" was only ever a grouping invented to make the static list readable
 * and the registry has no such concept — a resource is the unit an operator
 * registers, enables and disables.
 *
 * Categories are ALWAYS all six, including empty ones. An empty category that
 * says "nothing registered yet" is the prompt to register something; a category
 * that silently vanishes reads as a broken screen.
 */

/** Poll cadence. Registrations are rare, and the catalog screen is where they
 *  happen — this only has to catch a change made in another tab. */
const POLL_MS = 60_000;

/**
 * Last payload we had reason to believe.
 *
 * <p>Module-level, so a hook mounting fresh — the alert wizard's service picker,
 * say — paints from what Logs or Traces already fetched instead of starting
 * blank and waiting out a request that currently takes between ten and eighty
 * seconds on this deployment. It is a cache of the LAST GOOD answer, not a
 * substitute for asking: every mount still revalidates immediately and replaces
 * this the moment a trustworthy answer arrives.</p>
 */
let lastGood = { resources: null, categories: null };

/**
 * Consecutive loads that came back empty AFTER we had rows.
 *
 * <p>The coherence check below catches a HALF-failed read, where the counts and
 * the rows contradict each other. It cannot catch a read where both halves timed
 * out, because zero rows and zero counts agree with each other perfectly — and
 * that is the common case here, since both endpoints sit behind the same
 * OpenObserve connection.</p>
 *
 * <p>So emptiness that follows a non-empty answer has to be SEEN TWICE before it
 * is believed. Registrations are rare and deletions rarer; a registry going from
 * fifty-nine resources to none between two polls is far more likely to be a
 * dropped upstream than an operator clearing the estate. Requiring a second
 * opinion costs one poll interval in the genuine case and rides out every
 * single-shot timeout, which is the failure that actually happens.</p>
 */
let emptyStreak = 0;

/**
 * Does this pair of responses hang together?
 *
 * <p>The two endpoints are independent: `/categories` reports a `registeredCount`
 * per category, `/product-catalog` returns the rows. When the first says fifteen
 * Applications are registered and the second returns nothing, they cannot both be
 * right, and the empty one is the one to distrust.</p>
 *
 * <p>That combination is not hypothetical here. The backend answers an upstream
 * OpenObserve timeout with `200 OK`, `supported: true` and an EMPTY list rather
 * than an error — observed at a suspiciously round ten, twenty and thirty seconds
 * — so nothing downstream can tell a degraded answer from a genuinely empty
 * registry by status code alone. Believing it blanks the tree on every screen
 * that reads this hook and reads as "nothing is registered", which is a far
 * stronger claim than "we could not ask".</p>
 *
 * <p>Both halves reporting zero IS consistent, and is trusted: that is what an
 * empty registry, or one whose last resource was just deleted, actually looks
 * like. This only ever rejects a self-contradictory pair.</p>
 */
const isCoherent = (list, cats) => {
  const claimed = (cats || []).reduce((n, c) => n + (c.registeredCount || 0), 0);
  return !(claimed > 0 && (list || []).length === 0);
};

/**
 * @returns {{
 *   categories: Array<{code, label, description, resources, enabled, registeredCount}>,
 *   resources: Array,
 *   byCategory: Map<string, Array>,
 *   enabledNames: Array<string>,
 *   loading: boolean,
 *   error: string,
 *   degraded: boolean,
 *   supported: boolean,
 *   reload: Function,
 * }}
 */
export default function useCatalog() {
  const [categories, setCategories] = useState(() => lastGood.categories || []);
  const [resources, setResources] = useState(() => lastGood.resources || []);
  // Only "loading" when there is nothing to show meanwhile. A revalidation behind
  // a painted tree is not something to put a spinner over.
  const [loading, setLoading] = useState(() => lastGood.resources == null);
  const [error, setError] = useState('');
  const [supported, setSupported] = useState(true);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  /**
   * Was the last answer self-contradictory, so what is on screen is a cached one?
   *
   * <p>Surfaced rather than hidden: a screen showing a snapshot from two minutes
   * ago should be able to say so, and the Product Catalog screen in particular
   * must not let someone believe a registration failed when it is the read-back
   * that is degraded.</p>
   */
  const [degraded, setDegraded] = useState(false);

  const load = useCallback(async (signal) => {
    const [list, cats] = await Promise.all([
      fetchCatalogResources({ signal }),
      fetchCatalogCategories({ signal }),
    ]);

    // Categories are set either way: that half carries its own counts and is the
    // trustworthy one in exactly the case below, so dropping it too would throw
    // away the only evidence that the other half is wrong.
    setCategories(cats.items);
    setSupported(list.supported);

    if (!isCoherent(list.items, cats.items)) {
      // Keep whatever we are already showing. If this is a cold mount there is
      // nothing to keep and the tree stays empty — correct, since we genuinely
      // have nothing to show — but the flag says why.
      setDegraded(true);
      return;
    }

    // Emptiness on the heels of a non-empty answer is held for a second opinion.
    // A cold start that is simply empty has no streak to build and falls through.
    if (list.items.length === 0 && (lastGood.resources || []).length > 0) {
      emptyStreak += 1;
      if (emptyStreak < 2) {
        setDegraded(true);
        return;
      }
    } else {
      emptyStreak = 0;
    }

    setDegraded(false);
    setResources(list.items);
    lastGood = { resources: list.items, categories: cats.items };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    load(controller.signal)
      .then(() => { if (!cancelled) { setLoading(false); setError(''); } })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // A failed load must not empty the tree: the sidebar would then claim
        // nothing is registered, which is a much stronger statement than "we
        // could not ask". Keep what we have and surface the reason.
        console.error('Product Catalog unavailable:', err);
        setError(err.message || 'The Product Catalog is unavailable.');
        setLoading(false);
      });
    return () => { cancelled = true; controller.abort(); };
  }, [load, tick]);

  // Keep it current without polling a hidden tab.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    let timer = null;
    const tickOnce = () => { loadRef.current().catch(() => { /* keep what we have */ }); };
    const start = () => { if (timer == null) timer = setInterval(tickOnce, POLL_MS); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { tickOnce(); start(); } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  const grouped = useMemo(() => {
    const byCategory = new Map();
    categories.forEach((c) => byCategory.set(c.code, []));
    resources.forEach((r) => {
      // A resource whose category the server does not list would otherwise be
      // silently dropped — bucket it rather than lose it.
      if (!byCategory.has(r.category)) byCategory.set(r.category, []);
      byCategory.get(r.category).push(r);
    });

    // Alphabetical within a category. Registration order is meaningful in the
    // catalog table (it is the audit trail) but here the tree is something you
    // scan for a name, so sorted wins.
    byCategory.forEach((list) => list.sort((a, b) => (a.resourceName || '')
      .localeCompare(b.resourceName || '', undefined, { sensitivity: 'base' })));

    const shaped = categories.map((c) => {
      const own = byCategory.get(c.code) || [];
      const enabled = own.filter((r) => r.status === 'ENABLED');
      return {
        ...c,
        resources: own,
        enabled,
        // Prefer the count the server computed; fall back to what we can see, so
        // an older backend that omits it still renders a sensible badge.
        registeredCount: c.registeredCount ?? own.length,
      };
    });

    return { byCategory, shaped };
  }, [categories, resources]);

  /**
   * The identifiers a query should filter on, across the whole catalog.
   *
   * `resolvedName` — the spelling telemetry actually uses — not `resourceName`,
   * which is only the operator's label. The two differ whenever someone typed a
   * different case, and `service_name='…'` is compared exactly by the backend.
   */
  const enabledNames = useMemo(() => Array.from(new Set(
    resources
      .filter((r) => r.status === 'ENABLED')
      .map((r) => r.resolvedName || r.resourceName)
      .filter(Boolean),
  )), [resources]);

  return {
    categories: grouped.shaped,
    resources,
    byCategory: grouped.byCategory,
    enabledNames,
    loading,
    error,
    supported,
    /** True when the last answer contradicted itself and the rows on screen are a
     *  cached snapshot. See {@link isCoherent}. */
    degraded,
    reload,
  };
}

/** The enabled identifiers in one category — what ticking a category applies. */
export const categoryServiceNames = (categories, code) => {
  const category = (categories || []).find((c) => c.code === code);
  if (!category) return [];
  return Array.from(new Set(
    category.enabled.map((r) => r.resolvedName || r.resourceName).filter(Boolean),
  ));
};
