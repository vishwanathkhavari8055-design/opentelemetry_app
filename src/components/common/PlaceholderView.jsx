import React from 'react';
import PropTypes from 'prop-types';
import NavIcon from './NavIcons';

/**
 * Screen shown for a nav entry that exists in the rail but has no data source
 * behind it yet (RUM, Pipelines, Streams, Reports, Alerts, Data sources, IAM).
 *
 * These are OpenObserve features; the observability lib this UI talks to exposes
 * nothing for them, and the UI is not allowed to query OpenObserve directly (see
 * the contract at the top of services/api.js). Rather than route to a blank
 * panel, each states what it will show and exactly what it is waiting on — so
 * the rail is the full 12-item replica without any entry silently dead-ending.
 */
const PlaceholderView = ({ title, icon, summary, willShow, needs }) => (
  <section className="ph-view">
    <div className="ph-head">
      <span className="ov-panel-icon" aria-hidden="true">
        <NavIcon name={icon} size={18} />
      </span>
      <h1 className="page-heading">{title}</h1>
      <span className="ph-badge">Not wired up</span>
    </div>

    <p className="ph-summary">{summary}</p>

    <div className="ph-grid">
      {willShow?.length > 0 && (
        <section className="home-card ph-card">
          <header className="ov-panel-head home-panel-head">
            <h2 className="ov-panel-title">What this screen will show</h2>
          </header>
          <ul className="ph-list">
            {willShow.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </section>
      )}

      {needs?.length > 0 && (
        <section className="home-card ph-card">
          <header className="ov-panel-head home-panel-head">
            <h2 className="ov-panel-title">What it needs first</h2>
          </header>
          <ul className="ph-list ph-list--needs">
            {needs.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </section>
      )}
    </div>
  </section>
);

PlaceholderView.propTypes = {
  title:    PropTypes.string.isRequired,
  /** Key into NAV_ICONS — echoes the rail glyph so the screen is identifiable. */
  icon:     PropTypes.string.isRequired,
  summary:  PropTypes.string.isRequired,
  willShow: PropTypes.arrayOf(PropTypes.string),
  needs:    PropTypes.arrayOf(PropTypes.string),
};

export default PlaceholderView;
