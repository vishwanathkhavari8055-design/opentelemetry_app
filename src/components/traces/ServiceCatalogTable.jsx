import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDurationUs, formatCount, formatPercent, formatExact } from '../../utils/format';
import { ServiceIcon } from './ServiceIcon';

/**
 * Service Catalog tab: one row per service with request volume, error rate and
 * the latency distribution.
 *
 * Sorting and the name filter are client-side, deliberately. The backend
 * returns the full service list in one aggregation — a deployment has tens of
 * services, not thousands — so round-tripping for a re-sort would add latency
 * to something that can be instant.
 */

/** Ordering matches the backend's severity banding, worst first. */
const STATUS_RANK = { CRITICAL: 0, WARNING: 1, DEGRADED: 2, HEALTHY: 3 };

const COLUMNS = [
  { key: 'serviceName', label: 'Service',      cls: 'sc-col-svc',  numeric: false },
  { key: 'status',      label: 'Status',       cls: 'sc-col-stat', numeric: false },
  { key: 'requests',    label: 'Requests',     cls: 'sc-col-num',  numeric: true },
  { key: 'errorRate',   label: 'Error Rate',   cls: 'sc-col-num',  numeric: true },
  { key: 'errors',      label: 'Errors',       cls: 'sc-col-num',  numeric: true },
  { key: 'p50Us',       label: 'P50',          cls: 'sc-col-num',  numeric: true },
  { key: 'p95Us',       label: 'P95',          cls: 'sc-col-num',  numeric: true },
  { key: 'p99Us',       label: 'P99',          cls: 'sc-col-num',  numeric: true },
  { key: 'avgUs',       label: 'Avg Duration', cls: 'sc-col-num',  numeric: true },
  { key: 'maxUs',       label: 'Max Duration', cls: 'sc-col-num',  numeric: true },
];

export default function ServiceCatalogTable({
  data, loading, error, filter, onFilterChange, onServiceClick,
}) {
  // Default sort is by status, worst first — the reason to open this tab is to
  // find what's broken, not to read an alphabetical inventory.
  const [sort, setSort] = useState({ key: 'status', dir: 'asc' });

  const rows = useMemo(() => {
    const all = data?.items || [];
    const q = (filter || '').trim().toLowerCase();
    const filtered = q
      ? all.filter((r) => (r.serviceName || '').toLowerCase().includes(q))
      : all;

    const { key, dir } = sort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (key === 'status') {
        const d = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
        // Same band → busiest first, so "1 Critical" doesn't sit below a
        // critical service handling three requests an hour.
        return d !== 0 ? d * mul : (b.requests || 0) - (a.requests || 0);
      }
      if (key === 'serviceName') {
        return String(a.serviceName || '').localeCompare(String(b.serviceName || '')) * mul;
      }
      return ((a[key] || 0) - (b[key] || 0)) * mul;
    });
  }, [data, filter, sort]);

  const toggleSort = (key) => {
    setSort((s) => {
      if (s.key === key) {
        return { key, dir: s.dir === 'asc' ? 'desc' : 'asc' };
      }
      const dir = key === 'serviceName' || key === 'status' ? 'asc' : 'desc';
      return { key, dir };
    });
  };

  const total = data?.items?.length ?? 0;

  return (
    <div className="sc-wrap">
      <div className="sc-toolbar">
        <div className="sc-filter">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.6-3.6" />
          </svg>
          <input
            type="text"
            value={filter}
            placeholder="Filter by service name..."
            aria-label="Filter by service name"
            onChange={(e) => onFilterChange(e.target.value)}
          />
        </div>

        <span className="sc-chip">{total} service{total === 1 ? '' : 's'}</span>
        {data?.criticalCount > 0 && (
          <span className="sc-chip sc-chip--critical">{data.criticalCount} Critical</span>
        )}
        {data?.warningCount > 0 && (
          <span className="sc-chip sc-chip--warning">{data.warningCount} Warning</span>
        )}
        {data?.degradedCount > 0 && (
          <span className="sc-chip sc-chip--degraded">{data.degradedCount} Degraded</span>
        )}
      </div>

      <table style={{ width: '100%', display: 'block' }}>
        <thead>
          <tr className="sc-head">
            {COLUMNS.map((c) => {
              let caret = '⇅';
              if (sort.key === c.key) {
                caret = sort.dir === 'asc' ? '↑' : '↓';
              }
              return (
                <th scope="col" key={c.key} style={{ padding: 0, border: 'none' }}>
                  <button
                    type="button"
                    className={`sc-cell ${c.cls} sc-sortable ${sort.key === c.key ? 'is-sorted' : ''}`}
                    onClick={() => toggleSort(c.key)}
                    title={`Sort by ${c.label}`}
                  >
                    {c.label}
                    <span className="sc-sort-caret" aria-hidden="true">
                      {caret}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={10}><progress className="log-loading-bar" aria-label="Loading catalog" /></td></tr>}

        {rows.length === 0 ? (
          <tr className="log-empty">
            <td colSpan={10}>
              {(() => {
                if (loading) return <span>Loading service catalog…</span>;
                if (error) return <span className="log-empty-error">{error}</span>;
                if (filter) return <span>{`No service matches “${filter}”.`}</span>;
                return <span>No services produced spans in the selected time range.</span>;
              })()}
            </td>
          </tr>
        ) : rows.map((r) => (
          <tr
            className="sc-row"
            key={r.serviceName}
            tabIndex={0}
            title={`Filter the query to ${r.serviceName}`}
            onClick={() => onServiceClick(r.serviceName)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onServiceClick(r.serviceName);
              }
            }}
          >
            <td className="sc-cell sc-col-svc" title={r.serviceName}>
              <ServiceIcon name={r.serviceName} />
              <span className="tt-svc-name">{r.serviceName}</span>
            </td>
            <td className="sc-cell sc-col-stat">
              <span className={`sc-status sc-status--${(r.status || 'healthy').toLowerCase()}`}>
                {r.status ? r.status.charAt(0) + r.status.slice(1).toLowerCase() : 'Healthy'}
              </span>
            </td>
            <td className="sc-cell sc-col-num" title={formatExact(r.requests)}>
              {formatCount(r.requests)}
            </td>
            <td className={`sc-cell sc-col-num ${r.errorRate > 0 ? 'is-warn' : ''}`}>
              {formatPercent(r.errorRate)}
            </td>
            <td className="sc-cell sc-col-num" title={formatExact(r.errors)}>
              {formatCount(r.errors)}
            </td>
            <td className="sc-cell sc-col-num" title={`${formatExact(r.p50Us)} µs`}>
              {formatDurationUs(r.p50Us)}
            </td>
            <td className="sc-cell sc-col-num" title={`${formatExact(r.p95Us)} µs`}>
              {formatDurationUs(r.p95Us)}
            </td>
            <td className="sc-cell sc-col-num" title={`${formatExact(r.p99Us)} µs`}>
              {formatDurationUs(r.p99Us)}
            </td>
            <td className="sc-cell sc-col-num" title={`${formatExact(r.avgUs)} µs`}>
              {formatDurationUs(r.avgUs)}
            </td>
            <td className="sc-cell sc-col-num" title={`${formatExact(r.maxUs)} µs`}>
              {formatDurationUs(r.maxUs)}
            </td>
          </tr>
        ))}
        </tbody>
      </table>
    </div>
  );
}

ServiceCatalogTable.propTypes = {
  /** GET /api/traces/catalog response. */
  data: PropTypes.object,
  loading: PropTypes.bool,
  error: PropTypes.string,
  filter: PropTypes.string.isRequired,
  onFilterChange: PropTypes.func.isRequired,
  /** Clicking a row narrows the shared query to that service. */
  onServiceClick: PropTypes.func.isRequired,
};
