import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchMetricsSummary } from '../../services/api';
import { formatServiceName } from '../../utils/serviceFormatter';

// Display ordering + human labels + value formatters for the canonical four
// sparklines emitted by the backend. Keys here MUST match those produced by
// MetricsServiceImpl.fetchSparkline (jvmHeap, cpuUsage, threadsLive,
// httpReqsCount). Series the backend doesn't return are skipped.
const SERIES = [
  { key: 'jvmHeap',       label: 'JVM heap',  format: bytes },
  { key: 'cpuUsage',      label: 'CPU usage', format: percent },
  { key: 'threadsLive',   label: 'Threads',   format: number  },
  { key: 'httpReqsCount', label: 'HTTP reqs', format: number  },
];

// Persists the user's last picked service across page reloads so they don't
// have to re-pick on every visit. Versioned key keeps us safe if the storage
// shape changes in the future.
const LS_KEY = 'observability-ui:metrics-summary:service:v1';
const readPersistedService = () => {
  try { return localStorage.getItem(LS_KEY) || null; } catch { return null; }
};
const writePersistedService = (svc) => {
  try { localStorage.setItem(LS_KEY, svc); } catch { /* private mode / disabled storage */ }
};

const MetricsSummaryCard = ({ window, refreshTick, serviceOptions, topErrorService }) => {
  // Selection: starts from localStorage. The "auto-default to top-error
  // service" lives in a useEffect below so it can run once the donor card
  // has loaded its data, without clobbering an explicit user pick.
  const [selectedService, setSelectedService] = useState(() => readPersistedService());
  const defaultAppliedRef = useRef(false);

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(false);

  // Apply the top-error-service as the default exactly once per session, and
  // only when the user hasn't picked one (either now or in a previous visit).
  // Subsequent refreshTicks may change which service has the most errors —
  // we deliberately don't follow that, because flipping the picker out from
  // under the user would be jarring while they're reading the chart.
  useEffect(() => {
    if (defaultAppliedRef.current) return;
    if (selectedService) { defaultAppliedRef.current = true; return; }
    if (topErrorService) {
      defaultAppliedRef.current = true;
      setSelectedService(topErrorService);
      writePersistedService(topErrorService);
    }
  }, [selectedService, topErrorService]);

  // Union the picker options with the currently-selected service so the
  // dropdown stays valid even if the selected service has dropped out of the
  // uptime list (e.g. it just went DOWN past the liveness threshold).
  const options = useMemo(() => {
    const set = new Set(Array.isArray(serviceOptions) ? serviceOptions : []);
    if (selectedService) set.add(selectedService);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [serviceOptions, selectedService]);

  useEffect(() => {
    // No service picked yet → don't fetch (the backend would return empty
    // anyway, and the card renders the "pick a service" placeholder below).
    if (!selectedService) { setData(null); setLoading(false); return undefined; }

    let cancelled = false;
    // Previous sparklines / values stay visible during the refresh; the new
    // ones replace them only when the response arrives.
    setLoading(true);
    setError(false);
    fetchMetricsSummary({ window, serviceName: selectedService })
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [window, refreshTick, selectedService]);

  const onPickService = (svc) => {
    setSelectedService(svc);
    writePersistedService(svc);
  };

  return (
    <article className="summary-card">
      <header className="summary-card-header">
        <h3 className="summary-card-title">Metrics</h3>
        <span className="summary-card-subtitle">
          {selectedService ? `${formatServiceName(selectedService)} · ${labelForWindow(window)}` : labelForWindow(window)}
        </span>
      </header>

      <div className="summary-card-toolbar">
        <label className="summary-card-toolbar-label" htmlFor="metrics-service-picker">
          Service
        </label>
        <select
          id="metrics-service-picker"
          className="summary-card-select"
          value={selectedService || ''}
          onChange={(e) => onPickService(e.target.value)}
        >
          {!selectedService && <option value="" disabled>Select a service…</option>}
          {options.map(name => (
            <option key={name} value={name}>{formatServiceName(name)}</option>
          ))}
        </select>
      </div>

      {!selectedService && (
        <div className="summary-card-empty">
          Pick a service to view its JVM heap, CPU, threads, and HTTP request rate.
          Averaging across services hides which process is actually under load.
        </div>
      )}

      {selectedService && loading && (
        <progress className="summary-card-loading-bar" aria-label="Refreshing metrics summary" />
      )}
      {selectedService && loading && !data && (
        <div className="summary-card-loading">Loading…</div>
      )}
      {selectedService && !loading && error && (
        <div className="summary-card-error">Failed to load metrics summary.</div>
      )}
      {selectedService && !error && data && !data.supported && (
        <div className="summary-card-empty">
          Metrics summary is not available on the {data.backend ?? 'current'} backend.
        </div>
      )}
      {selectedService && !error && data?.supported && (() => {
        const sparklines   = data.sparklines   || {};
        const latestValues = data.latestValues || {};
        const visible = SERIES.filter(s => Array.isArray(sparklines[s.key]) && sparklines[s.key].length > 0);
        if (visible.length === 0) {
          return (
            <div className="summary-card-empty">
              No metric streams have data for {selectedService} in this window.
            </div>
          );
        }
        return (
          <>
            {visible.map(s => (
              <div className="summary-spark-row" key={s.key}>
                <span className="summary-spark-label">{s.label}</span>
                <Sparkline points={sparklines[s.key]} colorVar="--accent-color" />
                <span className="summary-spark-value">{s.format(latestValues[s.key])}</span>
              </div>
            ))}
          </>
        );
      })()}
    </article>
  );
};

/**
 * Inline SVG sparkline. Tiny by design — 30 px tall, single polyline. No
 * library dep; deliberate, because adding a charting framework would weigh
 * more than the entire Summary feature.
 */
const Sparkline = ({ points }) => {
  if (!points || points.length < 2) {
    return <svg className="summary-spark-svg" viewBox="0 0 100 30" preserveAspectRatio="none" />;
  }
  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const W = 100;
  const H = 30;
  const step = W / (points.length - 1);
  const path = points.map((p, i) => {
    const x = (i * step).toFixed(2);
    const y = (H - ((p.value - min) / range) * (H - 4) - 2).toFixed(2);
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');

  return (
    <svg className="summary-spark-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke="var(--accent-color)" strokeWidth="1.5" />
    </svg>
  );
};

Sparkline.propTypes = {
  points: PropTypes.arrayOf(
    PropTypes.shape({ timestamp: PropTypes.string, value: PropTypes.number })
  ),
};

function bytes(v) {
  if (v == null) return '-';
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (v >= 1024 * 1024)        return `${(v / 1024 / 1024).toFixed(0)} MB`;
  if (v >= 1024)               return `${(v / 1024).toFixed(0)} KB`;
  return `${v.toFixed(0)} B`;
}

function percent(v) {
  if (v == null) return '-';
  return `${(v * 100).toFixed(1)}%`;
}

function number(v) {
  if (v == null) return '-';
  return v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

const labelForWindow = (w) => {
  switch (w) {
    case 'now-15m': return 'LAST 15M';
    case 'now-1h':  return 'LAST 1H';
    case 'now-24h': return 'LAST 24H';
    default:        return w?.toUpperCase() || '';
  }
};

MetricsSummaryCard.propTypes = {
  window:          PropTypes.string.isRequired,
  refreshTick:     PropTypes.number.isRequired,
  serviceOptions:  PropTypes.arrayOf(PropTypes.string),
  topErrorService: PropTypes.string,
};

export default MetricsSummaryCard;
