import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import PropTypes from 'prop-types';
import { fetchMetricProducers, refreshMetricProducers } from '../../services/api';

/**
 * The catalogue read the other way round: pick a service, see what it exposes.
 *
 * The Explorer answers "what does this metric measure". This answers "what does
 * this service give me", which is the question you actually have when a service
 * is misbehaving and you do not yet know which of 3,215 metric names belong to
 * it.
 *
 * ── Two lists per service, and why that is not a detail ────────────────────
 *
 * `service_name` does not mean "this service exposed this metric" — it means
 * "this sample was attached to this OTel resource". kube-state-metrics
 * describes every pod in the cluster, so on this deployment twenty-odd pods
 * each carry 200 `kube_*` metrics with their own name on them. Presenting those
 * as exposed metrics would tell you `tiotmlinferencesvc` exports 200 Kubernetes
 * metrics when it exports none.
 *
 * So the backend splits them and this screen keeps them apart: EXPOSES is the
 * service's own instrumentation, OBSERVED is platform telemetry about it.
 *
 * ── The build is slow and the screen says so ───────────────────────────────
 *
 * Building the index is a ~3,200-probe sweep, about 90 seconds cold, because no
 * single query on this backend can invert the catalogue. So the endpoint never
 * blocks: it reports progress while sweeping and serves the previous answer,
 * labelled with its age, while a refresh runs. This component polls rather than
 * waiting on one long request, and shows the age instead of pretending the
 * number is live.
 */

/** Kinds in display order, with what each one is telling you. */
const KIND_HINT = {
  microservice: 'Instrumented with Micrometer or the OTel SDK — our own code.',
  middleware: 'Exposes a third-party product’s metrics: a database, broker or integration server.',
  platform: 'Emits Kubernetes or host telemetry.',
  observability: 'Part of the telemetry pipeline itself.',
  runtime: 'Emits only shared runtime metrics — process, host or language runtime.',
  'scrape-only': 'We scrape it and it answers, but it exposes no telemetry of its own — '
    + 'only up and scrape_*. An instrumentation gap.',
  'observed-only': 'Emits nothing. The name is known only because Kubernetes telemetry '
    + 'describes it.',
};

/** Facet button text per kind; any kind not listed reads as "Observed only". */
const FACET_LABEL = new Map([
  ['microservice', 'Microservices'],
  ['middleware', 'Middleware'],
  ['platform', 'Platform'],
  ['observability', 'Observability'],
  ['runtime', 'Runtime only'],
  ['scrape-only', 'Scraped only'],
]);

const KIND_ORDER = [
  'microservice', 'middleware', 'platform', 'observability', 'runtime',
  'scrape-only', 'observed-only',
];

/** While a sweep runs, poll this often. */
const POLL_MS = 2000;

const relativeAge = (secs) => {
  if (!secs || secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
};

export default function ServiceMetricsView({ onOpenMetric, initialService = '', notice = '' }) {
  const [state, setState] = useState({
    services: [], building: false, progressDone: 0, progressTotal: 0, loading: true,
  });
  const [selected, setSelected] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [showObserved, setShowObserved] = useState(false);

  // ── Polling ───────────────────────────────────────────────────────────────
  //
  // One fetch on mount, then again every POLL_MS only while the backend says a
  // build is running. Polling a finished index would be 3,000-service payloads
  // for nothing.
  const timer = useRef(null);
  const load = useCallback(() => {
    fetchMetricProducers()
      .then((res) => setState({ ...res, loading: false }))
      .catch(() => setState((s) => ({ ...s, loading: false })));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!state.building) {
      if (timer.current) { clearInterval(timer.current); timer.current = null; }
      return undefined;
    }
    timer.current = setInterval(load, POLL_MS);
    return () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  }, [state.building, load]);

  const onRefresh = useCallback(() => {
    refreshMetricProducers().then(load);
  }, [load]);

  // ── Seeded selection ──────────────────────────────────────────────────────
  //
  // Set when an alert whose metric could not be resolved sends the operator here
  // to pick one — see MetricsView's drill effect. The facet and the search box are
  // cleared alongside it, because a selection filtered off screen is immediately
  // replaced by the first visible row (see the effect below) and the seed would
  // silently do nothing.
  useEffect(() => {
    if (!initialService) return;
    setKind('');
    setQ('');
    setSelected(initialService);
  }, [initialService]);

  /* The seeded service is not in the index. Distinct from "not selected": the
     producers index only lists services that WROTE a metric in its window, so the
     honest answer is that this service has emitted nothing rather than that the
     drill failed. */
  const seedMissing = !!initialService && !state.loading
    && !state.services.some((s) => s.name === initialService);

  // ── Facets and filtering ──────────────────────────────────────────────────
  const kinds = useMemo(() => {
    const counts = new Map();
    state.services.forEach((s) => counts.set(s.kind, (counts.get(s.kind) || 0) + 1));
    return KIND_ORDER.filter((k) => counts.has(k)).map((k) => ({ key: k, count: counts.get(k) }));
  }, [state.services]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return state.services.filter((s) => {
      if (kind && s.kind !== kind) return false;
      if (!term) return true;
      // Search the metric names too, so "which service exposes hikaricp" works
      // without knowing the service's name — the inverse lookup this screen is
      // really for.
      return s.name.toLowerCase().includes(term)
        || (s.emitted?.metrics || []).some((m) => m.name.toLowerCase().includes(term));
    });
  }, [state.services, kind, q]);

  // Keep a selection only while it is still on screen; otherwise the detail
  // pane would describe a service the list no longer shows.
  const current = useMemo(
    () => visible.find((s) => s.name === selected) || null,
    [visible, selected],
  );
  useEffect(() => {
    if (!current && visible.length > 0) setSelected(visible[0].name);
  }, [current, visible]);

  const detail = current;

  // Metrics of the selected service, grouped under technology headings.
  //
  // Insertion order is the backend's — technology by descending count, then
  // name — so a Map preserves it and no sorting happens here. IoTOpsSvc emits
  // 268 metrics; ungrouped that is the same wall of names the Explorer had.
  const sections = useMemo(() => {
    if (!detail) return [];
    const bucket = showObserved ? detail.observed : detail.emitted;
    const byTech = new Map();
    (bucket?.metrics || []).forEach((m) => {
      const key = m.technology || 'Unclassified';
      if (!byTech.has(key)) byTech.set(key, []);
      byTech.get(key).push(m);
    });
    return [...byTech.entries()].map(([label, metrics]) => ({ label, metrics }));
  }, [detail, showObserved]);

  const progressPct = state.progressTotal
    ? Math.round((state.progressDone / state.progressTotal) * 100)
    : 0;

  if (state.loading) {
    return <div className="svm-empty">Loading the service index…</div>;
  }

  if (!state.supported) {
    return (
      <div className="svm-empty">
        Service index unavailable — {state.error || 'unsupported'}.
        {state.error === 'metrics.producers.enabled=false' && (
          <p className="svm-empty-hint">
            Set <code>metrics.producers.enabled=true</code> on the backend to enable it.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="svm">
      {/* Build state, always visible. A number this expensive to produce should
          never be presented without saying when it was produced. */}
      <div className="svm-status">
        {state.building ? (
          <>
            <span className="svm-status-spin" aria-hidden="true" />
            <span>
              Sweeping the catalogue — {state.progressDone.toLocaleString()} of{' '}
              {state.progressTotal.toLocaleString()} metrics ({progressPct}%)
              {/* Rows appear as the sweep runs, so say the counts are not final
                  yet. A partial index shown as complete reads as "that service
                  exposes nothing". */}
              {state.services.length > 0 && ` · ${state.services.length.toLocaleString()} producers so far`}
            </span>
            <span className="svm-bar"><span className="svm-bar-fill" style={{ width: `${progressPct}%` }} /></span>
          </>
        ) : (
          <>
            <span>
              {state.services.length.toLocaleString()} producers from{' '}
              {state.metricsProbed.toLocaleString()} metrics · built {relativeAge(state.ageSeconds)}
              {state.buildMillis > 0 && ` in ${Math.round(state.buildMillis / 1000)}s`}
            </span>
            <button type="button" className="svm-refresh" onClick={onRefresh}>Rebuild</button>
          </>
        )}
      </div>

      {/* Why the operator is on a list rather than on a chart. Supplied by the
          caller so this component stays a plain inventory that knows nothing
          about alerts. */}
      {notice && (
        <output className="svm-reconcile is-notice">
          {notice}
          {seedMissing && (
            <> Note that <strong>{initialService}</strong> is not in this index at all,
              which means it wrote no metric in the window the sweep covers.</>
          )}
        </output>
      )}

      {/* While the sweep runs the counts on screen are lower bounds, and a
          service that has not been reached yet looks like one that exposes
          nothing. Say so rather than letting the rows imply otherwise. */}
      {state.partial && state.services.length > 0 && (
        <div className="svm-reconcile is-partial">
          Partial — counts will grow until the sweep finishes, and services not reached
          yet are missing.
        </div>
      )}

      {/* The reconciliation line. Without it, "my service isn't listed" has no
          answer; with it, the usual answer (it wrote nothing in the window) is
          already on screen. */}
      {!state.building && state.metricsProbed > 0 && (
        <div className="svm-reconcile">
          {state.metricsWithNoData.toLocaleString()} metrics wrote nothing in the last{' '}
          {Math.round(state.windowSeconds / 60)}m
          {state.metricsUnscoped > 0
            && ` · ${state.metricsUnscoped.toLocaleString()} carry no service_name`}
          {state.probeFailures > 0
            && ` · ${state.probeFailures.toLocaleString()} probes failed — index is partial`}
        </div>
      )}

      <div className="svm-body">
        <aside className="svm-list">
          <div className="svm-list-head">
            <input
              className="svm-search"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search services or metric names…"
              aria-label="Search services by name, or by a metric they expose"
            />
            <fieldset className="svm-facets" aria-label="Filter by kind">
              <button
                type="button"
                className={`svm-facet ${kind === '' ? 'is-on' : ''}`}
                onClick={() => setKind('')}
              >
                {'All '}
                <span className="svm-facet-count">{state.services.length.toLocaleString()}</span>
              </button>
              {kinds.map((k) => (
                <button
                  type="button"
                  key={k.key}
                  className={`svm-facet is-${k.key} ${kind === k.key ? 'is-on' : ''}`}
                  onClick={() => setKind(k.key === kind ? '' : k.key)}
                  title={KIND_HINT[k.key]}
                >
                  {FACET_LABEL.get(k.key) ?? 'Observed only'}
                  {' '}
                  <span className="svm-facet-count">{k.count.toLocaleString()}</span>
                </button>
              ))}
            </fieldset>
          </div>

          <div className="svm-list-scroll">
            {visible.length === 0 && (
              <div className="svm-list-empty">
                {state.building ? 'Still sweeping…' : `No service matches “${q}”.`}
              </div>
            )}
            {visible.map((s) => (
              <button
                type="button"
                key={s.name}
                className={`svm-row is-${s.kind} ${selected === s.name ? 'is-on' : ''}`}
                onClick={() => { setSelected(s.name); setShowObserved(false); }}
                title={`${s.name} — ${s.kindLabel}\n${KIND_HINT[s.kind] || ''}`}
              >
                <span className="svm-row-name">{s.name}</span>
                <span className="svm-row-counts">
                  <span className="svm-row-emitted" title="metrics it exposes">
                    {s.emitted?.count ?? 0}
                  </span>
                  {(s.observed?.count ?? 0) > 0 && (
                    <span className="svm-row-observed" title="platform metrics about it">
                      +{s.observed.count}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="svm-detail">
          {!detail && <div className="svm-empty">Pick a service.</div>}
          {detail && (
            <>
              <header className="svm-detail-head">
                <h3 className="svm-detail-name">{detail.name}</h3>
                <span className={`svm-kind is-${detail.kind}`}>{detail.kindLabel}</span>
              </header>
              <p className="svm-detail-hint">{KIND_HINT[detail.kind]}</p>

              {/* Two tabs, not one merged list — see the component comment. */}
              <div className="svm-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={!showObserved}
                  className={`svm-tab ${!showObserved ? 'is-active' : ''}`}
                  onClick={() => setShowObserved(false)}
                >
                  Exposes ({detail.emitted?.count ?? 0})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={showObserved}
                  className={`svm-tab ${showObserved ? 'is-active' : ''}`}
                  onClick={() => setShowObserved(true)}
                  title="Kubernetes and host metrics that describe this service but are emitted by the platform, not by it"
                  disabled={(detail.observed?.count ?? 0) === 0}
                >
                  Observed about it ({detail.observed?.count ?? 0})
                </button>
              </div>

              {/* Technology breakdown — the shape of what this service exposes,
                  before the full name list. */}
              {((showObserved ? detail.observed : detail.emitted)?.technologies || []).length > 0 && (
                <div className="svm-techs">
                  {(showObserved ? detail.observed : detail.emitted).technologies.map((t) => (
                    <span className="svm-tech" key={t.name}>
                      {t.name}
                      <span className="svm-tech-count">{t.count}</span>
                    </span>
                  ))}
                </div>
              )}

              <div className="svm-metrics">
                {sections.length === 0 && (
                  <div className="svm-empty">
                    {showObserved
                      ? 'Nothing observed about this service.'
                      : 'This service exposes no metrics of its own.'}
                  </div>
                )}
                {sections.map((sec) => (
                  <div className="svm-section" key={sec.label}>
                    <div className="svm-section-head">
                      {sec.label}
                      <span className="svm-section-count">{sec.metrics.length}</span>
                    </div>
                    {sec.metrics.map((m) => (
                      <button
                        type="button"
                        key={m.name}
                        className="svm-metric"
                        onClick={() => onOpenMetric(m, detail.name)}
                        title={`Open ${m.name} in the Explorer, filtered to service_name="${detail.name}"`}
                      >
                        <span className={`svm-metric-type is-${m.type}`}>
                          {(m.type || '?').charAt(0).toUpperCase()}
                        </span>
                        <span className="svm-metric-name">{m.name}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

ServiceMetricsView.propTypes = {
  /**
   * (metric, serviceName) — open this metric in the Explorer, already filtered
   * to that service. `metric` is the catalogue-shaped `{name, type, technology}`
   * so the caller can wrap a counter in rate() the same way the catalogue does.
   *
   * The service filter is the point: without it the chart shows every
   * producer's series, which is the mixing this screen exists to undo.
   */
  onOpenMetric: PropTypes.func.isRequired,
  /** Preselect this service on arrival. Only an alert drill sets it; blank
   *  everywhere else, which leaves the list's own first-row default in charge. */
  initialService: PropTypes.string,
  /** One line explaining why the caller sent the operator here. */
  notice: PropTypes.string,
};
