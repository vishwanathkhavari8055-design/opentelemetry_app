import React from 'react';
import PropTypes from 'prop-types';
import NavIcon from '../common/NavIcons';
import { formatCount } from './StreamsPanel';

/**
 * The three cards on the Home grid below the Streams panel, laid out as
 * OpenObserve's own Home:
 *
 *   HomeResourcesCard — Functions / Dashboards counts, then an "Explore" list
 *                       of shortcuts into this app's screens.
 *   HomeSplitCard     — a Scheduled / Real time pair above a healthy / failed /
 *                       warning bar chart (Alerts, Pipelines).
 *
 * Every row and arrow that navigates does so only when given somewhere to go:
 * Functions and Pipelines have no screen in this app, and a chevron that leads
 * nowhere is worse than none.
 *
 * A null count shows "—" rather than 0 — see the note in StreamsPanel.
 */

const LOCAL_ICONS = {
  alerts: (
    <>
      <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6L12 3Z" />
      <path d="M12 8.5v4" />
      <path d="M12 15.5h.01" />
    </>
  ),
  pipelines: (
    <>
      <rect x="9" y="3" width="6" height="5" rx="1" />
      <rect x="3" y="16" width="6" height="5" rx="1" />
      <rect x="15" y="16" width="6" height="5" rx="1" />
      <path d="M12 8v4M6 16v-4h12v4" />
    </>
  ),
  // Log Analytics has no rail icon of its own (it borrows the dashboards glyph
  // inside the Logs group), and next to the real Dashboards row that would read
  // as a duplicate — so it gets a trend-over-bars mark here.
  analytics: (
    <>
      <path d="M4 20h16" />
      <path d="M7 16v-3M12 16v-6M17 16V8" />
      <path d="m5 10 5-4 4 3 5-5" />
    </>
  ),
};

const Glyph = ({ name, size = 18 }) => (LOCAL_ICONS[name] ? (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {LOCAL_ICONS[name]}
  </svg>
) : <NavIcon name={name} size={size} />);

Glyph.propTypes = { name: PropTypes.string.isRequired, size: PropTypes.number };

const Chevron = () => (
  <svg className="home-res-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const PanelHeader = ({ title, icon, tone, loading, onOpen }) => (
  <header className="ov-panel-head home-panel-head">
    <span className={`ov-panel-icon ov-panel-icon--${tone}`} aria-hidden="true">
      <Glyph name={icon} />
    </span>
    <h2 className="ov-panel-title">{title}</h2>
    {loading && <span className="home-panel-spinner" aria-label="Loading" />}
    {onOpen && (
      <button
        type="button"
        className="home-panel-open"
        onClick={onOpen}
        title={`Open ${title}`}
        aria-label={`Open ${title}`}
      >
        →
      </button>
    )}
  </header>
);

PanelHeader.propTypes = {
  title:   PropTypes.string.isRequired,
  icon:    PropTypes.string.isRequired,
  tone:    PropTypes.string,
  loading: PropTypes.bool,
  onOpen:  PropTypes.func,
};

/**
 * One row of the Resources card. A button when it has a destination, a plain
 * row otherwise — so keyboard focus only ever lands on something that acts.
 */
const ResourceRow = ({ label, icon, tone = 'accent', value, showValue, onOpen }) => {
  const Tag = onOpen ? 'button' : 'div';
  return (
    <Tag
      type={onOpen ? 'button' : undefined}
      className={`home-res-row${onOpen ? ' home-res-row--link' : ''}`}
      onClick={onOpen}
      title={onOpen ? `Open ${label}` : undefined}
    >
      <span className={`home-res-icon home-res-icon--${tone}`} aria-hidden="true">
        <Glyph name={icon} size={16} />
      </span>
      <span className="home-res-label">{label}</span>
      {showValue && <span className="home-res-value">{formatCount(value)}</span>}
      {onOpen ? <Chevron /> : <span className="home-res-chevron-spacer" aria-hidden="true" />}
    </Tag>
  );
};

ResourceRow.propTypes = {
  label:     PropTypes.string.isRequired,
  icon:      PropTypes.string.isRequired,
  tone:      PropTypes.string,
  value:     PropTypes.number,
  showValue: PropTypes.bool,
  onOpen:    PropTypes.func,
};

export function HomeResourcesCard({ counts, explore, loading }) {
  return (
    <section className="home-card home-res-card">
      <header className="home-res-head">
        <h2 className="ov-panel-title">Resources</h2>
        {loading && <span className="home-panel-spinner" aria-label="Loading" />}
      </header>

      <div className="home-res-list">
        {counts.map(({ key, ...row }) => (
          <ResourceRow key={key} {...row} showValue />
        ))}
      </div>

      {explore.length > 0 && (
        <>
          <hr className="home-res-divider" />
          <span className="home-res-section">Explore</span>
          <div className="home-res-list">
            {explore.map(({ key, ...row }) => (
              <ResourceRow key={key} {...row} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

const rowShape = PropTypes.shape({
  key:    PropTypes.string.isRequired,
  label:  PropTypes.string.isRequired,
  icon:   PropTypes.string.isRequired,
  tone:   PropTypes.string,
  value:  PropTypes.number,
  onOpen: PropTypes.func,
});

HomeResourcesCard.propTypes = {
  /** Rows with a count on the right (Functions, Dashboards). */
  counts:  PropTypes.arrayOf(rowShape).isRequired,
  /** Shortcut rows into the app's screens. */
  explore: PropTypes.arrayOf(rowShape).isRequired,
  loading: PropTypes.bool,
};

const HEALTH_BARS = [
  { key: 'healthy', label: 'Healthy', tone: 'ok'    },
  { key: 'failed',  label: 'Failed',  tone: 'error' },
  { key: 'warning', label: 'Warning', tone: 'warn'  },
];

/**
 * Healthy / failed / warning trigger counts as three bars. Heights are relative
 * to the largest bar; a non-zero value never drops below a sliver, so a 1
 * beside a 900 is still visibly there.
 */
const HealthChart = ({ health, noun }) => {
  const max = Math.max(1, ...HEALTH_BARS.map((b) => health[b.key] ?? 0));
  const summary = HEALTH_BARS
    .map((b) => `${b.label} ${health[b.key] == null ? 'unknown' : health[b.key]}`)
    .join(', ');

  return (
    <figure className="home-health" aria-label={`${noun} trigger status: ${summary}`}>
      <div className="home-health-plot">
        {HEALTH_BARS.map((b) => {
          const v = health[b.key];
          const pct = v ? Math.max(2, (v / max) * 100) : 0;
          return (
            <div className="home-health-col" key={b.key}>
              <span className="home-health-value">{formatCount(v)}</span>
              <span
                className={`home-health-bar home-health-bar--${b.tone}`}
                style={{ height: `${pct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="home-health-axis" aria-hidden="true">
        {HEALTH_BARS.map((b) => (
          <span className="home-health-label" key={b.key}>{b.label}</span>
        ))}
      </div>
      <figcaption className="home-health-caption" aria-hidden="true">Trigger status</figcaption>
    </figure>
  );
};

HealthChart.propTypes = {
  health: PropTypes.shape({
    healthy: PropTypes.number,
    failed:  PropTypes.number,
    warning: PropTypes.number,
  }).isRequired,
  noun: PropTypes.string.isRequired,
};

export function HomeSplitCard({
  title, icon, tone = 'accent', scheduled, realTime, health, loading, onOpen,
}) {
  // Matches OpenObserve: an all-zero (or unreadable) trigger status is "No data
  // available", not three empty bars that read like a broken chart.
  const hasHealth = !!health && HEALTH_BARS.some((b) => (health[b.key] ?? 0) > 0);

  return (
    <section className="home-card">
      <PanelHeader title={title} icon={icon} tone={tone} loading={loading} onOpen={onOpen} />

      <div className="home-split">
        <div className="home-split-stat">
          <span className="home-split-label">Scheduled</span>
          <span className="home-split-value">{formatCount(scheduled)}</span>
        </div>
        <div className="home-split-stat">
          <span className="home-split-label">Real time</span>
          <span className="home-split-value">{formatCount(realTime)}</span>
        </div>
      </div>

      <div className="home-card-body">
        {hasHealth
          ? <HealthChart health={health} noun={title} />
          : <span className="home-card-nodata">No data available</span>}
      </div>
    </section>
  );
}

HomeSplitCard.propTypes = {
  title:     PropTypes.string.isRequired,
  icon:      PropTypes.string.isRequired,
  tone:      PropTypes.string,
  scheduled: PropTypes.number,
  realTime:  PropTypes.number,
  health:    PropTypes.shape({
    healthy: PropTypes.number,
    failed:  PropTypes.number,
    warning: PropTypes.number,
  }),
  loading:   PropTypes.bool,
  onOpen:    PropTypes.func,
};
