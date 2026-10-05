import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';

import {
  fetchDashboardFolderTiles,
  fetchDashboardHealth,
  fetchDashboardRegistrations,
  fetchGrafanaFolders,
} from '../../services/dashboardsApi';
// Zero imports of its own — importing it here does NOT pull @grafana/* onto this
// screen's critical path. Keep it that way; see the lazy import below.
import { onDashboardNavigation } from '../../grafana/dashboardNavigation';
import NavIcon from '../common/NavIcons';
import Toast from '../common/Toast';
import FolderTileBrowser from './FolderTileBrowser';
import {
  buildFolderTree, collapseSingleChild, pathToUid, resolvePath,
} from './folderTree';

/**
 * The scene renderer, and everything @grafana/* it drags in, behind React.lazy.
 *
 * @grafana/ui is a large dependency. Loading it eagerly would put it on the
 * critical path of every screen in this application, including the ones that have
 * nothing to do with Grafana. Splitting it here means the cost is paid by the
 * click that opens a dashboard, and only then — the folder tiles and the registry
 * table below need none of it.
 */
const DashboardSceneViewer = lazy(() => import('./DashboardSceneViewer'));

/**
 * Dashboards — Grafana's folder tree, walked one level at a time, then one
 * dashboard.
 *
 * ─── Nothing on this screen is named in this file ───────────────────────────
 *
 * Not a folder, not a dashboard, not a UID, and not the depth of the nesting.
 * The levels are whatever Grafana's own folder tree says they are, and the
 * dashboards inside them are whatever the registry says: register a UID under a
 * folder in Settings -> Dashboard Catalog and it appears in that folder here;
 * unregister the last one and the folder's tile disappears again. Which is the
 * whole contract — "if I register it, and only then, I get the dashboard".
 *
 * The screen therefore reads as `OpenObserver -> DLHLnM Org. -> DLH Services ->
 * a dashboard` for this deployment WITHOUT any of those names existing in the
 * code: they come out of Grafana, and moving a folder there moves it here.
 *
 * ─── Why the navigation is local state, not a route ─────────────────────────
 *
 * This application's shell routes by `tab` and has no URL router. The folder path
 * is depth inside one tab, exactly like the Logs screen's trace drill-down
 * (`mode` in App.jsx), so it is held here for the same reason: leaving for Alerts
 * and coming back returns you where you were, rather than to the top of a folder
 * tree you have already navigated past.
 */
export default function DashboardsView({ activeOrg }) {
  /** Folder uids from the display root down. Empty = the top level. */
  const [path, setPath] = useState([]);
  const [openUid, setOpenUid] = useState(null);
  /** Time window a drill-down arrived with, or null to use the dashboard's own. */
  const [openRange, setOpenRange] = useState(null);
  /** Why a drill-down did not open. */
  const [navNotice, setNavNotice] = useState('');

  const [tiles, setTiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [registrations, setRegistrations] = useState([]);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');

    Promise.all([
      fetchDashboardFolderTiles({ signal: controller.signal }),
      // enabledOnly: this is the VIEWER's list. A disabled registration is an
      // administrator's decision to hide it, so it must not appear as a tile that
      // refuses the click — Settings is where disabled rows are managed.
      fetchDashboardRegistrations({ enabledOnly: true, signal: controller.signal }),
      // The nesting. Never fatal: with no folders every registration falls back to
      // a root-level tile of its own, which is the flat grid this screen had
      // before there was a tree — degraded, but not broken.
      fetchGrafanaFolders({ signal: controller.signal }).catch(() => null),
      // Read alongside the lists rather than only on failure: an empty catalog and
      // an unconfigured Grafana look identical, and the empty state has to be able
      // to tell the user which one this is.
      fetchDashboardHealth({ signal: controller.signal }).catch(() => null),
    ])
      .then(([tileList, registrationList, folderList, healthResult]) => {
        if (cancelled) return;
        setTiles(tileList?.items || []);
        setRegistrations(registrationList?.items || []);
        setFolders(folderList?.items || []);
        setHealth(healthResult);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Could not load the dashboard list.');
        setLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
    // `activeOrg` is not READ in this effect, and is a dependency anyway: under
    // grafana.registry.scope=ORG it changes what the backend returns, so dropping
    // it would leave another organization's tiles on screen after a switch.
  }, [activeOrg, reloadTick]);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  // Pruned: a branch with no enabled dashboard anywhere under it is not offered,
  // because this instance has 39 root folders and a viewer clicking through empty
  // ones would never reach anything.
  const tree = useMemo(
    () => buildFolderTree(folders, registrations, { summary: tiles }),
    [folders, registrations, tiles],
  );

  const { trail, roots } = useMemo(() => collapseSingleChild(tree.roots), [tree.roots]);

  const resolved = useMemo(() => resolvePath(roots, path), [roots, path]);
  // The path no longer resolves — a refresh removed the last dashboard from the
  // folder we were standing in. Fall back to the top rather than a dead level.
  const nodes = path.length && !resolved.length ? [] : resolved;
  const here = nodes.length ? nodes.at(-1) : null;

  const level = here ? here.children : roots;
  const dashboards = here ? here.dashboards : [];

  const openRegistration = useMemo(
    () => registrations.find((row) => row.uid === openUid),
    [registrations, openUid],
  );

  // ── Drill-down ──────────────────────────────────────────────────────────
  //
  // A panel on the dashboard currently open asked for another dashboard: a
  // clicked topology node, a data link, a table row. This screen owns `openUid`,
  // so this is where such a request can actually be answered — see
  // grafana/dashboardNavigation.js for how it gets here from inside a scene (or
  // from inside a panel's sandboxed iframe).
  //
  // ─── Answered against the CATALOG, not against Grafana ──────────────────
  //
  // The link says only `/d/<uid>`, and its author was writing for Grafana, where
  // every dashboard on the instance is reachable. Here a dashboard is reachable
  // only if it has been registered — the backend refuses the definition
  // otherwise, by design. So an unregistered uid is turned away HERE, with the
  // one sentence that says what to do about it, rather than opening a viewer
  // that fetches, fails, and reports a 404 the user cannot interpret.
  useEffect(() => onDashboardNavigation((target) => {
    const row = registrations.find((candidate) => candidate.uid === target.uid);
    if (!row) {
      setNavNotice(
        `This panel links to the Grafana dashboard "${target.uid}", which is not `
        + 'registered in this application yet. Register that UID in Settings → '
        + 'Dashboard Catalog and the link will work.',
      );
      return;
    }
    setNavNotice('');
    // Put the breadcrumb where the dashboard actually lives, so leaving it goes
    // back to its own folder rather than to whichever folder the user happened
    // to walk in through.
    setPath(pathToUid(roots, row.folderUid));
    setOpenRange(target.range || null);
    setOpenUid(target.uid);
  }), [registrations, roots]);

  // ── One dashboard ───────────────────────────────────────────────────────
  if (openUid) {
    return (
      <div className="gd-view gd-view--viewer">
        <Suspense fallback={(
          /* Wordless: that the renderer is a separate download is this
             application's build detail, not something the reader chose or can
             change, and naming it made a normal first open look like a fault. */
          <div className="gd-state gd-state--loading">
            <output className="gd-loader" aria-label="Loading" />
          </div>
        )}
        >
          <DashboardSceneViewer
            // Keyed by uid so switching dashboards builds a fresh scene rather
            // than mutating the previous one's grid in place.
            key={openUid}
            uid={openUid}
            registration={openRegistration}
            initialFrom={openRange?.from}
            initialTo={openRange?.to}
            breadcrumb={(
              <nav className="gd-crumbs" aria-label="Breadcrumb">
                <button
                  type="button" className="gd-crumb-link"
                  onClick={() => { setPath([]); setOpenUid(null); setOpenRange(null); }}
                >Dashboards</button>
                {/* Every folder on the way down stays clickable, so a dashboard
                    four levels deep does not strand the user at the top. */}
                {nodes.map((node, index) => (
                  <React.Fragment key={node.uid || 'ungrouped'}>
                    <span aria-hidden="true">/</span>
                    <button
                      type="button"
                      className="gd-crumb-link"
                      onClick={() => {
                        setPath(nodes.slice(0, index + 1).map((n) => n.uid));
                        setOpenUid(null);
                        setOpenRange(null);
                      }}
                    >{node.title}</button>
                  </React.Fragment>
                ))}
              </nav>
            )}
          />
        </Suspense>

        {/* A drill-down this application cannot follow. Raised while a dashboard
            is open, which is the only place drill-downs come from — so it has to
            be rendered here as well as on the browse screen below. */}
        <Toast
          message={navNotice}
          tone="warn"
          title="That dashboard is not registered"
          duration={8000}
          onDismiss={() => setNavNotice('')}
        />
      </div>
    );
  }

  const notConfigured = health?.supported === false;
  const nothingAnywhere = !loading && !error && tree.roots.length === 0;
  const totalDashboards = roots.reduce((sum, node) => sum + node.total, 0);
  const totalFolders = countFolders(roots);

  return (
    <div className="gd-view">
      <FolderTileBrowser
        rootLabel="Dashboards"
        trail={trail}
        nodes={nodes}
        onNavigate={setPath}
        folders={level}
        actions={<RefreshButton onClick={reload} />}
      >
        {/* Grafana is not configured, yet tiles are on screen: the registry is this
            application's OWN state and stays readable without Grafana, so a
            deployment with registrations but no GRAFANA_BASE_URL shows a full
            folder tree of dashboards that cannot open. Said here, once, rather
            than leaving each tile to fail on click — and only when there IS
            something to click, because the empty state below says it too. */}
        {notConfigured && !nothingAnywhere && (
          <output className="alerts-banner alerts-banner--error">
            <span className="alerts-banner-text">
              {health.message} The dashboards below are registered in this application,
              but none of them can be opened until Grafana is configured.
            </span>
          </output>
        )}

        {error && (
          <div className="alerts-banner alerts-banner--error" role="alert">
            <span className="alerts-banner-text">{error}</span>
            <button
              type="button" className="alerts-banner-x"
              onClick={() => setError('')} aria-label="Dismiss"
            >×</button>
          </div>
        )}

        {loading && (
          <div className="gd-state gd-state--loading">
            <output className="gd-loader" aria-label="Loading" />
          </div>
        )}

        {nothingAnywhere && (
          <div className="gd-state">
            {/* Two genuinely different situations, and they look identical on screen:
                nothing has been registered yet, versus this deployment has no Grafana
                configured at all. The fixes are completely different, so the empty
                state has to say which one it is. */}
            <span className="gd-state-title">
              {notConfigured ? 'Grafana is not configured' : 'No dashboards registered yet'}
            </span>
            <span className="gd-state-hint">
              {notConfigured
                ? health.message
                : 'Register a Grafana dashboard UID in Settings → Dashboard Catalog and it '
                  + 'will appear here, inside the folder you filed it under.'}
            </span>
          </div>
        )}

        {/* A folder holding only subfolders is not empty — its tiles are above.
            This is for a folder with neither subfolders nor dashboards. */}
        {!loading && !error && !nothingAnywhere
          && level.length === 0 && dashboards.length === 0 && (
          <div className="gd-state">
            <span className="gd-state-title">Nothing available here</span>
            <span className="gd-state-hint">
              This folder has no enabled dashboards. Register one into it, or re-enable
              it, in Settings → Dashboard Catalog.
            </span>
          </div>
        )}

        {dashboards.length > 0 && (
          <div className="gd-tiles">
            {dashboards.map((row) => (
              <button
                type="button"
                key={row.uid}
                className="gd-tile gd-tile--dashboard"
                // The range is cleared as well as the uid: opening a dashboard
                // from its tile means "as this dashboard is saved", not "still
                // on the window some earlier drill-down happened to carry".
                onClick={() => { setOpenRange(null); setOpenUid(row.uid); }}
                title={`Open ${row.title || row.uid}`}
              >
                <span className="gd-tile-icon" aria-hidden="true">
                  <NavIcon name="dashboards" size={20} />
                </span>
                <span className="gd-tile-name">{row.title || row.uid}</span>
                <code className="gd-tile-uid">{row.uid}</code>
                {/* Shown only when they differ. A dashboard moved in Grafana keeps
                    its tile here, and saying where it went is better than a tile
                    that quietly describes the wrong folder. */}
                {row.folderMismatch && (
                  <span
                    className="gd-tile-note"
                    title={`This dashboard lives in the Grafana folder "${row.grafanaFolderTitle}"`}
                  >
                    In Grafana: {row.grafanaFolderTitle}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {!loading && !error && !here && totalDashboards > 0 && (
          <footer className="gd-foot">
            {totalDashboards} dashboard{totalDashboards === 1 ? '' : 's'} across{' '}
            {totalFolders} folder{totalFolders === 1 ? '' : 's'}.
          </footer>
        )}
      </FolderTileBrowser>

      <Toast
        message={navNotice}
        tone="warn"
        title="That dashboard is not registered"
        duration={8000}
        onDismiss={() => setNavNotice('')}
      />
    </div>
  );
}

/** Folders that actually HOLD a dashboard — the ones the footer's count means. */
const countFolders = (nodes) => nodes.reduce(
  (sum, node) => sum + (node.dashboards.length > 0 ? 1 : 0) + countFolders(node.children),
  0,
);

function RefreshButton({ onClick }) {
  return (
    <button
      type="button"
      className="results-bar-btn"
      onClick={onClick}
      title="Refresh"
      aria-label="Refresh"
    >
      <svg
        width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      >
        <path d="M20 11a8 8 0 1 0-2.3 5.7" />
        <path d="M20 4v7h-7" />
      </svg>
    </button>
  );
}

RefreshButton.propTypes = { onClick: PropTypes.func.isRequired };

DashboardsView.propTypes = {
  /** Identifier of the organization every request is scoped to. */
  activeOrg: PropTypes.string,
};
