import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchAnalyticsLogCounts } from '../../services/api';
import {
  SEVERITY_BUCKETS, exactCount, formatCount, formatShare, severityMix,
} from './analyticsFormat';
import { buildLogsDrill, drillHint } from './analyticsDrill';

/**
 * Analytics Dashboard, CATEGORY BOARD face — pick a category, see everything in it.
 *
 * ─── Why this exists next to the Drill Table ────────────────────────────────
 *
 * Same endpoint, same numbers, a different question. The Drill Table answers "show me
 * this exact thing" — you already know what you are looking for and you steer three
 * pickers to it. This board answers "where is the volume", which is the question you
 * actually have when you open a dashboard cold: every category is on screen at once
 * with its counts and its share of the estate, so you can see that Applications
 * carries most of it BEFORE deciding what to click.
 *
 * That is also why the cards stay visible after one is picked. A drill that replaces
 * the level above it turns comparing two categories into clicking back and forth
 * while trying to remember numbers.
 *
 * ─── Click a category, get a flat list of SERVICES ──────────────────────────
 *
 * Clicking Applications lists HttpProtAdapterSvc, IoTOpsCIMService, DataFlowSvc and
 * the rest — one row per service, ranked by volume, with no product tier anywhere in
 * the layout. Clicking Tools does exactly the same. That symmetry is the point:
 * whether a category happens to carry products is an accident of the taxonomy, and a
 * board that made you open a product row first for some categories but not others
 * would be forcing the operator to care about it.
 *
 * The product is not a column, not a group and not a heading here. It survives only in
 * a row's tooltip, for the rare case of two similarly-named services — that is the
 * whole of its presence. One request per category, not one per product: the backend
 * flattens the tier with `level=microservice`.
 *
 * The Drill Table face still drills category → product → microservice for anyone who
 * does want the product tier. Neither face lost anything.
 *
 * ─── Nothing about the estate is written down here ──────────────────────────
 *
 * There is no list of categories, products or microservices in this file. Every card
 * and every row comes from /api/analytics/log-counts, which derives them from what is
 * REGISTERED in the Product Catalog. Register a microservice and it appears here;
 * remove it and its row goes away.
 *
 * ─── Two requests, the second only when a category is chosen ────────────────
 *
 * Categories on mount, then that category's services on selection. The service level
 * is the expensive one — it is a count per registered resource — so it is never
 * pre-fetched for a category nobody opened.
 */

/** Windows offered. Values are what the backend's parser already accepts. */
const WINDOWS = [
  { value: 'now-15m', label: 'Last 15 minutes' },
  { value: 'now-1h', label: 'Last hour' },
  { value: 'now-6h', label: 'Last 6 hours' },
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
];

const REFRESH_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
];

/**
 * The time range, under the SAME key the Drill Table uses.
 *
 * <p>Deliberately shared, not namespaced per face. Switching tabs is a change of
 * presentation, not of question — landing on the other face showing a different range
 * would make the two faces' numbers disagree for a reason nothing on screen
 * explains.</p>
 */
const LS_WINDOW = 'observability-ui:analytics:window:v1';

/**
 * Which category was open.
 *
 * <p>Persisted because this is the board's whole navigation state, and losing it on
 * every reload would make the screen useless as something to leave open. Validated
 * against what actually came back, so a category that is no longer registered is
 * dropped rather than left selected above an empty panel.</p>
 */
const LS_CATEGORY = 'observability-ui:analytics:board:category:v1';

/** The panel's columns, left to right. Total first because it is what the rows are
 *  ranked by; the severities follow in the shared order every Analytics surface
 *  uses. Built from SEVERITY_BUCKETS so the header and the cells cannot drift. */
const PANEL_COLUMNS = [{ key: 'total', label: 'Total logs' }, ...SEVERITY_BUCKETS];

export default function AnalyticsCategoryBoardView({ activeOrg, onNavigate, onDrillToLogs }) {
  const [timeWindow, setTimeWindow] = useState(() => {
    try {
      const stored = localStorage.getItem(LS_WINDOW);
      return WINDOWS.some((w) => w.value === stored) ? stored : 'now-24h';
    } catch { return 'now-24h'; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_WINDOW, timeWindow); } catch { /* not persisted */ }
  }, [timeWindow]);

  const [refreshMs, setRefreshMs] = useState(60_000);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  // ── Level 1: the category cards ─────────────────────────────────────────────

  const [board, setBoard] = useState(null);
  const [boardLoading, setBoardLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [boardError, setBoardError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (board) setRefreshing(true); else setBoardLoading(true);

    fetchAnalyticsLogCounts({ window: timeWindow, signal: controller.signal })
      .then((res) => {
        if (cancelled) return;
        setBoard(res);
        setBoardError('');
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // The previous cards stay on screen. Blanking them on a transient failure
        // would read as "no logs anywhere", which is the one thing a volume board
        // must never say by accident.
        setBoardError(err.message || 'Could not load the category board.');
      })
      .finally(() => {
        if (cancelled) return;
        setBoardLoading(false);
        setRefreshing(false);
      });

    return () => { cancelled = true; controller.abort(); };
    // `board` is read only to choose between the skeleton and a dimmed refresh;
    // depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeWindow, tick, activeOrg]);

  const categories = useMemo(() => board?.items || [], [board]);

  // ── Level 2: the selected category's microservices ──────────────────────────

  const [selected, setSelected] = useState(() => {
    try { return localStorage.getItem(LS_CATEGORY) || null; } catch { return null; }
  });
  const [members, setMembers] = useState(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState('');
  const [sort, setSort] = useState({ key: 'total', dir: 'desc' });

  /**
   * Drop a restored selection the catalog no longer has.
   *
   * <p>Guarded on `board` so it runs only once the cards have actually arrived.
   * Without that it would clear a perfectly valid selection on every mount, which is
   * precisely what persisting it was meant to prevent.</p>
   */
  useEffect(() => {
    if (!board || !selected) return;
    if (!categories.some((c) => c.key === selected)) setSelected(null);
  }, [board, categories, selected]);

  useEffect(() => {
    try {
      if (selected) localStorage.setItem(LS_CATEGORY, selected);
      else localStorage.removeItem(LS_CATEGORY);
    } catch { /* not persisted */ }
  }, [selected]);

  useEffect(() => {
    if (!selected) {
      setMembers(null);
      setMembersError('');
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setMembersLoading(true);

    fetchAnalyticsLogCounts({
      category: selected,
      // The product tier, flattened. Without this the backend would infer PRODUCT from
      // the lone category argument and hand back two product rows where the board
      // wants six services.
      level: 'microservice',
      window: timeWindow,
      signal: controller.signal,
    })
      .then((res) => {
        if (cancelled) return;
        setMembers(res);
        setMembersError('');
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setMembersError(err.message || 'Could not load this category.');
      })
      .finally(() => { if (!cancelled) setMembersLoading(false); });

    return () => { cancelled = true; controller.abort(); };
  }, [selected, timeWindow, tick, activeOrg]);

  // There is deliberately no third level. The rows ARE the microservices, so there is
  // nothing beneath them to expand, cache or invalidate — which is why this face needs
  // no per-row fetch state at all.

  // ── Auto-refresh, paused while the tab is hidden ─────────────────────────────
  // A background dashboard polling OpenObserve forever is pure cost.
  useEffect(() => {
    if (!refreshMs) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  // ── Derived ─────────────────────────────────────────────────────────────────

  const estateTotal = board?.totals?.total || 0;
  const selectedCard = useMemo(
    () => categories.find((c) => c.key === selected) || null,
    [categories, selected],
  );

  /**
   * The category's services, as one flat sorted list.
   *
   * <p>Sorted by Total descending by default, so the service producing the most logs is
   * the first row. That ranking is the reason to flatten: it puts the loudest service
   * in the category at the top regardless of which product it belongs to, which no
   * product-grouped view can do.</p>
   */
  const services = useMemo(() => {
    const items = [...(members?.items || [])];
    const dir = sort.dir === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      if (sort.key === 'label') return dir * String(a.label).localeCompare(String(b.label));
      return dir * ((a[sort.key] || 0) - (b[sort.key] || 0));
    });
    return items;
  }, [members, sort]);

  const toggleSort = (key) => setSort((s) => (
    s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));

  /**
   * Registered, enabled, and completely silent in this window.
   *
   * ─── Why this needs saying out loud ─────────────────────────────────────────
   *
   * A panel of nine services all reading zero is indistinguishable, on sight, from a
   * broken query or a filter that matched nothing — and "the dashboard is broken" is
   * the conclusion people reach, because it is the more common explanation. It is
   * also the wrong one often enough to matter: on this deployment every Applications
   * service stopped emitting within the same minute while Tools kept logging, which
   * is an ingest failure worth chasing and not a UI fault at all.
   *
   * So the zeros get a sentence stating that the rows ARE registered and the window
   * IS the reason, plus a one-click way to widen it — which is how somebody confirms
   * in two seconds that the services were alive earlier and have since gone quiet.
   */
  const allSilent = useMemo(
    () => services.length > 0 && services.every((r) => (Number(r.total) || 0) <= 0),
    [services],
  );

  const windowLabel = (WINDOWS.find((w) => w.value === timeWindow)?.label || timeWindow).toLowerCase();

  /** The next window up, for the "try a wider range" nudge. Null on the widest, so
   *  the offer disappears rather than becoming a button that changes nothing. */
  const widerWindow = useMemo(() => {
    const i = WINDOWS.findIndex((w) => w.value === timeWindow);
    return i >= 0 && i < WINDOWS.length - 1 ? WINDOWS[i + 1] : null;
  }, [timeWindow]);

  return (
    <div className="acb-view">
      <header className="acb-head">
        {/* No heading of its own: the deck's tab strip already names this face, and
            repeating it here would put two titles on one screen. What the left side
            carries instead is the one thing the strip cannot say — what to do next. */}
        <div className="acb-head-title">
          <p className="acb-subtitle">
            {selectedCard
              ? `Every microservice registered under ${selectedCard.label}.`
              : 'Pick a category to list every microservice inside it.'}
          </p>
        </div>

        <div className="acb-head-right">
          <select
            className="ae-select an-select"
            value={timeWindow}
            aria-label="Time range"
            onChange={(e) => setTimeWindow(e.target.value)}
          >
            {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>

          <label className="an-refresh">
            <span className="an-refresh-label">Auto</span>
            <select
              className="ae-select an-select an-select--narrow"
              value={refreshMs}
              aria-label="Auto-refresh interval"
              onChange={(e) => setRefreshMs(Number(e.target.value))}
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="results-bar-btn"
            onClick={reload}
            disabled={refreshing}
            title="Re-run the counts now"
            aria-label="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className={refreshing ? 'alerts-spin' : undefined}>
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
        </div>
      </header>

      {boardError && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">{boardError}</span>
          <button type="button" className="alerts-banner-x" onClick={reload} aria-label="Retry">↻</button>
        </div>
      )}

      {/* A partial answer is stated, not rounded into a confident number. Counts from
          a window OpenObserve could only partly scan are a floor, and a board that
          hides that is how somebody concludes a service went quiet. */}
      {board && !board.complete && (
        <output className="alerts-banner alerts-banner--warn native-el">
          <span className="alerts-banner-text">
            {board.message || 'OpenObserve served only part of this range — these counts are a '
              + 'floor, not a total.'}
          </span>
        </output>
      )}

      {board && !board.supported && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">{board.message}</span>
        </div>
      )}

      <div className="acb-scroll">
        {!boardLoading && board?.catalogEmpty && (
          <div className="iam-state">
            Nothing is registered in the Product Catalog yet, so there are no categories
            to show.
            {onNavigate && (
              <>
                {' '}
                <button type="button" className="pt-note-link" onClick={() => onNavigate('catalog')}>
                  Open Product Catalog
                </button>
                {' to register a microservice.'}
              </>
            )}
          </div>
        )}

        {/* ── The categories ──────────────────────────────────────────────────
            Every one on screen at once, with its share of the estate. This is the
            part that answers "where is the volume" before anything is clicked. */}
        <section className="acb-cards" aria-label="Categories">
          {boardLoading && !board && Array.from({ length: 4 }, (unused, i) => (
            <div className="acb-card acb-card--skeleton" key={`cs-${i}`} aria-hidden="true">
              <span className="alerts-skel" />
              <span className="alerts-skel" />
              <span className="alerts-skel" />
            </div>
          ))}

          {categories.map((row) => (
            <CategoryCard
              key={row.key}
              row={row}
              estateTotal={estateTotal}
              selected={row.key === selected}
              // Clicking the open card closes it. A board whose only way back to
              // "nothing selected" is a separate Clear button hides the way out.
              onSelect={() => setSelected((prev) => (prev === row.key ? null : row.key))}
            />
          ))}
        </section>

        {/* ── The selected category's microservices ──────────────────────────── */}
        {selected && (
          <section
            className="acb-panel"
            aria-label={`${selectedCard?.label || selected} microservices`}
          >
            <div className="acb-panel-head">
              <button
                type="button"
                className="acb-sort acb-panel-name"
                onClick={() => toggleSort('label')}
              >
                {levelNoun(members?.level)}
                <SortCaret active={sort.key === 'label'} dir={sort.dir} />
              </button>
              {PANEL_COLUMNS.map((col) => (
                <button
                  key={col.key}
                  type="button"
                  className="acb-sort acb-num"
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}
                  <SortCaret active={sort.key === col.key} dir={sort.dir} />
                </button>
              ))}
            </div>

            {membersError && (
              <div className="alerts-banner alerts-banner--error" role="alert">
                <span className="alerts-banner-text">{membersError}</span>
              </div>
            )}

            {membersLoading && services.length === 0
              && Array.from({ length: 5 }, (unused, i) => (
                <div className="acb-row acb-row--skeleton" key={`ms-${i}`} aria-hidden="true">
                  {Array.from({ length: 7 }, (u2, j) => (
                    <span key={j}><span className="alerts-skel" /></span>
                  ))}
                </div>
              ))}

            {/* Only once the request actually SUCCEEDED and returned nothing. Without
                the guard a failed fetch leaves "nothing registered" sitting under an
                error banner — two contradictory statements, and the reassuring one is
                the wrong one. */}
            {!membersLoading && members && services.length === 0 && (
              <div className="iam-state">
                {members.message || 'Nothing is registered under this category yet.'}
              </div>
            )}

            {/* Above the rows, not below: the explanation has to be where the doubt
                is, and the doubt starts at the first zero. */}
            {!membersLoading && allSilent && (
              <output className="acb-silent native-el">
                <span className="acb-silent-text">
                  {`All ${services.length} of these microservices are registered and enabled, `
                    + `and none produced a log line in the ${windowLabel}. `
                    + 'That is silence, not a filter — they may have stopped reporting.'}
                </span>
                {widerWindow && (
                  <button
                    type="button"
                    className="alerts-btn-ghost acb-silent-btn"
                    onClick={() => setTimeWindow(widerWindow.value)}
                  >{`Try ${widerWindow.label.toLowerCase()}`}</button>
                )}
              </output>
            )}

            {services.map((row) => (
              <ServiceRow
                key={row.key}
                row={row}
                window={timeWindow}
                onDrillToLogs={onDrillToLogs}
              />
            ))}
          </section>
        )}
      </div>

      <footer className="acb-foot">
        {board?.windowStart && (
          <span className="acb-foot-range" title={`${board.windowStart} → ${board.windowEnd}`}>
            {new Date(board.windowStart).toLocaleString()}
            {' → '}
            {new Date(board.windowEnd).toLocaleTimeString()}
          </span>
        )}
      </footer>
    </div>
  );
}

AnalyticsCategoryBoardView.propTypes = {
  /** Remounts on tenant change — the catalog, and therefore every card, is per-org. */
  activeOrg: PropTypes.string,
  /** (tab) — used for the "Open Product Catalog" jump from the empty state. */
  onNavigate: PropTypes.func,
  /** ({services, severity, range}) — opens Logs filtered to a clicked count. Absent,
   *  the counts render as plain text rather than as links that go nowhere. */
  onDrillToLogs: PropTypes.func,
};

/**
 * One category, as a clickable card.
 *
 * <p>A real button rather than a div with a click handler: this is the board's primary
 * control, and it has to be reachable and operable from the keyboard like any other.
 * `aria-pressed` carries the selection, which is what a toggle actually is.</p>
 */
function CategoryCard({ row, estateTotal, selected, onSelect }) {
  return (
    <button
      type="button"
      className={`acb-card ${selected ? 'is-selected' : ''} ${row.total > 0 ? '' : 'is-silent'}`}
      onClick={onSelect}
      aria-pressed={selected}
      title={identifierHint(row, 'category')}
    >
      <span className="acb-card-top">
        <span className="acb-card-name">{row.label}</span>
        {/* MICROSERVICES, not products — because that is what the click lists. Badging
            childCount here would put "2" on a card whose click produces six rows.
            Falls back to childCount for a backend that predates leafCount, which is
            wrong by the same amount as before rather than showing a zero. */}
        <span
          className="acb-card-children"
          title={`${serviceCount(row)} microservice(s) registered under this`}
        >
          {serviceCount(row)}
        </span>
      </span>

      <span className="acb-card-total">
        <span className="acb-card-total-value" title={exactCount(row.total)}>
          {formatCount(row.total)}
        </span>
        <span className="acb-card-share">{formatShare(row.total, estateTotal)} of estate</span>
      </span>

      <SeverityBar mix={severityMix(row)} />

      {/* Info, Warn, Error and Debug on the card itself. The severity split is the
          reason you are choosing between categories, so it cannot be one click away.

          The FIGURE carries the tone as well as the dot, and only when it is non-zero.
          The dot alone was enough while these chips were read as a legend, but they are
          not a legend — they are the counts, and the same counts are printed in tone
          colour in the panel this card opens. A card whose error chip is plain white
          next to a panel row whose error count is red is the same number rendered two
          ways, and the two faces sit side by side precisely so they can be trusted to agree.
          Zero stays neutral: a red 0 reads as a finding. */}
      <span className="acb-card-legend">
        {SEVERITY_BUCKETS.filter((b) => b.key !== 'other').map((bucket) => {
          const toneClass = row[bucket.key] > 0 ? `acb-chip-value--${bucket.tone}` : '';
          return (
            <span className="acb-chip" key={bucket.key}>
              <span className={`acb-dot acb-dot--${bucket.tone}`} aria-hidden="true" />
              <span className="acb-chip-label">{bucket.label}</span>
              <span
                className={`acb-chip-value ${toneClass}`}
                title={exactCount(row[bucket.key])}
              >
                {formatCount(row[bucket.key])}
              </span>
            </span>
          );
        })}
      </span>
    </button>
  );
}
CategoryCard.propTypes = {
  row: PropTypes.object.isRequired,
  estateTotal: PropTypes.number,
  selected: PropTypes.bool,
  onSelect: PropTypes.func.isRequired,
};

/**
 * One microservice in the selected category.
 *
 * <p>The service name and its six numbers, nothing else. No product cell, no severity
 * bar, no group heading, no indent — every row is the same kind of thing, which is what
 * makes the list scannable and sortable as one ranking. The proportions a bar would
 * have shown are readable straight off the columns beside it.</p>
 *
 * <p>Not expandable, and not a button: a microservice is the leaf of the catalog, so
 * there is nothing beneath it to open. A row that highlights on hover but does nothing
 * when clicked is worse than a plain one.</p>
 */
function ServiceRow({ row, window: window_, onDrillToLogs }) {
  /* Every count on the row is a link to the lines it counted — click 1,062 under Error
     and the Logs screen opens on exactly those 1,062, same service, same window. This
     is the face where that always works, because every row here is ONE service, which
     is the only scope the Logs screen can filter faithfully.

     Total is a link too: it means "all this service's logs", asked at least as often.
     `other` is not and cannot be — it is trace plus severity-unset, and the logs
     dialect has no OR to express a union. analyticsDrill decides all of it; this only
     renders what it returns. */
  const drillFor = (bucketKey) => (onDrillToLogs
    ? buildLogsDrill({ row, bucketKey, window: window_ })
    : null);

  return (
    <div className="acb-row" title={identifierHint(row, 'microservice')}>
      <span className="acb-name">
        <span className="acb-name-text">{row.label}</span>
      </span>

      <Num
        value={row.total}
        strong
        row={row}
        bucketKey="total"
        drill={drillFor('total')}
        onDrill={onDrillToLogs}
      />
      {SEVERITY_BUCKETS.map((bucket) => (
        <Num
          key={bucket.key}
          value={row[bucket.key]}
          tone={row[bucket.key] > 0 ? bucket.tone : undefined}
          dim={bucket.key === 'other'}
          row={row}
          bucketKey={bucket.key}
          drill={drillFor(bucket.key)}
          onDrill={onDrillToLogs}
        />
      ))}
    </div>
  );
}
ServiceRow.propTypes = {
  row: PropTypes.object.isRequired,
  /** The analytics window, carried into the drill so Logs opens on the same range. */
  window: PropTypes.string,
  onDrillToLogs: PropTypes.func,
};

/**
 * The stacked severity bar.
 *
 * <p>Proportions of Total, INCLUDING Other, so a row that is mostly unspecified looks
 * mostly unspecified. Renders a flat rail for a silent row rather than nothing at all:
 * an absent bar reads as a rendering failure, and "registered but produced no logs" is
 * a result worth showing.</p>
 */
function SeverityBar({ mix }) {
  if (!mix.length) {
    return <span className="acb-bar acb-bar--empty" title="No logs in this range" />;
  }
  // The segments are empty coloured spans, so the mix is spoken from the
  // visually-hidden label instead.
  return (
    <span className="acb-bar">
      <span className="sr-only">{mix.map((s) => `${s.label} ${Math.round(s.pct)}%`).join(', ')}</span>
      {mix.map((segment) => (
        <span
          key={segment.key}
          className={`acb-bar-seg acb-bar-seg--${segment.tone}`}
          style={{ width: `${segment.pct}%` }}
          title={`${segment.label}: ${exactCount(segment.count)} (${Math.round(segment.pct)}%)`}
        />
      ))}
    </span>
  );
}
SeverityBar.propTypes = { mix: PropTypes.array.isRequired };

/**
 * One numeric cell — a button when the count can be opened in Logs, plain text when
 * it cannot.
 *
 * <p>A real {@code <button>} rather than a span with a click handler, so the whole row
 * of counts is tabbable and Enter works without reimplementing it. It is styled to
 * look like the number it replaces until hovered or focused: a table where six cells
 * per row shout "link" is unreadable, and the underline on hover is enough to make
 * the affordance discoverable.</p>
 *
 * <p>Exact value in the title either way — a dashboard number gets pasted into
 * tickets, and "1.4M" is not a figure anybody can act on. When the cell is NOT a link
 * the title says why, because a number that is clickable on the row above and not on
 * this one needs to account for itself.</p>
 */
function Num({ value, strong, dim, tone, row, bucketKey, drill, onDrill }) {
  const n = value || 0;
  const toneClass = tone ? `acb-num--${tone}` : '';
  const className = `acb-num ${strong ? 'is-strong' : ''} ${dim ? 'is-dim' : ''} ${toneClass}`;
  const title = row && bucketKey
    ? drillHint({ row, bucketKey, drill, exact: exactCount(n) })
    : exactCount(n);

  if (!drill || !onDrill) {
    return <span className={className} title={title}>{formatCount(n)}</span>;
  }
  return (
    <button
      type="button"
      className={`${className} is-link`}
      title={title}
      onClick={() => onDrill(drill)}
    >{formatCount(n)}</button>
  );
}
Num.propTypes = {
  value: PropTypes.number,
  strong: PropTypes.bool,
  dim: PropTypes.bool,
  tone: PropTypes.string,
  /** The row this cell belongs to — only needed for the drill and its tooltip. */
  row: PropTypes.object,
  bucketKey: PropTypes.string,
  /** Prebuilt filter from buildLogsDrill, or null when this cell is not a link. */
  drill: PropTypes.object,
  onDrill: PropTypes.func,
};

function sortGlyph(active, dir) {
  if (!active) return '↕';
  return dir === 'asc' ? '↑' : '↓';
}

function SortCaret({ active, dir }) {
  return (
    <span className="acb-sort-caret" aria-hidden="true">
      {sortGlyph(active, dir)}
    </span>
  );
}
SortCaret.propTypes = { active: PropTypes.bool, dir: PropTypes.string };

/**
 * What a row was counted from, for its tooltip.
 *
 * <p>Without it a zero is unexplainable: an operator cannot tell "this is quiet" from
 * "the catalog has it registered under an identifier the logs never use". Truncated,
 * because a category can aggregate a hundred of them and a tooltip that fills the
 * screen is one nobody reads.</p>
 *
 * <p>The product is appended here and ONLY here. It is not what this list is organised
 * by — the rows are services, ranked by volume — but when two products ship a
 * similarly-named service it is the one thing that tells them apart, and a tooltip
 * costs the layout nothing.</p>
 */
function identifierHint(row, what) {
  const ids = row.matchedOn || [];
  const parent = row.parentLabel ? `In ${row.parentLabel}. ` : '';
  if (!ids.length) return `${parent}No telemetry identifier recorded for this ${what}`;
  const shown = ids.slice(0, 8).join(', ');
  return ids.length > 8
    ? `${parent}Counted from ${shown} and ${ids.length - 8} more`
    : `${parent}Counted from ${shown}`;
}

/**
 * How many microservices a category row aggregates.
 *
 * <p>`leafCount` is the microservices; `childCount` is whatever sits at the next drill
 * level, which for a category with a product tier is its PRODUCTS. This board lists
 * microservices, so it has to badge the former — otherwise the Applications card says
 * 2 and clicking it produces six rows.</p>
 *
 * <p>Falls back to `childCount` against a backend that predates `leafCount`, where it
 * is the same number for the four categories with no product tier and too low for the
 * other three. Wrong in the way it already was, rather than a confident zero.</p>
 */
function serviceCount(row) {
  return row.leafCount || row.childCount || 0;
}

/**
 * What the panel's rows are called.
 *
 * <p>Read from the level the BACKEND says it returned rather than assumed. This face
 * always asks for `microservice`, so it always reads "Microservice" — but if a backend
 * ever answers with a different grouping, the heading says what actually arrived
 * instead of mislabelling it.</p>
 */
function levelNoun(level) {
  if (level === 'MICROSERVICE') return 'Microservice';
  if (level === 'PRODUCT') return 'Application / product';
  if (level === 'CATEGORY') return 'Category';
  return 'Name';
}
