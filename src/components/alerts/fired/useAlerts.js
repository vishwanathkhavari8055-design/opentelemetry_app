/**
 * useAlerts — the enterprise alerts screen's data layer.
 *
 * ─── Filtering, sorting and paging all happen on the SERVER ────────────────
 *
 * Not a preference. Fetching a page and then filtering it here gives short pages
 * and a total that disagrees with the rows; sorting a page rather than the table
 * sorts the wrong set entirely. Both look fine on a hundred alerts and are wrong
 * on thousands, which is the scale this screen is for.
 *
 * ─── Two independent fetches ───────────────────────────────────────────────
 *
 * The table and the summary cards are fetched separately but from the SAME
 * filter window, because they have to agree: cards counting all time above a
 * table showing one hour would contradict each other with nothing on screen
 * saying which to trust. They are separate requests only so a slow table does
 * not hold up the counts.
 *
 * ─── Auto-refresh only replaces the data, never the scroll ─────────────────
 *
 * `paused` freezes the clock while somebody is reading, and a refresh keeps the
 * existing rows on screen until the new ones arrive — a table that empties and
 * refills on a timer is unusable for the thing it exists for.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bulkTransitionAlerts,
  fetchAlertIngestStatus,
  fetchAlertSummary2,
  fetchAlerts2,
  fetchLiveAlerts,
  transitionAlert,
  triggerAlertIngest,
} from '../../../services/api';

/** Auto-refresh cadence. Matches the backend's default poll, so the UI is never
 *  more than one interval behind what has been ingested. */
export const DEFAULT_REFRESH_MS = 30_000;

export const REFRESH_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 15_000, label: '15s' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
];

export const PAGE_SIZES = [25, 50, 100, 250];

/** Empty filter state, also used by the Clear button. */
export const EMPTY_FILTERS = {
  search: '',
  severity: [],
  status: ['FIRING', 'ACKNOWLEDGED'],
  service: '',
  stream: '',
  source: '',
  ruleId: '',
  /* Must be one of AlertFilters.WINDOWS, or the select renders with no option
     matched and the filter reads as blank while the query is still bounded.
     `now-1d` is the same span the old `now-24h` default was. */
  window: 'now-1d',
};

export function useAlerts() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sortBy, setSortBy] = useState('lastFiredAt');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [summary, setSummary] = useState(null);
  const [ingest, setIngest] = useState(null);

  // `loading` is the FIRST load (show skeletons); `refreshing` is a background
  // one (keep the rows, dim them). Conflating them makes every auto-refresh blank
  // the table.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastFetched, setLastFetched] = useState(null);

  const [refreshMs, setRefreshMs] = useState(DEFAULT_REFRESH_MS);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // Debounce the search box: it filters server-side, so typing "kubeworker"
  // unthrottled is ten requests whose responses can arrive out of order.
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(timer);
  }, [filters.search]);

  /** The exact query the table and the cards share. */
  const query = useMemo(() => ({
    ...filters,
    search: debouncedSearch,
    page,
    size,
    sortBy,
    sortDir,
  }), [filters, debouncedSearch, page, size, sortBy, sortDir]);

  // Any filter change resets to page 0 — staying on page 7 of a result set that
  // just shrank to two pages shows an empty table and looks broken.
  useEffect(() => { setPage(0); }, [
    debouncedSearch, filters.severity, filters.status, filters.service,
    filters.stream, filters.source, filters.ruleId, filters.window,
  ]);

  const firstLoadDone = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    if (firstLoadDone.current) setRefreshing(true); else setLoading(true);

    Promise.all([
      fetchAlerts2({ ...query, signal: controller.signal }),
      fetchAlertSummary2({ window: filters.window, signal: controller.signal }),
    ])
      .then(([list, cards]) => {
        if (cancelled) return;
        setItems(list.items);
        setTotal(list.total);
        setHasMore(list.hasMore);
        setSummary(cards);
        setError('');
        setLastFetched(new Date());
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // Keep whatever is on screen. Blanking the table on a transient failure
        // would say "no alerts", which is the most dangerous thing this screen
        // can wrongly claim.
        setError(err.message || 'Could not load alerts.');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
        firstLoadDone.current = true;
      });

    return () => { cancelled = true; controller.abort(); };
  }, [query, filters.window, tick]);

  // The Service / Rule / Stream / Source dropdowns this populated are gone (see
  // AlertFilters), so the request went with them — it ran on every reload, which
  // with auto-refresh on meant one wasted round trip every 30 seconds to fill
  // controls nobody was looking at. GET /api/alerts/query/filters still exists and
  // is unchanged for any other caller.

  // Ingest health. This is what lets the screen say "the poller is stalled"
  // instead of showing an empty table that could equally mean "nothing is wrong".
  useEffect(() => {
    const controller = new AbortController();
    fetchAlertIngestStatus({ signal: controller.signal })
      .then(setIngest)
      .catch(() => { /* non-fatal: the banner just does not appear */ });
    return () => controller.abort();
  }, [tick]);

  /**
   * The stream fallback.
   *
   * ─── When it runs ──────────────────────────────────────────────────────────
   *
   * Only when the pipeline cannot answer: the poller is failing (`healthy: false`),
   * or it is succeeding without the watermark moving (`stalled`), or a fetch just
   * errored. Not "when the table is empty" — a genuinely quiet system is empty and
   * asking OpenObserve to confirm that on every refresh is pure load.
   *
   * ─── Why it does not replace the rows silently ────────────────────────────
   *
   * Live rows have no id, so nothing on them can be acknowledged or resolved. They
   * are kept in their own state and the page states which source it is showing;
   * swapping them into `items` would produce a table that looks exactly like the
   * normal one and refuses every action taken on it.
   */
  const degraded = !!ingest && (ingest.healthy === false || ingest.stalled === true);
  const [live, setLive] = useState(null);

  useEffect(() => {
    if (!degraded) {
      // Recovered: drop the fallback rather than leaving stale stream rows behind
      // the banner that has just disappeared.
      setLive(null);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;

    fetchLiveAlerts({
      // Blank means "all time" to the stored query, but a stream read cannot be
      // unbounded — so the fallback bounds it at the default span instead.
      window: filters.window || 'now-1d',
      search: debouncedSearch,
      severity: filters.severity,
      page,
      size,
      sortBy,
      sortDir,
      signal: controller.signal,
    })
      .then((result) => { if (!cancelled) setLive(result); })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // The fallback failing is not worth a second error banner — the ingest one
        // is already up and says the same thing. Recorded so the page can say the
        // stream is unreachable too, which is a different sentence from "no alerts".
        setLive({ items: [], total: 0, unavailable: true, error: err.message || '' });
      });

    return () => { cancelled = true; controller.abort(); };
  }, [degraded, filters.window, filters.severity, debouncedSearch, page, size, sortBy, sortDir, tick]);

  // Auto-refresh. Paused while the tab is hidden as well as on request — a
  // background tab polling forever is pure waste.
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    if (!refreshMs) return undefined;
    const timer = setInterval(() => {
      if (!pausedRef.current && document.visibilityState === 'visible') {
        setTick((t) => t + 1);
      }
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  /** Refresh button: poll OpenObserve first, then re-read, so a just-fired
   *  alert appears now rather than after the next backend interval. */
  const refreshNow = useCallback(async () => {
    try {
      await triggerAlertIngest();
    } catch {
      // An ingest failure must not stop the re-read — there may be plenty
      // already stored that the operator wants to see.
    }
    reload();
  }, [reload]);

  const setFilter = useCallback((key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
  }, []);

  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), []);

  /** Click a sortable header: same column flips direction, new column starts desc. */
  const toggleSort = useCallback((column) => {
    setSortBy((current) => {
      if (current === column) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
        return current;
      }
      setSortDir('desc');
      return column;
    });
    setPage(0);
  }, []);

  /**
   * One transition, then reload.
   *
   * Reload rather than patching the row: a status change can move the alert in or
   * out of the current filter, and patching would leave a row on screen that no
   * longer matches what the table claims to show.
   */
  const transition = useCallback(async (id, action, opts) => {
    const result = await transitionAlert(id, action, opts);
    reload();
    return result;
  }, [reload]);

  const bulk = useCallback(async (ids, action, opts) => {
    const result = await bulkTransitionAlerts({ ids, action, ...opts });
    reload();
    return result;
  }, [reload]);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.search) n++;
    if (filters.severity.length) n++;
    if (JSON.stringify(filters.status) !== JSON.stringify(EMPTY_FILTERS.status)) n++;
    if (filters.service) n++;
    if (filters.stream) n++;
    if (filters.source) n++;
    if (filters.ruleId) n++;
    if (filters.window !== EMPTY_FILTERS.window) n++;
    return n;
  }, [filters]);

  return {
    filters, setFilter, clearFilters, activeFilterCount,
    items, total, hasMore, summary, ingest,
    loading, refreshing, error, lastFetched,
    page, setPage, size, setSize,
    sortBy, sortDir, toggleSort,
    refreshMs, setRefreshMs, paused, setPaused,
    reload, refreshNow, transition, bulk,
    // The fallback, kept separate from `items` so the page decides what to render
    // and can say which source the rows came from.
    degraded, live,
  };
}
