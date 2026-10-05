import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchServiceVitals } from '../../services/api';
import { formatServiceName } from '../../utils/serviceFormatter';

/**
 * Slide-in drawer with the "vital signs" of one service. Opens when a row
 * in the Services Uptime card is clicked.
 *
 * Six tiles in a fixed 3×2 grid: REQ rate, error %, latency, DB pool active,
 * heap, error log rate. Each tile renders a tiny inline-SVG sparkline (same
 * shape as MetricsSummaryCard.Sparkline) and a single number. The backend
 * omits absent tiles entirely (rather than emitting null fields), so the UI
 * iterates a fixed TILE_ORDER and shows "—" for absent ones — that way a
 * service that doesn't expose Hikari still gets a five-tile-and-one-blank
 * grid, not a four-tile reflow.
 *
 * Footer:
 *  - downstream list (clients this service calls)
 *  - notes from the backend (which streams were missing — diagnostic)
 *  - "View logs" jumps to the Logs tab with this service preselected
 */
const TILE_ORDER = [
  { key: 'reqRate',      fallbackLabel: 'Requests',         fmt: numberOrDash,  digits: 2 },
  { key: 'errorRate',    fallbackLabel: 'Error rate',       fmt: numberOrDash,  digits: 2 },
  { key: 'latencyMs',    fallbackLabel: 'Latency (max)',    fmt: numberOrDash,  digits: 0 },
  { key: 'poolActive',   fallbackLabel: 'DB pool (active)', fmt: numberOrDash,  digits: 1 },
  { key: 'heapUsedMb',   fallbackLabel: 'JVM heap',         fmt: numberOrDash,  digits: 0 },
  { key: 'errorLogRate', fallbackLabel: 'Error logs',       fmt: numberOrDash,  digits: 2 },
];

const ServiceVitalsDrawer = ({ serviceName, window, onClose, onViewLogs }) => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    if (!serviceName) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetchServiceVitals(serviceName, { window })
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [serviceName, window]);

  // ESC closes — common drawer affordance.
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!serviceName) return null;

  const tiles      = data?.tiles      || {};
  const downstream = data?.downstream || [];
  const notes      = data?.notes      || [];

  return (
    <>
      <button
        type="button"
        className="svc-vitals-overlay"
        aria-label="Close drawer"
        onClick={onClose}
      />
      <dialog
        open
        className="svc-vitals-drawer"
        aria-labelledby="svc-vitals-title"
        style={{ position: 'fixed', right: 0, top: 0, bottom: 0, zIndex: 51 }}
      >
        <header className="svc-vitals-header">
          <div>
            <h3 id="svc-vitals-title" className="svc-vitals-title">{formatServiceName(serviceName)}</h3>
            <span className="svc-vitals-subtitle">
              {data?.windowStart && data?.windowEnd
                ? `${shortIso(data.windowStart)} → ${shortIso(data.windowEnd)}`
                : labelForWindow(window)}
            </span>
          </div>
          <div className="svc-vitals-header-actions">
            <button
              type="button"
              className="svc-vitals-link"
              onClick={() => onViewLogs?.(serviceName)}
              title="Jump to Logs filtered by this service"
            >
              View logs →
            </button>
            <button
              type="button"
              className="svc-vitals-close"
              onClick={onClose}
              aria-label="Close service vitals"
            >
              ×
            </button>
          </div>
        </header>

        {loading && <div className="svc-vitals-loading">Loading vitals…</div>}
        {!loading && error && (
          <div className="svc-vitals-error">Failed to load service vitals.</div>
        )}

        {!loading && !error && data && !data.supported && (
          <div className="svc-vitals-empty">
            Service vitals need OpenObserve. Enable {`'openobserve.enabled'`} and confirm
            the collector is scraping Actuator metrics.
          </div>
        )}

        {!loading && !error && data?.supported && (
          <>
            <div className="svc-vitals-grid">
              {TILE_ORDER.map(spec => {
                const tile = tiles[spec.key];
                const label = tile?.label || spec.fallbackLabel;
                return (
                  <div className="svc-vitals-tile" key={spec.key}>
                    <span className="svc-vitals-tile-label">{label}</span>
                    <div className="svc-vitals-tile-figure">
                      <span className="svc-vitals-tile-value">
                        {tile ? spec.fmt(tile.latest, spec.digits) : '—'}
                      </span>
                      {tile?.unit && (
                        <span className="svc-vitals-tile-unit">{tile.unit}</span>
                      )}
                    </div>
                    <Sparkline points={tile?.sparkline} />
                  </div>
                );
              })}
            </div>

            <section className="svc-vitals-section">
              <h4 className="svc-vitals-section-title">Downstream calls</h4>
              {downstream.length === 0 ? (
                <p className="svc-vitals-section-empty">
                  No outbound HTTP client metrics in this window.
                </p>
              ) : (
                <ul className="svc-vitals-downstream">
                  {downstream.map((d, i) => (
                    <li className="svc-vitals-downstream-row" key={d.clientName || i}>
                      <span className="svc-vitals-downstream-name">{formatServiceName(d.clientName)}</span>
                      <span className="svc-vitals-downstream-metrics">
                        <span>{numberOrDash(d.reqRate, 2)} req/s</span>
                        {d.maxLatencyMs != null && (
                          <span>{numberOrDash(d.maxLatencyMs, 0)} ms</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {notes.length > 0 && (
              <section className="svc-vitals-section">
                <h4 className="svc-vitals-section-title">Missing signals</h4>
                <ul className="svc-vitals-notes">
                  {notes.map((n) => (
                    <li key={n} className="svc-vitals-note">{n}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </dialog>
    </>
  );
};

// Same SVG-only sparkline shape as MetricsSummaryCard — kept in-component so
// the drawer doesn't pull in a charting library dep that would dwarf this
// feature.
const Sparkline = ({ points }) => {
  if (!points || points.length < 2) {
    return <svg className="svc-vitals-spark" viewBox="0 0 100 24" preserveAspectRatio="none" />;
  }
  const values = points.map(p => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 100;
  const H = 24;
  const step = W / (points.length - 1);
  const path = points.map((p, i) => {
    const x = (i * step).toFixed(2);
    const y = (H - ((p.value - min) / range) * (H - 4) - 2).toFixed(2);
    return `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }).join(' ');
  return (
    <svg className="svc-vitals-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke="var(--accent-color)" strokeWidth="1.5" />
    </svg>
  );
};

Sparkline.propTypes = {
  points: PropTypes.arrayOf(
    PropTypes.shape({ timestamp: PropTypes.string, value: PropTypes.number })
  ),
};

function numberOrDash(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

// Trim ISO to HH:MM for the subtitle — full ISO is too verbose for a drawer
// header. Falls back to the raw value if parsing flops.
function shortIso(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(11, 16);
  } catch {
    return iso;
  }
}

function labelForWindow(w) {
  switch (w) {
    case 'now-15m': return 'LAST 15M';
    case 'now-1h':  return 'LAST 1H';
    case 'now-24h': return 'LAST 24H';
    default:        return w?.toUpperCase() || '';
  }
}

ServiceVitalsDrawer.propTypes = {
  serviceName: PropTypes.string,
  window:      PropTypes.string.isRequired,
  onClose:     PropTypes.func.isRequired,
  onViewLogs:  PropTypes.func,
};

export default ServiceVitalsDrawer;
