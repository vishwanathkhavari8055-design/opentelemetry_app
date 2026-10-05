import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchTracesSummary } from '../../services/api';

const TracesSummaryCard = ({ window, refreshTick, onData }) => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Previous data stays on screen until the new response arrives —
    // only the loading bar signals the refresh.
    setLoading(true);
    setError(false);
    fetchTracesSummary({ window })
      .then(d => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
        // Up to the Home screen's overview tiles — avoids a second fetch of
        // the same endpoint just to fill the Traces / Avg-latency tiles.
        if (onData) onData(d);
      })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [window, refreshTick, onData]);

  return (
    <article className="summary-card">
      <header className="summary-card-header">
        <h3 className="summary-card-title">Traces</h3>
        <span className="summary-card-subtitle">{labelForWindow(window)}</span>
      </header>

      {loading && (
        <progress className="summary-card-loading-bar" aria-label="Refreshing traces summary" />
      )}
      {loading && !data && <div className="summary-card-loading">Loading…</div>}
      {!loading && error && <div className="summary-card-error">Failed to load traces summary.</div>}
      {!error && data && !data.supported && (
        <div className="summary-card-empty">
          Traces summary is not available on the {data.backend ?? 'current'} backend.
        </div>
      )}

      {!error && data?.supported && (
        <>
          <div className="summary-stats-grid">
            <div className="summary-stat">
              <span className="summary-stat-label">Traces</span>
              <span className="summary-stat-value">{(data.traceCount ?? 0).toLocaleString()}</span>
            </div>
            <div className="summary-stat">
              <span className="summary-stat-label">Error rate</span>
              <span className={`summary-stat-value ${(data.errorRate ?? 0) > 0 ? 'error' : 'ok'}`}>
                {formatPercent(data.errorRate)}
              </span>
            </div>
            <div className="summary-stat">
              <span className="summary-stat-label">Avg latency</span>
              <span className="summary-stat-value">{formatMs(data.avgLatencyMs)}</span>
            </div>
            <div className="summary-stat">
              <span className="summary-stat-label">P95 latency</span>
              <span className="summary-stat-value">{formatMs(data.p95LatencyMs)}</span>
            </div>
          </div>

          {Array.isArray(data.slowestOps) && data.slowestOps.length > 0 && (
            <>
              <div className="summary-subtitle">Slowest operations</div>
              <div className="summary-top-list">
                {data.slowestOps.map((o, idx) => (
                  <div className="summary-top-row" key={`${o.operationName}-${idx}`}>
                    <span className="summary-top-row-name">{o.operationName}</span>
                    <span className="summary-top-row-value">{formatMs(o.durationMs)}</span>
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

const formatPercent = (rate) => {
  if (rate == null) return '0.0%';
  return `${(rate * 100).toFixed(1)}%`;
};

const formatMs = (ms) => {
  if (ms == null) return '-';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
};

const labelForWindow = (w) => {
  switch (w) {
    case 'now-15m': return 'LAST 15M';
    case 'now-1h':  return 'LAST 1H';
    case 'now-24h': return 'LAST 24H';
    default:        return w?.toUpperCase() || '';
  }
};

TracesSummaryCard.propTypes = {
  window:      PropTypes.string.isRequired,
  refreshTick: PropTypes.number.isRequired,
  /** Receives the raw /traces/summary response on every successful fetch. */
  onData:      PropTypes.func,
};

export default TracesSummaryCard;
