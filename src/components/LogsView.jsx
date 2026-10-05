import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchLogs, fetchLogServiceCounts, fetchStreams } from '../services/api';
import {
  parseLogQuery, toSql, fromSql, sqlTemplate, withServiceClauses,
  withoutSeverityClauses, withSeverityClause, withTraceClause,
} from '../utils/logQuery';
import LogsToolbar from './logs/LogsToolbar';
import QueryEditor from './logs/QueryEditor';
import LogTable from './logs/LogTable';
import LogFieldSidebar from './logs/LogFieldSidebar';
import LogHistogram from './logs/LogHistogram';
import LogResultsBar from './logs/LogResultsBar';
import LogDetailsModal from './logs/LogDetailsModal';
import useCatalog, { categoryServiceNames } from './common/useCatalog';

/**
 * Container for the logs view.
 *
 * The screen follows the OpenObserve model: you write a query, pick a time
 * range, and press Run. Nothing re-queries on its own except the auto-refresh
 * interval — that's the whole point of an explicit Run button, and it's why
 * there is no debounce anywhere in this file. Filters that used to live in a
 * toolbar (service, severity, free text, dates) are now clauses in the query
 * editor; see utils/logQuery.js for how they map onto the backend's
 * parameters, which have not changed.
 *
 * State is deliberately split in two:
 *
 *   draft      what the editor and the pickers currently hold
 *   committed  what produced the rows on screen
 *
 * Only `committed` is a dependency of the fetch effects. Without that split,
 * typing in the editor would re-query on every keystroke and "Run query" would
 * be decoration.
 */

/** One page-0 fetch of the newest rows feeds the histogram and the field list.
 *  500 is enough to shape a readable distribution and to surface every field
 *  that's actually populated. */
const SAMPLE_SIZE = 500;

/**
 * The stream the picker falls back to.
 *
 * <p>Used only until /api/streams answers, and as the answer itself when that call
 * fails — an empty dropdown would leave no way back to a queryable stream. The real
 * list is discovered from OpenObserve, so a tenant with fourteen streams now sees
 * fourteen instead of this one.</p>
 *
 * <p>`/api/logs` DOES take a stream now, and the selection is sent on every read.
 * It used to not, which is why this was a hardcoded array: the selector named what
 * was being queried and could not change it.</p>
 */
const FALLBACK_STREAM = 'default';

const LS = {
  query:     'observability-ui:logs:query:v1',
  sqlMode:   'observability-ui:logs:sql-mode:v1',
  timeRange: 'observability-ui:logs:time-range:v1',
  // v3, bumped for the same reason v2 was. This value is written back on mount,
  // so EVERY user who has opened this screen has a stored number — v2 means a
  // stored 5 — and a change of DEFAULT_REFRESH_SECS alone would apply to nobody
  // but a brand-new browser. Bumping the key is what makes the new default (60s,
  // see DEFAULT_REFRESH_SECS) actually take effect once; from then on v3 persists
  // whatever the user picks, including Off and including 5 sec.
  //
  // The cost of the bump, stated plainly: a deliberate non-default choice made
  // under v2 — Off, or 30 sec — is forgotten once, and the picker starts at 1 min.
  // That is the same trade the v1 → v2 bump accepted, and it is one click to redo.
  refresh:   'observability-ui:logs:refresh-secs:v3',
  fields:    'observability-ui:logs:fields-collapsed:v1',
  histogram: 'observability-ui:logs:histogram:v1',
  editor:    'observability-ui:logs:editor-collapsed:v1',
  views:     'observability-ui:logs:saved-views:v1',
};

const readLS = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
};
const writeLS = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* private mode / disabled storage — preference just won't persist */ }
};

/**
 * Monotonic counter for the re-fetch nonce.
 *
 * Was `Date.now()`, which has a real failure mode for auto-refresh: the fetch
 * effect keys off the nonce VALUE, so two commits landing in the same millisecond
 * produce an identical nonce, no dependency change, and therefore no re-fetch —
 * the refresh is silently swallowed. A counter can never collide with itself, so
 * every re-run is guaranteed to reach the network. It also removes a dependency on
 * the wall clock, which is not monotonic across an NTP correction.
 *
 * Module scope rather than a ref: it only ever has to be unique, never meaningful,
 * and it is never persisted or put in a share link.
 */
let nonceSeq = 0;
const nextNonce = () => { nonceSeq += 1; return nonceSeq; };

/**
 * Auto-refresh interval a first load starts with, in seconds. 0 would be off.
 *
 * ON by default, which is a deliberate reversal. This screen is used to WATCH a
 * live stream, and the previous default of 0 meant the only way to see new lines
 * was to keep pressing the refresh button — the clock control that switches
 * tailing on sits behind a menu, so "the logs do not update" was the normal
 * first experience rather than an edge case.
 *
 * The cost is real and worth stating: each tick is three backend queries (table,
 * histogram sample, service counts), measured at roughly 300 / 600 / 280 ms
 * against this deployment — about 1.2s of work inside every 60s window, per
 * viewer. That is affordable here, and it stops as soon as the tab is hidden.
 * Turning it off is one click and is remembered.
 *
 * ── Why 60 and not 5 ────────────────────────────────────────────────────────
 *
 * 5s was the first value chosen when the point was simply to have tailing ON at
 * all. It bought very little: the default window is the last 15 minutes and the
 * histogram buckets it far coarser than 5s, so twelve ticks a minute mostly
 * redraw a table whose visible top row has not changed, at 1.2s of backend work
 * each. A minute is still tailing — new lines appear without anyone pressing a
 * button, which was the whole reason for defaulting it on — at a twelfth of the
 * cost per viewer. Anyone watching a live incident can still pick 5s from the
 * clock menu, and that choice is remembered.
 */
const DEFAULT_REFRESH_SECS = 60;

const DEFAULT_RANGE = { mode: 'relative', relative: '15m', from: '', to: '' };

/**
 * Time range → the `startTime` / `endTime` the backend expects.
 *
 * Relative windows are passed through as `now-15m`, which TimeRangeParser
 * resolves server-side — sending a client-computed instant instead would bake
 * in whatever clock skew the browser has. Absolute windows are local wall time
 * from a `datetime-local` input, so they're converted to ISO here.
 */
const rangeToParams = (range) => {
  if (range.mode === 'absolute') {
    const iso = (local) => {
      if (!local) return '';
      const d = new Date(local);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString();
    };
    return { startDate: iso(range.from), endDate: iso(range.to) };
  }
  return { startDate: `now-${toBackendUnit(range.relative || '15m')}`, endDate: '' };
};

/**
 * The backend's TimeRangeParser matches `now-(\d+)([smhdw])` — seconds through
 * weeks, with no month unit. The picker offers months because that's a range
 * people ask for, so they're converted to days here rather than sent as `1M`,
 * which wouldn't parse. 30 days per month is the same approximation every
 * relative-range picker makes.
 */
const toBackendUnit = (rel) => {
  const m = /^(\d+)M$/.exec(rel);
  return m ? `${Number(m[1]) * 30}d` : rel;
};

/** URL-safe snapshot of everything that defines the current query. */
const encodeShare = (state) => {
  const usp = new URLSearchParams();
  if (state.query) usp.set('q', state.query);
  if (state.sqlMode) usp.set('sql', '1');
  if (state.range.mode === 'absolute') {
    usp.set('from', state.range.from || '');
    usp.set('to', state.range.to || '');
  } else {
    usp.set('period', state.range.relative || '15m');
  }
  return usp.toString();
};

/** Reads a shared query out of the address bar, if one is there. */
const readShare = () => {
  try {
    const usp = new URLSearchParams(window.location.search);
    if (!usp.has('q') && !usp.has('period') && !usp.has('from')) return null;
    const from = usp.get('from') || '';
    const to = usp.get('to') || '';
    return {
      query: usp.get('q') || '',
      sqlMode: usp.get('sql') === '1',
      range: (from || to)
        ? { mode: 'absolute', relative: '15m', from, to }
        : { mode: 'relative', relative: usp.get('period') || '15m', from: '', to: '' },
    };
  } catch { return null; }
};

/** Downloads `rows` as a JSON or CSV file, client-side. */
const downloadRows = (rows, format) => {
  if (!rows.length) return;
  const records = rows.map((r) => r._raw || r);
  let blob;
  let filename;

  if (format === 'csv') {
    // Union of every record's keys, so a row missing a field still lines up
    // under the right column instead of shifting the rest left.
    const columns = Array.from(records.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set()));
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const csv = [
      columns.join(','),
      ...records.map((r) => columns.map((c) => escape(r[c])).join(',')),
    ].join('\n');
    blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    filename = 'logs.csv';
  } else {
    blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    filename = 'logs.json';
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

function LogsView({
  onTraceClick, hoveredTraceId, setHoveredTraceId,
  page, setPage, pageSize, setPageSize,
  servicePrefill, onServicePrefillConsumed,
  tracePrefill, onTracePrefillConsumed,
  filterPrefill, onFilterPrefillConsumed,
  onNavigate,
}) {
  // A link shared from another session wins over the persisted state — the
  // whole point of opening one is to see what the sender saw.
  const shared = useRef(readShare()).current;

  // ── Draft state: what the toolbar and editor currently hold ───────────────
  const [query, setQuery] = useState(() => shared?.query ?? readLS(LS.query, ''));
  const [sqlMode, setSqlMode] = useState(() => shared?.sqlMode ?? readLS(LS.sqlMode, false));
  const [timeRange, setTimeRange] = useState(() => shared?.range ?? readLS(LS.timeRange, DEFAULT_RANGE));

  // ── Committed state: what produced the rows on screen ─────────────────────
  const [committed, setCommitted] = useState(() => ({
    query: shared?.query ?? readLS(LS.query, ''),
    sqlMode: shared?.sqlMode ?? readLS(LS.sqlMode, false),
    range: shared?.range ?? readLS(LS.timeRange, DEFAULT_RANGE),
    // Bumped by Run / auto-refresh / the refresh buttons to force a re-fetch
    // even when nothing else changed.
    nonce: 0,
  }));

  const isDirty = query !== committed.query
    || sqlMode !== committed.sqlMode
    || JSON.stringify(timeRange) !== JSON.stringify(committed.range);

  useEffect(() => { writeLS(LS.query, query); }, [query]);
  useEffect(() => { writeLS(LS.sqlMode, sqlMode); }, [sqlMode]);
  useEffect(() => { writeLS(LS.timeRange, timeRange); }, [timeRange]);

  // Parse the DRAFT for editor feedback (warnings appear as you type) but the
  // COMMITTED query for the actual request — otherwise a half-typed clause
  // would change what's fetched.
  const draftParse = useMemo(() => parseLogQuery(query, sqlMode), [query, sqlMode]);
  const activeParse = useMemo(
    () => parseLogQuery(committed.query, committed.sqlMode),
    [committed.query, committed.sqlMode],
  );

  // ── Screen layout prefs ───────────────────────────────────────────────────
  const [fieldsCollapsed, setFieldsCollapsed] = useState(() => readLS(LS.fields, false));
  const [histogramVisible, setHistogramVisible] = useState(() => readLS(LS.histogram, true));
  const [editorCollapsed, setEditorCollapsed] = useState(() => readLS(LS.editor, false));
  useEffect(() => { writeLS(LS.fields, fieldsCollapsed); }, [fieldsCollapsed]);
  useEffect(() => { writeLS(LS.histogram, histogramVisible); }, [histogramVisible]);
  useEffect(() => { writeLS(LS.editor, editorCollapsed); }, [editorCollapsed]);

  const [refreshSecs, setRefreshSecs] = useState(
    () => readLS(LS.refresh, DEFAULT_REFRESH_SECS),
  );
  useEffect(() => { writeLS(LS.refresh, refreshSecs); }, [refreshSecs]);

  const [savedViews, setSavedViews] = useState(() => readLS(LS.views, []));
  useEffect(() => { writeLS(LS.views, savedViews); }, [savedViews]);

  const [stream, setStream] = useState(FALLBACK_STREAM);

  /**
   * Streams this tenant has, for the picker.
   *
   * <p>Seeded with the fallback so the control is never empty, and unioned with it
   * on arrival: the configured stream must stay selectable even if discovery does
   * not list it, or a lookup hiccup would strand the screen on a stream it cannot
   * offer to leave.</p>
   */
  const [streams, setStreams] = useState([FALLBACK_STREAM]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetchStreams({ type: 'logs', signal: controller.signal })
      .then((names) => {
        if (cancelled) return;
        const merged = names.includes(FALLBACK_STREAM)
          ? names
          : [FALLBACK_STREAM, ...names];
        setStreams(merged.length ? merged : [FALLBACK_STREAM]);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // Non-fatal: the picker keeps the fallback and the table is unaffected.
        console.warn('Stream list unavailable; keeping the default stream only:', err.message);
      });
    return () => { cancelled = true; controller.abort(); };
  }, []);
  // No `product` state: the tree reads its ticks back out of the query, so
  // there is nothing to persist and nothing that can disagree with the editor.
  // (A stale persisted product key was also a hazard — a renamed product left
  // the old filter applied with the UI showing none.)
  const [expandedAll, setExpandedAll] = useState(false);
  // Index into the rows on screen of the record whose Source Details modal is
  // open; null when closed. An index rather than the record itself so
  // Previous/Next are a simple ±1 and the modal always reflects the current
  // page even if it refreshes underneath.
  const [detailIndex, setDetailIndex] = useState(null);

  // Service inventory for the sidebar's checkbox filter. Fetched once from the
  // discovery endpoint — deliberately NOT derived from the rows on screen,
  // which only ever show a page's worth and would hide every quiet service.
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(true);

  // The Product Catalog drives the sidebar tree. It is also what the BACKEND
  // scopes every logs query to, so this is not a second, competing filter —
  // it is a view of the one already being applied.
  const catalog = useCatalog();
  useEffect(() => {
    const controller = new AbortController();
    // Scoped to the SAME range as the table, and refetched whenever it changes.
    // A fixed 24h window listed 111 services while a 15-minute table had data
    // for 35 — the other 76 returned nothing when ticked and looked like
    // phantom entries.
    //
    // Single source with counts: not fetchServiceNames, which unions in the
    // heartbeat inventory and adds names that never appear in the logs.
    const { startDate, endDate } = rangeToParams(committed.range);
    fetchLogServiceCounts({ startTime: startDate, endTime: endDate, signal: controller.signal })
      .then((list) => { setServices(list); setServicesLoading(false); })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        console.error('Service discovery failed:', err);
        setServicesLoading(false);
      });
    return () => controller.abort();
  }, [committed.range, committed.nonce]);
  const [shareState, setShareState] = useState('');

  // ── Result state ──────────────────────────────────────────────────────────
  const [rows, setRows] = useState([]);
  const [hasMorePages, setHasMorePages] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [totalCount, setTotalCount] = useState(null);
  const [tookMs, setTookMs] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);

  const [sampleRows, setSampleRows] = useState([]);
  const [sampleLoading, setSampleLoading] = useState(false);

  // ── Running the query ─────────────────────────────────────────────────────
  const runQuery = useCallback(({ resetPage = true } = {}) => {
    if (resetPage) setPage(0);
    setCommitted({ query, sqlMode, range: timeRange, nonce: nextNonce() });
  }, [query, sqlMode, timeRange, setPage]);

  /** Re-run exactly what's on screen — used by the refresh buttons and the
   *  auto-refresh timer, which must not pick up unrun editor edits. */
  const rerun = useCallback(() => {
    setCommitted((c) => ({ ...c, nonce: nextNonce() }));
  }, []);

  // Changing the time range is a query change, so it commits immediately —
  // picking "Past 1 Hour" and then having to press Run is the kind of
  // half-applied state that makes a screen feel broken.
  const handleTimeRangeChange = (next) => {
    setTimeRange(next);
    setPage(0);
    setCommitted({ query, sqlMode, range: next, nonce: nextNonce() });
  };

  const handleToggleSqlMode = () => {
    // Carry the expression across rather than clearing it, so flipping the
    // switch to look at the SQL form doesn't cost you what you typed.
    setQuery((q) => {
      if (sqlMode) return fromSql(q);
      return q.trim() ? toSql(q, stream) : sqlTemplate(stream);
    });
    setSqlMode((s) => !s);
  };

  // The per-service multi-select was removed from this screen: the product
  // picker is the scope control now. Service-level filtering is still fully
  // available — click a value under `service.name` in the field list, or write
  // the clause directly in the query editor. `services` is still fetched
  // because the product picker needs it for its counts and coverage list.

  /**
   * Apply an exact set of services to the query and run.
   *
   * Everything in the products tree funnels through here, so ticking a service,
   * ticking a whole product, and typing the clause by hand are all the same
   * operation — there is no separate selection state that could drift from
   * what the editor shows.
   */
  const applyServices = useCallback((names) => {
    const text = withServiceClauses(query, sqlMode, names, stream);
    setQuery(text);
    setPage(0);
    setCommitted({ query: text, sqlMode, range: timeRange, nonce: nextNonce() });
  }, [query, sqlMode, stream, timeRange, setPage]);

  /** Tick/untick one service. Additive: other selections are preserved, so a
   *  filter can span two products. */
  const handleToggleService = useCallback((name) => {
    const next = new Set(draftParse.serviceNames);
    if (next.has(name)) next.delete(name); else next.add(name);
    applyServices(Array.from(next));
  }, [draftParse.serviceNames, applyServices]);

  /**
   * Tick/untick every ENABLED resource in a category, leaving other categories'
   * selections alone.
   *
   * Enabled only, deliberately: a disabled resource returns nothing from the
   * backend, so adding its name would produce a clause that silently narrows the
   * result to zero. Its checkbox is disabled in the tree for the same reason.
   */
  const handleToggleCategory = useCallback((code, select) => {
    const names = categoryServiceNames(catalog.categories, code);
    const next = new Set(draftParse.serviceNames);
    names.forEach((n) => (select ? next.add(n) : next.delete(n)));
    applyServices(Array.from(next));
  }, [draftParse.serviceNames, catalog.categories, applyServices]);

  /**
   * Append `field='value'` to the query and run it. The field sidebar, the
   * histogram legend and the expanded-record `=` buttons all land here.
   *
   * The next query text is computed synchronously and used for BOTH the editor
   * and the commit. Setting the editor first and committing from an effect
   * looks equivalent but isn't: clicking a value that's already in the query
   * produces no state change, so the effect never fires and the queued run
   * leaks onto whatever the user typed next.
   */
  const runWithClause = useCallback((field, value) => {
    const escapedValue = String(value).replaceAll("'", String.raw`\'`);
    const clause = `${field}='${escapedValue}'`;
    const text = query.trim();

    let next;
    if (!text) {
      next = sqlMode ? toSql(clause, stream) : clause;
    } else if (text.includes(clause)) {
      next = query; // already narrowed by this exact clause
    } else if (sqlMode) {
      const where = fromSql(text);
      next = toSql(where ? `${where} AND ${clause}` : clause, stream);
    } else {
      next = `${text} AND ${clause}`;
    }

    setQuery(next);
    setPage(0);
    setCommitted({ query: next, sqlMode, range: timeRange, nonce: nextNonce() });
  }, [query, sqlMode, stream, timeRange, setPage]);

  // ── Service prefill from the Summary drill-through ────────────────────────
  // The Summary screen's Services Uptime card switches to this tab with a
  // service preselected. It becomes a query clause now that the service
  // dropdown is gone. Consumed exactly once.
  useEffect(() => {
    if (!servicePrefill) return;
    runWithClause('service_name', servicePrefill);
    if (onServicePrefillConsumed) onServicePrefillConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servicePrefill]);

  // Trace drill-through from the trace detail view's "View Logs". The bare
  // trace id IS the query: api.js promotes a 32-hex term to the exact traceId
  // parameter, so this is an exact filter rather than a text search. Consumed
  // once, like the service prefill.
  useEffect(() => {
    if (!tracePrefill) return;
    setQuery(tracePrefill);
    setPage(0);
    setCommitted({ query: tracePrefill, sqlMode: false, range: timeRange, nonce: nextNonce() });
    setSqlMode(false);
    if (onTracePrefillConsumed) onTracePrefillConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracePrefill]);

  /**
   * ── Drill-through from another screen ─────────────────────────────────────
   *
   * Two callers, one contract: `{ services, severity, range, traceId }`, meaning
   * "open Logs on exactly this question".
   *
   * The Analytics Dashboard sends it when a severity count is clicked. The clicked
   * cell said "1,062 errors for IoTOpsSvc in the last hour", so all three parts
   * arrive together and all three are applied — a drill that kept this screen's own
   * persisted range would land on a different number than the one that was clicked,
   * which is the one thing a drill-through must never do.
   *
   * An alert's Telemetry panel sends it too, with `severity` blank (an alert's
   * grading is the rule's, not a log level — see alertDrill.js), a `range` around
   * the firing, and `traceId` when the firing named one. Same three rules apply for
   * the same reason: the window IS half the answer, and without it "View logs"
   * lands on the last fifteen minutes of everything.
   *
   * REPLACES the query rather than appending to it. The other prefills above add a
   * clause to what is already there, which is right for them: they narrow the
   * screen you are on. This one answers a question asked somewhere else, so
   * whatever service the operator last had in the editor is not part of it — and
   * because the dialect treats repeated service clauses as a SET, appending would
   * have widened the result to include that stale service rather than narrowing it.
   *
   * The editor's SQL/filter mode is preserved: the drill decides what to ask, not
   * how the operator prefers to read it.
   */
  useEffect(() => {
    if (!filterPrefill) return;
    const {
      services, severity, range, traceId,
    } = filterPrefill;

    let text = withServiceClauses('', sqlMode, services || [], stream);
    text = withSeverityClause(text, sqlMode, severity || '', stream);
    // Appended as a clause rather than replacing the text: a trace id and a
    // service narrow along different axes, and the dialect maps `trace_id` to the
    // backend's exact traceId parameter (see utils/logQuery.js), so this stays an
    // exact filter rather than degrading to a search.
    if (traceId) text = withTraceClause(text, sqlMode, traceId, stream);

    const nextRange = range || timeRange;
    setQuery(text);
    setTimeRange(nextRange);
    setPage(0);
    setCommitted({ query: text, sqlMode, range: nextRange, nonce: nextNonce() });
    if (onFilterPrefillConsumed) onFilterPrefillConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterPrefill]);

  // ── Table fetch ───────────────────────────────────────────────────────────
  const { query: cQuery, sqlMode: cSql, range: cRange, nonce } = committed;
  useEffect(() => {
    // A query that didn't parse has no filters to send, so running it anyway
    // would return the whole stream — the opposite of what was asked for, and
    // indistinguishable from a query that legitimately matched everything.
    if (activeParse.error) {
      setRows([]);
      setHasMorePages(false);
      setIsLoading(false);
      setIsError(true);
      setErrorMessage(activeParse.error);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;

    setIsLoading(true);
    setIsError(false);
    setErrorMessage('');

    const { startDate, endDate } = rangeToParams(cRange);
    const startedAt = performance.now();

    fetchLogs({
      stream,
      serviceName: activeParse.serviceNames,
      severity: activeParse.severity,
      traceId: activeParse.traceId,
      search: activeParse.search,
      startDate,
      endDate,
      page,
      // Fetch exactly one page. Over-fetching and slicing (what this used to
      // do) silently skipped rows, because the backend's offset advances by
      // the *requested* size.
      size: pageSize === -1 ? 500 : pageSize,
      sort: 'timestamp,desc',
      signal: controller.signal,
    }).then(({ items, hasMore, total }) => {
      if (cancelled) return;
      setRows(Array.isArray(items) ? items : []);
      setHasMorePages(!!hasMore);
      setTotalCount(total ?? null);
      setTookMs(Math.round(performance.now() - startedAt));
      setFetchedAt(Date.now());
      setIsLoading(false);
    }).catch((err) => {
      if (cancelled || err.name === 'AbortError') return;
      console.error('Fetch error:', err);
      setRows([]);
      setHasMorePages(false);
      setIsLoading(false);
      setIsError(true);
      setErrorMessage(err.message || '');
    });

    return () => { cancelled = true; controller.abort(); };
    // activeParse is derived from cQuery/cSql, so those two cover it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cQuery, cSql, cRange, nonce, page, pageSize]);

  // ── Sample fetch (histogram + field sidebar) ──────────────────────────────
  // Deliberately independent of `page`: the chart and the field list describe
  // the whole result set, so they must not change as the user pages. Skipped
  // when neither consumer is on screen — the request would be pure backend load.
  const needsSample = histogramVisible || !fieldsCollapsed;
  useEffect(() => {
    if (!needsSample || activeParse.error) {
      setSampleRows([]);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;
    setSampleLoading(true);

    const { startDate, endDate } = rangeToParams(cRange);
    fetchLogs({
      stream,
      serviceName: activeParse.serviceNames,
      severity: activeParse.severity,
      traceId: activeParse.traceId,
      search: activeParse.search,
      startDate,
      endDate,
      page: 0,
      size: SAMPLE_SIZE,
      sort: 'timestamp,desc',
      signal: controller.signal,
    }).then(({ items }) => {
      if (cancelled) return;
      setSampleRows(Array.isArray(items) ? items : []);
      setSampleLoading(false);
    }).catch((err) => {
      if (cancelled || err.name === 'AbortError') return;
      // A failed sample degrades the chart and the field list to their empty
      // states; it must never take the table down with it.
      console.error('Sample fetch failed (histogram / field list):', err);
      setSampleRows([]);
      setSampleLoading(false);
    });

    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cQuery, cSql, cRange, nonce, needsSample]);

  // ── Auto-refresh ──────────────────────────────────────────────────────────

  /**
   * `isLoading`, readable without making the scheduler depend on it.
   *
   * This ref is the whole fix for "auto-refresh doesn't work every time". The
   * scheduler needs to know whether a request is in flight, but it must NOT
   * re-subscribe when that changes: `isLoading` in the dependency list tore the
   * timer down and rebuilt it on EVERY request, so the countdown never measured
   * `refreshSecs` from the previous tick — it restarted from whenever the last
   * fetch happened to finish. At 5s over a ~1.2s query that alone stretched the
   * real period to ~6.2s, and any other state change that triggered a fetch could
   * reset the countdown before it ever reached zero, starving refresh entirely.
   */
  const isLoadingRef = useRef(isLoading);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  /**
   * Why auto-refresh is asleep despite being switched on, or '' when running.
   *
   * Surfaced on the picker rather than left implicit: a clock reading "5s" while
   * nothing reloads is the most confusing state this screen can be in, and both
   * pauses below are deliberate.
   */
  let autoRefreshPaused = '';
  if (refreshSecs && page !== 0) {
    // Polling a later page is incoherent: new rows arrive at the FRONT, so
    // page 3 quietly shows different rows each tick without the user moving.
    autoRefreshPaused = 'Paused while you are off the first page';
  } else if (refreshSecs && cRange.mode === 'absolute') {
    // A fixed start AND end cannot yield new rows however often it is asked.
    // Polling it spends three queries an interval redrawing identical data,
    // and reads to the user as "auto-refresh is broken".
    autoRefreshPaused = 'Paused for a fixed time range — pick a relative range to tail live';
  }

  /**
   * Self-scheduling timeout, deliberately NOT setInterval.
   *
   * Each tick is armed only once the previous one has been dealt with, which is
   * what makes the cadence hold: a query slower than the interval delays the next
   * tick instead of stacking requests, and a tick arriving mid-flight is retried
   * shortly rather than DROPPED. The old `if (!isLoading) rerun()` threw that beat
   * away, so a query routinely slower than the interval missed most refreshes.
   *
   * Calls `rerun`, never `runQuery`: auto-refresh re-runs what is on screen and
   * must never pick up half-typed edits sitting in the editor.
   */
  useEffect(() => {
    if (!refreshSecs || autoRefreshPaused) return undefined;

    let stopped = false;
    let timer;
    const period = refreshSecs * 1000;
    const arm = (ms) => { timer = setTimeout(fire, ms); };

    function fire() {
      if (stopped) return;
      // A hidden tab costs three backend queries an interval for nobody to look
      // at. The timer stays armed, so it resumes by itself.
      if (typeof document !== 'undefined' && document.hidden) {
        arm(period);
        return;
      }
      if (isLoadingRef.current) {
        arm(Math.min(500, period));
        return;
      }
      rerun();
      arm(period);
    }

    arm(period);

    // Returning to the tab should show current logs at once, rather than what was
    // on screen when it was hidden plus up to a full interval of waiting.
    const onVisible = () => {
      if (stopped || document.hidden || isLoadingRef.current) return;
      clearTimeout(timer);
      rerun();
      arm(period);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      stopped = true;
      clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [refreshSecs, autoRefreshPaused, rerun]);

  // ── Toolbar actions ───────────────────────────────────────────────────────
  const handleShare = () => {
    const url = `${window.location.origin}${window.location.pathname}?${
      encodeShare({ query, sqlMode, range: timeRange })}`;
    navigator.clipboard.writeText(url)
      .then(() => {
        setShareState('copied');
        setTimeout(() => setShareState(''), 2000);
      })
      .catch(() => { /* clipboard blocked (insecure origin) — no feedback to give */ });
  };

  const handleSaveView = (name) => {
    setSavedViews((prev) => [
      ...prev.filter((v) => v.name !== name),
      { name, query, sqlMode, range: timeRange },
    ]);
  };
  const handleLoadView = (view) => {
    setQuery(view.query || '');
    setSqlMode(!!view.sqlMode);
    setTimeRange(view.range || DEFAULT_RANGE);
    setPage(0);
    setCommitted({
      query: view.query || '',
      sqlMode: !!view.sqlMode,
      range: view.range || DEFAULT_RANGE,
      nonce: nextNonce(),
    });
  };
  const handleDeleteView = (name) =>
    setSavedViews((prev) => prev.filter((v) => v.name !== name));

  /**
   * Clicking a severity in the chart legend filters the table to it; clicking
   * the active one clears the filter. Single click, because a chart legend
   * that needs a double-click to do the obvious thing reads as inert — which
   * is exactly how the previous mute-on-single/filter-on-double behaved.
   */
  const activeSeverity = activeParse.severity || '';
  const handleSeverityFromLegend = useCallback((sev) => {
    const clause = `severity_text='${sev}'`;
    const text = query.trim();
    const isOn = activeSeverity.toUpperCase() === String(sev).toUpperCase();

    let next;
    if (isOn) {
      // Toggle off: drop every severity clause, leave the rest of the query.
      next = withoutSeverityClauses(query, sqlMode, stream);
    } else if (!text) {
      next = sqlMode ? toSql(clause, stream) : clause;
    } else {
      const base = withoutSeverityClauses(query, sqlMode, stream);
      const where = sqlMode ? fromSql(base) : base;
      const combined = where ? `${where} AND ${clause}` : clause;
      next = sqlMode ? toSql(combined, stream) : combined;
    }

    setQuery(next);
    setPage(0);
    setCommitted({ query: next, sqlMode, range: timeRange, nonce: nextNonce() });
  }, [query, sqlMode, stream, timeRange, activeSeverity, setPage]);

  const displayedRows = useMemo(
    () => (pageSize === -1 ? rows : rows.slice(0, pageSize)),
    [rows, pageSize],
  );

  // A refresh, a new page or a new query can shrink the row set out from under
  // an open modal; close it rather than leaving it pointing at a row that is
  // no longer there.
  useEffect(() => {
    if (detailIndex != null && detailIndex >= displayedRows.length) setDetailIndex(null);
  }, [detailIndex, displayedRows.length]);

  const handleOpenDetails = useCallback((log) => {
    const i = displayedRows.indexOf(log);
    if (i >= 0) setDetailIndex(i);
  }, [displayedRows]);

  /**
   * "Search Around": re-point the query at a window centred on this record so
   * the table shows what happened either side of it.
   *
   * The current filters are deliberately DROPPED. The question being asked is
   * "what else was happening at this instant", and keeping a service or
   * severity filter would answer a narrower question than the button implies.
   * The window is derived from the requested event count so asking for 100
   * events looks wider than asking for 10.
   */
  const handleSearchAround = useCallback((log, count) => {
    const t = Date.parse(log?.timestamp);
    if (!Number.isFinite(t)) return;

    const halfSpanMs = Math.max(30_000, count * 1_500);
    const toLocalInput = (ms) => {
      const d = new Date(ms - d0Offset(ms));
      return d.toISOString().slice(0, 19);
    };

    const range = {
      mode: 'absolute',
      relative: timeRange.relative,
      from: toLocalInput(t - halfSpanMs),
      to: toLocalInput(t + halfSpanMs),
    };

    setDetailIndex(null);
    setQuery('');
    setPage(0);
    setPageSize(count);
    setTimeRange(range);
    setCommitted({ query: '', sqlMode, range, nonce: nextNonce() });
  }, [sqlMode, timeRange.relative, setPage, setPageSize]);

  return (
    <div className="logs-container logs-container--split">
      <LogsToolbar
        sqlMode={sqlMode}
        onToggleSqlMode={handleToggleSqlMode}
        histogramVisible={histogramVisible}
        onToggleHistogram={() => setHistogramVisible((v) => !v)}
        fieldsCollapsed={fieldsCollapsed}
        onToggleFields={() => setFieldsCollapsed((c) => !c)}
        editorCollapsed={editorCollapsed}
        onToggleEditor={() => setEditorCollapsed((c) => !c)}
        timeRange={timeRange}
        onTimeRangeChange={handleTimeRangeChange}
        refreshSecs={refreshSecs}
        onRefreshSecsChange={setRefreshSecs}
        refreshPausedReason={autoRefreshPaused}
        onRun={runQuery}
        isRunning={isLoading}
        // A query that doesn't parse can't be run — the button says so rather
        // than accepting the click and returning the unfiltered stream.
        runDisabled={!!draftParse.error}
        isDirty={isDirty}
        savedViews={savedViews}
        onSaveView={handleSaveView}
        onLoadView={handleLoadView}
        onDeleteView={handleDeleteView}
        onShare={handleShare}
        shareState={shareState}
        onDownload={(fmt) => downloadRows(displayedRows, fmt)}
      />

      <QueryEditor
        value={query}
        onChange={setQuery}
        onRun={runQuery}
        sqlMode={sqlMode}
        collapsed={editorCollapsed}
        onToggleCollapsed={() => setEditorCollapsed((c) => !c)}
        warnings={draftParse.warnings}
        error={draftParse.error}
        placeholder={sqlMode
          ? `SELECT * FROM "${stream}" WHERE severity_text='ERROR'`
          : "severity_text='ERROR' AND service_name='iotopsservice'"}
      />

      <div className="logs-body">
        <LogFieldSidebar
          rows={sampleRows}
          loading={sampleLoading}
          collapsed={fieldsCollapsed}
          onToggleCollapsed={() => setFieldsCollapsed((c) => !c)}
          streams={streams}
          stream={stream}
          onStreamChange={setStream}
          services={services}
          servicesLoading={servicesLoading}
          selectedServices={draftParse.serviceNames}
          onToggleService={handleToggleService}
          onToggleCategory={handleToggleCategory}
          catalogCategories={catalog.categories}
          catalogLoading={catalog.loading}
          catalogError={catalog.error}
          onNavigateToCatalog={onNavigate ? () => onNavigate('catalog') : undefined}
          onValueClick={runWithClause}
          onRefresh={rerun}
        />

        <section className="logs-main">
          <LogResultsBar
            page={page}
            setPage={setPage}
            pageSize={pageSize}
            setPageSize={setPageSize}
            rowCount={displayedRows.length}
            total={totalCount}
            tookMs={tookMs}
            fetchedAt={fetchedAt}
            unit="events"
            loading={isLoading}
            onRefresh={rerun}
            histogramVisible={histogramVisible}
            onToggleHistogram={() => setHistogramVisible((v) => !v)}
            hasMore={hasMorePages}
            showExpandAll
            expandedAll={expandedAll}
            onToggleExpandedAll={() => setExpandedAll((v) => !v)}
          />

          {histogramVisible && (
            <LogHistogram
              rows={sampleRows}
              loading={sampleLoading}
              sampleLimit={SAMPLE_SIZE}
              onSeverityClick={handleSeverityFromLegend}
              activeSeverity={activeSeverity}
            />
          )}

          <LogTable
            rows={displayedRows}
            hoveredTraceId={hoveredTraceId}
            setHoveredTraceId={setHoveredTraceId}
            onTraceClick={onTraceClick}
            highlight={activeParse.search}
            onFieldFilter={runWithClause}
            expandedAll={expandedAll}
            onOpenDetails={handleOpenDetails}
            isLoading={isLoading}
            isError={isError}
            errorMessage={errorMessage}
            hasQuery={!!committed.query.trim()}
          />
        </section>
      </div>

      {detailIndex != null && displayedRows[detailIndex] && (
        <LogDetailsModal
          log={displayedRows[detailIndex]}
          index={detailIndex}
          total={displayedRows.length}
          onPrev={() => setDetailIndex((i) => Math.max(0, i - 1))}
          onNext={() => setDetailIndex((i) => Math.min(displayedRows.length - 1, i + 1))}
          onClose={() => setDetailIndex(null)}
          onSearchAround={handleSearchAround}
          // The same handler the inline expanded row uses, so "Open trace"
          // behaves identically whichever gesture opened the record.
          onTraceClick={onTraceClick}
        />
      )}
    </div>
  );
}

/**
 * Offset in ms between a UTC instant and the same wall clock locally.
 *
 * `datetime-local` inputs speak local wall time with no zone, so an instant has
 * to be shifted by the zone offset before being sliced into that format —
 * otherwise a "search around 14:00 IST" would populate the picker with 08:30.
 */
function d0Offset(ms) {
  return new Date(ms).getTimezoneOffset() * 60_000;
}

LogsView.propTypes = {
  onTraceClick: PropTypes.func.isRequired,
  hoveredTraceId: PropTypes.string,
  setHoveredTraceId: PropTypes.func,
  page: PropTypes.number.isRequired,
  setPage: PropTypes.func.isRequired,
  pageSize: PropTypes.number.isRequired,
  setPageSize: PropTypes.func.isRequired,
  servicePrefill: PropTypes.string,
  onServicePrefillConsumed: PropTypes.func,
  /** Trace id from the trace view's "View Logs"; scopes the table to it. */
  tracePrefill: PropTypes.string,
  onTracePrefillConsumed: PropTypes.func,

  /** Drill-through from the Analytics dashboard or an alert's Telemetry panel:
   *  the services, severity, trace and time range the click stood for. Applied as
   *  a whole, replacing the current query — see the effect for why. */
  filterPrefill: PropTypes.shape({
    services: PropTypes.arrayOf(PropTypes.string),
    severity: PropTypes.string,
    traceId: PropTypes.string,
    range: PropTypes.object,
  }),
  onFilterPrefillConsumed: PropTypes.func,
  /** (tabKey) — switch top-level screen. Used to offer a jump to the Product
   *  Catalog from a category with nothing registered in it. */
  onNavigate: PropTypes.func,
};

export default LogsView;
