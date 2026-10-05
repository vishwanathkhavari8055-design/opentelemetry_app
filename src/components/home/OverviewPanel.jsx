import React from 'react';
import PropTypes from 'prop-types';

/**
 * The hero panel at the top of the Home screen: one titled panel holding a row
 * of large stat tiles, each with a labelled value and a tinted icon chip.
 *
 * Every number here is *derived*, not fetched — the four cards below the panel
 * already fetch /logs/summary, /traces/summary and /services/uptime, and they
 * hand their responses up via onData callbacks. Recomputing the tiles from that
 * data means the hero costs zero extra round-trips (and can never disagree with
 * the cards, which a parallel fetch of the same endpoints eventually would).
 *
 * Tiles show "—" until their donor card's response lands.
 */

const ICONS = {
  services: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  events: (
    <>
      <path d="M4 19V5" />
      <path d="M8 19v-7" />
      <path d="M12 19V8" />
      <path d="M16 19v-4" />
      <path d="M20 19v-9" />
    </>
  ),
  errors: (
    <>
      <path d="M10.3 4.3 2.6 17.6A1.5 1.5 0 0 0 3.9 20h16.2a1.5 1.5 0 0 0 1.3-2.4L13.7 4.3a1.5 1.5 0 0 0-2.6 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 17h.01" />
    </>
  ),
  traces: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8 7.5h6a2 2 0 0 1 2 2v6" />
    </>
  ),
  latency: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
};

const TileIcon = ({ name }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {ICONS[name]}
  </svg>
);

TileIcon.propTypes = { name: PropTypes.string.isRequired };

/** Compact ordinal formatting — 47.8M / 105.7K / 632 — like the reference UI. */
const formatCount = (n) => {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
};

const formatMs = (ms) => {
  if (ms == null) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
};

const OverviewPanel = ({ logsSummary, tracesSummary, uptime, windowLabel, onNavigate }) => {
  const severityCounts = logsSummary?.countsBySeverity || {};
  const errorTotal = logsSummary
    ? (severityCounts.ERROR ?? 0) + (severityCounts.FATAL ?? 0)
    : null;

  const uptimeItems = Array.isArray(uptime?.items) ? uptime.items : null;
  const servicesUp = uptimeItems
    ? uptimeItems.filter((it) => (it.status || 'DOWN') === 'UP').length
    : null;

  const tiles = [
    {
      key: 'services',
      label: 'Services',
      value: uptimeItems ? String(uptimeItems.length) : '—',
      // Sub-line carries the health split — the headline count alone would hide
      // a service that stopped heartbeating.
      detail: uptimeItems ? `${servicesUp} up · ${uptimeItems.length - servicesUp} down` : null,
      tone: uptimeItems && servicesUp < uptimeItems.length ? 'warn' : 'ok',
    },
    {
      key: 'events',
      label: 'Log Events',
      value: formatCount(logsSummary?.totalCount ?? null),
      detail: logsSummary ? windowLabel : null,
      tone: 'accent',
      target: 'logs',
    },
    {
      key: 'errors',
      label: 'Errors',
      value: formatCount(errorTotal),
      detail: logsSummary?.totalCount
        ? `${(((errorTotal || 0) / logsSummary.totalCount) * 100).toFixed(2)}% of events`
        : null,
      tone: errorTotal > 0 ? 'error' : 'ok',
      target: 'logs',
    },
    {
      key: 'traces',
      label: 'Traces',
      value: formatCount(tracesSummary?.traceCount ?? null),
      detail: tracesSummary
        ? `${((tracesSummary.errorRate ?? 0) * 100).toFixed(1)}% error rate`
        : null,
      tone: (tracesSummary?.errorRate ?? 0) > 0 ? 'warn' : 'ok',
      target: 'traces',
    },
    {
      key: 'latency',
      label: 'Avg Latency',
      value: formatMs(tracesSummary?.avgLatencyMs ?? null),
      detail: tracesSummary ? `p95 ${formatMs(tracesSummary.p95LatencyMs)}` : null,
      tone: 'accent',
      target: 'traces',
    },
  ];

  return (
    <section className="ov-panel">
      <header className="ov-panel-head">
        <span className="ov-panel-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 9v12" />
          </svg>
        </span>
        <h2 className="ov-panel-title">Overview</h2>
        <span className="ov-panel-window">{windowLabel}</span>
      </header>

      <div className="ov-tiles">
        {tiles.map((t) => {
          const clickable = !!(t.target && onNavigate);
          const Tag = clickable ? 'button' : 'div';
          return (
            <Tag
              key={t.key}
              type={clickable ? 'button' : undefined}
              className={`ov-tile ov-tile--${t.tone}${clickable ? ' ov-tile--clickable' : ''}`}
              onClick={clickable ? () => onNavigate(t.target) : undefined}
              title={clickable ? `Open ${t.target}` : undefined}
            >
              <span className="ov-tile-top">
                <span className="ov-tile-label">{t.label}</span>
                <span className="ov-tile-chip" aria-hidden="true">
                  <TileIcon name={t.key} />
                </span>
              </span>
              <span className="ov-tile-value">{t.value}</span>
              <span className="ov-tile-detail">{t.detail || ' '}</span>
            </Tag>
          );
        })}
      </div>
    </section>
  );
};

OverviewPanel.propTypes = {
  /** Raw /logs/summary response, or null until it arrives. */
  logsSummary:   PropTypes.object,
  /** Raw /traces/summary response, or null until it arrives. */
  tracesSummary: PropTypes.object,
  /** Raw /services/uptime response, or null until it arrives. */
  uptime:        PropTypes.object,
  windowLabel:   PropTypes.string.isRequired,
  /** Called with a nav key ('logs' | 'traces') when a tile is clicked. */
  onNavigate:    PropTypes.func,
};

export default OverviewPanel;
