import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchRumScope } from '../../services/api';
import RumPerformance from './RumPerformance';
import RumSessions from './RumSessions';
import RumErrors from './RumErrors';
import { RUM_WINDOWS, RUM_REFRESH } from './rumFormat';
import '../../styles/rum.css';

/**
 * Real User Monitoring — what the browser actually experienced.
 *
 * ─── The shell owns the query, the tabs own the rendering ────────────────────
 *
 * Window, service, environment and version live here, not in the tabs. All three
 * tabs describe the same population of sessions, so the filters have to survive a
 * tab switch: narrowing to one service on Performance and then finding Sessions
 * showing every service would make the two tabs disagree for a reason nothing on
 * screen explains.
 *
 * The tabs are handed those values and fetch their own data. That keeps each tab's
 * request to exactly what it draws — three separate aggregations server-side, so a
 * single combined fetch would make Sessions pay for the Error Tracking queries.
 *
 * ─── Only the visible tab is mounted ────────────────────────────────────────
 *
 * Each tab polls when auto-refresh is on. A permanently-mounted hidden tab would
 * double or triple that load to keep state nobody is looking at, so the inactive
 * tabs are unmounted and re-fetch on return. The filters they re-read live here, so
 * coming back shows the same scope you left.
 *
 * ─── No Source Maps tab ─────────────────────────────────────────────────────
 *
 * OpenObserve's own RUM screen has a fourth tab for uploading source maps, which
 * symbolicate a minified stack back to original filenames. That is a build-pipeline
 * concern — it needs each release's maps stored server-side — and it was explicitly
 * out of scope. Error Tracking shows the raw `file:line` the SDK reported, which is
 * what OpenObserve itself shows when no map has been uploaded.
 */

const TABS = [
  {
    key: 'performance',
    label: 'Performance',
    hint: 'Core Web Vitals, page load and API timings for your frontend',
  },
  {
    key: 'sessions',
    label: 'Sessions',
    hint: 'Real user sessions — who, on what, how long, and what broke',
  },
  {
    key: 'errors',
    label: 'Error Tracking',
    hint: 'Frontend errors grouped into distinct issues',
  },
];

/** Persisted, because which tab and window somebody works from is a preference
 *  about how they read this screen, not navigation state. */
const LS_TAB = 'observability-ui:rum:tab:v1';
const LS_WINDOW = 'observability-ui:rum:window:v1';

/** The all-marker the dropdowns use. Sent as "no filter" by the API layer rather
 *  than as a literal the backend would have to special-case. */
const ALL = '<ALL>';

export default function RumView({ activeOrg }) {
  const [tab, setTab] = useState(() => {
    try {
      const stored = localStorage.getItem(LS_TAB);
      return TABS.some((t) => t.key === stored) ? stored : TABS[0].key;
    } catch { return TABS[0].key; }
  });

  const [timeWindow, setTimeWindow] = useState(() => {
    try {
      const stored = localStorage.getItem(LS_WINDOW);
      return RUM_WINDOWS.some((w) => w.value === stored) ? stored : 'now-6h';
    } catch { return 'now-6h'; }
  });

  const [service, setService] = useState(ALL);
  const [env, setEnv] = useState(ALL);
  const [version, setVersion] = useState(ALL);

  const [refreshSecs, setRefreshSecs] = useState(0);

  /** Bumped to ask the active tab to re-fetch. A counter rather than a callback
   *  registry: the tab is unmounted and replaced on every switch, so anything it
   *  registered here would be stale by the time Refresh was pressed. */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    try { localStorage.setItem(LS_TAB, tab); } catch { /* not persisted */ }
  }, [tab]);
  useEffect(() => {
    try { localStorage.setItem(LS_WINDOW, timeWindow); } catch { /* not persisted */ }
  }, [timeWindow]);

  // ── The filter dropdowns ─────────────────────────────────────────────────
  // Read from the RUM stream itself, scoped to the window. Nothing here knows
  // which applications exist: a frontend appears the moment it reports an event,
  // and disappears from the list when it stops reporting inside the window.
  const [scope, setScope] = useState({ services: [], environments: [], versions: [] });
  const [scopeError, setScopeError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchRumScope({ window: timeWindow, signal: controller.signal });
        if (cancelled) return;
        setScope(data);
        setScopeError('');
      } catch (err) {
        if (cancelled || err.name === 'AbortError') return;
        // Non-fatal. The tabs still work unfiltered; the dropdowns just have
        // nothing to offer, which is visible without needing its own banner.
        setScopeError(err.message || 'Could not load RUM filters.');
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [timeWindow, activeOrg, reloadToken]);

  /**
   * A selection that has vanished from the stream is dropped back to "all".
   *
   * Without this, narrowing to a service and then moving the window to a range it
   * never reported in leaves every panel empty with the cause hidden in a dropdown
   * showing a value the backend is filtering on but the list no longer contains.
   */
  useEffect(() => {
    if (service !== ALL && scope.services.length && !scope.services.includes(service)) {
      setService(ALL);
    }
    if (env !== ALL && scope.environments.length && !scope.environments.includes(env)) {
      setEnv(ALL);
    }
    if (version !== ALL && scope.versions.length && !scope.versions.includes(version)) {
      setVersion(ALL);
    }
  }, [scope, service, env, version]);

  // ── Auto-refresh ─────────────────────────────────────────────────────────
  // Paused while the tab is hidden: a background screen polling a stream scan
  // forever is pure load. The visibility handler fires one refresh on return so
  // coming back shows current numbers rather than whatever was last drawn.
  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);

  useEffect(() => {
    if (!refreshSecs) return undefined;
    let timer = null;
    const start = () => {
      if (timer == null) timer = setInterval(() => reloadRef.current(), refreshSecs * 1000);
    };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { reloadRef.current(); start(); } else { stop(); }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refreshSecs]);

  /** Handed to every tab as one object so adding a filter does not mean touching
   *  three prop lists. */
  const query = useMemo(
    () => ({ window: timeWindow, service, env, version, reloadToken }),
    [timeWindow, service, env, version, reloadToken],
  );

  const activeTab = TABS.find((t) => t.key === tab) || TABS[0];

  return (
    <div className="rum-view">
      <header className="rum-head">
        <div className="rum-head-title">
          <h1 className="rum-title">Real User Monitoring</h1>
          <p className="rum-subtitle">
            Monitor real-user sessions, errors, and frontend performance
          </p>
        </div>
      </header>

      <nav className="rum-tabs" role="tablist" aria-label="RUM sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            className={`rum-tab ${t.key === tab ? 'is-active' : ''}`}
            title={t.hint}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </nav>

      <div className="rum-toolbar">
        <p className="rum-toolbar-hint">{activeTab.hint}</p>

        <div className="rum-toolbar-controls">
          <Picker
            label="Service"
            value={service}
            options={scope.services}
            onChange={setService}
          />
          <Picker label="Env" value={env} options={scope.environments} onChange={setEnv} />
          <Picker
            label="Version"
            value={version}
            options={scope.versions}
            onChange={setVersion}
          />

          <label className="rum-select-wrap">
            <span className="rum-select-label">Period</span>
            <select
              className="rum-select"
              value={timeWindow}
              aria-label="Time range"
              onChange={(e) => setTimeWindow(e.target.value)}
            >
              {RUM_WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>{w.label}</option>
              ))}
            </select>
          </label>

          <label className="rum-select-wrap">
            <span className="rum-select-label">Refresh</span>
            <select
              className="rum-select"
              value={refreshSecs}
              aria-label="Auto refresh interval"
              onChange={(e) => setRefreshSecs(Number(e.target.value))}
            >
              {RUM_REFRESH.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="rum-refresh-btn"
            onClick={reload}
            title="Re-run this tab's queries now"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <path d="M21 3v6h-6" />
            </svg>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {scopeError && (
        <output className="rum-banner rum-banner--warn">
          {scopeError} The filters below may be incomplete; the panels are unaffected.
        </output>
      )}

      {/* Keyed by tab AND org: switching tenant must rebuild the panel rather than
          leave another org's numbers on screen while the new ones load. */}
      <div className="rum-body">
        {tab === 'performance' && (
          <RumPerformance key={`perf-${activeOrg || 'default'}`} query={query} />
        )}
        {tab === 'sessions' && (
          <RumSessions key={`ses-${activeOrg || 'default'}`} query={query} />
        )}
        {tab === 'errors' && (
          <RumErrors key={`err-${activeOrg || 'default'}`} query={query} />
        )}
      </div>
    </div>
  );
}

/**
 * One filter dropdown.
 *
 * <p>The all-option is always present and always first: it is how a filter is
 * undone, and a picker with no way back to "everything" traps whoever used it.
 * Disabled when the stream offered nothing, which says "no values here" rather
 * than presenting an empty list as a broken control.</p>
 */
function Picker({ label, value, options, onChange }) {
  const empty = !options || options.length === 0;
  return (
    <label className={`rum-select-wrap ${empty ? 'is-disabled' : ''}`}>
      <span className="rum-select-label">{label}</span>
      <select
        className="rum-select"
        value={value}
        disabled={empty}
        aria-label={label}
        title={empty ? `No ${label.toLowerCase()} values reported in this window` : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value={ALL}>{ALL}</option>
        {(options || []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
Picker.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  options: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
};

RumView.propTypes = {
  /** Remounts the active panel on tenant change — RUM is read per organization. */
  activeOrg: PropTypes.string,
};
