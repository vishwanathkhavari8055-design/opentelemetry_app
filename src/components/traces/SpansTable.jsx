import React from 'react';
import PropTypes from 'prop-types';
import { formatIsoDateTime } from '../../utils/dateUtils';
import { formatDurationUs } from '../../utils/format';
import { ServiceIcon } from './ServiceIcon';

/**
 * Spans tab: one row per span — timestamp, service, operation, duration,
 * status.
 *
 * Clicking a row opens the span's trace in the drill-down view, which is the
 * only reason you'd be looking at a span list in the first place.
 */

const LOCAL_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
})();

/** Columns, in render order. `sortKey` is null for ones the backend can't sort. */
const COLUMNS = [
  { key: 'timestamp', label: `Timestamp (${LOCAL_TZ})`, cls: 'tt-col-ts' },
  { key: 'service', label: 'Service', cls: 'tt-col-svc' },
  { key: 'operation', label: 'Operation Name', cls: 'tt-col-op' },
  { key: 'duration', label: 'Duration', cls: 'tt-col-dur' },
  { key: 'status', label: 'Span Status', cls: 'tt-col-status' },
];

export default function SpansTable({ rows, loading, error, onTraceClick }) {
  return (
    <table className="tt-wrap">
      <thead>
        <tr role="row" className="tt-head">
          {COLUMNS.map((c) => (
            <th className={`tt-cell ${c.cls}`} key={c.key} scope="col">{c.label}</th>
          ))}
        </tr>
      </thead>

      <tbody>
        {loading && (
          <tr role="row">
            <td colSpan={5}>
              <progress className="log-loading-bar" aria-label="Running query" />
            </td>
          </tr>
        )}

        {rows.length === 0 ? (
          <tr role="row" className="log-empty">
            <td colSpan={5}>
              {(() => {
                if (loading) return <span>Running query…</span>;
                if (error) return <span className="log-empty-error">{error}</span>;
                return <span>No spans matched this query in the selected time range.</span>;
              })()}
            </td>
          </tr>
        ) : rows.map((s, i) => {
          const errored = (s.spanStatus || '').toUpperCase() === 'ERROR';
          return (
            <tr
              role="row"
              className={`tt-row ${errored ? 'is-error' : ''}`}
              key={`${s.spanId}-${i}`}
              tabIndex={0}
              title={`Open trace ${s.traceId}`}
              onClick={() => s.traceId && onTraceClick(s.traceId)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && s.traceId) {
                  e.preventDefault();
                  onTraceClick(s.traceId);
                }
              }}
            >
              <td className="tt-cell tt-col-ts">{formatIsoDateTime(s.timestamp)}</td>
              <td className="tt-cell tt-col-svc" title={s.serviceName || ''}>
                <ServiceIcon name={s.serviceName} />
                <span className="tt-svc-name">{s.serviceName || '—'}</span>
              </td>
              <td className="tt-cell tt-col-op" title={s.operationName || ''}>
                {s.operationName || '—'}
              </td>
              <td className="tt-cell tt-col-dur">{formatDurationUs(s.durationUs)}</td>
              <td className="tt-cell tt-col-status">
                <span className={`tt-status tt-status--${(s.spanStatus || 'unset').toLowerCase()}`}>
                  {s.spanStatus || 'UNSET'}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

SpansTable.propTypes = {
  rows: PropTypes.array.isRequired,
  loading: PropTypes.bool,
  error: PropTypes.string,
  onTraceClick: PropTypes.func.isRequired,
};
