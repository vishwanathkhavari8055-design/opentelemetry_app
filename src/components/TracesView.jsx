import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  fetchSpans, fetchTraceList, fetchServiceCatalog, fetchTraceHistogram,
  fetchStreams,
} from '../services/api';
import {
  parseTraceQuery, toSql, fromSql, sqlTemplate, withServiceClauses, withTraceClause,
} from '../utils/logQuery';
import useCatalog, { categoryServiceNames } from './common/useCatalog';
import { formatCount } from '../utils/format';
import TracesToolbar from './traces/TracesToolbar';
import QueryEditor from './logs/QueryEditor';
import LogFieldSidebar from './logs/LogFieldSidebar';
import LogResultsBar from './logs/LogResultsBar';
import TraceCharts from './traces/TraceCharts';
import SpansTable from './traces/SpansTable';
import TracesTable from './traces/TracesTable';
import ServiceCatalogTable from './traces/ServiceCatalogTable';
import TraceDetail from './traces/TraceDetail';

/**
 * Container for the Traces screen: three tabs over one shared query.
 *
 *   Spans            flat span-grain listing
 *   Traces           trace-grain listing with a service-latency breakdown
 *   Service Catalog  per-service volume, error rate and latency percentiles
 *
 * The query, the time range and the error-only switch are shared across all
 * three, so switching tabs re-asks the same question a different way rather
 * than resetting what you were looking at.
 *
 * Same draft/committed split as LogsView: only `committed` is a fetch
 * dependency, so typing in the editor never re-queries and "Run query" means
 * something. See utils/logQuery.js — parseTraceQuery maps the same grammar
 * onto the traces stream's columns.
 *
 * Clicking any row in the Spans or Traces tables opens TraceDetail — the
 * waterfall / flame graph / trace graph view for that trace.
 */

/** Fallback until /api/streams?type=traces answers, and the answer itself if that
 *  call fails — an empty picker would offer no queryable stream at all. */
const FALLBACK_STREAM = 'default';

/** Fields the sidebar hides for spans: the typed duplicates the API adds on top
 *  of the raw document, which would otherwise appear twice. */
const TRACE_HIDDEN_FIELDS = new Set([
  'raw', 'timestamp', 'traceId', 'spanId', 'serviceName', 'operationName',
  'durationUs', 'spanStatus',
]);

const LS = {
  tab:       'observability-ui:traces:tab:v1',
  query:     'observability-ui:traces:query:v1',
  sqlMode:   'observability-ui:traces:sql-mode:v1',
  timeRange: 'observability-ui:traces:time-range:v1',
  refresh:   'observability-ui:traces:refresh-secs:v1',
  fields:    'observability-ui:traces:fields-collapsed:v1',
  charts:    'observability-ui:traces:charts:v1',
  editor:    'observability-ui:traces:editor-collapsed:v1',
  errors:    'observability-ui:traces:errors-only:v1',
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

const DEFAULT_RANGE = { mode: 'relative', relative: '15m', from: '', to: '' };

/** Months aren't in the backend's `now-(\d+)([smhdw])` grammar — see LogsView. */
const toBackendUnit = (rel) => {
  const m = /^(\d+)M$/.exec(rel);
  return m ? `${Number(m[1]) * 30}d` : rel;
};

const rangeToParams = (range) => {
  if (range.mode === 'absolute') {
    const iso = (local) => {
      if (!local) return '';
      const d = new Date(local);
      return Number.isNaN(d.getTime()) ? '' : d.toISOString();
    };
    return { startTime: iso(range.from), endTime: iso(range.to) };
  }
  return { startTime: `now-${toBackendUnit(range.relative || '15m')}`, endTime: '' };
};

const downloadJson = (rows, filename) => {
  if (!rows?.length) return;
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export default function TracesView({
  drillPrefill, onDrillPrefillConsumed, traceId, onTraceIdChange,
}) {
  // The Product Catalog behind the sidebar tree. Named distinctly from the
  // `catalog` further down, which is this screen's own SERVICE catalog tab —
  // two different things that would be one very confusing identifier.
  const productCatalog = useCatalog();

  // ── Draft state ───────────────────────────────────────────────────────────
  const [tab, setTab] = useState(() => {
    const t = readLS(LS.tab, 'spans');
    return ['spans', 'traces', 'catalog'].includes(t) ? t : 'spans';
  });
  const [query, setQuery] = useState(() => readLS(LS.query, ''));
  const [sqlMode, setSqlMode] = useState(() => readLS(LS.sqlMode, false));
  const [timeRange, setTimeRange] = useState(() => readLS(LS.timeRange, DEFAULT_RANGE));
  const [errorsOnly, setErrorsOnly] = useState(() => readLS(LS.errors, false));

  // ── Committed state ───────────────────────────────────────────────────────
  const [committed, setCommitted] = useState(() => ({
    query: readLS(LS.query, ''),
    sqlMode: readLS(LS.sqlMode, false),
    range: readLS(LS.timeRange, DEFAULT_RANGE),
    errorsOnly: readLS(LS.errors, false),
    nonce: 0,
  }));

  const isDirty = query !== committed.query
    || sqlMode !== committed.sqlMode
    || errorsOnly !== committed.errorsOnly
    || JSON.stringify(timeRange) !== JSON.stringify(committed.range);

  useEffect(() => { writeLS(LS.tab, tab); }, [tab]);
  useEffect(() => { writeLS(LS.query, query); }, [query]);
  useEffect(() => { writeLS(LS.sqlMode, sqlMode); }, [sqlMode]);
  useEffect(() => { writeLS(LS.timeRange, timeRange); }, [timeRange]);
  useEffect(() => { writeLS(LS.errors, errorsOnly); }, [errorsOnly]);

  const draftParse = useMemo(() => parseTraceQuery(query, sqlMode), [query, sqlMode]);
  const activeParse = useMemo(
    () => parseTraceQuery(committed.query, committed.sqlMode),
    [committed.query, committed.sqlMode],
  );

  // ── Layout prefs ──────────────────────────────────────────────────────────
  const [fieldsCollapsed, setFieldsCollapsed] = useState(() => readLS(LS.fields, false));
  const [chartsVisible, setChartsVisible] = useState(() => readLS(LS.charts, true));
  const [editorCollapsed, setEditorCollapsed] = useState(() => readLS(LS.editor, false));
  const [refreshSecs, setRefreshSecs] = useState(() => readLS(LS.refresh, 0));
  useEffect(() => { writeLS(LS.fields, fieldsCollapsed); }, [fieldsCollapsed]);
  useEffect(() => { writeLS(LS.charts, chartsVisible); }, [chartsVisible]);
  useEffect(() => { writeLS(LS.editor, editorCollapsed); }, [editorCollapsed]);
  useEffect(() => { writeLS(LS.refresh, refreshSecs); }, [refreshSecs]);

  const [stream, setStream] = useState(FALLBACK_STREAM);

  /** Trace streams this tenant has. Discovered for the SAME reason the logs picker
   *  is: the list belongs to the tenant, not to this file. */
  const [streams, setStreams] = useState([FALLBACK_STREAM]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetchStreams({ type: 'traces', signal: controller.signal })
      .then((names) => {
        if (cancelled) return;
        const merged = names.includes(FALLBACK_STREAM) ? names : [FALLBACK_STREAM, ...names];
        setStreams(merged.length ? merged : [FALLBACK_STREAM]);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        console.warn('Trace stream list unavailable:', err.message);
      });
    return () => { cancelled = true; controller.abort(); };
  }, []);
  const [catalogFilter, setCatalogFilter] = useState('');

  // Service inventory for the products tree and the service.name checkboxes.
  //
  // The trace catalog alone, scoped to the SAME range as the table. It is one
  // GROUP BY over the traces stream, so it is authoritative for "which
  // services emitted spans in this window" and carries a request count per
  // service for free.
  //
  // Previously this unioned in fetchServiceNames (which covers services that
  // LOG) over a fixed 24h window. Both were wrong here: a service that logs
  // but emits no spans can never match a trace query, and a fixed window
  // offered services with no data in the range the user is actually looking
  // at — they read as phantom entries because ticking them returned nothing.
  const [services, setServices] = useState([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const { startTime, endTime } = rangeToParams(committed.range);

    fetchServiceCatalog({ startTime, endTime, size: 1000, signal: controller.signal })
      .then((res) => {
        if (cancelled) return;
        const seen = new Set();
        setServices((res?.items || [])
          .map((r) => ({ name: (r.serviceName || '').trim(), count: r.requests ?? null }))
          .filter((r) => r.name && r.name !== 'unknown-service' && r.name !== '-'
            && !seen.has(r.name) && seen.add(r.name))
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
        setServicesLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        console.error('Trace service discovery failed:', err);
        setServicesLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
  }, [committed.range, committed.nonce]);

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);

  // ── Results ───────────────────────────────────────────────────────────────
  const [listData, setListData] = useState({ items: [], total: null, errorTotal: null, hasMore: false });
  const [catalog, setCatalog] = useState(null);
  const [charts, setCharts] = useState({ buckets: [], interval: '' });
  const [loading, setLoading] = useState(false);
  const [chartsLoading, setChartsLoading] = useState(false);
  const [error, setError] = useState('');
  const [tookMs, setTookMs] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);

  // The open trace drill-down. CONTROLLED by the shell rather than held here:
  // the shell writes the open trace into the address bar so that a reload comes
  // back to it, and a value it cannot see is a value it cannot write. Everything
  // below still decides when a trace opens and closes — a row click, the alert
  // drill, the Back button — it just says so upwards instead of inwards.
  //
  // Local aliases so those call sites read exactly as they did.
  const selectedTraceId = traceId || null;
  const setSelectedTraceId = onTraceIdChange;

  // ── Running ───────────────────────────────────────────────────────────────
  const runQuery = useCallback(() => {
    setPage(0);
    setCommitted({ query, sqlMode, range: timeRange, errorsOnly, nonce: Date.now() });
  }, [query, sqlMode, timeRange, errorsOnly]);

  const rerun = useCallback(() => {
    setCommitted((c) => ({ ...c, nonce: Date.now() }));
  }, []);

  // Range and the errors switch commit immediately — they're pickers, not text,
  // so there is nothing half-typed to protect and making the user press Run
  // after flipping a toggle reads as the toggle being broken.
  const commitWith = (patch) => {
    setPage(0);
    setCommitted({ query, sqlMode, range: timeRange, errorsOnly, ...patch, nonce: Date.now() });
  };
  const handleTimeRangeChange = (next) => { setTimeRange(next); commitWith({ range: next }); };
  const handleToggleErrorsOnly = () => {
    const next = !errorsOnly;
    setErrorsOnly(next);
    commitWith({ errorsOnly: next });
  };

  const handleToggleSqlMode = () => {
    setQuery((q) => {
      if (sqlMode) return fromSql(q);
      return q.trim() ? toSql(q, stream) : sqlTemplate(stream);
    });
    setSqlMode((s) => !s);
  };

  /** Append `field='value'` to the query and run. Computed synchronously so the
   *  commit uses the new text rather than the previous render's. */
  const runWithClause = useCallback((field, value) => {
    const escapedValue = String(value).replaceAll("'", String.raw`\'`);
    const clause = `${field}='${escapedValue}'`;
    const text = query.trim();
    let next;
    if (!text) next = sqlMode ? toSql(clause, stream) : clause;
    else if (text.includes(clause)) next = query;
    else if (sqlMode) {
      const where = fromSql(text);
      next = toSql(where ? `${where} AND ${clause}` : clause, stream);
    } else next = `${text} AND ${clause}`;

    setQuery(next);
    setPage(0);
    setCommitted({ query: next, sqlMode, range: timeRange, errorsOnly, nonce: Date.now() });
  }, [query, sqlMode, stream, timeRange, errorsOnly]);

  /**
   * Set the query's service filter to exactly these services and run. Rewrites
   * the service_name clauses rather than appending, so unticking a box removes
   * the filter — the checkbox and the editor are one state, not two.
   */
  const handleServicesChange = useCallback((next) => {
    const text = withServiceClauses(query, sqlMode, next, stream);
    setQuery(text);
    setPage(0);
    setCommitted({ query: text, sqlMode, range: timeRange, errorsOnly, nonce: Date.now() });
  }, [query, sqlMode, stream, timeRange, errorsOnly]);

  /** Tick/untick one service. Additive, so a filter can span two products. */
  const handleToggleService = useCallback((name) => {
    const next = new Set(draftParse.serviceNames);
    if (next.has(name)) next.delete(name); else next.add(name);
    handleServicesChange(Array.from(next));
  }, [draftParse.serviceNames, handleServicesChange]);

  /**
   * Tick/untick every ENABLED resource in a category, leaving others alone.
   *
   * Enabled only: the backend returns nothing for a disabled resource, so
   * including its name would add a clause that silently empties the result.
   */
  const handleToggleCategory = useCallback((code, select) => {
    const names = categoryServiceNames(productCatalog.categories, code);
    const next = new Set(draftParse.serviceNames);
    names.forEach((n) => (select ? next.add(n) : next.delete(n)));
    handleServicesChange(Array.from(next));
  }, [draftParse.serviceNames, productCatalog.categories, handleServicesChange]);

  /**
   * ── Drill-through from an alert's Telemetry panel ─────────────────────────
   *
   * `{ services, traceId, openTrace, range }`, built in
   * components/alerts/alertDrill.js. Consumed exactly once, like every other
   * prefill in this application.
   *
   * REPLACES the query rather than adding to it, and applies the range. Before
   * this prop existed the alert's "View traces" button did neither — it switched
   * tab and left the screen on whatever query and range it happened to be holding,
   * which is why it looked like it was showing "all traces": it was.
   *
   * A trace id opens that trace's waterfall directly. It identifies exactly one
   * trace, so listing it as a single-row table and asking the operator to click it
   * would be a step that can only have one outcome. The list underneath is still
   * scoped and committed first, so Back lands on the alert's service and window
   * rather than on whatever was there before.
   */
  useEffect(() => {
    if (!drillPrefill) return;
    const { services, traceId, openTrace, range } = drillPrefill;

    let text = withServiceClauses('', sqlMode, services || [], stream);
    if (traceId) text = withTraceClause(text, sqlMode, traceId, stream);
    const nextRange = range || timeRange;

    setQuery(text);
    setTimeRange(nextRange);
    setPage(0);
    // An alert never asks for "the errors in this window" — it asks for the
    // telemetry behind ONE firing, which is not necessarily an error span, and a
    // switch left on from an earlier session would silently hide it. Cleared in
    // the committed object as well as in the draft: committing the old value would
    // leave the toolbar reading "off" while the query still filtered on it.
    setErrorsOnly(false);
    setCommitted({
      query: text, sqlMode, range: nextRange, errorsOnly: false, nonce: Date.now(),
    });
    setSelectedTraceId(openTrace && traceId ? traceId : null);

    if (onDrillPrefillConsumed) onDrillPrefillConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drillPrefill]);

  // ── Shared request shape ──────────────────────────────────────────────────
  const { query: cQuery, sqlMode: cSql, range: cRange, errorsOnly: cErrors, nonce } = committed;

  const baseParams = useMemo(() => {
    const { startTime, endTime } = rangeToParams(cRange);
    return {
      // Repeated param: the backend ORs them into a service_name IN (...).
      serviceNames: activeParse.serviceNames,
      traceId: activeParse.traceId || '',
      spanName: activeParse.operationName || '',
      // The toolbar switch wins over a span_status clause: it's the more
      // recent, more visible action, and having both fight would leave the
      // switch looking inert.
      outcome: cErrors ? 'ERROR' : (activeParse.outcome || ''),
      search: activeParse.search || '',
      startTime,
      endTime,
    };
  }, [activeParse, cRange, cErrors]);

  // ── Table fetch ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeParse.error) {
      setListData({ items: [], total: null, errorTotal: null, hasMore: false });
      setCatalog(null);
      setError(activeParse.error);
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');
    const startedAt = performance.now();

    let req;
    if (tab === 'catalog') {
      req = fetchServiceCatalog({ ...baseParams, size: 1000, signal: controller.signal });
    } else {
      const fetcher = tab === 'traces' ? fetchTraceList : fetchSpans;
      req = fetcher({
        ...baseParams, page, size: pageSize, signal: controller.signal,
      });
    }

    req.then((data) => {
      if (cancelled) return;
      if (tab === 'catalog') {
        setCatalog(data);
      } else {
        setListData({
          items: data.items || [],
          total: data.total ?? null,
          errorTotal: data.errorTotal ?? null,
          hasMore: !!data.hasMore,
        });
      }
      if (data?.supported === false) {
        setError('Traces analytics requires the OpenObserve backend.');
      }
      setTookMs(Math.round(performance.now() - startedAt));
      setFetchedAt(Date.now());
      setLoading(false);
    }).catch((err) => {
      if (cancelled || err.name === 'AbortError') return;
      console.error('Traces fetch failed:', err);
      setListData({ items: [], total: null, errorTotal: null, hasMore: false });
      setCatalog(null);
      setError(err.message || 'Request failed.');
      setLoading(false);
    });

    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, cQuery, cSql, cRange, cErrors, nonce, page, pageSize]);

  // ── Charts fetch ──────────────────────────────────────────────────────────
  // Independent of `page`: the charts describe the whole window, so they must
  // not change as the user pages. Skipped on the catalog tab and when hidden.
  const needCharts = chartsVisible && tab !== 'catalog';
  useEffect(() => {
    if (!needCharts || activeParse.error) {
      setCharts({ buckets: [], interval: '' });
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setChartsLoading(true);

    fetchTraceHistogram({ ...baseParams, signal: controller.signal })
      .then((d) => {
        if (cancelled) return;
        setCharts({ buckets: d.buckets || [], interval: d.interval || '' });
        setChartsLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // A failed chart must never take the table down with it.
        console.error('Trace histogram failed:', err);
        setCharts({ buckets: [], interval: '' });
        setChartsLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needCharts, cQuery, cSql, cRange, cErrors, nonce]);

  // ── Auto-refresh ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!refreshSecs) return undefined;
    if (page !== 0) return undefined;
    const id = setInterval(() => { if (!loading) rerun(); }, refreshSecs * 1000);
    return () => clearInterval(id);
  }, [refreshSecs, page, loading, rerun]);

  // Spans carry their whole source document; the field explorer reads that so
  // it lists every attribute the agent captured, not just the table's columns.
  const sidebarRows = useMemo(
    () => (tab === 'spans' ? listData.items.map((s) => s.raw || s) : listData.items),
    [tab, listData.items],
  );

  const prevTab = useRef(tab);
  useEffect(() => {
    // Page indices don't carry across tabs — page 3 of spans is not page 3 of
    // traces — so switching resets to the first page.
    if (prevTab.current !== tab) { setPage(0); prevTab.current = tab; }
  }, [tab]);

  if (selectedTraceId) {
    return <TraceDetail traceId={selectedTraceId} onBack={() => setSelectedTraceId(null)} />;
  }

  const isCatalog = tab === 'catalog';
  const unit = tab === 'traces' ? 'traces' : 'spans';

  return (
    <div className="traces-view traces-view--oo">
      <TracesToolbar
        tab={tab}
        onTabChange={setTab}
        chartsVisible={chartsVisible}
        onToggleCharts={() => setChartsVisible((v) => !v)}
        fieldsCollapsed={fieldsCollapsed}
        onToggleFields={() => setFieldsCollapsed((c) => !c)}
        editorCollapsed={editorCollapsed}
        onToggleEditor={() => setEditorCollapsed((c) => !c)}
        errorsOnly={errorsOnly}
        onToggleErrorsOnly={handleToggleErrorsOnly}
        sqlMode={sqlMode}
        onToggleSqlMode={handleToggleSqlMode}
        timeRange={timeRange}
        onTimeRangeChange={handleTimeRangeChange}
        refreshSecs={refreshSecs}
        onRefreshSecsChange={setRefreshSecs}
        onRun={runQuery}
        isRunning={loading}
        isDirty={isDirty}
        runDisabled={!!draftParse.error}
        onDownload={() => downloadJson(
          isCatalog ? (catalog?.items || []) : listData.items,
          `${tab}.json`,
        )}
      />

      {!isCatalog && (
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
            ? `SELECT * FROM "${stream}" WHERE service_name='SSOservice'`
            : "service_name='SSOservice' AND span_status='ERROR'"}
        />
      )}

      <div className="logs-body">
        {!isCatalog && (
          <LogFieldSidebar
            rows={sidebarRows}
            loading={loading}
            collapsed={fieldsCollapsed}
            onToggleCollapsed={() => setFieldsCollapsed((c) => !c)}
            streams={streams}
            stream={stream}
            onStreamChange={setStream}
            services={services}
            selectedServices={draftParse.serviceNames}
            servicesLoading={servicesLoading}
            onToggleService={handleToggleService}
            onToggleCategory={handleToggleCategory}
            catalogCategories={productCatalog.categories}
            catalogLoading={productCatalog.loading}
            catalogError={productCatalog.error}
            onValueClick={runWithClause}
            onRefresh={rerun}
            hiddenFields={TRACE_HIDDEN_FIELDS}
          />
        )}

        <section className="logs-main">
          {isCatalog ? (
            <ServiceCatalogTable
              data={catalog}
              loading={loading}
              error={error}
              filter={catalogFilter}
              onFilterChange={setCatalogFilter}
              onServiceClick={(name) => {
                setTab('spans');
                runWithClause('service_name', name);
              }}
            />
          ) : (
            <>
              <div className="tv-summary">
                <span className="tv-chip">
                  {formatCount(listData.total)} {unit === 'traces' ? 'Traces' : 'Spans'} Found
                </span>
                {listData.errorTotal != null && (
                  <span className="tv-chip tv-chip--error">
                    {formatCount(listData.errorTotal)} Error {unit === 'traces' ? 'Traces' : 'Spans'}
                  </span>
                )}
              </div>

              <LogResultsBar
                page={page}
                setPage={setPage}
                pageSize={pageSize}
                setPageSize={setPageSize}
                rowCount={listData.items.length}
                total={listData.total}
                tookMs={tookMs}
                fetchedAt={fetchedAt}
                unit={unit}
                loading={loading}
                onRefresh={rerun}
                histogramVisible={chartsVisible}
                onToggleHistogram={() => setChartsVisible((v) => !v)}
                hasMore={listData.hasMore}
              />

              {chartsVisible && (
                <TraceCharts
                  buckets={charts.buckets}
                  interval={charts.interval}
                  loading={chartsLoading}
                />
              )}

              {tab === 'traces' ? (
                <TracesTable
                  rows={listData.items}
                  loading={loading}
                  error={error}
                  onTraceClick={setSelectedTraceId}
                />
              ) : (
                <SpansTable
                  rows={listData.items}
                  loading={loading}
                  error={error}
                  onTraceClick={setSelectedTraceId}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

TracesView.propTypes = {
  /** Alert drill-through: `{ services, traceId, openTrace, range }`. Applied as a
   *  whole and then cleared — see the effect for why it replaces rather than adds. */
  drillPrefill: PropTypes.shape({
    services: PropTypes.arrayOf(PropTypes.string),
    traceId: PropTypes.string,
    openTrace: PropTypes.bool,
    range: PropTypes.object,
  }),
  onDrillPrefillConsumed: PropTypes.func,
  /** The open trace drill-down, owned by the shell so it can be restored from the
   *  URL on reload. Null (or absent) shows this screen's tables. */
  traceId: PropTypes.string,
  /** Called with a trace id to open it, and with null to return to the tables. */
  onTraceIdChange: PropTypes.func.isRequired,
};
