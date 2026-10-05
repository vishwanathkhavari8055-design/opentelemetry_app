/**
 * AlertsShell — top-level wrapper for the Alerts section.
 *
 * Presents two sub-tabs:
 *   • "Rules"  → the existing AlertsView (define / edit alert rules)
 *   • "Alerts" → FiredAlertsPage (monitor / ack / resolve). The tab is LABELLED
 *                "Alerts"; its key and ids are still `fired`.
 *
 * The fired-alerts badge on the "Alerts" tab shows the live firing count
 * from /notifications/summary so it is always fresh without re-fetching
 * the whole list.
 *
 * ── Chrome ────────────────────────────────────────────────────────────────
 *
 * Drawn to the Settings spec (see styles/alerts-settings.css): a screen title
 * bar, then a segmented tab strip, then one framed panel per tab — the same
 * three-part assembly IamView builds out of `.iam-topbar` / `.iam-tabs` /
 * `.iam-main`. All of that is CSS on the markup below; the only thing this
 * component gained for it is the title bar and the inset wrapper.
 *
 * AlertsView and FiredAlertsPage keep their own state, fetches and behaviour —
 * this shell still wraps them from the outside.
 */

import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import AlertsView from './AlertsView';
import FiredAlertsPage from './fired/FiredAlertsPage';
import { fetchAlertNotificationsSummary } from '../../services/api';
import { usePermissions } from '../../auth/usePermissions';
import { PERMISSIONS } from '../../auth/constants';

const POLL_MS = 15_000;

/** Which sub-tab was open. The shell restores WHICH screen a reload lands on;
 *  this restores which face of this one, the same way AlertsView below already
 *  remembers its own folder tab. Without it, reloading while reading the rules
 *  list bounced back to Fired. */
const LS_TAB = 'observability-ui:alerts:shell-tab:v1';

/** The only two values worth restoring — anything else is a stale or hand-edited
 *  key, and 'fired' is the right answer for those. */
const SHELL_TABS = new Set(['fired', 'rules']);

export default function AlertsShell({ activeOrg, onNavigate }) {
  // 'rules' | 'fired'
  //
  // Defaults to 'fired'. Clicking Alerts should answer "what is wrong right now"
  // without a second click — the rules list is the configuration behind that
  // answer, which is the less urgent question and the one you go looking for.
  //
  // A REMEMBERED choice outranks that default, and only that: a user who was
  // last on Rules was reading configuration and a reload should not drop them
  // into the firing list. The default still applies to everyone who has not
  // chosen, which is every first visit.
  const [tab, setTab] = useState(() => {
    try {
      const stored = localStorage.getItem(LS_TAB);
      return SHELL_TABS.has(stored) ? stored : 'fired';
    } catch { return 'fired'; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_TAB, tab); } catch { /* not persisted */ }
  }, [tab]);

  const { can } = usePermissions();
  const canViewRules = can(PERMISSIONS.VIEW_ALERT_RULES);

  /**
   * The tab actually shown.
   *
   * <p>DERIVED rather than corrected by an effect. Only Rules is permission gated;
   * Fired remains available to operators.</p>
   */
  const activeTab = !canViewRules && tab === 'rules' ? 'fired' : tab;

  // Live badge count for the "Fired" tab
  const [firingCount, setFiringCount] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const fetchBadge = () => {
      fetchAlertNotificationsSummary()
        .then((s) => {
          if (!cancelled) {
            // needsAttention = firing + acknowledged — what the operator has to deal with.
            setFiringCount(s.needsAttention ?? s.firing ?? 0);
          }
        })
        .catch(() => { /* badge is best-effort */ });
    };

    fetchBadge();
    timer = setInterval(fetchBadge, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeOrg]);

  return (
    <div className="alerts-shell">
      {/* Screen title bar, the twin of Settings' `.iam-topbar`. Alerts and
          Settings are the two screens with no SectionNav column between the rail
          and the content, so they are the two that name themselves. The card
          titles below ("Alert Rules", "Fired Alerts") are section titles under
          it, exactly as the Settings tabs' titles are. */}
      <header className="alerts-topbar">
        <h1 className="alerts-topbar-title">Alerts</h1>
      </header>

      {/* Wrapper carrying the 12px the strip and the panel are inset from the
          content area — the same job `.iam-shell` does on Settings. It draws
          nothing itself; the visible frame is the panel's own 11px border. */}
      <div className="alerts-sh-shell">
        {/* Sub-tab strip */}
        <div className="alerts-shell-tabs" role="tablist" aria-label="Alerts section">
          {/* Absent, not disabled, for a user without the rules grant. A greyed tab
              advertises a screen they cannot reach and invites them to ask why. */}
          {canViewRules && (
            <button
              type="button"
              role="tab"
              id="alerts-tab-rules"
              aria-selected={activeTab === 'rules'}
              aria-controls="alerts-panel-rules"
              className={`alerts-shell-tab ${activeTab === 'rules' ? 'alerts-shell-tab--active' : ''}`}
              onClick={() => setTab('rules')}
            >
              Rules
            </button>
          )}
          <button
            type="button"
            role="tab"
            id="alerts-tab-fired"
            aria-selected={activeTab === 'fired'}
            aria-controls="alerts-panel-fired"
            className={`alerts-shell-tab ${activeTab === 'fired' ? 'alerts-shell-tab--active' : ''}`}
            onClick={() => setTab('fired')}
          >
            {/* Labelled "Alerts"; the tab key, element ids and the component behind it
                stay `fired`. Renaming those too would churn the aria wiring and the
                page's own module path for a word on a button. */}
            Alerts
            {firingCount != null && firingCount > 0 && (
              <span className="alerts-shell-badge" aria-label={`${firingCount} firing`}>
                {firingCount > 99 ? '99+' : firingCount}
              </span>
            )}
          </button>
        </div>

        {/* Panels */}
        {/* The whole panel is omitted without the grant, not just hidden. This one is
            mounted-but-hidden so AlertsView keeps its folder and filter state across a
            tab switch — which also means merely rendering it runs its fetches, so
            `hidden` alone would have queried the rule store for a user who may not
            read it. */}
        {canViewRules && (
          <div
            id="alerts-panel-rules"
            role="tabpanel"
            aria-labelledby="alerts-tab-rules"
            hidden={activeTab !== 'rules'}
            className="alerts-shell-panel"
          >
            {/* Always rendered so AlertsView keeps its folder/tab state on switch */}
            <AlertsView activeOrg={activeOrg} />
          </div>
        )}

        <div
          id="alerts-panel-fired"
          role="tabpanel"
          aria-labelledby="alerts-tab-fired"
          hidden={activeTab !== 'fired'}
          className="alerts-shell-panel"
        >
          {/* Lazy-mount: only create when first visited to avoid polluting initial load */}
          {activeTab === 'fired' && (
            <FiredAlertsPage activeOrg={activeOrg} onNavigate={onNavigate} />
          )}
        </div>
      </div>
    </div>
  );
}

AlertsShell.propTypes = {
  activeOrg: PropTypes.string,
  /** (tab, alert, drill) — telemetry drill-through from an alert's details panel.
   *  `drill` carries the scoping for that signal; see components/alerts/alertDrill.js. */
  onNavigate: PropTypes.func,
};
