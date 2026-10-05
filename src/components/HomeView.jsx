import React, { useCallback, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchOrgSummary } from '../services/api';
import { fetchDashboardRegistrations } from '../services/dashboardsApi';
import NavIcon from './common/NavIcons';
import StreamsPanel from './home/StreamsPanel';
import { HomeResourcesCard, HomeSplitCard } from './home/HomePanels';

/**
 * Home screen: the org's ingest posture at a glance, laid out as OpenObserve's
 * Home — a Streams panel of five headline figures, then Resources (with the
 * Explore shortcuts) / Alerts / Pipelines.
 *
 * Every shortcut lands on THIS app's screen, not OpenObserve's: Logs, Log
 * Analytics, Traces, Metrics, RUM, Dashboards and Alerts all go through the
 * shell's navigate(), so permission gating and group resolution apply exactly as
 * they do from the rail. OpenObserve's Reports entry is deliberately absent.
 *
 * The Dashboards count is the number of dashboards registered and enabled in
 * this app's Dashboard Catalog — what the Dashboards screen will actually show —
 * not OpenObserve's own dashboard count, which would promise dashboards the
 * click could not open.
 *
 * Every figure comes from ONE call to GET /api/org/summary (see its contract in
 * services/api.js). That endpoint is not in the lib yet, so until it ships this
 * screen renders a state naming the path and the status it got back rather than
 * inventing numbers or showing a bare zero — a zero here is indistinguishable
 * from "632 streams and we failed to ask", which is the worse failure.
 *
 * No time-window control: these are whole-org totals, not windowed aggregates.
 * Refresh is manual — the backend has to sum stats across every stream to answer,
 * which is not something to put on a 30-second timer.
 */

const relativeTime = (ts) => {
  if (!ts) return null;
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
};

const HomeView = ({ onNavigate }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // Read separately from the summary: a different backend (the Grafana-backed
  // Dashboard Catalog), and a failure of one must not blank the other.
  const [dashboardCount, setDashboardCount] = useState(null);
  const [dashLoading, setDashLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchOrgSummary({ signal: controller.signal })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setFetchedAt(Date.now());
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err);
        setLoading(false);
        // Nothing about this failure is shown on the page — the screen is meant
        // to read exactly as the reference design, so the tiles simply fall back
        // to "—". Log it, and hang the same explanation off the refresh button's
        // tooltip, so the reason is still findable instead of silently gone.
        console.warn(
          '[HomeView] Org summary unavailable — tiles will render "—". '
          + `${err.message}. See docs/org-summary-endpoint.md for the contract `
          + 'this screen expects from GET /api/org/summary.',
        );
      });

    return () => { cancelled = true; controller.abort(); };
  }, [refreshTick]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setDashLoading(true);

    // enabledOnly: the viewer's list, the same one the Dashboards screen renders.
    fetchDashboardRegistrations({ enabledOnly: true, signal: controller.signal })
      .then((registry) => {
        if (cancelled) return;
        const items = Array.isArray(registry?.items) ? registry.items : null;
        setDashboardCount(items ? items.length : null);
        setDashLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // "—", never 0: an unreadable catalog is not an empty one.
        setDashboardCount(null);
        setDashLoading(false);
        console.warn(`[HomeView] Dashboard count unavailable — ${err.message}`);
      });

    return () => { cancelled = true; controller.abort(); };
  }, [refreshTick]);

  const handleRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  const ago = relativeTime(fetchedAt);

  // Panel arrows are rendered only when there's somewhere to go, so a host that
  // mounts this without onNavigate gets clean headers instead of dead controls.
  const open = (navKey) => (onNavigate ? () => onNavigate(navKey) : undefined);

  // Only surface for the refresh button's tooltip. 404/501 means the endpoint
  // isn't deployed; 500 is included because this backend answers unmapped paths
  // with 500, so the two can't be told apart from here.
  const isMissingEndpoint = error && [404, 500, 501].includes(error.status);
  let refreshTitle = 'Refresh org summary';
  if (isMissingEndpoint) {
    refreshTitle = `Refresh — figures unavailable: GET /api/org/summary returned HTTP ${error.status} `
      + '(endpoint not on the lib yet; see docs/org-summary-endpoint.md)';
  } else if (error) {
    refreshTitle = `Refresh — figures unavailable: ${error.message}`;
  }

  const counts = [
    // No Functions screen in this app — a count, not a link.
    { key: 'functions', label: 'Functions', icon: 'functions', tone: 'accent',
      value: data?.functions?.count },
    { key: 'dashboards', label: 'Dashboards', icon: 'dashboards', tone: 'warn',
      value: dashboardCount, onOpen: open('dashboards') },
  ];

  // Keys are the shell's tab keys, unchanged — 'analytics' is the Log Analytics
  // section inside the Logs group, reached the same way the rail reaches it.
  const explore = [
    { key: 'logs',      label: 'Logs',          icon: 'logs',      tone: 'ok',     onOpen: open('logs') },
    { key: 'analytics', label: 'Log Analytics', icon: 'analytics', tone: 'accent', onOpen: open('analytics') },
    { key: 'traces',    label: 'Traces',        icon: 'traces',    tone: 'accent', onOpen: open('traces') },
    { key: 'metrics',   label: 'Metrics',       icon: 'metrics',   tone: 'ok',     onOpen: open('metrics') },
    { key: 'rum',       label: 'RUM',           icon: 'rum',       tone: 'accent', onOpen: open('rum') },
  ].filter((row) => row.onOpen);

  return (
    <section className="home-view">
      <div className="home-toolbar">
        <span className="home-title-icon" aria-hidden="true">
          <NavIcon name="home" size={20} />
        </span>
        <div className="home-title">
          <h1 className="page-heading">Home</h1>
          <span className="home-subtitle">Your observability workspace at a glance</span>
        </div>
        {data?.org && <span className="home-org-chip">{data.org}</span>}
        <div className="home-toolbar-right">
          {ago && (
            <span className="home-updated">
              {loading ? 'refreshing…' : `updated ${ago}`}
            </span>
          )}
          <button
            type="button"
            className="results-bar-btn"
            onClick={handleRefresh}
            title={refreshTitle}
            aria-label="Refresh org summary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* No arrow on Streams: OpenObserve's goes to its Streams page, which this
          app does not have (Streams was removed from the rail). An arrow there
          would navigate to a tab with no route and blank the content area. */}
      <StreamsPanel
        streams={data?.streams}
        loading={loading}
      />

      <div className="home-grid">
        <HomeResourcesCard
          counts={counts}
          explore={explore}
          loading={loading || dashLoading}
        />

        <HomeSplitCard
          title="Alerts"
          icon="alerts"
          tone="warn"
          scheduled={data?.alerts?.scheduled}
          realTime={data?.alerts?.realTime}
          health={data?.alerts?.health}
          loading={loading}
          onOpen={open('alerts')}
        />

        {/* No arrow: there is no Pipelines screen in this app to open. */}
        <HomeSplitCard
          title="Pipelines"
          icon="pipelines"
          tone="accent"
          scheduled={data?.pipelines?.scheduled}
          realTime={data?.pipelines?.realTime}
          health={data?.pipelines?.health}
          loading={loading}
        />
      </div>
    </section>
  );
};

HomeView.propTypes = {
  /** Nav-key switcher — drives the panel "open" arrows. */
  onNavigate: PropTypes.func,
};

export default HomeView;
