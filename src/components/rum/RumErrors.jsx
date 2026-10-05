import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchRumErrors } from '../../services/api';
import {
  formatAbsolute, formatAgo, formatCount, formatPct,
} from './rumFormat';
import RumPanelState, { RumPartialNotice, panelStateKind } from './RumPanelState';

/**
 * The Error Tracking tab — occurrences grouped into issues.
 *
 * ─── An issue is not an occurrence ──────────────────────────────────────────
 *
 * The table lists ISSUES: the backend groups on (type, message, source), so 35
 * error events across 9 distinct issues is nine problems to fix, not thirty-five.
 * That grouping is deliberately server-side — the same message thrown from two
 * different files is two bugs, and merging them would produce one row nobody can
 * act on.
 *
 * ─── Handled is not harmless ────────────────────────────────────────────────
 *
 * Handled and unhandled are shown side by side rather than the handled ones being
 * hidden. A handled error is one the page caught, not one that did not happen; a
 * frontend logging thousands of caught failures is still failing. The chart splits
 * them so the shape of each is visible independently.
 */

const HANDLING = [
  { key: 'all', label: 'All' },
  { key: 'unhandled', label: 'Unhandled' },
  { key: 'handled', label: 'Handled' },
];

const PAGE_SIZE = 50;

export default function RumErrors({ query }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [handling, setHandling] = useState('all');
  const [page, setPage] = useState(0);

  const { window: win, service, env, version, reloadToken } = query;

  useEffect(() => { setPage(0); }, [win, service, env, version, handling]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetchRumErrors({
          window: win, service, env, version, handling, page, size: PAGE_SIZE,
          signal: controller.signal,
        });
        if (cancelled) return;
        setData(res);
        setError('');
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Could not load RUM errors.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [win, service, env, version, handling, page, reloadToken]);

  const stateProps = {
    loading,
    error,
    meta: data?.meta,
    empty: !loading && !error && !!data && data.summary.totalErrors === 0,
    emptyTitle: 'No frontend errors in this window',
    emptyBody: 'Nothing was reported for the selected filters — which on an error screen '
      + 'is the result you want. Widen the period to confirm it holds.',
  };
  if (panelStateKind(stateProps)) {
    return <div className="rum-panel"><RumPanelState {...stateProps} /></div>;
  }

  const s = data.summary;
  const totalPages = Math.max(Math.ceil(data.total / PAGE_SIZE), 1);

  return (
    <div className="rum-panel">
      <RumPartialNotice meta={data.meta} />

      <div className="rum-error-top">
        <ErrorChart series={data.series} />

        <div className="rum-tiles rum-tiles--stack">
          <Stat label="Total Errors" value={formatCount(s.totalErrors)}
            tone={s.totalErrors > 0 ? 'warn' : undefined}
            note={`across ${formatCount(s.uniqueIssues)} unique issue${
              s.uniqueIssues === 1 ? '' : 's'}`} />
          <Stat
            label="Crash-free Sessions"
            value={formatPct(s.crashFreeSessionsPct)}
            tone={crashTone(s.crashFreeSessionsPct)}
            note={`${formatCount(s.sessionsAffected)} of ${
              formatCount(s.totalSessions)} sessions hit an error`}
          />
          <Stat label="Users Affected" value={formatCount(s.usersAffected)}
            note="distinct users who saw at least one error" />
        </div>
      </div>

      <div className="rum-chips">
        <span className="rum-chips-label">Type</span>
        {HANDLING.map((h) => (
          <button
            key={h.key}
            type="button"
            className={`rum-chip ${handling === h.key ? 'is-active' : ''}`}
            onClick={() => setHandling(h.key)}
          >{h.label}</button>
        ))}
        <span className="rum-chips-note">re-queries the window</span>
      </div>

      <div className="rum-table-wrap">
        <table className="rum-table">
          <thead>
            <tr>
              <th>Issue</th>
              <th className="rum-num">Events</th>
              <th className="rum-num">Users</th>
              <th className="rum-num">Sessions</th>
              <th>First / Last seen</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((it, i) => (
              <tr key={`${it.type || ''}|${it.source || ''}|${it.message || ''}|${i}`}>
                <td className="rum-cell-issue">
                  <span className="rum-issue-msg" title={it.message || ''}>
                    {it.type && <strong className="rum-issue-type">{it.type}: </strong>}
                    {it.message || '(no message reported)'}
                  </span>
                  <span className="rum-cell-sub">
                    <span className={`rum-pill ${it.handling === 'unhandled'
                      ? 'rum-pill--error' : 'rum-pill--warn'}`}>
                      {(it.handling || 'unknown').toUpperCase()}
                    </span>
                    {it.source && <code className="rum-issue-src">{it.source}</code>}
                    {it.service && <span className="rum-issue-svc">{it.service}</span>}
                  </span>
                </td>
                <td className="rum-num">{formatCount(it.events)}</td>
                <td className="rum-num">{formatCount(it.users)}</td>
                <td className="rum-num">{formatCount(it.sessions)}</td>
                <td>
                  <span className="rum-cell-strong" title={formatAbsolute(it.lastSeen)}>
                    {formatAgo(it.lastSeen)}
                  </span>
                  <span className="rum-cell-sub" title={formatAbsolute(it.firstSeen)}>
                    first {formatAgo(it.firstSeen)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="rum-foot">
        <span className="rum-foot-note">
          {formatCount(data.total)} issue{data.total === 1 ? '' : 's'} · page {page + 1} of{' '}
          {totalPages}. “First seen” is the earliest occurrence IN THIS WINDOW — widening
          the period can only move it earlier.
        </span>
        <span className="rum-pager">
          <button type="button" className="rum-page-btn" disabled={page === 0}
            onClick={() => setPage((p) => Math.max(p - 1, 0))}>Previous</button>
          <button type="button" className="rum-page-btn" disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}>Next</button>
        </span>
      </footer>
    </div>
  );
}

/** Crash-free is a health figure, so its colour follows the published-style bands
 *  rather than "any errors at all is red" — 99.9% crash-free is a good service. */
function crashTone(pct) {
  if (pct == null) return undefined;
  if (pct >= 99) return 'good';
  return pct >= 95 ? 'warn' : 'error';
}

/**
 * Errors over time, handled stacked under unhandled.
 *
 * <p>Inline SVG rather than a chart library: this is one stacked bar chart with no
 * interaction beyond a tooltip, and a charting dependency would be the largest thing
 * in the bundle. Unhandled rides on top so it stays visible against the baseline
 * even when a bucket is one pixel tall — it is the series you are looking for.</p>
 */
function ErrorChart({ series }) {
  const model = useMemo(() => {
    const rows = Array.isArray(series) ? series : [];
    const peak = rows.reduce((m, b) => Math.max(m, (b.handled || 0) + (b.unhandled || 0)), 0);
    return { rows, peak };
  }, [series]);

  if (model.rows.length === 0) {
    return (
      <div className="rum-chart rum-chart--empty">
        <span>No error events to plot in this window.</span>
      </div>
    );
  }

  const H = 120;
  const W = Math.max(model.rows.length * 14, 240);
  const bw = W / model.rows.length;
  // A flat zero line rather than nothing when every bucket is empty: an absent
  // chart reads as a rendering failure, a flat line reads as zero.
  const scale = (n) => (model.peak === 0 ? 0 : (n / model.peak) * (H - 8));

  return (
    <figure className="rum-chart">
      <figcaption className="rum-chart-head">
        <span>Errors over time</span>
        <span className="rum-chart-legend">
          <span className="rum-legend-item">
            <i className="rum-swatch rum-swatch--handled" />
            {' '}Handled
          </span>
          <span className="rum-legend-item">
            <i className="rum-swatch rum-swatch--unhandled" />
            {' '}Unhandled
          </span>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="rum-chart-svg"
        role="img" aria-label={`Error volume across ${model.rows.length} time buckets`}>
        {model.rows.map((b, i) => {
          const h = scale(b.handled || 0);
          const u = scale(b.unhandled || 0);
          const x = i * bw;
          return (
            <g key={b.bucketStart || i}>
              <title>
                {`${formatAbsolute(b.bucketStart)} — ${b.handled || 0} handled, ${
                  b.unhandled || 0} unhandled`}
              </title>
              <rect x={x + bw * 0.15} y={H - h} width={bw * 0.7} height={h}
                className="rum-bar rum-bar--handled" />
              <rect x={x + bw * 0.15} y={H - h - u} width={bw * 0.7} height={u}
                className="rum-bar rum-bar--unhandled" />
            </g>
          );
        })}
      </svg>
      <span className="rum-chart-foot">
        {model.rows.length} buckets · peak {formatCount(model.peak)} error
        {model.peak === 1 ? '' : 's'} — bucket width follows the selected period
      </span>
    </figure>
  );
}
ErrorChart.propTypes = { series: PropTypes.array };

function Stat({ label, value, note, tone }) {
  const toneClass = tone ? `rum-tile--${tone}` : '';
  return (
    <div className={`rum-tile is-big ${toneClass}`}>
      <span className="rum-tile-label">{label}</span>
      <span className="rum-tile-value">{value}</span>
      {note && <span className="rum-tile-foot">{note}</span>}
    </div>
  );
}
Stat.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  note: PropTypes.string,
  tone: PropTypes.string,
};

RumErrors.propTypes = {
  query: PropTypes.object.isRequired,
};
