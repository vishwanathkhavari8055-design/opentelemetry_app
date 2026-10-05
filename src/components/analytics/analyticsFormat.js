/**
 * Formatting shared by the Analytics faces.
 *
 * ─── Why this is a module and not a helper in each view ─────────────────────
 *
 * The Drill Table and the Category Board show the SAME numbers in two layouts, and
 * the whole point of the flip is that you can compare what you saw on one face with
 * what you see on the other. Two copies of `formatCount` is how "1.4M" on one face
 * becomes "1.38M" on the other and an operator starts wondering which is right.
 * One implementation makes that class of disagreement unavailable.
 */

/** The severity buckets the backend reports, in the order they are always shown.
 *
 *  Exported as data rather than repeated as JSX so the header, the cells and the
 *  legend cannot drift into different orders — a column labelled Error above a
 *  column of debug counts is worse than no column at all.
 *
 *  `key` matches the field on an AnalyticsResponseDTO.Row exactly. */
export const SEVERITY_BUCKETS = [
  { key: 'info', label: 'Info', tone: 'info' },
  { key: 'warn', label: 'Warn', tone: 'warn' },
  { key: 'error', label: 'Error', tone: 'error' },
  { key: 'debug', label: 'Debug', tone: 'debug' },
  { key: 'other', label: 'Other', tone: 'other' },
];

/**
 * Compact counts, because these reach seven figures and a column of raw digits
 * cannot be compared at a glance. Zero stays "0" rather than becoming a dash: on a
 * volume dashboard, zero errors is a result worth stating.
 */
export function formatCount(value) {
  const n = Number(value) || 0;
  if (n === 0) return '0';
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** The exact figure, for a tooltip. A dashboard number gets pasted into tickets,
 *  and "1.4M" is not a figure anybody can act on. */
export function exactCount(value) {
  return (Number(value) || 0).toLocaleString();
}

/**
 * A row's severity split as percentages of its own total, for the stacked bar.
 *
 * ─── Measured against `total`, never against the sum of the buckets ─────────
 *
 * Total is every log line and the five buckets are what we can name of it, so they
 * already reconcile — `other` IS the remainder. Re-normalising against their sum
 * would make a row that is 95% unspecified look like a clean info/error mix, which
 * is precisely the impression this bar exists to prevent.
 *
 * Returns an empty array for a silent row rather than five zero-width segments, so
 * the caller can render "no logs in range" instead of an empty bar that reads as a
 * rendering failure.
 */
export function severityMix(row) {
  const total = Number(row?.total) || 0;
  if (total <= 0) return [];
  return SEVERITY_BUCKETS
    .map((bucket) => ({
      ...bucket,
      count: Number(row?.[bucket.key]) || 0,
      pct: ((Number(row?.[bucket.key]) || 0) / total) * 100,
    }))
    .filter((segment) => segment.count > 0);
}

/**
 * Share of a scope, as a whole-number percent string.
 *
 * <p>Sub-1% is reported as "&lt;1%" rather than rounded to "0%": a category with
 * four thousand errors out of a million lines is not zero, and a board that says 0%
 * next to a non-zero count reads as broken.</p>
 */
export function formatShare(part, whole) {
  const p = Number(part) || 0;
  const w = Number(whole) || 0;
  if (w <= 0 || p <= 0) return '0%';
  const pct = (p / w) * 100;
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}
