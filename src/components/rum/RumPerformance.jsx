import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchRumPerformance } from '../../services/api';
import {
  formatCount, formatMs, formatPct, formatVital, shortenUrl,
} from './rumFormat';
import RumPanelState, { panelStateKind } from './RumPanelState';

/**
 * The Performance tab: Core Web Vitals, error counters and API timings.
 *
 * ─── Four views of one fetch ────────────────────────────────────────────────
 *
 * Overview, Web Vitals, Errors and API are sub-tabs over the SAME response, not
 * four requests. The backend returns all of it in one call because the three
 * aggregations share a scan, and splitting them here would triple the query load to
 * show subsets of data already in hand. Switching sub-tab is therefore instant and
 * costs nothing.
 *
 * ─── Ratings come from the payload, not from thresholds here ─────────────────
 *
 * Each vital arrives with `rating` already resolved server-side against the
 * published Core Web Vitals thresholds. Re-deriving it in the browser would put the
 * same numbers in two places, and the moment they drifted the colour would stop
 * agreeing with the figure it was colouring.
 */

const SUB_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'vitals', label: 'Web Vitals' },
  { key: 'errors', label: 'Errors' },
  { key: 'api', label: 'API' },
];

/** The three Core Web Vitals, in the order Google publishes them. The rest of the
 *  payload is supporting load timing and is shown separately. */
const CORE_KEYS = ['lcp', 'inp', 'cls'];

export default function RumPerformance({ query }) {
  const [sub, setSub] = useState('overview');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const { window: win, service, env, version, reloadToken } = query;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetchRumPerformance({
          window: win, service, env, version, signal: controller.signal,
        });
        if (cancelled) return;
        setData(res);
        setError('');
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Could not load RUM performance.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [win, service, env, version, reloadToken]);

  const byKey = useMemo(() => {
    const map = {};
    (data?.vitals || []).forEach((v) => { map[v.key] = v; });
    return map;
  }, [data]);

  const core = CORE_KEYS.map((k) => byKey[k]).filter(Boolean);
  const supporting = (data?.vitals || []).filter((v) => !CORE_KEYS.includes(v.key));

  // Asked as a STRING, never as an element. `const s = <Foo/>; if (s)` is always
  // true — a React element is truthy even when the component renders null — which
  // is what made every panel return an empty div. See RumPanelState.
  const stateProps = {
    loading,
    error,
    meta: data?.meta,
    empty: !loading && !error && !!data && data.counts.totalSessions === 0
      && (data.vitals || []).every((v) => v.value == null),
    emptyTitle: 'No RUM data in this window',
    emptyBody: 'Nothing was reported by the browser SDK for the selected filters. '
      + 'Widen the period, or clear the Service / Env / Version filters.',
  };
  if (panelStateKind(stateProps)) {
    return <div className="rum-panel"><RumPanelState {...stateProps} /></div>;
  }

  return (
    <div className="rum-panel">
      <div className="rum-panel-head">
        <div>
          <h2 className="rum-panel-title">Performance Summary</h2>
          <p className="rum-panel-sub">
            Core Web Vitals, page load and API performance for your frontend
          </p>
        </div>
      </div>

      <nav className="rum-subtabs" role="tablist" aria-label="Performance sections">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === sub}
            className={`rum-subtab ${t.key === sub ? 'is-active' : ''}`}
            onClick={() => setSub(t.key)}
          >{t.label}</button>
        ))}
      </nav>

      {sub === 'overview' && (
        <div className="rum-columns">
          <Column title="Web Vitals">
            {core.map((v) => <VitalTile key={v.key} vital={v} />)}
          </Column>
          <Column title="Errors">
            <Tile
              label="Total Unhandled Errors"
              value={formatCount(data.counts.unhandledErrors)}
              tone={data.counts.unhandledErrors > 0 ? 'error' : undefined}
              hint="Errors the page did not catch — these break a session rather than get logged."
            />
            <Tile
              label="Total Errors"
              value={formatCount(data.counts.totalErrors)}
              tone={data.counts.totalErrors > 0 ? 'warn' : undefined}
              hint="Every error event, handled and unhandled."
            />
            <Tile
              label="Sessions with Errors"
              value={formatCount(data.counts.sessionsWithErrors)}
              tone={data.counts.sessionsWithErrors > 0 ? 'warn' : undefined}
              hint="Distinct sessions that hit at least one error."
            />
          </Column>
          <Column title="Sessions">
            <Tile
              label="Total Sessions"
              value={formatCount(data.counts.totalSessions)}
              hint="Distinct RUM sessions in the selected window."
            />
            <Tile
              label="Error-free Sessions"
              value={data.counts.totalSessions === 0 ? '—' : formatPct(
                ((data.counts.totalSessions - data.counts.sessionsWithErrors) * 100)
                / data.counts.totalSessions,
              )}
              hint="Share of sessions that hit no error at all."
            />
          </Column>
        </div>
      )}

      {sub === 'vitals' && (
        <>
          <div className="rum-tiles rum-tiles--wide">
            {core.map((v) => <VitalTile key={v.key} vital={v} big />)}
          </div>
          <h3 className="rum-section-title">Supporting load metrics</h3>
          <p className="rum-section-note">
            Not Core Web Vitals and deliberately unrated — there is no published
            good/poor threshold for them, and inventing one would make the colour mean
            something different here than on the three tiles above.
          </p>
          <div className="rum-tiles">
            {supporting.map((v) => <VitalTile key={v.key} vital={v} />)}
          </div>
        </>
      )}

      {sub === 'errors' && (
        <div className="rum-tiles rum-tiles--wide">
          <Tile
            label="Total Errors"
            value={formatCount(data.counts.totalErrors)}
            tone={data.counts.totalErrors > 0 ? 'warn' : undefined}
            big
          />
          <Tile
            label="Unhandled"
            value={formatCount(data.counts.unhandledErrors)}
            tone={data.counts.unhandledErrors > 0 ? 'error' : undefined}
            big
          />
          <Tile
            label="Handled"
            value={formatCount(
              Math.max(data.counts.totalErrors - data.counts.unhandledErrors, 0),
            )}
            big
          />
          <Tile
            label="Sessions Affected"
            value={`${formatCount(data.counts.sessionsWithErrors)} of ${
              formatCount(data.counts.totalSessions)}`}
            big
          />
          <p className="rum-section-note rum-section-note--span">
            Counters only. The Error Tracking tab groups these occurrences into distinct
            issues, which is what you triage — 35 events across 9 issues is nine problems,
            not thirty-five.
          </p>
        </div>
      )}

      {sub === 'api' && (
        <ApiTable rows={data.api} />
      )}
    </div>
  );
}

/** One labelled group of tiles on the Overview. */
function Column({ title, children }) {
  return (
    <section className="rum-column">
      <h3 className="rum-column-title">{title}</h3>
      <div className="rum-column-body">{children}</div>
    </section>
  );
}
Column.propTypes = { title: PropTypes.string.isRequired, children: PropTypes.node };

/**
 * A vital, coloured by the rating the backend resolved.
 *
 * <p>The sample size is printed under every tile. A p75 taken over three views is
 * not a percentile, and a tile that looks identical whether it rests on 3 or 30,000
 * views invites a decision the data cannot support.</p>
 */
function VitalTile({ vital, big }) {
  const ratingClass = vital.rating ? `rum-tile--${vital.rating}` : '';
  const bigClass = big ? 'is-big' : '';
  let footText = 'not reported in this window';
  if (vital.value != null) {
    const sfx = vital.sample === 1 ? '' : 's';
    footText = `p75 over ${formatCount(vital.sample)} view${sfx}`;
  }

  return (
    <div className={`rum-tile ${bigClass} ${ratingClass}`}>
      <span className="rum-tile-label">{vital.label}</span>
      <span className="rum-tile-value">{formatVital(vital)}</span>
      <span className="rum-tile-foot">
        {footText}
        {vital.rating ? ` · ${vital.rating.replaceAll('-', ' ')}` : ''}
      </span>
    </div>
  );
}
VitalTile.propTypes = { vital: PropTypes.object.isRequired, big: PropTypes.bool };

function Tile({ label, value, tone, hint, big }) {
  const bigClass = big ? 'is-big' : '';
  const toneClass = tone ? `rum-tile--${tone}` : '';
  return (
    <div
      className={`rum-tile ${bigClass} ${toneClass}`}
      title={hint || undefined}
    >
      <span className="rum-tile-label">{label}</span>
      <span className="rum-tile-value">{value}</span>
    </div>
  );
}
Tile.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  tone: PropTypes.string,
  hint: PropTypes.string,
  big: PropTypes.bool,
};

/**
 * Per-endpoint browser-side API timings.
 *
 * <p>These are what the BROWSER measured, network included, so they are expected to
 * exceed the server-side latency for the same route. That gap is the reason the
 * table exists, and the note says so rather than leaving someone to conclude the
 * backend is slow.</p>
 */
function ApiTable({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rum-empty">
        <p>No xhr or fetch calls were recorded in this window.</p>
        <p className="rum-empty-note">
          Static assets are deliberately excluded — including images, CSS and scripts
          here would bury the API calls this table is for.
        </p>
      </div>
    );
  }
  return (
    <>
      <p className="rum-section-note">
        Measured in the browser, so the network is included. These numbers should read
        higher than the server-side latency for the same route; the difference is what
        the user actually waited for.
      </p>
      <div className="rum-table-wrap">
        <table className="rum-table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th className="rum-num">Method</th>
              <th className="rum-num">Calls</th>
              <th className="rum-num">Avg</th>
              <th className="rum-num">p95</th>
              <th className="rum-num">Errors</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.method || ''}|${r.url}`}>
                <td className="rum-cell-url" title={r.url}>{shortenUrl(r.url)}</td>
                <td className="rum-num">{r.method || '—'}</td>
                <td className="rum-num">{formatCount(r.calls)}</td>
                <td className="rum-num">{formatMs(r.avgMs)}</td>
                <td className="rum-num">{formatMs(r.p95Ms)}</td>
                <td className={`rum-num ${r.errorCalls > 0 ? 'rum-num--error' : ''}`}>
                  {formatCount(r.errorCalls)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
ApiTable.propTypes = { rows: PropTypes.array };

RumPerformance.propTypes = {
  /** {window, service, env, version, reloadToken} — owned by RumView. */
  query: PropTypes.object.isRequired,
};
