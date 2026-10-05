import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchLogsSummary } from '../../services/api';
import { formatServiceName } from '../../utils/serviceFormatter';

const SEVERITY_ORDER = ['FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

/**
 * Logs card on the Summary screen — total log count, breakdown by severity,
 * and top-5 services emitting ERROR/FATAL logs. Backed by GET /api/logs/summary
 * (one round-trip; aggregation happens server-side).
 */
const LogsSummaryCard = ({ window, refreshTick, onTopErrorServices, onData }) => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Keep the previous `data` on screen while refreshing — only swap it out
    // when the new response arrives (see `setData(d)` in .then below). The
    // loading bar communicates "refresh in progress" without yanking the
    // numbers out from under the user mid-glance.
    setLoading(true);
    setError(false);
    fetchLogsSummary({ window })
      .then(d => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
        // Surface the top-error-services list up to SummaryView so the
        // Metrics card can default its picker without a duplicate fetch.
        if (onTopErrorServices) onTopErrorServices(d?.topErrorServices || []);
        // Whole response up as well, for the Home screen's overview tiles —
        // same reason: one fetch, two consumers.
        if (onData) onData(d);
      })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [window, refreshTick, onTopErrorServices, onData]);

  return (
    <article className="summary-card">
      <header className="summary-card-header">
        <h3 className="summary-card-title">Logs</h3>
        <span className="summary-card-subtitle">{labelForWindow(window)}</span>
      </header>

      {loading && (
        <progress className="summary-card-loading-bar" aria-label="Refreshing logs summary" />
      )}
      {loading && !data && <div className="summary-card-loading">Loading…</div>}
      {!loading && error && <div className="summary-card-error">Failed to load logs summary.</div>}
      {!error && data && !data.supported && (
        <div className="summary-card-empty">
          Logs summary is not available on the {data.backend ?? 'current'} backend.
        </div>
      )}

      {!error && data?.supported && (
        <>
          <div className="summary-stats-grid">
            <div className="summary-stat">
              <span className="summary-stat-label">Total</span>
              <span className="summary-stat-value">{(data.totalCount ?? 0).toLocaleString()}</span>
            </div>
            <div className="summary-stat">
              <span className="summary-stat-label">Errors</span>
              <span className={`summary-stat-value ${errorCount(data) > 0 ? 'error' : ''}`}>
                {errorCount(data).toLocaleString()}
              </span>
            </div>
          </div>

          <div>
            {renderSeverityRows(data)}
          </div>

          {Array.isArray(data.topErrorServices) && data.topErrorServices.length > 0 && (
            <>
              <div className="summary-subtitle">Top error services</div>
              <div className="summary-top-list">
                {data.topErrorServices.map(s => (
                  <div className="summary-top-row" key={s.serviceName}>
                    <span className="summary-top-row-name">{formatServiceName(s.serviceName)}</span>
                    <span className="summary-top-row-value">{(s.errorCount ?? 0).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </article>
  );
};

const renderSeverityRows = (data) => {
  const counts = data.countsBySeverity || {};
  const total  = Math.max(1, data.totalCount || 0);
  return SEVERITY_ORDER
    .filter(sev => counts[sev] != null)
    .map(sev => {
      const n = counts[sev] ?? 0;
      const pct = (n / total) * 100;
      return (
        <div className="sev-row" key={sev}>
          <span className={`sev-row-label ${sev}`}>{sev}</span>
          <span className="sev-row-count">{n.toLocaleString()}</span>
          <span className="sev-bar">
            <span className={`sev-bar-fill ${sev}`} style={{ width: `${Math.min(100, pct).toFixed(1)}%` }} />
          </span>
          <span className="sev-row-pct">{pct.toFixed(1)}%</span>
        </div>
      );
    });
};

const errorCount = (data) => {
  const c = data.countsBySeverity || {};
  return (c.ERROR ?? 0) + (c.FATAL ?? 0);
};

const labelForWindow = (w) => {
  switch (w) {
    case 'now-15m': return 'LAST 15M';
    case 'now-1h':  return 'LAST 1H';
    case 'now-24h': return 'LAST 24H';
    default:        return w?.toUpperCase() || '';
  }
};

LogsSummaryCard.propTypes = {
  window:             PropTypes.string.isRequired,
  refreshTick:        PropTypes.number.isRequired,
  onTopErrorServices: PropTypes.func,
  /** Receives the raw /logs/summary response on every successful fetch. */
  onData:             PropTypes.func,
};

export default LogsSummaryCard;
