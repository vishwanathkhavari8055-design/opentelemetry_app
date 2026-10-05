import React from 'react';
import PropTypes from 'prop-types';
import NavIcon from './NavIcons';

/**
 * Second-level navigation — the vertical list of screens inside one rail group.
 *
 * ─── Why a second column instead of a tab strip ─────────────────────────────
 *
 * Logs, Analytics, Traces and Metrics used to be four sibling entries on the
 * icon rail. They are not siblings of Alerts and Settings, though: they are four
 * readings of the SAME telemetry, and an operator moves between them constantly
 * while holding one question. Flattening them into the rail said the opposite —
 * that going from Logs to Traces was the same kind of move as going from Logs to
 * Settings.
 *
 * So they collapsed into one rail group, and this is what the group opens into.
 * A vertical column rather than a horizontal strip because the rail is already
 * vertical: the eye travels down the same axis to go one level deeper, and the
 * content column keeps its full height, which the Logs toolbar and field sidebar
 * both need.
 *
 * ─── Collapsed until pointed at ─────────────────────────────────────────────
 *
 * At rest this is a narrow strip of glyphs; hovering it (or tabbing into it)
 * slides the labels out over the content. All of that is CSS — see the
 * .section-nav rules in index.css — and deliberately so. A JS hover state would
 * mean a re-render on every pointer crossing of a control that sits between the
 * rail and everything else, and it would have to solve enter/leave races that
 * :hover already gets right for free.
 *
 * Two things the markup owes that arrangement.
 *
 * The `title` on every item. With the labels faded out at rest, the tooltip is
 * not a nicety for a truncated string any more — it is the only way to name a
 * glyph without moving the pointer onto the column, and someone who has not yet
 * learned the four icons needs it.
 *
 * And the label as its own element rather than a bare text node. The stylesheet
 * takes it out of the item's box and hangs it off the right-hand side, so the
 * clickable item can stay strip-width while the WORD extends over the content.
 * That is what stops this column from swallowing clicks aimed at the screen
 * behind it — the panel paints over a 126px band, and only the label of the item
 * actually being pointed at is a target within it. The full reasoning is in
 * index.css; what matters here is that nesting the label deeper, or dropping the
 * span, would quietly re-break it.
 *
 * ─── It renders labels, and only labels of what it was handed ───────────────
 *
 * No knowledge of which sections exist, which one is a placeholder, or who may
 * see them. App.jsx passes the list it has already filtered by permission, the
 * same contract SideNav has, so gating a section stays a property on one line of
 * the nav table rather than a condition in here.
 *
 * ─── Not a router ──────────────────────────────────────────────────────────
 *
 * `onSelect` gets the section key and nothing else. The keys are the SAME tab
 * keys the app has always used ('logs', 'analytics', 'traces', 'metrics'), which
 * is what let this column be added without touching a single existing navigation
 * call site — the alert drawer's "View traces" jump, the analytics count drill,
 * the summary card's service drill-through and the Home tiles all still pass the
 * strings they always passed.
 */
const SectionNav = ({ items, activeItem, label, onSelect }) => (
  <nav className="section-nav" aria-label={label}>
    <ul className="section-nav-list" role="tablist" aria-orientation="vertical">
      {items.map((item) => {
        const isActive = item.key === activeItem;
        return (
          <li key={item.key}>
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              // Load-bearing, not decoration: the label beside this glyph is
              // faded out until the column is hovered, so at rest this tooltip
              // is the only thing that names the icon. See the note above.
              title={item.label}
              className={`section-nav-item ${isActive ? 'is-active' : ''}`}
              onClick={() => onSelect(item.key)}
            >
              <NavIcon name={item.icon} size={16} className="section-nav-icon" />
              <span className="section-nav-label">{item.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  </nav>
);

SectionNav.propTypes = {
  /** Sections to offer, in display order. Already filtered by permission. */
  items: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      /** Key into NAV_ICONS (see common/NavIcons.jsx). */
      icon: PropTypes.string,
    }),
  ).isRequired,
  /** Key of the section currently on screen. */
  activeItem: PropTypes.string.isRequired,
  /** Accessible name for the column, e.g. "Logs sections". */
  label: PropTypes.string.isRequired,
  /** (key) — the caller sets the tab. */
  onSelect: PropTypes.func.isRequired,
};

export default SectionNav;
