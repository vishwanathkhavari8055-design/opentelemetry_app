import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchServicesUptime } from '../../services/api';
import { formatServiceName } from '../../utils/serviceFormatter';

/**
 * Service Uptime card — shows two signals per row, side by side:
 *
 *   ●●  service-name                        METRICS UP · HEALTH UP
 *       uptime 2h 14m
 *
 * The left dot is the OTel-pipeline heartbeat (did jvm_memory_used emit a
 * sample in the last livenessSec seconds?). The right dot is the service's
 * own /actuator/health, exposed as a Micrometer gauge (application_health),
 * scraped by the OTel Collector and stored in OpenObserve. Either can be
 * missing — services that don't expose the gauge just show one dot.
 *
 * Why both: the heartbeat tells you "the metrics pipeline is working", the
 * health gauge tells you "the service itself reports healthy". They can
 * disagree — e.g. METRICS UP / HEALTH DOWN means the OTel agent is still
 * pushing but a dependency just broke; METRICS DOWN / HEALTH UP means the
 * service is fine but the collector / agent is wedged.
 *
 * Row click is handled by the parent — typically used to open the Service
 * Vitals drawer (six-tile per-service detail). The drawer itself exposes a
 * "View logs" affordance, so this card no longer navigates straight to Logs.
 */
const ServicesUptimeCard = ({ window, refreshTick, onRowClick, onServicesList, onData }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Previous rows stay on screen during the refresh — the loading bar is
    // the only signal until the new response arrives and swaps `data`.
    setLoading(true);
    setError(false);
    fetchServicesUptime({ window })
      .then(d => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
        // Surface the discovered service names up to SummaryView so the
        // Metrics card's picker can populate without a duplicate fetch.
        if (onServicesList) {
          const items = Array.isArray(d?.items) ? d.items : [];
          const names = items
            .map(it => it['service.name'] || it.serviceName)
            .filter(Boolean);
          onServicesList(names);
        }
        // Whole response up to the Home screen, which counts UP/DOWN rows for
        // its Services tile rather than re-fetching /services/uptime.
        if (onData) onData(d);
      })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [window, refreshTick, onServicesList, onData]);

  const items = Array.isArray(data?.items) ? data.items : [];
  // Sort: any DEGRADED / DOWN row first (those need attention), then alpha by
  // name. Tie-break by name keeps order stable across refreshes.
  const sorted = [...items].sort((a, b) => {
    const aRank = rowAttentionRank(a);
    const bRank = rowAttentionRank(b);
    if (aRank !== bRank) return aRank - bRank;
    return String(a['service.name'] || a.serviceName || '').localeCompare(
      String(b['service.name'] || b.serviceName || ''));
  });

  return (
    <article className="summary-card">
      <header className="summary-card-header">
        <h3 className="summary-card-title">Services Uptime</h3>
        <span className="summary-card-subtitle">
          {data?.heartbeatStream
            ? `via ${data.heartbeatStream} · application_health`
            : labelForWindow(window)}
        </span>
      </header>

      {loading && (
        <progress className="summary-card-loading-bar" aria-label="Refreshing services uptime" />
      )}
      {loading && !data && <div className="summary-card-loading">Loading…</div>}
      {!loading && error && <div className="summary-card-error">Failed to load services uptime.</div>}
      {!error && data && !data.supported && (
        <div className="summary-card-empty">
          Service uptime needs OpenObserve. Enable openobserve.enabled and confirm
          the collector is receiving metrics.
        </div>
      )}
      {!error && data?.supported && sorted.length === 0 && (
        <div className="summary-card-empty">
          No services have emitted metrics in this window.
        </div>
      )}

      {!error && data?.supported && sorted.length > 0 && (
        <div className="svc-uptime-list">
          {sorted.map(item => {
            const name = item['service.name'] || item.serviceName || 'unknown';
            const metricStatus = item.status || 'DOWN';
            const healthStatus = item.healthStatus || null;
            const detail = renderDetail(item);
            return (
              <button
                key={name}
                className="svc-uptime-row svc-uptime-row--dual"
                onClick={() => onRowClick?.(name)}
                title={`Open vitals for ${formatServiceName(name)}`}
              >
                <span className="svc-dots">
                  <span className={`svc-dot ${metricStatus}`} title={`Metrics: ${metricStatus}`} />
                  {healthStatus
                    ? <span className={`svc-dot ${dotClassForHealth(healthStatus)}`}
                      title={`Health: ${healthStatus}`} />
                    : <span className="svc-dot svc-dot--none"
                      title="Health gauge not exposed by this service" />}
                </span>
                <span className="svc-uptime-body">
                  <div className="svc-uptime-name">{formatServiceName(name)}</div>
                  {detail && (
                    <div className="svc-uptime-detail">{detail}</div>
                  )}
                </span>
                <span className="svc-uptime-statuses">
                  <span className={`svc-uptime-status ${metricStatus}`}>METRICS {metricStatus}</span>
                  {healthStatus && (
                    <span className={`svc-uptime-status ${dotClassForHealth(healthStatus)}`}>
                      HEALTH {healthStatus}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
};

/**
 * Lower = more attention. Any signal that disagrees with itself or reports a
 * non-UP state floats to the top so the user sees problems first.
 */
const rowAttentionRank = (item) => {
  const metricStatus = item.status;
  const healthStatus = item.healthStatus;
  const healthMissing = !healthStatus;
  if (metricStatus === 'DOWN' || healthStatus === 'DOWN') return 0;
  if (metricStatus !== healthStatus && !healthMissing) return 1; // disagreement
  return 2;
};

const dotClassForHealth = (status) => {
  if (!status) return 'UNKNOWN';
  if (status === 'UP') return 'UP';
  if (status === 'DOWN') return 'DOWN';
  return 'UNKNOWN';
};

const renderDetail = (item) => {
  if (item.processUptimeSec != null) return `uptime ${formatDuration(item.processUptimeSec)}`;
  if (item.lastSeenAgoSec != null) return `last seen ${formatDuration(item.lastSeenAgoSec)} ago`;
  return null;
};

const formatDuration = (sec) => {
  if (sec == null) return '-';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
};

const labelForWindow = (w) => {
  switch (w) {
    case 'now-15m': return 'LAST 15M';
    case 'now-1h': return 'LAST 1H';
    case 'now-24h': return 'LAST 24H';
    default: return w?.toUpperCase() || '';
  }
};

ServicesUptimeCard.propTypes = {
  window: PropTypes.string.isRequired,
  refreshTick: PropTypes.number.isRequired,
  onRowClick: PropTypes.func,
  onServicesList: PropTypes.func,
  /** Receives the raw /services/uptime response on every successful fetch. */
  onData: PropTypes.func,
};

export default ServicesUptimeCard;
