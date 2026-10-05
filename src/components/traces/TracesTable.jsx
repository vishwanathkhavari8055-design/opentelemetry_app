import React from 'react';
import PropTypes from 'prop-types';
import { formatIsoDateTime } from '../../utils/dateUtils';
import { formatDurationUs, formatExact } from '../../utils/format';
import { ServiceIcon, colorForService } from './ServiceIcon';

/**
 * Traces tab: one row per trace — root operation, span count, status, and a
 * Service Latency bar showing which services the trace's time went to.
 */

const LOCAL_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
})();

/**
 * The Service Latency bar: one segment per service, width proportional to that
 * service's share of the trace's summed span time, coloured by the same
 * name-derived palette the service icons use.
 *
 * Proportions are taken over the SUM of the slices, not over the trace's own
 * duration. Child spans nest and overlap, so their sum routinely exceeds the
 * root's wall clock — normalising against the root would produce segments
 * totalling more than 100% and a bar that overflows its cell.
 */
function ServiceLatencyBar({ services }) {
  const slices = (services || []).filter((s) => (s.durationUs || 0) > 0);
  const total = slices.reduce((sum, s) => sum + (s.durationUs || 0), 0);

  if (!slices.length || total <= 0) {
    return <span className="tt-lat-bar tt-lat-bar--empty" aria-hidden="true" />;
  }

  return (
    <span className="tt-lat-bar">
      {slices.map((s) => {
        const pct = ((s.durationUs || 0) / total) * 100;
        return (
          <span
            key={s.serviceName}
            className="tt-lat-seg"
            style={{ width: `${pct}%`, background: colorForService(s.serviceName) }}
            title={`${s.serviceName} — ${formatDurationUs(s.durationUs)} across ${
              s.spanCount} span${s.spanCount === 1 ? '' : 's'} (${pct.toFixed(1)}%)`}
          />
        );
      })}
    </span>
  );
}
ServiceLatencyBar.propTypes = { services: PropTypes.array };

export default function TracesTable({ rows, loading, error, onTraceClick }) {
  return (
    <table className="tt-wrap">
      <thead>
      <tr role="row" className="tt-head tt-head--traces">
        <th scope="col" className="tt-cell tt-col-ts">Timestamp ({LOCAL_TZ})</th>
        <th scope="col" className="tt-cell tt-col-svc">Service</th>
        <th scope="col" className="tt-cell tt-col-op">Operation Name</th>
        <th scope="col" className="tt-cell tt-col-dur">Duration</th>
        <th scope="col" className="tt-cell tt-col-spans">Spans</th>
        <th scope="col" className="tt-cell tt-col-status">Status</th>
        <th scope="col" className="tt-cell tt-col-lat">Service Latency</th>
      </tr>
      </thead>

      {loading && <progress className="log-loading-bar" aria-label="Running query" />}

      <tbody className="tt-body">
        {rows.length === 0 ? (
          <tr className="log-empty">
            <td colSpan={7}>
              {(() => {
                if (loading) return <span>Running query…</span>;
                if (error) return <span className="log-empty-error">{error}</span>;
                return <span>No traces matched this query in the selected time range.</span>;
              })()}
            </td>
          </tr>
        ) : rows.map((t) => {
          const errored = (t.status || '').toUpperCase() === 'ERROR';
          return (
            <tr
              role="row"
              className={`tt-row tt-row--traces ${errored ? 'is-error' : ''}`}
              key={t.traceId}
              tabIndex={0}
              title={`Open trace ${t.traceId}`}
              onClick={() => onTraceClick(t.traceId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onTraceClick(t.traceId);
                }
              }}
            >
              <td className="tt-cell tt-col-ts">{formatIsoDateTime(t.timestamp)}</td>
              <td className="tt-cell tt-col-svc" title={t.serviceName || ''}>
                <ServiceIcon name={t.serviceName} />
                <span className="tt-svc-name">{t.serviceName || '—'}</span>
              </td>
              <td className="tt-cell tt-col-op" title={t.operationName || ''}>
                {t.operationName || '—'}
              </td>
              <td className="tt-cell tt-col-dur">{formatDurationUs(t.durationUs)}</td>
              <td className="tt-cell tt-col-spans" title={`${formatExact(t.spanCount)} spans`}>
                {t.spanCount ?? '—'}
              </td>
              <td className="tt-cell tt-col-status">
                <span className={`tt-status tt-status--${(t.status || 'success').toLowerCase()}`}>
                  {t.status || 'SUCCESS'}
                </span>
              </td>
              <td className="tt-cell tt-col-lat">
                <ServiceLatencyBar services={t.services} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

TracesTable.propTypes = {
  rows: PropTypes.array.isRequired,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onTraceClick: PropTypes.func.isRequired,
};
