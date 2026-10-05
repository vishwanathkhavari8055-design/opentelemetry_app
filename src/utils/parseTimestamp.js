/**
 * Parse a timestamp into milliseconds-since-epoch.
 *
 * Accepts the three shapes the lib + OpenObserve emit:
 *   - ISO 8601 string (`"2026-05-07T09:06:30.495821Z"`)
 *   - Numeric milliseconds (`1746611400000`)
 *   - Numeric microseconds (`1746611400000000`) — used by OpenObserve's
 *     `_timestamp`. Detected via the `> 1e14` threshold and divided by 1000.
 *
 * Returns `null` for unparseable / nullish input. Centralized here so the
 * waterfall, the tree's sibling-sort, and any future caller agree on the
 * same parsing rules — previously this was duplicated in TraceView and
 * TraceWaterfall and prone to drift.
 */
export const parseTimestampMs = (ts) => {
  if (ts == null) return null;
  const s = String(ts);
  if (s.includes('T')) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  let v = Number(s);
  if (Number.isNaN(v)) return null;
  if (v > 1e14) v = v / 1000;
  return v;
};
