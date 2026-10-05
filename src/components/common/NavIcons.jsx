import React from 'react';
import PropTypes from 'prop-types';

/**
 * The nav icon set, shared by the left rail (SideNav) and by the screens that
 * echo their own rail icon in their header (PlaceholderView).
 *
 * Inline SVG rather than an icon dependency: this bundle ships as a Web
 * Component into host apps, so every avoided runtime dep is one less thing the
 * host has to resolve. Each entry is stroke-only path content on a 24-unit
 * viewBox, so it inherits `currentColor` and works at any size.
 */
export const NAV_ICONS = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  // Product Catalog — a bound register of entries, as distinct from the grid of
  // panels `dashboards` uses and the document outline `reports` uses.
  catalog: (
    <>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M4 16.5A1.5 1.5 0 0 1 5.5 15H20" />
      <path d="M8 7h8" />
      <path d="M8 10.5h5" />
    </>
  ),
  logs: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </>
  ),
  metrics: (
    <>
      <path d="M4 20V9" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M21 20H3" />
    </>
  ),
  traces: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M8.5 18h7" />
      <path d="M8 7.5h6a2 2 0 0 1 2 2v6" />
    </>
  ),
  // Real User Monitoring — a browser/device outline, as in the reference rail.
  rum: (
    <>
      <rect x="2.5" y="6" width="13" height="9" rx="1.5" />
      <path d="M2.5 18h13" />
      <rect x="17.5" y="9.5" width="4" height="8.5" rx="1" />
    </>
  ),
  pipelines: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="m8.2 10.9 7.6-3.8" />
      <path d="m8.2 13.1 7.6 3.8" />
    </>
  ),
  // AIOps — an inference chip: the rail's only glyph about a machine reading the
  // telemetry rather than a shape of the telemetry itself. Chip body with its
  // pins, sparked in the middle; deliberately not another chart or graph outline,
  // which is what every neighbouring entry already is.
  aiops: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
      <path d="M9.5 3.5V6M14.5 3.5V6M9.5 18v2.5M14.5 18v2.5M3.5 9.5H6M3.5 14.5H6M18 9.5h2.5M18 14.5h2.5" />
      <path d="M12 8.8l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9Z" />
    </>
  ),
  dashboards: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1" />
    </>
  ),
  streams: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 9v12" />
    </>
  ),
  reports: (
    <>
      <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
      <path d="M8.5 13h7" />
      <path d="M8.5 17h4.5" />
    </>
  ),
  alerts: (
    <>
      <path d="M10.3 4.3 2.6 17.6A1.5 1.5 0 0 0 3.9 20h16.2a1.5 1.5 0 0 0 1.3-2.4L13.7 4.3a1.5 1.5 0 0 0-2.6 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 17h.01" />
    </>
  ),
  // Data sources — the funnel from the reference rail.
  datasources: (
    <path d="M3.5 4.5h17L13.5 13v7l-3-2v-5Z" />
  ),
  iam: (
    <>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M3.5 20c0-3.3 2.9-5.5 6.5-5.5 1 0 2 .2 2.8.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
      <path d="M17.5 13.5v1M17.5 20.5v1M13.9 15.4l.9.5M20.2 19.1l.9.5M13.9 19.6l.9-.5M20.2 15.9l.9-.5" />
    </>
  ),
  functions: (
    <>
      <path d="M14 5.5c0-1.4-1-2.5-2.4-2.5-1.3 0-2.3 1-2.4 2.3L8.5 19c-.1 1.3-1.1 2.3-2.4 2.3" />
      <path d="M7.5 9.5h8" />
    </>
  ),
};

export default function NavIcon({ name, size = 20, className }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {NAV_ICONS[name] || NAV_ICONS.home}
    </svg>
  );
}

NavIcon.propTypes = {
  /** Key into NAV_ICONS. Falls back to the home glyph for an unknown name. */
  name: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
};
