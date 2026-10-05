import React, { useCallback, useState } from 'react';
import PropTypes from 'prop-types';
import LogsSummaryCard from './summary/LogsSummaryCard';
import TracesSummaryCard from './summary/TracesSummaryCard';
import MetricsSummaryCard from './summary/MetricsSummaryCard';
import ServicesUptimeCard from './summary/ServicesUptimeCard';
import ServiceVitalsDrawer from './summary/ServiceVitalsDrawer';
import OverviewPanel from './home/OverviewPanel';

// Window options mirror the LogsView presets so users get a familiar control.
const WINDOWS = [
  { key: 'now-15m', label: 'Last 15m' },
  { key: 'now-1h',  label: 'Last 1h'  },
  { key: 'now-24h', label: 'Last 24h' },
];

// Auto-refresh interval. 30s matches the cadence the user would manually
// hit "refresh" on a dashboard; faster polling burns OpenObserve compute for
// no perceptible benefit at this aggregate level.
const AUTO_REFRESH_MS = 30_000;

/**
 * Top-level container for the Summary tab. Owns:
 *  - the active time-window (passed down to every card)
 *  - the refresh tick (incremented every 30 s; each card watches it as a dep)
 *
 * Each card has its own loading/error state; failures in one card never block
 * the others. The four cards are independent fetches against the lib's
 * summary endpoints.
 */
const WINDOW_LABELS = {
  'now-15m': 'Last 15 minutes',
  'now-1h':  'Last 1 hour',
  'now-24h': 'Last 24 hours',
};

const SummaryView = ({ onDrillToService, onNavigate }) => {
  const [window, setWindow] = useState('now-1h');
  const [refreshTick, setRefreshTick] = useState(0);
  const [paused, setPaused] = useState(false);
  // Service whose vitals drawer is open. Null = closed. Drawer mounts on
  // open and unmounts on close so its fetch hooks re-run cleanly between
  // services; cheaper than a keep-open-and-swap model and keeps state local.
  const [drawerService, setDrawerService] = useState(null);

  // Cross-card signals fed into the Metrics card so it can default sensibly
  // without making its own duplicate fetches:
  //  - topErrorService: the service at #1 in LogsSummaryCard's "top error
  //    services" — the Metrics card uses this as the default selection when
  //    the user hasn't picked one (per product direction: align metrics with
  //    whatever's most likely under investigation).
  //  - serviceOptions: the full list of services emitting metrics, sourced
  //    from ServicesUptimeCard's fetch — populates the picker dropdown.
  // Both are pushed up via stable callbacks (useCallback) so the donor cards
  // don't trigger a re-render storm every refresh tick.
  const [topErrorService, setTopErrorService] = useState(null);
  const [serviceOptions, setServiceOptions]   = useState([]);

  const handleLogsTopServices = useCallback((list) => {
    const first = Array.isArray(list) && list.length > 0 ? list[0]?.serviceName : null;
    setTopErrorService(first || null);
  }, []);
  const handleServicesList = useCallback((list) => {
    setServiceOptions(Array.isArray(list) ? list : []);
  }, []);

  // Raw responses lifted out of three of the cards so the Overview panel at the
  // top can render its tiles from them. Stable setters as callbacks — an inline
  // arrow would be a new function identity every render and, since the cards
  // list onData in their fetch effect's deps, would refetch on every render.
  const [logsSummary, setLogsSummary]     = useState(null);
  const [tracesSummary, setTracesSummary] = useState(null);
  const [uptimeData, setUptimeData]       = useState(null);
  const handleLogsData   = useCallback((d) => setLogsSummary(d), []);
  const handleTracesData = useCallback((d) => setTracesSummary(d), []);
  const handleUptimeData = useCallback((d) => setUptimeData(d), []);

  React.useEffect(() => {
    if (paused) return undefined;
    const id = setInterval(() => setRefreshTick(t => t + 1), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [paused]);

  // Drawer's "View logs →" forwards to App.handleDrillToService, then closes
  // the drawer — keeping it open while a tab switch happens is jarring.
  const handleViewLogs = (serviceName) => {
    if (onDrillToService) onDrillToService(serviceName);
    setDrawerService(null);
  };

  return (
    <section className="summary-view">
      <div className="summary-toolbar">
        <h1 className="page-heading">Metrics &amp; Services</h1>
        <span className="summary-toolbar-label">Window</span>
        <div className="summary-window-group" role="radiogroup" aria-label="Time window">
          {WINDOWS.map(w => (
            <button
              key={w.key}
              className={`summary-window-btn ${window === w.key ? 'summary-window-btn--active' : ''}`}
              onClick={() => setWindow(w.key)}
            >
              {w.label}
            </button>
          ))}
        </div>

        <button
          className={`summary-window-btn ${paused ? 'summary-window-btn--active' : ''}`}
          onClick={() => setPaused(p => !p)}
          title={paused ? 'Auto-refresh is paused — click to resume' : 'Pause auto-refresh'}
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>

        <span className="summary-refresh-hint">
          {paused ? 'Auto-refresh paused' : 'Refreshes every 30s'}
        </span>
      </div>

      <OverviewPanel
        logsSummary={logsSummary}
        tracesSummary={tracesSummary}
        uptime={uptimeData}
        windowLabel={WINDOW_LABELS[window] || window}
        onNavigate={onNavigate}
      />

      <div className="summary-grid">
        <LogsSummaryCard       window={window} refreshTick={refreshTick}
                               onTopErrorServices={handleLogsTopServices}
                               onData={handleLogsData} />
        <TracesSummaryCard     window={window} refreshTick={refreshTick}
                               onData={handleTracesData} />
        <MetricsSummaryCard    window={window} refreshTick={refreshTick}
                               serviceOptions={serviceOptions}
                               topErrorService={topErrorService} />
        <ServicesUptimeCard    window={window} refreshTick={refreshTick}
                               onRowClick={setDrawerService}
                               onServicesList={handleServicesList}
                               onData={handleUptimeData} />
      </div>

      {drawerService && (
        <ServiceVitalsDrawer
          serviceName={drawerService}
          window={window}
          onClose={() => setDrawerService(null)}
          onViewLogs={handleViewLogs}
        />
      )}
    </section>
  );
};

SummaryView.propTypes = {
  onDrillToService: PropTypes.func,
  /** Nav-key switcher ('logs' | 'traces') for the Overview tiles. */
  onNavigate:       PropTypes.func,
};

export default SummaryView;
