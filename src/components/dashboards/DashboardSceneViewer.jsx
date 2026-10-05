import React, { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

// This module is the ONLY thing that pulls @grafana/* into the bundle, and it is
// reached exclusively through React.lazy from DashboardsView. That is deliberate:
// @grafana/ui is large, and a static import here would put it on the critical
// path of Logs, Traces, Metrics and Alerts — screens that have nothing to do with
// Grafana. A user who never opens a dashboard never downloads any of it.
import { bootstrapGrafanaRuntime } from '../../grafana/bootstrap';
import { buildDashboardSceneAsync, sceneTimeRangeOf } from '../../grafana/buildScene';
import {
  parseDashboardTarget,
  requestDashboardNavigation,
} from '../../grafana/dashboardNavigation';
import SceneThemeProvider from '../../grafana/SceneThemeProvider';
import { fetchDashboardDefinition, fetchDashboardHealth } from '../../services/dashboardsApi';
import DashboardToolbar, { REFRESH_OPTIONS, parseRefresh } from './DashboardToolbar';
import SceneErrorBoundary from './SceneErrorBoundary';

/**
 * How often an open dashboard re-reads its definition to pick up edits made in
 * Grafana. One small GET per beat, and only while the tab is visible.
 */
const DEFINITION_WATCH_MS = 30_000;

/**
 * One dashboard, rendered.
 *
 * ─── This component knows a UID and nothing else ────────────────────────────
 *
 * It fetches whatever JSON Grafana currently holds for that UID, hands it to the
 * ONE buildDashboardScene() implementation, and renders the result:
 *
 *   uid -> GET /api/dashboards/registry/{uid}/definition -> dashboard JSON
 *       -> buildDashboardSceneAsync(json)                -> EmbeddedScene
 *       -> <scene.Component model={scene} />             -> rendered dashboard
 *
 * Dashboard A and dashboard B travel this exact path. There is no branch on which
 * dashboard is being shown, anywhere — which is what makes "register a UID" the
 * whole process for adding one.
 *
 * ─── Read-only, on purpose ──────────────────────────────────────────────────
 *
 * Panels cannot be dragged, resized, added or edited here. Grafana stays the one
 * place a dashboard is authored, so a panel here can never disagree with the same
 * panel in Grafana — and the backend needs only a Viewer-role token, which is the
 * smallest credential that can do this job.
 */
/** The toolbar's status word: what the viewer is doing right now. */
function viewerStatus({ loading, error, autoRefresh }) {
  if (loading) return 'Loading';
  if (error) return 'Error';
  return autoRefresh ? `Live · ${autoRefresh}` : 'Paused';
}

export default function DashboardSceneViewer({
  uid, registration, breadcrumb, initialFrom, initialTo,
}) {
  const [scene, setScene] = useState(null);
  const [meta, setMeta] = useState(null);          // the dashboard's title and version
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);        // a title, detail and HTTP status
  const [reloadKey, setReloadKey] = useState(0);

  const [range, setRange] = useState({ from: 'now-6h', to: 'now' });
  const [autoRefresh, setAutoRefresh] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Fill Grafana's runtime registries before anything renders a scene. Idempotent,
  // and called here rather than at module scope so it runs inside React's
  // lifecycle rather than during the lazy chunk's evaluation.
  //
  // The THEME deliberately does not depend on this effect's timing: SceneThemeProvider
  // asks getSceneTheme(), which bootstraps on demand. Panels would otherwise be
  // themed correctly only because the scene mounts after an async fetch — true
  // today, and the kind of ordering that breaks silently when it stops being true.
  useEffect(() => { bootstrapGrafanaRuntime(); }, []);

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!uid) return undefined;

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    setScene(null);

    (async () => {
      // ALWAYS the current definition. Nothing about a dashboard is cached in
      // this application — the registry stores metadata only, Grafana owns the
      // JSON — so a panel edited in Grafana appears on this open, and on an
      // already-open dashboard within DEFINITION_WATCH_MS (see below).
      const data = await fetchDashboardDefinition(uid, { signal: controller.signal });
      if (cancelled) return;

      if (!data?.model || typeof data.model !== 'object') {
        throw Object.assign(
          new Error('Grafana returned no dashboard model for this UID.'),
          { title: 'Invalid dashboard' },
        );
      }

      const built = await buildDashboardSceneAsync(data.model);
      if (cancelled) return;

      setMeta({ title: data.title, version: data.version });
      setScene(built);

      // Adopt the dashboard's own defaults, the way opening it in Grafana would
      // — unless we arrived here by drilling down from another dashboard, in
      // which case the window that was being looked at wins. Grafana carries it
      // in the link for the same reason: "that service DURING THIS INCIDENT" is
      // the question being asked, and this dashboard's own default is usually
      // the last six hours, which hides it.
      const arriving = initialFrom && initialTo
        ? { from: initialFrom, to: initialTo }
        : null;
      setRange(arriving ?? built.__defaultTime);
      if (arriving) {
        try {
          sceneTimeRangeOf(built)?.onTimeRangeChange({ raw: arriving });
        } catch (err) {
          // The panels then render the dashboard's own window instead of the
          // one we came from. Worth a line in the console, not worth failing
          // the whole open over.
          console.error('[dashboards] could not apply the incoming time range', err);
        }
      }
      const dashboardRefresh = built.__defaultRefresh;
      if (REFRESH_OPTIONS.some((option) => option.value === dashboardRefresh)) {
        setAutoRefresh(dashboardRefresh);
      }
    })()
      .catch(async (err) => {
        if (cancelled || err.name === 'AbortError') return;

        // A 409 has two completely different causes behind one status code: this
        // dashboard is disabled in the catalog, or the deployment has no Grafana
        // at all (the backend's requireUsable() refuses every write AND this read
        // with the same code). Titling both "This dashboard is disabled" sends
        // whoever reads it to flip a toggle that is not the problem — the toggle
        // is already on, and nothing they do in the catalog will help.
        //
        // So ask /health which one it is. One extra request, only on failure, and
        // re-asked by Try again, so a deployment that gets its GRAFANA_BASE_URL
        // recovers on a click rather than a reload.
        const unconfigured = err.status === 409
          ? await unconfiguredReason(controller.signal)
          : null;
        if (cancelled) return;

        setError(unconfigured
          ? {
            title: 'Grafana is not configured on this deployment',
            detail: unconfigured,
            status: err.status,
          }
          : { title: describeFailure(err), detail: err.message, status: err.status });
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; controller.abort(); };
    // Strings rather than a `{from,to}` object, deliberately: an object prop
    // rebuilt on every parent render would re-run this effect — and this effect
    // refetches the dashboard and rebuilds the scene.
  }, [uid, reloadKey, initialFrom, initialTo]);

  // ── Two-way time-range binding ──────────────────────────────────────────
  //
  // Both directions matter, and they are not symmetrical:
  //
  //  · toolbar -> scene. `applyRange` writes THROUGH the scene's time range,
  //    which is what makes every dependent SceneQueryRunner re-execute. It also
  //    sets local state, so the picker moves even if the write-through fails —
  //    with a console error rather than a control that silently ignores clicks.
  //
  //  · scene -> toolbar. Drag-to-zoom inside a panel writes straight to the
  //    SceneTimeRange, and this subscription brings the picker back in step
  //    instead of leaving it claiming a window that is no longer on screen.
  //
  // Both go through sceneTimeRangeOf(), which ASKS THE SCENE GRAPH for the live
  // object rather than trusting a reference captured at build time — see its note.
  useEffect(() => {
    const timeRange = sceneTimeRangeOf(scene);
    if (!timeRange) return undefined;
    setRange({ from: timeRange.state.from, to: timeRange.state.to });
    const subscription = timeRange.subscribeToState((next) => {
      setRange((prev) => (prev.from === next.from && prev.to === next.to
        ? prev
        : { from: next.from, to: next.to }));
    });
    return () => subscription.unsubscribe();
  }, [scene]);

  const applyRange = useCallback((next) => {
    // Optimistic, deliberately. If the write below throws or lands on the wrong
    // object, the user still sees the window they asked for and an error in the
    // console — rather than a picker that snaps back with no explanation, which
    // is indistinguishable from a dead control.
    setRange(next);

    const timeRange = sceneTimeRangeOf(scene);
    if (!timeRange) return;
    try {
      timeRange.onTimeRangeChange({ raw: { from: next.from, to: next.to } });
    } catch (err) {
      console.error('[dashboards] could not apply the time range to the scene', err);
    }
  }, [scene]);

  const refreshNow = useCallback(() => {
    const timeRange = sceneTimeRangeOf(scene);
    if (!timeRange) return;
    setRefreshing(true);
    try {
      timeRange.onRefresh();  // re-evaluates "now" and re-runs every query
    } catch (err) {
      console.error('[dashboards] could not refresh the scene', err);
    }
    // The spin is a fixed beat rather than "until the queries finish": the panels
    // report their own loading state, and tracking N queries to drive one icon
    // would be a second, disagreeing source of truth.
    window.setTimeout(() => setRefreshing(false), 500);
  }, [scene]);

  // ── Auto-refresh ────────────────────────────────────────────────────────
  //
  // Two rules, both learned the hard way elsewhere in this app:
  //
  //  1. The timer NEVER depends on loading state. A timer that is cancelled and
  //     recreated whenever a fetch starts drifts, double-fires, or stops
  //     altogether depending on how long the fetch takes.
  //  2. It pauses while the tab is hidden. One dashboard is one query PER PANEL
  //     per tick — a fourteen-panel dashboard on 30s is 28 queries a minute
  //     against Grafana, and a forgotten background tab should not be paying that
  //     all weekend. Coming back refreshes immediately, so nothing looks stale.
  const sceneRef = useRef(scene);
  useEffect(() => { sceneRef.current = scene; }, [scene]);

  useEffect(() => {
    const period = parseRefresh(autoRefresh);
    if (!period) return undefined;

    let timer = null;
    const tick = () => {
      try {
        sceneTimeRangeOf(sceneRef.current)?.onRefresh();
      } catch (err) {
        // A failed tick must not kill the timer — the next one may well work,
        // and an auto-refresh that stops after one bad beat is worse than one
        // that logs and carries on.
        console.error('[dashboards] auto-refresh tick failed', err);
      }
    };
    const start = () => { if (timer == null) timer = setInterval(tick, period); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') { tick(); start(); } else stop();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
    // Deliberately NOT depending on `scene`: the ref above keeps the callback
    // current, so reloading a dashboard does not reset the refresh cadence.
  }, [autoRefresh]);

  // ── Follow edits made in Grafana while the dashboard is open ────────────
  //
  // Opening always reads the current definition, but a dashboard is often left
  // open on a wall screen for days — and a panel edited in Grafana used to reach
  // it only when someone reopened it. So while the tab is visible, re-read the
  // definition every DEFINITION_WATCH_MS and rebuild when Grafana's `version`
  // has moved. Grafana bumps it on EVERY save, of any change — a panel, a query,
  // a datasource, a variable, the layout — so it is the one signal that covers
  // all of them without diffing the JSON.
  //
  // The swap is silent: no loading state, no spinner, and the window being
  // looked at is carried across. A check that fails is simply skipped — the
  // dashboard on screen is still a valid one, and the next beat will try again.
  const rangeRef = useRef(range);
  useEffect(() => { rangeRef.current = range; }, [range]);

  const version = meta?.version;
  useEffect(() => {
    if (!uid || !scene || version == null) return undefined;

    let stopped = false;
    let inflight = null;
    const check = async () => {
      if (inflight || document.visibilityState !== 'visible') return;
      const controller = new AbortController();
      inflight = controller;
      try {
        const data = await fetchDashboardDefinition(uid, { signal: controller.signal });
        if (stopped || !data?.model || typeof data.model !== 'object') return;
        if (data.version === version) return;

        const built = await buildDashboardSceneAsync(data.model);
        if (stopped) return;
        const current = rangeRef.current;
        if (current?.from && current?.to) {
          try {
            sceneTimeRangeOf(built)?.onTimeRangeChange({
              raw: { from: current.from, to: current.to },
            });
          } catch (err) {
            console.error('[dashboards] could not carry the time range across an update', err);
          }
        }
        console.info(
          `[dashboards] "${data.title}" changed in Grafana (v${version} -> v${data.version}) — updated`,
        );
        setMeta({ title: data.title, version: data.version });
        setScene(built);
      } catch (err) {
        if (!stopped && err?.name !== 'AbortError') {
          console.warn('[dashboards] could not check the dashboard for changes', err);
        }
      } finally {
        if (inflight === controller) inflight = null;
      }
    };

    const timer = setInterval(check, DEFINITION_WATCH_MS);
    // Back from another tab: the dashboard may have been edited meanwhile.
    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      inflight?.abort();
    };
  }, [uid, scene, version]);

  const reload = () => setReloadKey((key) => key + 1);

  // ── Drill-down from a core panel ────────────────────────────────────────
  //
  // A Grafana DATA LINK — the thing that makes a table row or a series clickable
  // — is rendered by @grafana/ui as a plain `<a href="/d/<uid>…">`. In Grafana
  // its router picks that up. Here it is a link into an application that has no
  // router and no such path, so following it would leave the app entirely and
  // land on a 404.
  //
  // Caught here rather than per panel: this is one listener for every panel type
  // at once, present and future, and it needs to know nothing about any of them
  // beyond "an anchor whose href names a dashboard". Anything else — an external
  // link, an in-page anchor — is left completely alone.
  //
  // Dynamic text panels do NOT come through here. Their content lives in a
  // sandboxed iframe whose clicks never reach this document, so they carry the
  // same interception inside the sandbox; see grafana/panelDynamicText.jsx.
  const onSceneClick = useCallback((event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    const target = parseDashboardTarget(anchor.getAttribute('href'));
    if (!target) return;
    // Prevented whether or not anything is listening: the alternative is
    // navigating away from the application, which is never the better outcome.
    event.preventDefault();
    requestDashboardNavigation(target);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────

  const title = meta?.title || registration?.title || uid;
  const subtitle = [
    uid && `UID ${uid}`,
    meta?.version != null && `v${meta.version}`,
    registration?.folderTitle,
  ].filter(Boolean).join(' · ');

  const status = viewerStatus({ loading, error, autoRefresh });

  return (
    <div className="gd-viewer">
      <DashboardToolbar
        title={title}
        subtitle={subtitle}
        breadcrumb={breadcrumb}
        range={range}
        onRangeChange={applyRange}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        onRefresh={refreshNow}
        refreshing={refreshing}
        status={status}
        live={!loading && !!scene && !!autoRefresh}
        disabled={!scene}
      />

      {/* Not a control: a capture-phase listener that re-routes the anchors
          Grafana's own panels render. Every one of them is already a real,
          keyboard-reachable link; this only changes where it goes. */}
      <div className="gd-scene" onClickCapture={onSceneClick}>
        {loading && (
          /* No prose, and no UID. Where the definition comes from is not the
             reader's problem while it is arriving — the toolbar above already
             names the dashboard and shows the Loading status, and if the fetch
             fails the error card below says what went wrong and offers a retry. */
          <div className="gd-state gd-state--loading">
            <output className="gd-loader native-el native-inline" aria-label="Loading" />
          </div>
        )}

        {!loading && error && (
          <div className="gd-state gd-state--error" role="alert">
            <span className="gd-state-title">{error.title}</span>
            <span className="gd-state-detail">{error.detail}</span>
            <button type="button" className="alerts-btn-primary" onClick={reload}>
              Try again
            </button>
          </div>
        )}

        {!loading && !error && scene && (
          <SceneErrorBoundary resetKey={`${uid}:${reloadKey}`}>
            <SceneThemeProvider>
              <scene.Component model={scene} />
            </SceneThemeProvider>
          </SceneErrorBoundary>
        )}
      </div>
    </div>
  );
}

/**
 * The deployment's own reason Grafana cannot be used at all, or null if it can.
 *
 * Read from {@code /health} rather than matched out of the failed request's prose:
 * that sentence is written for a human and will be reworded eventually, and a UI
 * that grepped it would then quietly fall back to the wrong heading — which is
 * exactly the bug this exists to fix.
 */
async function unconfiguredReason(signal) {
  try {
    const health = await fetchDashboardHealth({ signal });
    if (health?.supported !== false) return null;
    return health.message || 'No Grafana is configured on this deployment.';
  } catch {
    // The diagnostic endpoint is unreachable too. Say nothing extra and let the
    // original failure stand, rather than replacing one unknown with another.
    return null;
  }
}

/**
 * Turn a failure into a heading someone can act on.
 *
 * The three the backend actually produces need three different responses, and a
 * single "could not load the dashboard" would hide which one happened: 404 means
 * fix the registration, 409 means flip a toggle, 502 means look at Grafana.
 *
 * The 409 heading here assumes the catalog toggle, because the caller has already
 * ruled out the unconfigured-deployment 409 via unconfiguredReason() above.
 */
function describeFailure(err) {
  if (err.title) return err.title;
  switch (err.status) {
    case 404: return 'Dashboard not found';
    case 409: return 'This dashboard is disabled';
    case 400: return 'Grafana rejected the request';
    case 502: return 'Grafana could not be reached';
    default: return err.status ? 'Could not load the dashboard' : 'The backend is unreachable';
  }
}

DashboardSceneViewer.propTypes = {
  /** Grafana dashboard UID. The only thing this component is told about it. */
  uid: PropTypes.string.isRequired,
  /** The registry row, used only for labels before the definition arrives. */
  registration: PropTypes.shape({
    title: PropTypes.string,
    folderTitle: PropTypes.string,
  }),
  breadcrumb: PropTypes.node,
  /**
   * Time range to open on, overriding the dashboard's own default. Set when the
   * user arrived by drilling down from another dashboard, so the window they
   * were looking at follows them. Grafana's raw syntax ("now-1h", or an epoch
   * in milliseconds as a string) — the same strings the toolbar uses.
   */
  initialFrom: PropTypes.string,
  initialTo: PropTypes.string,
};
