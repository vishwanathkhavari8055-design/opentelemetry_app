import React from 'react';
import PropTypes from 'prop-types';
import NavIcon from './NavIcons';

/**
 * Left icon rail — the app's primary navigation.
 *
 * Replaces the horizontal TabBar as the top-level switcher: with the nav on the
 * left, every screen gets the full width of the viewport for its own toolbar
 * (the Logs screen in particular needs a wide toolbar row plus a field sidebar,
 * which a horizontal tab strip above it was eating into).
 *
 * Icon + label stacked per item, active item marked by an accent left bar and a
 * tinted background — colours all come from the existing token set
 * (--accent-color / --hover-bg / --text-secondary), no new palette.
 *
 * Selection state stays in App.jsx, same contract TabBar had, so switching the
 * nav shell did not move any state. The glyphs live in NavIcons so the screens
 * can echo their own rail icon in their header.
 */
const SideNav = ({ items, activeItem, onItemChange }) => (
  <nav className="side-nav" role="tablist" aria-label="Primary view" aria-orientation="vertical">
    {items.map((item) => {
      const isActive = item.key === activeItem;
      return (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={isActive}
          title={item.label}
          className={`side-nav-item ${isActive ? 'side-nav-item--active' : ''}`}
          onClick={() => onItemChange(item.key)}
        >
          <NavIcon name={item.icon} className="side-nav-icon" />
          <span className="side-nav-label">{item.label}</span>
        </button>
      );
    })}
  </nav>
);

SideNav.propTypes = {
  items: PropTypes.arrayOf(
    PropTypes.shape({
      key:   PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      /** Key into NAV_ICONS (see common/NavIcons.jsx). */
      icon:  PropTypes.string,
    }),
  ).isRequired,
  activeItem:   PropTypes.string.isRequired,
  onItemChange: PropTypes.func.isRequired,
};

export default SideNav;
