import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import AnalyticsShell from './components/analytics/AnalyticsShell';
import LogsView from './components/LogsView';
import TraceDetail from './components/traces/TraceDetail';
import HomeView from './components/HomeView';
import MetricsView from './components/MetricsView';
import TracesView from './components/TracesView';
import SideNav from './components/common/SideNav';
import SectionNav from './components/common/SectionNav';
import RumView from './components/rum/RumView';
// Grafana dashboards. A plain import: this component itself only talks to
// /api/dashboards, and the heavy part — @grafana/scenes and @grafana/ui — sits
// behind a React.lazy inside it, so opening any other screen costs nothing.
import DashboardsView from './components/dashboards/DashboardsView';
import PlaceholderView from './components/common/PlaceholderView';
import UserMenu from './components/auth/UserMenu';
import IamView from './components/IamView';
import AlertsShell from './components/alerts/AlertsShell';
import OrgSwitcher from './components/common/OrgSwitcher';
import { fetchOrganizations, getOrg, setOrg as setApiOrg } from './services/api';
import { usePermissions } from './auth/usePermissions';
import { PERMISSIONS } from './auth/constants';
// The nav table and the three pure questions asked of it. Lives outside this
// file because entries can now hold sections, which turned "which entry is
// selected" from an equality check into a walk of the table — see navModel.js.
import {
  NAV_ITEMS, navItemForTab, groupForTab, resolveNavTarget,
} from './components/common/navModel';
// Which screen the URL names, and which URL names a screen. Pure string work,
// kept out of here for the same reason the nav table is — see tabRoute.js for
// why the fragment carries this, and why its query part is preserved rather
// than overwritten.
import {
  DEFAULT_TAB, hashForTab, tabFromHash, traceFromHash,
} from './components/common/tabRoute';

// The rail entries with nothing behind them yet. Each says what it will show
// and what has to exist first, so the gap is legible instead of looking like a
// broken screen. Keyed by nav key; the spread goes straight into
// PlaceholderView.
//
// Alerts used to be here. It is now a real screen backed by
// GET/POST/PUT/DELETE /api/alerts, which proxies OpenObserve's own alert store —
// so alerts are authored here and in OpenObserve interchangeably.
//
// RUM used to be here too, and is now backed by /api/rum, which aggregates the
// browser SDK's own RUM stream in OpenObserve. Its Source Maps tab is deliberately
// absent: symbolicating a minified stack needs each release's maps stored
// server-side, which is a build-pipeline concern rather than a read.
const PLACEHOLDERS = {
  aiops: {
    title: 'AIOps',
    icon: 'aiops',
    summary: 'Machine-side reading of the telemetry — anomalies, correlated '
      + 'incidents and root-cause candidates, surfaced without being queried.',
    willShow: [
      'Detected anomalies with the service, signal and window they were found in',
      'Related alerts and log spikes grouped into one incident rather than listed separately',
      'Ranked root-cause candidates, each linking to the logs or trace behind it',
    ],
    needs: [
      'A detection endpoint on the lib — the UI is not allowed to query OpenObserve directly',
      'A retained baseline per service, so "anomalous" means something other than "different from the last hour"',
    ],
  },
  reports: {
    title: 'Reports',
    icon: 'reports',
    summary: 'Scheduled reports — dashboard snapshots delivered on a cadence.',
    willShow: [
      'Report definitions with their schedule, dashboard and recipient list',
      'Delivery history, including failures and the reason',
    ],
    needs: [
      'A reports endpoint on the lib',
      'A delivery mechanism (SMTP or webhook) configured server-side',
    ],
  },
};

/** How often the organization list is re-checked while the tab is visible.
 *  Organizations change rarely, so this is deliberately slow — the
 *  visibility/focus refresh is what makes a just-created org appear at once. */
const ORG_POLL_MS = 60_000;

/** Rows-per-page choices on the Logs screen, and where the choice is kept.
 *  Shared with LogResultsBar so the list and the validation can't drift. */
const LOGS_PAGE_SIZES = new Set([50, 100, 250, 500]);
const LOGS_PAGE_SIZE_KEY = 'observability-ui:logs:page-size:v1';

/**
 * What the address bar says at boot: the screen, and the trace open on it.
 *
 * <p>Read ONCE, before any state exists, because the two answers have to agree.
 * `#/traces/trace/4bf92f…` means the Traces screen holds that trace and the Logs
 * screen holds none; reading the id without the screen it belongs to would open
 * it on both, and the second one would be showing a trace the user reached from
 * somewhere else entirely.</p>
 *
 * <p>Outside a browser (a server render, a test importing this module) there is
 * no address to read and the answer is the cold-start one.</p>
 */
const readBootRoute = () => {
  if (typeof window === 'undefined') return { tab: DEFAULT_TAB, trace: '' };
  const hash = window.location.hash;
  return { tab: tabFromHash(hash) || DEFAULT_TAB, trace: traceFromHash(hash) };
};

const App = () => {
  /** The URL as it was when this component first rendered. */
  const boot = useRef(null);
  if (boot.current === null) boot.current = readBootRoute();

  /**
   * Whether the next fragment write should REPLACE the current history entry
   * rather than push a new one.
   *
   * <p>Set by the permission guard's bounce to Home: that is a correction of
   * the entry the user is on, not a step they took. The first write (normalising
   * the boot URL) replaces too, tracked by {@link hashWritten}. Every other
   * screen change pushes, so the browser's Back and Forward buttons walk
   * between screens.</p>
   */
  const replaceNextHash = useRef(false);
  /** Whether the fragment writer has run once yet. */
  const hashWritten = useRef(false);

  /**
   * The current screen — read from the URL fragment on first render, so a
   * reload returns to the screen that was open rather than to Home.
   *
   * <p>Home stays the cold-start landing page: an empty or unrecognised
   * fragment falls back to it, which is every case that used to be the only
   * case. What changes is that a fragment naming a screen is now honoured, and
   * the effect below makes sure one is always there to be read.</p>
   */
  const [tab, setTab] = useState(() => boot.current.tab);

  /** Which IAM section to open, when something navigates into IAM. */
  const [iamSection, setIamSection] = useState(null);

  // ── Role gating ───────────────────────────────────────────────────────────
  // `can` resolves against PERMISSION_MATRIX, so nothing below compares a role
  // name. The administrator holds the wildcard and passes every check.
  const { can } = usePermissions();

  /** The rail, minus entries this user may not open. */
  const navItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.permission || can(item.permission)),
    [can],
  );

  /**
   * The group the current tab sits in, or undefined when the tab is a plain
   * top-level entry.
   *
   * <p>Two things read this. The rail highlights `activeGroup.key` rather than
   * `tab`, so opening Traces keeps the Logs entry lit instead of leaving the rail
   * with nothing selected; and the second column is rendered only when there is a
   * group to render, so every other screen keeps the full width it has now.</p>
   */
  const activeGroup = useMemo(() => groupForTab(tab), [tab]);

  /** The rail entry to mark active: the group when we are inside one. */
  const railActive = activeGroup ? activeGroup.key : tab;

  /**
   * The active group's sections, minus any this user may not open.
   *
   * <p>Nothing is filtered out today — none of the four carries a `permission`.
   * It is here so that gating one stays what gating a rail entry already is: a
   * property on one line of the nav table. SectionNav is handed a finished list
   * and, like SideNav, never learns that roles exist.</p>
   */
  const activeSections = useMemo(
    () => (activeGroup?.sections || []).filter(
      (sec) => !sec.permission || can(sec.permission),
    ),
    [activeGroup, can],
  );

  const canOpenIam = can(PERMISSIONS.VIEW_IAM);

  /**
   * Never leave the user parked on a tab they may not open.
   *
   * <p>Hiding a rail entry is not a guard on its own: `tab` is also set by
   * {@link navigate} from inside other screens, and a session whose role changes —
   * signing out of an admin account and back in as an operator, without a reload —
   * would otherwise keep rendering the screen the previous role reached. Falling
   * back to Home is the safe answer, and it is one line rather than a redirect
   * rule per screen.</p>
   */
  useEffect(() => {
    // Resolved through the group, so a permission on a group entry guards every
    // section inside it — a direct key match would miss a gated section entirely.
    const active = navItemForTab(tab);
    if (active?.permission && !can(active.permission)) {
      replaceNextHash.current = true;
      setTab('home');
    }
  }, [tab, can]);

  /**
   * A tab change requested by a child screen.
   *
   * 'catalog' is no longer a tab — it is a section inside IAM — so it is
   * TRANSLATED here rather than silently dropped. That is what keeps the Logs
   * sidebar's "open the Product Catalog" jump working without that button having
   * to know where the catalog moved to.
   *
   * The nonce makes the jump repeatable: without it, asking for the same section
   * twice would not change the prop, so a user who navigated away and pressed the
   * button again would stay put.
   */
  const navigate = useCallback((target) => {
    if (target === 'catalog') {
      // The catalog lives inside IAM, so reaching it needs the IAM grant. Refused
      // rather than partially honoured: sending someone to a tab that the guard
      // above immediately bounces to Home would flash a screen they cannot use.
      // Callers do not have to check first — the buttons that offer this jump are
      // already hidden by not passing them a navigate function (see below).
      if (!canOpenIam) return;
      setIamSection({ section: 'catalog', nonce: Date.now() });
      setTab('iam');
      return;
    }
    // Same group-aware resolution as the guard above, so navigate('traces')
    // is checked against whatever the Logs group requires rather than against
    // nothing. Section keys ARE valid targets — that is what keeps every
    // existing caller (the alert drawer, the analytics drill, the summary
    // cards, the Home tiles) working without knowing groups exist.
    const item = navItemForTab(target);
    if (item?.permission && !can(item.permission)) return;
    // Groups resolve to their first section — there is no screen behind a
    // heading. A plain tab key comes back unchanged.
    setTab(resolveNavTarget(target));
  }, [can, canOpenIam]);

  /**
   * The navigate function handed to screens whose only use for it is the "open the
   * Product Catalog" jump.
   *
   * <p>Undefined when the user cannot reach the catalog, because both consumers —
   * the Logs field sidebar's product tree and the Analytics empty states — already
   * render that button only when they are given a callback. Passing a function that
   * silently refuses would leave a control on screen that does nothing, which is
   * the one outcome worse than not offering it.</p>
   */
  const navigateToCatalog = canOpenIam ? navigate : undefined;

  // ── Active OpenObserve organization ─────────────────────────────────────
  // Held here because it scopes EVERY screen, not just IAM. api.js owns the
  // value that actually goes on the wire (it appends `org=` to every request);
  // this mirrors it so the header can render it and so a change can force the
  // content column to remount.
  const [org, setOrg] = useState(() => getOrg());
  const [organizations, setOrganizations] = useState([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  // Set when the org we were pointed at stops existing — see the note in
  // loadOrganizations about why this cannot be handled silently.
  const [orgGoneNotice, setOrgGoneNotice] = useState('');

  const orgRef = useRef(org);
  useEffect(() => { orgRef.current = org; }, [org]);

  /**
   * Refresh the organization list.
   *
   * Also reconciles the ACTIVE org against what came back, which is the part
   * that matters: organizations are created and deleted in OpenObserve, not
   * here, so the list this app holds is always a cache of someone else's
   * state.
   *
   *  - nothing selected yet → adopt the backend's default, so the header shows
   *    a real name on first load instead of a blank.
   *  - the selected org has disappeared → fall back to the default and SAY SO.
   *    Silently continuing would leave every request scoped to a dead org
   *    (errors everywhere, no explanation); silently switching would show one
   *    tenant's data under another tenant's name, which is worse.
   */
  const loadOrganizations = useCallback(async (signal) => {
    try {
      const res = await fetchOrganizations({ signal });
      const items = res?.items || [];
      setOrganizations(items);
      setOrgsLoading(false);

      if (!items.length) return;
      const fallback = items.find((o) => o.type === 'default') || items[0];
      const active = orgRef.current;

      if (!active) {
        setApiOrg(fallback.identifier);
        setOrg(fallback.identifier);
        return;
      }
      if (!items.some((o) => o.identifier === active)) {
        console.warn(`[App] Organization "${active}" no longer exists — `
          + `falling back to "${fallback.identifier}".`);
        setOrgGoneNotice(active);
        setApiOrg(fallback.identifier);
        setOrg(fallback.identifier);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      // A failed refresh keeps the list we already have rather than blanking
      // the switcher — a transient backend blip shouldn't look like "all your
      // organizations were deleted".
      console.error('Organization list unavailable:', err);
      setOrgsLoading(false);
    }
  }, []);

  // Keep the list live. Organizations change in OpenObserve, so this is a
  // cache that has to be re-checked; three triggers, cheapest first:
  //
  //   • on mount
  //   • when the tab becomes visible again — covers "I created it in the
  //     OpenObserve tab and came back", which is the common case and needs to
  //     feel instant
  //   • a slow background poll, so an unattended screen still converges
  //
  // The poll is paused while the tab is hidden: a background tab polling every
  // 60s forever is pure waste, and the visibility handler already refreshes the
  // moment it matters.
  useEffect(() => {
    const controller = new AbortController();
    loadOrganizations(controller.signal);

    let timer = null;
    const start = () => {
      if (timer == null) timer = setInterval(() => loadOrganizations(), ORG_POLL_MS);
    };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') { loadOrganizations(); start(); }
      else stop();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', loadOrganizations);

    return () => {
      controller.abort();
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', loadOrganizations);
    };
  }, [loadOrganizations]);

  /** Manual refresh for the switcher and the IAM Organizations tab. */
  const refreshOrganizations = useCallback(() => loadOrganizations(), [loadOrganizations]);

  const handleOrgChange = useCallback((identifier) => {
    if (!identifier || identifier === getOrg()) return;
    setOrgGoneNotice('');
    setApiOrg(identifier);
    setOrg(identifier);
  }, []);

  // Logs-tab-local state. `mode` is the inner Logs/Trace toggle; it stays
  // scoped here so that summary→logs round-trips don't lose the open trace.
  //
  // Both are seeded from the address bar when it opened on THIS screen, which is
  // what makes a reload inside a trace come back to that trace instead of to the
  // log table it was reached from. `mode` is derived rather than stored
  // separately in the URL: "a trace is named" and "the trace view is showing"
  // are the same fact, and a fragment that could say one without the other would
  // have a state the UI cannot render.
  const [selectedTraceId, setSelectedTraceId] = useState(
    () => (boot.current.tab === 'logs' ? boot.current.trace : '') || null,
  );
  const [mode, setMode] = useState(() => (selectedTraceId ? 'trace' : 'logs'));
  const [hoveredTraceId, setHoveredTraceId] = useState(null);
  const [logsPage, setLogsPage] = useState(0);
  // Default 50, and remembered. 10 was too small to be useful on a log
  // screen — you spend the session paging instead of reading.
  const [logsPageSize, setLogsPageSize] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(LOGS_PAGE_SIZE_KEY));
      return LOGS_PAGE_SIZES.has(stored) ? stored : 50;
    } catch { return 50; }
  });
  useEffect(() => {
    try { localStorage.setItem(LOGS_PAGE_SIZE_KEY, String(logsPageSize)); }
    catch { /* private mode — the choice just won't persist */ }
  }, [logsPageSize]);

  // Service drill-through from the Summary screen's Services Uptime card.
  // Lifted here so the prefill survives the tab switch.
  const [logsServicePrefill, setLogsServicePrefill] = useState(null);

  // Set by "View Logs" in the trace detail view: the Logs table reopens
  // scoped to that trace. Consumed once by LogsView, same as the service
  // prefill above.
  const [logsTracePrefill, setLogsTracePrefill] = useState(null);

  // Set by clicking a severity count on the Analytics Dashboard. Unlike the two
  // prefills above this carries a whole filter — services, severity AND the
  // analytics time range — because the count that was clicked was true only for
  // that combination, and landing on any other range would show a different
  // number than the one the operator followed.
  const [logsFilterPrefill, setLogsFilterPrefill] = useState(null);

  // The same drill-through, for the other two signals. Set by the alert details
  // panel's Telemetry buttons and consumed once by the target screen, exactly like
  // the three prefills above.
  //
  // They exist because those two screens previously received NOTHING: "View traces"
  // and "View metrics" switched tab and left the operator on whatever query and
  // range the screen last held, which is how a drill-through from a 04:10 firing
  // ended up showing the last fifteen minutes of every service. What each carries
  // is built in components/alerts/alertDrill.js — the scoping the alert can
  // actually justify, and nothing invented on top of it.
  const [tracesDrillPrefill, setTracesDrillPrefill] = useState(null);
  const [metricsDrillPrefill, setMetricsDrillPrefill] = useState(null);

  /**
   * The trace open on the TRACES screen, held here rather than inside it.
   *
   * <p>The Traces screen has its own trace drill-down — a span row opens the
   * same TraceDetail the Logs screen does — and it is a second thing a reload
   * used to lose. It is lifted for one reason: the URL has a single writer. Left
   * inside TracesView, either that component would write the address bar too (two
   * writers racing over one string, and the shell's own write would erase the
   * trace on every tab change), or the shell would be guessing at state it cannot
   * see.</p>
   *
   * <p>CLEARED when the screen is left, by the effect below. TracesView unmounts
   * on a tab change and has always come back on its list, so keeping the id would
   * be a behaviour change smuggled in with a bug fix — Logs is the tab that
   * deliberately remembers, and it still does.</p>
   */
  const [tracesTraceId, setTracesTraceId] = useState(
    () => (boot.current.tab === 'traces' ? boot.current.trace : '') || null,
  );
  useEffect(() => {
    if (tab !== 'traces') setTracesTraceId(null);
  }, [tab]);

  /**
   * The trace the CURRENT screen is showing, or '' — the one fact the URL needs
   * on top of the tab.
   *
   * <p>Asked of the screen that is actually open, which is why it is a
   * derivation and not a third piece of state. The Logs screen keeps its
   * drill-down while another screen is in front — that is what makes a trip to
   * Home and back return to the open trace — so "a trace is open" is only the
   * address bar's business for the tab being rendered. Writing the other one's
   * id would send a reload into a trace the user is not looking at.</p>
   */
  let openTraceId = '';
  if (tab === 'logs' && mode === 'trace') openTraceId = selectedTraceId || '';
  else if (tab === 'traces') openTraceId = tracesTraceId || '';

  /**
   * Keep the URL fragment naming the current screen, so a reload can find it.
   *
   * <p>Runs on EVERY tab change rather than only on the ones the rail makes,
   * because `tab` is also set from inside screens — the alert drawer's
   * telemetry drill, the Analytics count drill-through, the Home tiles, the
   * brand-mark's jump to Home — and a reload after one of those has to land on
   * the same screen as a reload after a rail click. One effect on the state
   * itself is what makes that true without every caller remembering. The open
   * trace rides along for the same reason: opening one is a navigation,
   * whichever of the four routes into it the user took.</p>
   *
   * <p>`pushState` for a screen change, so the browser's Back and Forward
   * buttons step between screens (and in and out of an open trace) the way
   * they do on any other site. `replaceState` for the first write and for the
   * permission guard's correction — see {@link replaceNextHash} — because
   * neither is a step the user took. Neither call fires `hashchange` or
   * `popstate`, so the listener below cannot loop back into this effect; and
   * when the listener applies a Back/Forward, the state it sets already
   * matches the URL, so this returns early without writing.</p>
   *
   * <p>The permission guard above can correct `tab` one render later (an
   * unauthorised fragment bounces to Home); this then runs again and rewrites
   * the fragment, so the URL never names a screen the user cannot open.</p>
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const { history, location } = window;
    const next = hashForTab(tab, location.hash, openTraceId);
    const firstWrite = !hashWritten.current;
    hashWritten.current = true;
    // A URL that already matches needs no write. The guard's flag is left
    // alone here: its correction lands one render later, in the next run.
    if (location.hash === next) return;
    const replace = firstWrite || replaceNextHash.current;
    replaceNextHash.current = false;
    try {
      // Path and query rebuilt verbatim — the SSO hand-off and the Logs share
      // link both live in the query string, and this must not be the thing that
      // edits them.
      const url = `${location.pathname}${location.search}${next}`;
      if (replace) history.replaceState(history.state, '', url);
      else history.pushState(history.state, '', url);
    } catch {
      // Sandboxed frame, or a URL the History API refuses. The fragment is a
      // convenience; failing to write it must not break navigation itself.
    }
  }, [tab, openTraceId]);

  /**
   * Follow the fragment when something outside this component changes it.
   *
   * <p>Which is the Back and Forward buttons, and a hand-edited or pasted
   * address. Without this the URL and the screen would
   * disagree until the next reload — the address bar saying Traces while Home
   * is on screen — and the next reload would then honour the stale fragment.</p>
   *
   * <p>A fragment naming nothing routable is ignored rather than treated as
   * Home: the host page may use the fragment for its own purposes, and
   * yanking the user to Home because someone else wrote there would be worse
   * than the drift.</p>
   *
   * <p>The drill-down is applied to the NAMED screen only. A fragment says which
   * screen it is talking about, so `#/traces/trace/…` must not also open that
   * trace on Logs — and clearing it on the named screen is what closes the detail
   * view when someone edits the id back out of the address.</p>
   */
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onHashChange = () => {
      const nextTab = tabFromHash(window.location.hash);
      if (!nextTab) return;
      const nextTrace = traceFromHash(window.location.hash);
      // Rewrite a hand-typed spelling (`#traces`, `#/TRACES/`) to the canonical
      // one IN PLACE, so the writer above sees a match and does not push a
      // second entry for what the user experiences as one step.
      const canonical = hashForTab(nextTab, window.location.hash, nextTrace);
      if (window.location.hash !== canonical) {
        try {
          const { history, location } = window;
          history.replaceState(history.state, '', `${location.pathname}${location.search}${canonical}`);
        } catch { /* the writer will reconcile on the next change */ }
      }
      setTab((current) => (current === nextTab ? current : nextTab));
      if (nextTab === 'logs') {
        setSelectedTraceId(nextTrace || null);
        setMode(nextTrace ? 'trace' : 'logs');
      } else if (nextTab === 'traces') {
        setTracesTraceId(nextTrace || null);
      }
    };
    // Both events, because browsers differ on which a fragment-only Back fires;
    // applying the same fragment twice is a no-op.
    window.addEventListener('popstate', onHashChange);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('popstate', onHashChange);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const handleTraceClick = (traceId) => {
    setSelectedTraceId(traceId);
    setMode('trace');
  };

  const handleBackToLogs = () => {
    setMode('logs');
    setSelectedTraceId(null);
  };

  // Called from SummaryView when a service row is clicked. Switch to the
  // Logs tab with the chosen service set as the active filter. The prefill
  // is consumed (and cleared) by LogsView on mount.
  const handleDrillToService = (serviceName) => {
    setLogsServicePrefill(serviceName);
    setTab('logs');
    setMode('logs');
  };

  /**
   * Called from the Analytics Dashboard when a severity count is clicked.
   *
   * `filter` is `{ services, severity, range }`, already built by
   * analyticsDrill.buildLogsDrill — the shell only routes it. `setMode('logs')` is
   * needed as well as `setTab`: the Logs tab remembers whether it was last showing
   * the table or a trace drill-down, and arriving into the trace view would hide
   * the very rows the click asked for.
   */
  const handleDrillToLogs = useCallback((filter) => {
    if (!filter) return;
    setLogsFilterPrefill(filter);
    setTab('logs');
    setMode('logs');
  }, []);

  /**
   * Route an alert's Telemetry drill-through to the screen that can answer it.
   *
   * The Logs case reuses `logsFilterPrefill` rather than adding a fourth prefill:
   * the analytics drill already means "open Logs on exactly this question,
   * replacing what was there", which is the same contract — it simply gains an
   * optional trace id. Sharing the path is what keeps the two from drifting into
   * two different ideas of what a drill-through does.
   */
  const handleAlertDrill = useCallback((target, alert, drill) => {
    if (!drill) { navigate(target); return; }
    if (target === 'logs') {
      setLogsFilterPrefill(drill);
      setMode('logs');
    } else if (target === 'traces') {
      setTracesDrillPrefill(drill);
    } else if (target === 'metrics') {
      setMetricsDrillPrefill(drill);
    }
    navigate(target);
  }, [navigate]);

  const placeholder = PLACEHOLDERS[tab];

  return (
    <div className="app-shell">
      {/* UserMenu owns the whole top bar (brand on the left, identity on the
          right); the org controls go into its actions slot rather than into a
          wrapper around it. Wrapping it moved the logo — .app-shell >
          .app-topbar is a direct-child rule that stops matching. */}
      <UserMenu
        // Same target as the rail's Home entry. Deliberately does NOT reset the
        // Logs tab's inner trace drill-down: the rail behaves that way too, so
        // Home-and-back returns you where you were.
        onHome={() => setTab('home')}
        actions={(
          <>
            {/* Only shown when the org we were pointed at was deleted
                elsewhere. Dismissible rather than auto-hiding: the screen's
                entire contents just changed tenant, which the user should
                acknowledge, not possibly miss. */}
            {orgGoneNotice && (
              <output className="org-gone native-el native-inline">
                Organization “{orgGoneNotice}” no longer exists — switched to {org}.
                <button
                  type="button"
                  className="org-gone-x"
                  onClick={() => setOrgGoneNotice('')}
                  aria-label="Dismiss"
                >×</button>
              </output>
            )}
            <OrgSwitcher
              organizations={organizations}
              value={org}
              onChange={handleOrgChange}
              onOpen={refreshOrganizations}
              loading={orgsLoading}
            />
          </>
        )}
      />

      <div className="app-shell-body">
        {/* The FILTERED list. SideNav renders what it is given and knows nothing
            about roles, so an entry the user may not open never reaches it.

            `railActive`, not `tab`: inside a group the rail marks the GROUP. With
            `tab` here, opening Traces or Metrics would leave the rail with no
            selection at all, because neither is a rail entry any more. */}
        <SideNav items={navItems} activeItem={railActive} onItemChange={navigate} />

        {/* Second column, only when the current screen is inside a group. Sits
            between the rail and the content so depth reads left-to-right, and is
            absent everywhere else — Alerts and Settings keep exactly the width
            they have now.

            The section keys ARE tab keys, so `navigate` is the same function the
            rail uses and the same one every other screen already calls. This
            column adds a way to reach those four screens; it does not add a
            second way to route to them.

            `> 1` because a navigation column offering one destination is not
            navigation — it is a label taking 172px away from the screen. Cannot
            happen today (nothing filters the four), but a future permission on
            three of them should hand the survivor the full width. */}
        {activeGroup && activeSections.length > 1 && (
          <SectionNav
            items={activeSections}
            activeItem={tab}
            label={`${activeGroup.label} sections`}
            onSelect={navigate}
          />
        )}

        <main key={org || 'default'} className="app-shell-content">
          {tab === 'traces' && (
            <TracesView
              drillPrefill={tracesDrillPrefill}
              onDrillPrefillConsumed={() => setTracesDrillPrefill(null)}
              // The open trace lives up here so that the address bar has one
              // writer — see the note on `tracesTraceId`. TracesView decides WHEN
              // a trace opens, exactly as before; it just no longer owns the fact.
              traceId={tracesTraceId}
              onTraceIdChange={setTracesTraceId}
            />
          )}

          {tab === 'logs' && (
            mode === 'logs' ? (
              <LogsView
                onTraceClick={handleTraceClick}
                hoveredTraceId={hoveredTraceId}
                setHoveredTraceId={setHoveredTraceId}
                page={logsPage}
                setPage={setLogsPage}
                pageSize={logsPageSize}
                setPageSize={setLogsPageSize}
                servicePrefill={logsServicePrefill}
                onServicePrefillConsumed={() => setLogsServicePrefill(null)}
                tracePrefill={logsTracePrefill}
                onTracePrefillConsumed={() => setLogsTracePrefill(null)}
                // The Analytics Dashboard's count drill-through.
                filterPrefill={logsFilterPrefill}
                onFilterPrefillConsumed={() => setLogsFilterPrefill(null)}
                // Lets the sidebar's catalog tree offer a jump to Product
                // Catalog when a category has nothing registered in it. Undefined
                // for a user who cannot open IAM, which is what removes the button
                // rather than leaving it to refuse the click.
                onNavigate={navigateToCatalog}
              />
            ) : (
              <TraceDetail
                traceId={selectedTraceId}
                onBack={handleBackToLogs}
                // "View Logs" returns to the Logs table scoped to this trace.
                // api.js promotes a bare 32-hex term to the exact traceId
                // parameter, so the trace id alone is a precise filter.
                onViewLogs={(tid) => { setLogsTracePrefill(tid); handleBackToLogs(); }}
              />
            )
          )}

          {tab === 'home' && (
            <HomeView onNavigate={navigate} />
          )}

          {/* Counts only, full screen. Two faces side by side behind one tab strip,
              the way Alerts presents Rules and Alerts: the Category Table that has
              always been here, and a Category Board that puts every category on
              screen at once. AnalyticsShell owns the strip and mounts exactly one
              face at a time, so the hidden one is not polling OpenObserve behind the
              visible one.

              Keyed by org because every row is derived from the Product Catalog,
              which is a per-tenant registry — a stale row from the previous tenant
              would be reporting another org's volume. */}
          {tab === 'analytics' && (
            <AnalyticsShell
              key={org || 'default'}
              activeOrg={org}
              // Only the "Open Product Catalog" jump from the empty states, so it
              // follows the same rule as the Logs sidebar above.
              onNavigate={navigateToCatalog}
              // Clicking a severity count opens Logs filtered to exactly what that
              // number counted — same services, same severity, same window.
              onDrillToLogs={handleDrillToLogs}
            />
          )}

          {/* MetricsView owns two sub-tabs: the new PromQL Explorer and the
              SummaryView that used to render here directly. Same component,
              same props — moved behind a tab rather than replaced, so nothing
              that worked before is gone. */}
          {/* Real User Monitoring — Core Web Vitals, sessions and frontend errors,
              read live from the RUM stream the browser SDK writes. Keyed by org: the
              RUM streams are per-tenant, so a stale panel would be reporting another
              organization's sessions under this one's name. */}
          {tab === 'rum' && (
            <RumView key={org || 'default'} activeOrg={org} />
          )}

          {/* Grafana dashboards, rendered natively — folder tiles, then a
              folder's dashboards, then one dashboard. Every tile comes from the
              registry an administrator curates in Settings → Dashboard Catalog.

              Keyed by org so that under grafana.registry.scope=ORG switching
              tenant rebuilds the screen rather than leaving another
              organization's tiles (and a folder drill-down into them) in place.
              Under the default GLOBAL scope the list is shared, and the remount
              is a harmless refetch. */}
          {tab === 'dashboards' && (
            <DashboardsView key={org || 'default'} activeOrg={org} />
          )}

          {tab === 'metrics' && (
            <MetricsView
              onDrillToService={handleDrillToService}
              onNavigate={navigate}
              drillPrefill={metricsDrillPrefill}
              onDrillPrefillConsumed={() => setMetricsDrillPrefill(null)}
            />
          )}

          {/* Alerts read and WRITE OpenObserve's alert store through the lib.
              Keyed by org so switching tenant rebuilds the screen rather than
              leaving another org's folder selection in place — a folder id is
              org-scoped, and a stale one would list nothing with no explanation. */}
          {tab === 'alerts' && (
            <AlertsShell
              key={org || 'default'}
              activeOrg={org}
              // Telemetry drill-through from an alert's details panel.
              //
              // `drill` is built by the panel (components/alerts/alertDrill.js) and
              // holds everything the alert can justify filtering on for THAT signal
              // — the service, the trace id, the metric it named, and the window
              // around the firing. This shell only routes it to the right prefill.
              //
              // `navigate`, not `setTab`: it is the permission- and group-aware
              // router every other screen already goes through, so a target the
              // user cannot open is refused here instead of mounting for a frame.
              // `setMode('logs')` alongside it because the Logs tab remembers
              // whether it was last on the table or inside a trace, and landing in
              // the trace view would hide the very rows the click asked for.
              onNavigate={handleAlertDrill}
            />
          )}

          {/* Two independent conditions, deliberately. The effect above bounces an
              unauthorised tab to Home, but it runs AFTER a render — without this
              check the IAM screen would mount for one frame and fire its user and
              organization fetches before being unmounted. Guarding the render as
              well means those requests are never issued. */}
          {tab === 'iam' && canOpenIam && (
            <IamView
              activeOrg={org}
              onOrgChange={handleOrgChange}
              organizations={organizations}
              organizationsLoading={orgsLoading}
              onRefreshOrganizations={refreshOrganizations}
              requestedSection={iamSection}
            />
          )}

          {placeholder && <PlaceholderView {...placeholder} />}
        </main>
      </div>
    </div>
  );
};

export default App;
