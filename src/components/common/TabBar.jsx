import React from 'react';
import PropTypes from 'prop-types';

/**
 * Top-level navigation strip. Two tabs (Logs / Summary) — when only two are
 * present the visual is more "segmented control" than "browser tabs",
 * matching how this UI is meant to be embedded as a Web Component inside
 * larger host apps that already provide their own primary nav.
 *
 * Selection state lives in App.jsx (the parent), so this component stays
 * stateless — handy because the Logs tab is allowed to navigate to the
 * trace drill-down without dropping the top-nav state.
 *
 * `trailing` is an optional slot pinned to the right end of the strip, for
 * controls that belong to the whole app rather than to one tab (today: the
 * account chip on the Dashboard tab, where the app top bar is hidden). When
 * omitted the markup is exactly the flat tablist it has always been.
 */
const TabBar = ({ tabs, activeTab, onTabChange, trailing }) => {
  const tabButtons = tabs.map((t) => {
    const isActive = t.key === activeTab;
    return (
      <button
        key={t.key}
        role="tab"
        aria-selected={isActive}
        className={`top-tab-btn ${isActive ? 'top-tab-btn--active' : ''}`}
        onClick={() => onTabChange(t.key)}
      >
        {t.label}
      </button>
    );
  });

  // Without a trailing slot, keep the original single-element structure.
  if (!trailing) {
    return (
      <nav className="top-tab-bar" role="tablist" aria-label="Primary view">
        {tabButtons}
      </nav>
    );
  }

  // With one, the tablist moves to an inner wrapper so the extra controls are
  // not exposed as tabs to assistive tech.
  return (
    <nav className="top-tab-bar" aria-label="Primary view">
      <div className="top-tab-list" role="tablist" aria-label="Primary view">
        {tabButtons}
      </div>
      <div className="top-tab-trailing">{trailing}</div>
    </nav>
  );
};

TabBar.propTypes = {
  tabs: PropTypes.arrayOf(
    PropTypes.shape({
      key:   PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
    })
  ).isRequired,
  activeTab:   PropTypes.string.isRequired,
  onTabChange: PropTypes.func.isRequired,
  /** Optional controls pinned to the right end of the strip. */
  trailing:    PropTypes.node,
};

export default TabBar;
