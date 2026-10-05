import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchRumSessions } from '../../services/api';
import {
  formatAbsolute, formatAgo, formatCount, formatDuration, formatPct,
} from './rumFormat';
import RumPanelState, { RumPartialNotice, panelStateKind } from './RumPanelState';

/**
 * The Sessions tab — one row per real user session.
 *
 * ─── The summary and the list answer different questions ────────────────────
 *
 * The five headline numbers describe EVERY session in the window; the table below
 * is one page of them. They are two separate figures from one backend response and
 * are deliberately not derived from each other — a bounce rate computed over the 50
 * rows on screen would change every time somebody paged, which is the opposite of
 * what a rate is for.
 *
 * ─── Health filtering is client-side, on purpose ────────────────────────────
 *
 * With errors / frustrated / clean, and the device split, filter the page already
 * in hand rather than re-querying. They are properties the backend already returned
 * per row, so a round trip would buy nothing; the counts beside each chip come from
 * the page too, and the labels say so rather than implying they cover the window.
 */

const HEALTH = [
  { key: 'all', label: 'All' },
  { key: 'errors', label: 'With errors', test: (r) => r.errorCount > 0 },
  { key: 'frustrated', label: 'Frustrated', test: (r) => r.frustrationCount > 0 },
  { key: 'clean', label: 'Clean', test: (r) => r.errorCount === 0 && r.frustrationCount === 0 },
];

const PAGE_SIZE = 50;

export default function RumSessions({ query }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [health, setHealth] = useState('all');

  const { window: win, service, env, version, reloadToken } = query;

  // Filters changing resets to the first page: staying on page 4 of a result set
  // that is now two pages long shows an empty table for no visible reason.
  useEffect(() => { setPage(0); }, [win, service, env, version]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetchRumSessions({
          window: win, service, env, version, page, size: PAGE_SIZE,
          signal: controller.signal,
        });
        if (cancelled) return;
        setData(res);
        setError('');
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Could not load RUM sessions.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [win, service, env, version, page, reloadToken]);

  // Memoised rather than `data?.items || []` inline: the fallback allocates a new
  // array on every render, which changes the dependency below and defeats the memo
  // it is feeding — the filter would re-run on every keystroke elsewhere on screen.
  const rows = useMemo(() => data?.items || [], [data]);
  const shown = useMemo(() => {
    const entry = HEALTH.find((h) => h.key === health);
    return entry?.test ? rows.filter(entry.test) : rows;
  }, [rows, health]);

  const stateProps = {
    loading,
    error,
    meta: data?.meta,
    empty: !loading && !error && !!data && data.total === 0,
    emptyTitle: 'No sessions in this window',
    emptyBody: 'The browser SDK reported no sessions for the selected filters. '
      + 'Widen the period, or clear the Service / Env / Version filters.',
  };
  if (panelStateKind(stateProps)) {
    return <div className="rum-panel"><RumPanelState {...stateProps} /></div>;
  }

  const s = data.summary;
  const totalPages = Math.max(Math.ceil(data.total / PAGE_SIZE), 1);

  return (
    <div className="rum-panel">
      <RumPartialNotice meta={data.meta} />

      <div className="rum-tiles rum-tiles--wide">
        <Stat label="Sessions" value={formatCount(s.sessions)}
          note="in selected time range" />
        <Stat label="With Errors" value={formatCount(s.withErrors)}
          tone={s.withErrors > 0 ? 'error' : undefined}
          note={s.sessions ? `${formatPct((s.withErrors * 100) / s.sessions)} · ≥1 error` : '—'} />
        <Stat label="Frustrated" value={formatCount(s.frustrated)}
          tone={s.frustrated > 0 ? 'warn' : undefined}
          note="rage & dead clicks" />
        <Stat label="Median Duration" value={formatDuration(s.medianDurationMs)}
          note="median, not mean — one abandoned tab would skew a mean" />
        <Stat label="Bounce Rate" value={formatPct(s.bounceRatePct)}
          note="sessions with a single view" />
      </div>

      <div className="rum-chips">
        <span className="rum-chips-label">Health</span>
        {HEALTH.map((h) => {
          const n = h.test ? rows.filter(h.test).length : rows.length;
          return (
            <button
              key={h.key}
              type="button"
              className={`rum-chip ${health === h.key ? 'is-active' : ''}`}
              onClick={() => setHealth(h.key)}
              // Says "on this page" outright: these counts cannot cover the window,
              // because the rows they count are one page of it.
              title={`${n} of the ${rows.length} sessions on this page`}
            >{h.label} · {n}</button>
          );
        })}
        <span className="rum-chips-note">counts describe this page</span>
      </div>

      <div className="rum-table-wrap">
        <table className="rum-table">
          <thead>
            <tr>
              <th>User &amp; Session</th>
              <th>Platform</th>
              <th className="rum-num">Views</th>
              <th className="rum-num">Events</th>
              <th>Health</th>
              <th>Location</th>
              <th className="rum-num">Duration</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.sessionId} className={r.errorCount > 0 ? 'is-errored' : ''}>
                <td>
                  <span className="rum-cell-strong">{r.user ? shortId(r.user) : 'Unknown'}</span>
                  <span className="rum-cell-sub" title={r.sessionId}>
                    {shortId(r.sessionId)}
                    {r.lastViewUrl ? ` · ${r.lastViewUrl}` : ''}
                  </span>
                </td>
                <td>
                  <span className="rum-badge">{r.source || '—'}</span>
                  {r.sessionType && r.sessionType !== 'user' && (
                    <span className="rum-badge rum-badge--muted">{r.sessionType}</span>
                  )}
                </td>
                <td className="rum-num">{formatCount(r.views)}</td>
                <td className="rum-num">{formatCount(r.events)}</td>
                <td>
                  {r.errorCount > 0 && (
                    <span className="rum-pill rum-pill--error"
                      title={`${r.errorCount} error events`}>{r.errorCount} err</span>
                  )}
                  {r.frustrationCount > 0 && (
                    <span className="rum-pill rum-pill--warn"
                      title={`${r.frustrationCount} rage or dead clicks`}>
                      {r.frustrationCount} frustr
                    </span>
                  )}
                  {r.errorCount === 0 && r.frustrationCount === 0 && (
                    <span className="rum-pill rum-pill--ok">clean</span>
                  )}
                </td>
                <td>
                  <span className="rum-cell-strong">{r.browser || 'Unknown'}</span>
                  <span className="rum-cell-sub">
                    {[r.os, r.device !== 'Other' ? r.device : null].filter(Boolean).join(' · ')
                      || '—'}
                  </span>
                </td>
                <td className="rum-num">{formatDuration(r.durationMs)}</td>
                <td title={formatAbsolute(r.lastSeenAt)}>{formatAgo(r.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.length === 0 && rows.length > 0 && (
        <p className="rum-empty-note">
          No session on this page matches the “{HEALTH.find((h) => h.key === health)?.label}”
          filter. Other pages may still contain some.
        </p>
      )}

      <footer className="rum-foot">
        <span className="rum-foot-note">
          Showing {shown.length === rows.length
            ? `${rows.length}`
            : `${shown.length} of ${rows.length}`} on page {page + 1} of {totalPages} —{' '}
          {formatCount(data.total)} session{data.total === 1 ? '' : 's'} in window
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

/** UUIDs are unreadable in full and unusable when truncated to nothing. Head and
 *  tail keeps them recognisable and distinguishable; the full value is in a title. */
function shortId(id) {
  const s = String(id || '');
  return s.length <= 14 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

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

RumSessions.propTypes = {
  query: PropTypes.object.isRequired,
};
