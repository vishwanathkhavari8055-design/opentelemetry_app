/**
 * Display formatting shared by the traces screens.
 */

/**
 * Microseconds → the unit ladder OpenObserve uses: `26.00us`, `1.41ms`,
 * `5.13s`, `1.14m`.
 *
 * The traces stream stores `duration` in MICROSECONDS. This is easy to get
 * wrong because OpenObserve's own tooltip labels the raw value "ns" while
 * rendering it as microseconds — a span whose stored duration is 5,261,305
 * shows as "5.26s", which is only true if the unit is µs. The backend keeps
 * every latency in µs and names those fields `…Us`; this is the only place
 * that turns them into text.
 */
export const formatDurationUs = (us) => {
  if (us == null || !Number.isFinite(Number(us))) return '—';
  const v = Number(us);
  if (v === 0) return '0.00ns';
  if (v < 1000) return `${v.toFixed(2)}us`;
  const ms = v / 1000;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  return `${(s / 60).toFixed(2)}m`;
};

/**
 * Compact counts: `966`, `15.0K`, `1.4M`. Values below 1000 are shown exactly,
 * because "1.0K requests" reads as a rounded estimate when the real number is
 * 966 and precision still matters at that scale.
 */
export const formatCount = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
};

/** Fraction (0–1) → `19.46%`. */
export const formatPercent = (fraction) => {
  if (fraction == null || !Number.isFinite(Number(fraction))) return '—';
  return `${(Number(fraction) * 100).toFixed(2)}%`;
};

/** Exact integer with thousands separators, for tooltips and totals. */
export const formatExact = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString();
};
