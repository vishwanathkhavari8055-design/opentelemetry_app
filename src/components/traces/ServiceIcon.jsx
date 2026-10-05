import React from 'react';
import PropTypes from 'prop-types';

/**
 * Small coloured glyph in front of a service name, as in the reference UI.
 *
 * The colour is DERIVED from the service name rather than assigned from a
 * rotating counter, so a given service is the same colour in the Spans table,
 * the Traces table, the Service Catalog and the Service Latency bar — and
 * stays that colour across pages, filters and reloads. A counter-based palette
 * would recolour everything the moment a filter changed the row order, which
 * defeats the point of colour-coding at all.
 */

/** Hues picked to stay distinguishable on a dark background. */
const PALETTE = [
  '#4dabf7', '#38d9a9', '#ffa94d', '#f783ac', '#9775fa',
  '#63e6be', '#ffd43b', '#ff8787', '#748ffc', '#a9e34b',
  '#66d9e8', '#e599f7',
];

/** FNV-1a — small, stable, and spreads similar names apart. */
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.codePointAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h);
};

export const colorForService = (name) => {
  if (!name) return 'var(--text-secondary)';
  return PALETTE[hash(String(name)) % PALETTE.length];
};

export function ServiceIcon({ name }) {
  const color = colorForService(name);
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  return (
    <span
      className="tt-svc-icon"
      style={{ borderColor: color, color }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

ServiceIcon.propTypes = {
  name: PropTypes.string,
};

export default ServiceIcon;
