import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import PropTypes from 'prop-types';
import SummaryView from './SummaryView';
import MetricCatalog from './metrics/MetricCatalog';
import MetricChart, { seriesLabel, varyingLabels } from './metrics/MetricChart';
import ServiceMetricsView from './metrics/ServiceMetricsView';
import TimeRangePicker from './logs/TimeRangePicker';
import RefreshIntervalPicker from './logs/RefreshIntervalPicker';
import {
  fetchMetricCatalog, fetchMetricRange, fetchMetricLabels, fetchMetricLabelValues,
} from '../services/api';
import { resolveMetricIdentity } from './alerts/alertDrill';
import { formatCount } from '../utils/format';

/**
 * The Metrics screen.
 *
 * Two views over the same catalogue, because there are two questions:
 *
 *   Explorer   — metric first. "What does this metric measure, and plot it."
 *   By service — service first. "What does this service expose?" That one
 *                cannot be answered from the metric catalogue at all; it needs
 *                the inverted index from /api/metrics/producers.
 *
 * The second exists because 3,215 metric names in one list gives you no way in
 * when what you know is the service, not the metric name. Picking a metric over
 * there hands it back to the Explorer with a service_name filter already
 * applied — see openMetricForService.
 *
 * The Summary sub-tab (the four cards this screen used to render directly, via
 * SummaryView) is HIDDEN — see SHOW_SUMMARY_TAB below.
 *
 * DRAFT vs COMMITTED, as on Logs and Traces: typing in the query box changes
 * `draft` and nothing else. Only Run (or Ctrl+Enter, or an auto-refresh tick)
 * copies it into `committed`, which is what the fetch effect depends on.
 * Without that split, every keystroke fires a PromQL query — expensive here,
 * because a half-typed expression is usually a parse error the engine still
 * has to reject.
 */

/**
 * Whether the Summary sub-tab is offered.
 *
 * Off by request. Kept as a flag rather than deleted because SummaryView is
 * otherwise unreachable from the app — this screen is its only route (the
 * web-component entry in wc-entry.jsx mounts it separately). Flipping this to
 * true restores the tab strip and the four cards with no other edit.
 */
const SHOW_SUMMARY_TAB = false;

const TABS = [
  { key: 'explorer', label: 'Explorer' },
  { key: 'services', label: 'By service' },
  { key: 'summary', label: 'Summary' },
];

const DEFAULT_RANGE = { mode: 'relative', relative: '1h', from: '', to: '' };

const LS_QUERY = 'observability-ui:metrics:query:v1';
const LS_RANGE = 'observability-ui:metrics:range:v1';
/** Which sub-tab was open. Remembered for the same reason the query and the
 *  range above already are: a reload should hand back the screen it left rather
 *  than a reset one. The shell restores WHICH screen is open (it writes the tab
 *  into the URL fragment); this restores which face of this one, exactly as
 *  Settings and Analytics already do for theirs. */
const LS_TAB = 'observability-ui:metrics:tab:v1';

const readLS = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
};
const writeLS = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* private mode — the preference just won't persist */ }
};

/**
 * The backend's TimeRangeParser matches `now-(\d+)([smhdw])` — no month unit —
 * so months are converted to days, exactly as LogsView does. Keeping the two
 * in step matters: a range that works on Logs and silently fails on Metrics is
 * worse than one that fails on both.
 */
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
  return { startTime: `now-${toBackendUnit(range.relative || '1h')}`, endTime: '' };
};

/** Seconds spanned by the committed range — used to label the auto step. */
const spanSeconds = (range) => {
  if (range.mode === 'absolute') {
    const a = new Date(range.from).getTime();
    const b = new Date(range.to).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? (b - a) / 1000 : 3600;
  }
  const m = /^(\d+)([smhdwM])$/.exec(range.relative || '1h');
  if (!m) return 3600;
  const mult = {
    s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000,
  }[m[2]] || 3600;
  return Number(m[1]) * mult;
};

/**
 * PromQL words that are NOT metric selectors, so a label filter must never be
 * attached to them. Aggregators are in here because `sum by (x) (...)` puts the
 * aggregator's name in front of everything with no bracket directly after it.
 */
const NOT_A_SELECTOR = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
  'and', 'or', 'unless', 'offset', 'bool', 'start', 'end',
  'sum', 'min', 'max', 'avg', 'count', 'count_values', 'group',
  'stddev', 'stdvar', 'topk', 'bottomk', 'quantile', 'limitk', 'limit_ratio',
]);

/**
 * Insert `label="value"` into the metric selector of a PromQL expression.
 *
 * Returns the expression unchanged when there is no selector to attach to (an
 * empty box, a pure literal) or when the clause is already present — pressing
 * a chip twice should not build an unsatisfiable selector.
 *
 * Anchoring on the FIRST identifier is wrong the moment the expression is
 * wrapped, and it usually is: the catalogue wraps every counter in `rate(...)`
 * before it reaches the box, so the first identifier is `rate` and the filter
 * lands as `rate{service_name="x"}(...)` — a parse error, on the exact path
 * that matters most here, since filtering by service is how a shared metric
 * like `process_cpu_seconds_total` gets segregated at all. Identifiers followed
 * by `(` are therefore skipped as function calls, keywords and aggregators are
 * skipped by name, and the first thing left is the selector.
 */
const labelMatcher = ([label, value]) => `${label}="${value}"`;

const withLabelFilter = (expr, label, value) => {
  const clause = labelMatcher([label, value]);

  // The label names inside a grouping clause — `sum by (service_name) (…)` —
  // are identifiers followed by neither `(` nor `{`, so they otherwise look
  // exactly like the selector. Their spans are marked off first.
  const grouped = [];
  const groupRe = /\b(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)/g;
  let g = groupRe.exec(expr);
  while (g !== null) {
    grouped.push([g.index, g.index + g[0].length]);
    g = groupRe.exec(expr);
  }
  const inGrouping = (i) => grouped.some(([from, to]) => i >= from && i < to);

  const ident = /[a-zA-Z_:][a-zA-Z0-9_:]*/g;
  let m = ident.exec(expr);
  while (m !== null) {
    const start = m.index + m[0].length;
    const after = expr.slice(start);
    const isCall = /^\s*\(/.test(after);
    // Inside a quoted label value, where an identifier is data, not a selector.
    const quoted = (expr.slice(0, m.index).match(/"/g) || []).length % 2 === 1;
    if (!isCall && !quoted && !inGrouping(m.index) && !NOT_A_SELECTOR.has(m[0])) {
      const braces = /^\s*\{([^}]*)\}/.exec(after);
      if (!braces) return `${expr.slice(0, start)}{${clause}}${expr.slice(start)}`;
      const inner = braces[1].trim();
      if (inner.includes(clause)) return expr;
      const lead = inner ? `${inner}, ` : '';
      return `${expr.slice(0, start)}{${lead}${clause}}${expr.slice(start + braces[0].length)}`;
    }
    m = ident.exec(expr);
  }
  return expr;
};

export default function MetricsView({
  onDrillToService, onNavigate, drillPrefill, onDrillPrefillConsumed,
}) {
  // Validated against TABS on the way in, and against the Summary flag as well:
  // a value stored while SHOW_SUMMARY_TAB was true would otherwise restore a tab
  // that no longer has a strip entry, leaving the user on a face with no way back.
  const [tab, setTab] = useState(() => {
    const stored = readLS(LS_TAB, '');
    const known = TABS.some((t) => t.key === stored);
    if (!known || (stored === 'summary' && !SHOW_SUMMARY_TAB)) return 'explorer';
    return stored;
  });
  useEffect(() => { writeLS(LS_TAB, tab); }, [tab]);

  // ── Query state ───────────────────────────────────────────────────────────
  const [draft, setDraft] = useState(() => readLS(LS_QUERY, ''));
  const [range, setRange] = useState(() => readLS(LS_RANGE, DEFAULT_RANGE));
  const [step, setStep] = useState(0);
  const [refreshSecs, setRefreshSecs] = useState(0);

  const [committed, setCommitted] = useState(() => ({
    query: readLS(LS_QUERY, ''),
    range: readLS(LS_RANGE, DEFAULT_RANGE),
    step: 0,
    nonce: 0,
  }));

  const run = useCallback(() => {
    writeLS(LS_QUERY, draft);
    writeLS(LS_RANGE, range);
    setCommitted((c) => ({
      query: draft, range, step, nonce: c.nonce + 1,
    }));
  }, [draft, range, step]);

  // Changing the range or step re-runs immediately: they are picker controls,
  // not typing, so there is no half-finished state to protect against — and
  // having to press Run after choosing a range reads as the picker being broken.
  const rangeRef = useRef(range);
  const stepRef = useRef(step);
  useEffect(() => {
    if (rangeRef.current === range && stepRef.current === step) return;
    rangeRef.current = range;
    stepRef.current = step;
    writeLS(LS_RANGE, range);
    setCommitted((c) => ({
      ...c, range, step, nonce: c.nonce + 1,
    }));
  }, [range, step]);

  const isDirty = draft !== committed.query;

  // ── Catalogue ─────────────────────────────────────────────────────────────
  const [catalog, setCatalog] = useState({
    items: [], groups: [], total: 0, error: null,
  });
  const [catalogLoading, setCatalogLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    fetchMetricCatalog({ signal: controller.signal })
      .then((res) => {
        setCatalog({
          items: res.items,
          groups: res.groups,
          total: res.total,
          error: res.supported ? null : (res.error || 'unavailable'),
        });
        setCatalogLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setCatalogLoading(false);
      });
    return () => controller.abort();
  }, []);

  // ── Results ───────────────────────────────────────────────────────────────
  const [result, setResult] = useState({ series: [], resultType: null, error: null });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!committed.query.trim()) {
      setResult({ series: [], resultType: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    const { startTime, endTime } = rangeToParams(committed.range);
    fetchMetricRange({
      query: committed.query, startTime, endTime, step: committed.step, signal: controller.signal,
    })
      .then((res) => {
        setResult({
          series: res.series,
          resultType: res.resultType,
          error: res.supported ? null : (res.error || 'query failed'),
        });
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        setResult({ series: [], resultType: null, error: err.message });
        setLoading(false);
      });
    return () => controller.abort();
  }, [committed.query, committed.range, committed.step, committed.nonce]);

  // Auto-refresh re-commits the CURRENT committed query, not the draft — a
  // timer that picks up half-typed text would fire errors while you edit.
  useEffect(() => {
    if (!refreshSecs || !committed.query.trim()) return undefined;
    const id = setInterval(
      () => setCommitted((c) => ({ ...c, nonce: c.nonce + 1 })),
      refreshSecs * 1000,
    );
    return () => clearInterval(id);
  }, [refreshSecs, committed.query]);

  // ── Metric selection → query text ─────────────────────────────────────────
  const selectedMetric = useMemo(() => {
    const m = /(?:^|[\s({,])([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:\{|$|\s|\))/.exec(committed.query || '');
    return m ? m[1] : '';
  }, [committed.query]);

  const handleSelectMetric = useCallback((metric) => {
    // Picking from the catalogue replaces the drilled query, so the note that
    // explained it no longer describes what is on screen.
    setDrillNote('');
    // A counter is pre-wrapped in rate(): plotted bare it is a line that only
    // ever goes up, which is never the question being asked.
    const text = metric.type === 'counter'
      ? `rate(${metric.name}[5m])`
      : metric.name;
    setDraft(text);
    writeLS(LS_QUERY, text);
    setCommitted((c) => ({
      query: text, range, step, nonce: c.nonce + 1,
    }));
  }, [range, step]);

  // ── Label helper ──────────────────────────────────────────────────────────
  const [labels, setLabels] = useState([]);
  const [labelValues, setLabelValues] = useState({ label: '', items: [] });
  useEffect(() => {
    if (!selectedMetric) { setLabels([]); return undefined; }
    const controller = new AbortController();
    fetchMetricLabels({ metric: selectedMetric, signal: controller.signal })
      .then((items) => setLabels(items.filter((l) => l !== '__name__')))
      .catch(() => {});
    return () => controller.abort();
  }, [selectedMetric]);

  const openLabel = useCallback((label) => {
    if (labelValues.label === label) { setLabelValues({ label: '', items: [] }); return; }
    setLabelValues({ label, items: [] });
    fetchMetricLabelValues({ label, metric: selectedMetric })
      .then((items) => setLabelValues({ label, items }));
  }, [labelValues.label, selectedMetric]);

  // ── Provenance of the selected metric ─────────────────────────────────────
  //
  // The catalogue entry carries the classification the backend assigned, so
  // once a metric is in the query the screen can say where it came from
  // ("PostgreSQL", "Kubernetes (kube-state-metrics)") instead of leaving the
  // name to be decoded by prefix.
  const selectedEntry = useMemo(
    () => catalog.items.find((m) => m.name === selectedMetric) || null,
    [catalog.items, selectedMetric],
  );

  /**
   * Which services actually emit the selected metric.
   *
   * This is the half the metric NAME cannot answer. Verified on this instance:
   * `process_cpu_seconds_total` carries series from openobserve, tiotapi,
   * tiotesb, DLHAppService and MsSqlExporter at once — a tool, three of our
   * services and an exporter under one name. Grouping by name puts such metrics
   * in "Shared runtime"; this row is what segregates them, and clicking a chip
   * pins the query to one producer.
   *
   * Fetched for every metric, not only the shared ones: on a single-producer
   * metric the row is one chip that confirms the owner, which is cheap and
   * still worth saying. It is one scoped /series call — the same one the label
   * helper already makes.
   */
  const [sources, setSources] = useState({ metric: '', items: [], loading: false });
  useEffect(() => {
    if (!selectedMetric) { setSources({ metric: '', items: [], loading: false }); return undefined; }
    let live = true;
    setSources({ metric: selectedMetric, items: [], loading: true });
    fetchMetricLabelValues({ label: 'service_name', metric: selectedMetric })
      .then((items) => { if (live) setSources({ metric: selectedMetric, items, loading: false }); })
      // A metric with no service_name label is normal (kube_*, zo_*): show
      // nothing rather than an error the user cannot act on.
      .catch(() => { if (live) setSources({ metric: selectedMetric, items: [], loading: false }); });
    return () => { live = false; };
  }, [selectedMetric]);

  /** Add `label="value"` to the selector in the query, then run. */
  const addLabelFilter = useCallback((label, value) => {
    const next = withLabelFilter(draft, label, value);
    setDraft(next);
    writeLS(LS_QUERY, next);
    setCommitted((c) => ({
      query: next, range, step, nonce: c.nonce + 1,
    }));
  }, [draft, range, step]);

  /**
   * "By service" → Explorer: plot one metric for one service.
   *
   * Built from the metric name rather than from the current draft, because the
   * draft belongs to whatever the user last explored and this is a fresh
   * question. Counters get the same rate() wrapper the catalogue applies — a
   * bare counter is a line that only rises — and the service filter goes in
   * before the query is committed, so the chart never flashes up every
   * producer's series first.
   */
  const openMetricForService = useCallback((metric, serviceName) => {
    const base = metric.type === 'counter'
      ? `rate(${metric.name}[5m])`
      : metric.name;
    const text = withLabelFilter(base, 'service_name', serviceName);
    setDraft(text);
    writeLS(LS_QUERY, text);
    setCommitted((c) => ({
      query: text, range, step, nonce: c.nonce + 1,
    }));
    setTab('explorer');
  }, [range, step]);

  // ── Drill-through from an alert's Telemetry panel ─────────────────────
  //
  // What the alert NAMED, resolved against the real catalogue, plotted over the
  // firing's window and narrowed to the entity the alert is about. `drillNote`
  // says which of those actually happened, because the three outcomes look
  // identical once a chart is on screen and only one of them is "this is the exact
  // series that fired".
  const [drillNote, setDrillNote] = useState('');
  const [drillBusy, setDrillBusy] = useState(false);

  /** The service the drill should preselect on the By-service tab, when no metric
   *  could be resolved. Held in state rather than passed straight through so that
   *  leaving the tab and coming back does not re-select it under the operator. */
  const [drillService, setDrillService] = useState('');

  useEffect(() => {
    if (!drillPrefill) return undefined;
    // The catalogue is the authority on whether a name the alert wrote is a real
    // metric here, so nothing can be decided until it has answered. This effect
    // re-runs when it does.
    if (catalogLoading) return undefined;

    const {
      promql, candidates = [], identityValues = [], serviceName, range: drillRange,
    } = drillPrefill;

    const controller = new AbortController();
    let cancelled = false;

    const commit = (text, note) => {
      if (cancelled) return;
      const nextRange = drillRange || range;
      setDraft(text);
      writeLS(LS_QUERY, text);
      writeLS(LS_RANGE, nextRange);
      setRange(nextRange);
      // rangeRef is synced here so the range-watching effect above does not fire a
      // SECOND commit for the same change and re-run the query twice.
      rangeRef.current = nextRange;
      setCommitted((c) => ({
        query: text, range: nextRange, step, nonce: c.nonce + 1,
      }));
      setDrillNote(note);
      setTab('explorer');
    };

    // 1. A PromQL rule already states the expression that fired. Nothing derived
    //    here could be more accurate than the query the evaluator itself ran.
    if (promql) {
      commit(promql, 'Plotted from the rule\u2019s own PromQL, over the alert\u2019s window.');
      if (onDrillPrefillConsumed) onDrillPrefillConsumed();
      return () => { cancelled = true; controller.abort(); };
    }

    // 2. The first name the alert wrote that is a real metric here. A name absent
    //    from the catalogue is dropped rather than plotted — see alertDrill.js.
    const entry = candidates
      .map((name) => catalog.items.find((m) => m.name === name))
      .find(Boolean);

    if (!entry) {
      // 3. Nothing named a metric. The By-service tab lists what this service
      //    actually exposes, which is a true answer; a guessed metric is not.
      if (!cancelled) {
        setDrillService(serviceName || '');
        setDrillNote('');
        setTab(serviceName ? 'services' : 'explorer');
      }
      if (onDrillPrefillConsumed) onDrillPrefillConsumed();
      return () => { cancelled = true; controller.abort(); };
    }

    setDrillBusy(true);
    // Same shaping the catalogue click uses, so a drilled counter reads as a rate
    // rather than as a line that only ever goes up.
    const base = entry.type === 'counter' ? `rate(${entry.name}[5m])` : entry.name;

    resolveMetricIdentity({
      metric: entry.name,
      identityValues,
      fetchLabels: ({ metric, signal }) => fetchMetricLabels({ metric, signal }),
      fetchLabelValues: ({ label, metric, signal }) => (
        fetchMetricLabelValues({ label, metric, signal })
      ),
      signal: controller.signal,
    }).then((filters) => {
      if (cancelled) return;
      const text = filters.reduce(
        (expr, [label, value]) => withLabelFilter(expr, label, value),
        base,
      );
      commit(text, filters.length
        ? `${entry.name}, narrowed to ${filters.map(labelMatcher).join(' and ')}`
          + ' \u2014 the only labels on this metric that actually carry this alert\u2019s values.'
        : `${entry.name} over the alert\u2019s window. None of this alert\u2019s identifiers appear`
          + ' among this metric\u2019s label values, so every series is shown rather than a'
          + ' filter that would have matched nothing.');
      setDrillBusy(false);
      if (onDrillPrefillConsumed) onDrillPrefillConsumed();
    }).catch(() => {
      if (cancelled) return;
      // The narrowing is an improvement, never a precondition: a failed label
      // lookup still leaves a correct chart of the metric that fired.
      commit(base, `${entry.name} over the alert\u2019s window. The label lookup failed, so it`
        + ' is not narrowed to a single series.');
      setDrillBusy(false);
      if (onDrillPrefillConsumed) onDrillPrefillConsumed();
    });

    // NOT consumed here. Clearing the prefill re-runs this effect, and the cleanup
    // below would abort the label lookups that have not answered yet — leaving the
    // screen on its old query with the note still promising a narrowed chart. The
    // two synchronous branches above commit before they consume; this one has to
    // wait until it has committed too.
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drillPrefill, catalogLoading]);

  // ── Series table ──────────────────────────────────────────────────────────
  const tableRows = useMemo(() => {
    const varying = varyingLabels(result.series);
    return result.series.map((s, i) => {
      const vals = s.points.map((p) => p.v).filter((v) => v !== null);
      const last = vals.length ? vals[vals.length - 1] : null;
      return {
        key: `${seriesLabel(s.labels, varying)}#${i}`,
        label: seriesLabel(s.labels, varying),
        last,
        min: vals.length ? Math.min(...vals) : null,
        max: vals.length ? Math.max(...vals) : null,
        avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
        points: s.points.length,
      };
    });
  }, [result.series]);

  const autoStepLabel = useMemo(() => {
    const span = spanSeconds(committed.range);
    const auto = Math.max(1, Math.ceil(span / 1500));
    return auto >= 60 ? `${Math.round(auto / 60)}m` : `${auto}s`;
  }, [committed.range]);

  if (SHOW_SUMMARY_TAB && tab === 'summary') {
    return (
      <div className="metrics-view">
        <MetricsTabs tab={tab} onChange={setTab} />
        {/* Unchanged — same component, same props as before this screen
            gained tabs. */}
        <SummaryView onDrillToService={onDrillToService} onNavigate={onNavigate} />
      </div>
    );
  }

  if (tab === 'services') {
    return (
      <div className="metrics-view">
        <MetricsTabs tab={tab} onChange={setTab} />
        {/* `initialService` is only ever set by an alert drill that could not
            resolve a metric name; `notice` is what says why the operator landed on
            a list instead of on a chart. Both are blank for every other route in,
            which leaves this tab exactly as it was. */}
        <ServiceMetricsView
          onOpenMetric={openMetricForService}
          initialService={drillService}
          notice={drillService
            ? 'This alert names no metric, so it could not be plotted directly. These are '
              + `the metrics ${drillService} actually exposes \u2014 pick the one you want.`
            : ''}
        />
      </div>
    );
  }

  return (
    <div className="metrics-view">
      <MetricsTabs tab={tab} onChange={setTab} />

      <div className="mv-body">
        <MetricCatalog
          items={catalog.items}
          groups={catalog.groups}
          total={catalog.total}
          loading={catalogLoading}
          error={catalog.error}
          selected={selectedMetric}
          onSelect={handleSelectMetric}
        />

        <section className="mv-main">
          <div className="mv-toolbar">
            <div className="mv-query">
              <textarea
                className="mv-query-input"
                value={draft}
                onChange={(e) => {
                  // The drill note describes how THIS query got here; the first
                  // hand edit makes it a claim about something else.
                  if (drillNote) setDrillNote('');
                  setDraft(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
                }}
                rows={2}
                spellCheck={false}
                placeholder='PromQL — e.g. rate(jvm_memory_used_bytes[5m]) or up{service_name="IoTOpsSvc"}'
                aria-label="PromQL query"
              />
            </div>

            <div className="mv-controls">
              <TimeRangePicker value={range} onChange={setRange} />

              <label className="mv-step" title="Seconds between points. Auto derives it from the window and is capped at 1,500 points per series.">
                <span>Step</span>
                <select value={step} onChange={(e) => setStep(Number(e.target.value))}>
                  <option value={0}>Auto ({autoStepLabel})</option>
                  <option value={15}>15s</option>
                  <option value={30}>30s</option>
                  <option value={60}>1m</option>
                  <option value={300}>5m</option>
                  <option value={900}>15m</option>
                  <option value={3600}>1h</option>
                </select>
              </label>

              <RefreshIntervalPicker value={refreshSecs} onChange={setRefreshSecs} />

              <button
                type="button"
                className={`mv-run ${isDirty ? 'is-dirty' : ''}`}
                onClick={run}
                disabled={!draft.trim() || loading}
                title="Run query (Ctrl+Enter)"
              >
                {loading ? 'Running…' : 'Run query'}
              </button>
            </div>
          </div>

          {/* What an alert drill actually resolved to.
              Three outcomes reach this chart — the rule's own PromQL, a metric the
              alert named narrowed to its pod, and that same metric with no
              narrowing possible — and they are indistinguishable once plotted.
              Saying which one this is, is the difference between "this is the
              series that fired" and "this is the metric it was about".
              Dismissible, and cleared by any hand edit, because it describes how
              the query got here and stops being true the moment it is changed. */}
          {(drillBusy || drillNote) && (
            <output className="mv-drill-note native-el">
              <span className="mv-drill-note-text">
                {drillBusy ? 'Working out which of this metric’s labels carry this alert’s values…' : drillNote}
              </span>
              {!drillBusy && (
                <button
                  type="button"
                  className="mv-drill-note-x"
                  onClick={() => setDrillNote('')}
                  aria-label="Dismiss"
                >×</button>
              )}
            </output>
          )}

          {/* Where the selected metric comes from, and who emits it. Two
              different answers: the badge is the technology the NAME belongs
              to, the chips are the services the DATA came from. For a shared
              metric only the chips are meaningful, which is what the note
              says. */}
          {selectedEntry && (
            <div className="mv-provenance">
              <span className={`mv-prov-badge is-${selectedEntry.group}`}>
                {selectedEntry.technology}
              </span>
              <code className="mv-prov-metric">{selectedEntry.name}</code>

              {sources.items.length > 0 && (
                <span className="mv-prov-sources">
                  <span className="mv-prov-label">
                    {sources.items.length === 1 ? 'emitted by' : `emitted by ${sources.items.length} services`}
                  </span>
                  {sources.items.slice(0, 12).map((s) => (
                    <button
                      type="button"
                      key={s}
                      className="mv-prov-chip"
                      onClick={() => addLabelFilter('service_name', s)}
                      title={`Filter this query to service_name="${s}"`}
                    >
                      {s}
                    </button>
                  ))}
                  {sources.items.length > 12 && (
                    <span className="mv-prov-more">
                      +{sources.items.length - 12} more — use the service_name filter below
                    </span>
                  )}
                </span>
              )}

              {selectedEntry.shared && sources.items.length > 1 && (
                <span className="mv-prov-note">
                  Shared metric — the name belongs to no one service. Pick a producer above.
                </span>
              )}
            </div>
          )}

          {selectedMetric && labels.length > 0 && (
            <div className="mv-labels">
              <span className="mv-labels-title">Filter {selectedMetric} by</span>
              {labels.map((l) => (
                <span className="mv-label-wrap" key={l}>
                  <button
                    type="button"
                    className={`mv-label ${labelValues.label === l ? 'is-open' : ''}`}
                    onClick={() => openLabel(l)}
                  >
                    {l}
                  </button>
                  {labelValues.label === l && (
                    <div className="mv-label-values">
                      {labelValues.items.length === 0 && <div className="mv-label-empty">Loading…</div>}
                      {labelValues.items.slice(0, 200).map((v) => (
                        <button
                          type="button"
                          key={v}
                          className="mv-label-value"
                          onClick={() => { addLabelFilter(l, v); setLabelValues({ label: '', items: [] }); }}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  )}
                </span>
              ))}
            </div>
          )}

          <MetricChart
            series={result.series}
            loading={loading}
            error={result.error}
            resultType={result.resultType}
          />

          {tableRows.length > 0 && (
            <div className="mv-table-wrap">
              <table className="mv-table">
                <thead>
                  <tr>
                    <th>Series</th>
                    <th className="is-num">Last</th>
                    <th className="is-num">Min</th>
                    <th className="is-num">Avg</th>
                    <th className="is-num">Max</th>
                    <th className="is-num">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r) => (
                    <tr key={r.key}>
                      <td className="mv-table-label" title={r.label}>{r.label}</td>
                      <td className="is-num">{r.last === null ? '—' : formatCount(r.last)}</td>
                      <td className="is-num">{r.min === null ? '—' : formatCount(r.min)}</td>
                      <td className="is-num">{r.avg === null ? '—' : formatCount(r.avg)}</td>
                      <td className="is-num">{r.max === null ? '—' : formatCount(r.max)}</td>
                      <td className="is-num">{r.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MetricsTabs({ tab, onChange }) {
  // Summary stays hidden unless the flag is on; the other two are always
  // offered, so the strip has something to switch between either way.
  const shown = TABS.filter((t) => t.key !== 'summary' || SHOW_SUMMARY_TAB);
  return (
    <div className="mv-tabs" role="tablist">
      {shown.map((t) => (
        <button
          type="button"
          key={t.key}
          role="tab"
          aria-selected={tab === t.key}
          className={`mv-tab ${tab === t.key ? 'is-active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
MetricsTabs.propTypes = {
  tab: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};

MetricsView.propTypes = {
  /** Passed straight through to the Summary tab, unchanged. */
  onDrillToService: PropTypes.func,
  onNavigate: PropTypes.func,
  /** Alert drill-through: `{ promql, candidates, identityValues, serviceName, range }`,
   *  built in components/alerts/alertDrill.js. Consumed once. */
  drillPrefill: PropTypes.shape({
    promql: PropTypes.string,
    candidates: PropTypes.arrayOf(PropTypes.string),
    identityValues: PropTypes.arrayOf(PropTypes.string),
    serviceName: PropTypes.string,
    range: PropTypes.object,
  }),
  onDrillPrefillConsumed: PropTypes.func,
};
