/**
 * AnalyticsShell — top-level wrapper for the Log Analytics section.
 *
 * Presents two sub-tabs, side by side, exactly the way AlertsShell presents
 * Rules / Alerts:
 *
 *   • "Category Table" → AnalyticsDashboardView     (cascading pickers and a
 *                                                    sortable table, drilling
 *                                                    Category → Product →
 *                                                    Microservice)
 *   • "Category Board" → AnalyticsCategoryBoardView (every category on screen at
 *                                                    once with its share of the
 *                                                    estate)
 *
 * Both read /api/analytics/log-counts and report the same numbers; they differ in
 * the question they are shaped for. Neither is a mode of the other.
 *
 * ── Chrome ────────────────────────────────────────────────────────────────
 *
 * Drawn to the Settings spec (see styles/analytics-settings.css): a screen title
 * bar, then a segmented tab strip, then one framed panel per tab — the same
 * three-part assembly AlertsShell builds out of `.alerts-topbar` /
 * `.alerts-shell-tabs` / `.alerts-shell-panel`, and IamView out of `.iam-topbar` /
 * `.iam-tabs` / `.iam-main`. All of that is CSS on the markup below; the only
 * things this component contributes are the title bar and the inset wrapper.
 *
 * ── Replaces the flip, not the faces ──────────────────────────────────────
 *
 * This shell took over from AnalyticsFlipDeck, which showed the same two faces
 * behind a rotating card. THE FACES ARE UNTOUCHED: both views keep their own
 * state, fetches, pickers, drill-through and time range, and this shell only wraps
 * them from the outside. AnalyticsFlipDeck itself is left in place, imports the
 * same two components and still works if it is ever mounted again.
 *
 * ── Only the visible tab is mounted ───────────────────────────────────────
 *
 * AlertsShell keeps its Rules panel mounted-but-hidden so its folder and filter
 * state survives a tab switch. That is deliberately NOT done here: each face polls
 * OpenObserve on an interval, so a permanently-mounted hidden face would double the
 * query load on the backing store to preserve state nobody is looking at.
 *
 * That is the same trade the flip deck made, and it is why the state which matters
 * across a switch — the time range, and the board's selected category — is
 * persisted to localStorage by the faces themselves rather than held up here.
 */

import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import AnalyticsDashboardView from './AnalyticsDashboardView';
import AnalyticsCategoryBoardView from './AnalyticsCategoryBoardView';

/** The tabs, in strip order. Adding a third needs an entry here and a panel below;
 *  the strip itself is rendered from this list. */
const TABS = [
  {
    key: 'table',
    label: 'Category Table',
    hint: 'Cascading pickers and a sortable table — for when you know what you are looking for',
  },
  {
    key: 'board',
    label: 'Category Board',
    hint: 'Every category at once with its share of the estate — for finding where the volume is',
  },
];

/**
 * Which tab was last open.
 *
 * <p>Deliberately the key AnalyticsFlipDeck used for the same preference, and the
 * values are the same two strings — so somebody who worked from the Category Board
 * before this shell landed is still on it after, rather than being reset by a
 * change to the chrome around their screen.</p>
 */
const LS_TAB = 'observability-ui:analytics:face:v1';

export default function AnalyticsShell({ activeOrg, onNavigate, onDrillToLogs }) {
  // 'table' | 'board'
  //
  // Defaults to the Category Table. It is the face that answers "show me this exact
  // thing", which is the question somebody usually arrives with, and it is the
  // screen that has always been here.
  const [tab, setTab] = useState(() => {
    try {
      const stored = localStorage.getItem(LS_TAB);
      return TABS.some((t) => t.key === stored) ? stored : TABS[0].key;
    } catch { return TABS[0].key; }
  });

  useEffect(() => {
    try { localStorage.setItem(LS_TAB, tab); } catch { /* not persisted */ }
  }, [tab]);

  return (
    <div className="analytics-shell">
      {/* Screen title bar, the twin of `.alerts-topbar` and Settings' `.iam-topbar`.
          Analytics, Alerts and Settings are the screens with no SectionNav column
          between the rail and the content, so they are the ones that name
          themselves. The strip below names the face, which is why neither panel
          repeats it as a card title. */}
      <header className="analytics-topbar">
        <h1 className="analytics-topbar-title">Log Analytics</h1>
      </header>

      {/* Wrapper carrying the 12px the strip and the panel are inset from the content
          area — the same job `.alerts-sh-shell` does on Alerts and `.iam-shell` on
          Settings. It draws nothing itself; the visible frame is the panel's own 11px
          border. */}
      <div className="analytics-sh-shell">
        {/* Sub-tab strip */}
        <div className="analytics-shell-tabs" role="tablist" aria-label="Log Analytics section">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              id={`analytics-tab-${entry.key}`}
              aria-selected={tab === entry.key}
              aria-controls={`analytics-panel-${entry.key}`}
              title={entry.hint}
              className={`analytics-shell-tab ${tab === entry.key ? 'analytics-shell-tab--active' : ''}`}
              onClick={() => setTab(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {/* Panels.

            Lazy-mounted rather than mounted-and-hidden (see the header comment), and
            keyed by org: every row on both faces is derived from the Product Catalog,
            which is a per-tenant registry, so a row left over from the previous
            tenant would be reporting another org's volume under this one's name.

            Both faces get the drill unchanged. A count means the same thing on either
            side, so it has to lead to the same place from either side. */}
        <div
          id="analytics-panel-table"
          role="tabpanel"
          aria-labelledby="analytics-tab-table"
          hidden={tab !== 'table'}
          className="analytics-shell-panel"
        >
          {tab === 'table' && (
            <AnalyticsDashboardView
              key={`table-${activeOrg || 'default'}`}
              activeOrg={activeOrg}
              onNavigate={onNavigate}
              onDrillToLogs={onDrillToLogs}
            />
          )}
        </div>

        <div
          id="analytics-panel-board"
          role="tabpanel"
          aria-labelledby="analytics-tab-board"
          hidden={tab !== 'board'}
          className="analytics-shell-panel"
        >
          {tab === 'board' && (
            <AnalyticsCategoryBoardView
              key={`board-${activeOrg || 'default'}`}
              activeOrg={activeOrg}
              onNavigate={onNavigate}
              onDrillToLogs={onDrillToLogs}
            />
          )}
        </div>
      </div>
    </div>
  );
}

AnalyticsShell.propTypes = {
  /** Passed through to both faces, which key off it — the Product Catalog behind
   *  every row is a per-tenant registry. */
  activeOrg: PropTypes.string,
  /** (tab) — used by both faces for the "Open Product Catalog" jump out of an empty
   *  state. */
  onNavigate: PropTypes.func,
  /** ({services, severity, range}) — opens Logs filtered to exactly what a clicked
   *  count counted. Routed straight through; the faces build the filter, the app
   *  shell navigates. */
  onDrillToLogs: PropTypes.func,
};
