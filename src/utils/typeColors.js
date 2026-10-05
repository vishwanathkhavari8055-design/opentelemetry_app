/**
 * Canonical span-type → CSS-colour map. Single source of truth for the
 * waterfall bars, summary chips, type badges, and inspector dots.
 *
 * Keys are uppercase to match `inferEffectiveType` output. Unknown types
 * fall through to {@link getTypeColor}'s grey fallback.
 *
 * Palette rationale:
 *   HTTP                 — blue (network/transport)
 *   MONGODB              — green (brand-adjacent)
 *   NEO4J                — cyan
 *   SQL / DATABASE / REDIS — warm hues (visually grouped as "data store"),
 *                            distinct from each other so SQL is not confused
 *                            with Redis at a glance. SQL covers every SQL
 *                            flavour because the classifier routes by leading
 *                            keyword (SELECT/INSERT/…) rather than vendor.
 *   INTERNAL             — purple (app code / non-IO work)
 *   LOG                  — grey (informational, low contrast on purpose)
 *   EXTERNAL             — teal (third-party callouts)
 *   THREAD / EXECUTION   — lavender (synthetic wrappers from logs-by-span)
 */
export const TYPE_COLORS = {
  HTTP:      '#388bfd',
  MONGODB:   '#3fb950',
  NEO4J:     '#22d3ee',
  SQL:       '#f78166',
  DATABASE:  '#d29922',
  REDIS:     '#dc382d',
  INTERNAL:  '#8957e5',
  LOG:       '#6e7681',
  EXTERNAL:  '#39c5bb',
  THREAD:    '#d2a8ff',
  EXECUTION: '#a371f7',
};

const FALLBACK = '#6e7681';

export const getTypeColor = (type) => {
  const t = String(type || '').toUpperCase();
  return TYPE_COLORS[t] || FALLBACK;
};
