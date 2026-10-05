import React from 'react';
import PropTypes from 'prop-types';

/**
 * This application's own dashboard toolbar.
 *
 * Time range, manual refresh and auto-refresh are driven from here, not from
 * Grafana's dashboard chrome — the user never sees a Grafana toolbar, and the
 * controls look and behave like the ones on Logs and Traces.
 *
 * The range control is deliberately TWO-WAY. Drag-to-zoom inside a panel writes
 * straight to the scene's SceneTimeRange, and the viewer feeds that change back
 * here so the picker reads "Custom range · …" with the real window instead of
 * still claiming "Last 6 hours" while showing four minutes of data.
 */

/** Presets, matching the windows the rest of the app offers. */
export const RANGE_OPTIONS = [
  { value: 'now-5m', label: 'Last 5 minutes' },
  { value: 'now-15m', label: 'Last 15 minutes' },
  { value: 'now-30m', label: 'Last 30 minutes' },
  { value: 'now-1h', label: 'Last 1 hour' },
  { value: 'now-3h', label: 'Last 3 hours' },
  { value: 'now-6h', label: 'Last 6 hours' },
  { value: 'now-12h', label: 'Last 12 hours' },
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-2d', label: 'Last 2 days' },
  { value: 'now-7d', label: 'Last 7 days' },
  { value: 'now-30d', label: 'Last 30 days' },
];

export const REFRESH_OPTIONS = [
  { value: '', label: 'Off' },
  { value: '10s', label: '10s' },
  { value: '30s', label: '30s' },
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
];

/** "30s" -> 30000. Anything unrecognised means "no auto-refresh". */
export function parseRefresh(value) {
  if (!value) return 0;
  const match = /^(\d+)([smh])$/.exec(String(value));
  if (!match) return 0;
  const amount = Number.parseInt(match[1], 10);
  if (match[2] === 's') return amount * 1000;
  if (match[2] === 'm') return amount * 60_000;
  if (match[2] === 'h') return amount * 3_600_000;
  return 0;
}

/** The preset this range corresponds to, or '' when it is a custom window. */
function presetOf(range) {
  if (range?.to !== 'now') return '';
  return RANGE_OPTIONS.some((option) => option.value === range.from) ? range.from : '';
}

/** Human label for a window the presets do not cover — a zoom, usually. */
function customLabel(range) {
  const format = (value) => {
    if (typeof value === 'string') return value;
    let date = null;
    if (value?.toDate) {
      date = value.toDate();
    } else if (value instanceof Date) {
      date = value;
    }
    return date ? date.toLocaleString() : String(value ?? '');
  };
  return `Custom · ${format(range?.from)} → ${format(range?.to)}`;
}

export default function DashboardToolbar({
  title, subtitle, breadcrumb,
  range, onRangeChange,
  autoRefresh, onAutoRefreshChange,
  onRefresh, refreshing,
  status, live, disabled,
  actions,
}) {
  const preset = presetOf(range);

  return (
    <header className="gd-toolbar">
      <div className="gd-toolbar-title">
        {breadcrumb}
        <h1 className="gd-toolbar-heading" title={title}>{title || 'Dashboard'}</h1>
        {subtitle && <span className="gd-toolbar-sub">{subtitle}</span>}
      </div>

      <div className="gd-toolbar-controls">
        {actions}

        <select
          className="ae-select gd-range"
          value={preset}
          disabled={disabled}
          aria-label="Time range"
          title="Time range"
          onChange={(e) => onRangeChange?.({ from: e.target.value, to: 'now' })}
        >
          {/* Only present while the window is a custom one, so the picker can
              show what is actually on screen instead of the nearest preset. */}
          {!preset && <option value="">{customLabel(range)}</option>}
          {RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>

        <select
          className="ae-select gd-refresh"
          value={autoRefresh ?? ''}
          disabled={disabled}
          aria-label="Auto-refresh interval"
          title="Auto-refresh interval"
          onChange={(e) => onAutoRefreshChange?.(e.target.value)}
        >
          {REFRESH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value ? `Auto ${option.label}` : 'Auto off'}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="results-bar-btn"
          onClick={onRefresh}
          disabled={disabled || refreshing}
          title="Refresh now"
          aria-label="Refresh now"
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            className={refreshing ? 'gd-spin' : undefined}
          >
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>

        {status && (
          <span className="gd-status" title={status}>
            <span className={`gd-dot${live ? ' is-live' : ''}`} aria-hidden="true" />
            {status}
          </span>
        )}
      </div>
    </header>
  );
}

DashboardToolbar.propTypes = {
  title: PropTypes.string,
  subtitle: PropTypes.string,
  /** Rendered above the heading — the Dashboards / folder trail. */
  breadcrumb: PropTypes.node,
  range: PropTypes.shape({ from: PropTypes.any, to: PropTypes.any }),
  onRangeChange: PropTypes.func,
  autoRefresh: PropTypes.string,
  onAutoRefreshChange: PropTypes.func,
  onRefresh: PropTypes.func,
  refreshing: PropTypes.bool,
  status: PropTypes.string,
  /** Lights the status dot: auto-refresh is on and the scene is rendered. */
  live: PropTypes.bool,
  disabled: PropTypes.bool,
  actions: PropTypes.node,
};
