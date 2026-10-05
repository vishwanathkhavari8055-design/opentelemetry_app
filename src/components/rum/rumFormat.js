/**
 * Formatting shared by the RUM tabs.
 *
 * One module rather than a helper per tab: Performance, Sessions and Error Tracking
 * all print durations and counts, and two copies of a millisecond formatter is how
 * "1.8s" on one tab becomes "1820ms" on another for the same measurement.
 *
 * ─── The unit contract ──────────────────────────────────────────────────────
 *
 * Everything the backend sends as a duration is ALREADY in milliseconds. The RUM
 * SDK writes nanoseconds; that conversion happens server-side, once, so nothing
 * here divides by 1e6. A vital whose `unit` is `score` (Cumulative Layout Shift) is
 * not a duration at all and must never reach formatMs.
 */

/** Compact counts. Zero stays "0" rather than a dash — on an error screen, zero
 *  errors is a result worth stating plainly. */
export function formatCount(value) {
  const n = Number(value) || 0;
  if (n === 0) return '0';
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/**
 * A duration in ms, rendered at the scale an operator reads it at.
 *
 * Core Web Vitals are quoted in seconds once they pass a second (LCP "1.05s") and
 * in milliseconds below it (INP "47.77ms"), which is how every published threshold
 * is written. Sub-millisecond values keep two decimals rather than rounding to
 * "0ms", which would report a fast interaction as an instantaneous one.
 */
export function formatMs(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const ms = Number(value);
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  return `${ms.toFixed(2)}ms`;
}

/** A session length, which is read as a clock span rather than a latency. */
export function formatDuration(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const total = Math.max(Math.round(Number(ms) / 1000), 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * One vital's value, formatted by its own declared unit.
 *
 * Driven by `unit` from the payload rather than by the metric's name, so adding a
 * vital server-side needs no change here — and so CLS cannot accidentally be
 * printed as a duration, which would report a layout-shift score of 0.08 as "0.08ms"
 * and make a failing page look excellent.
 */
export function formatVital(vital) {
  if (vital?.value == null) return '—';
  if (vital.unit === 'score') return Number(vital.value).toFixed(2);
  if (vital.unit === 's') return `${Number(vital.value).toFixed(2)}s`;
  return formatMs(vital.value);
}

/** A percentage that is allowed to be absent. `0%` and "not measured" are different
 *  answers: a crash-free rate of 0 means every session broke. */
export function formatPct(value, digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}%`;
}

/** Relative time, for "first/last seen". Absolute timestamps go in the title. */
export function formatAgo(iso) {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const secs = Math.max(Math.round((Date.now() - then) / 1000), 0);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

/** The absolute instant, for a tooltip. A dashboard timestamp gets pasted into a
 *  ticket, and "35 minutes ago" is not something anybody can correlate against. */
export function formatAbsolute(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? String(iso) : new Date(t).toLocaleString();
}

/**
 * A URL trimmed to what distinguishes it.
 *
 * The API table groups by full URL, and a column of identical
 * "http://host:4200/..." prefixes is a column that cannot be scanned. The origin
 * stays in the tooltip because two same-path endpoints on different hosts are two
 * different endpoints.
 */
export function shortenUrl(url) {
  if (!url) return '—';
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || u.host;
  } catch {
    return String(url);
  }
}

/** The windows the picker offers. Values are the backend's relative expressions,
 *  parsed there by TimeRangeParser — the same grammar every other screen uses. */
export const RUM_WINDOWS = [
  { value: 'now-15m', label: 'Past 15 Minutes' },
  { value: 'now-1h', label: 'Past 1 Hour' },
  { value: 'now-6h', label: 'Past 6 Hours' },
  { value: 'now-12h', label: 'Past 12 Hours' },
  { value: 'now-24h', label: 'Past 24 Hours' },
  { value: 'now-7d', label: 'Past 7 Days' },
];

/** Auto-refresh choices, in seconds. 0 is Off and is the default — RUM queries
 *  scan a whole stream, and a screen left open on a 10s poll is a standing load
 *  on OpenObserve that nobody asked for. */
export const RUM_REFRESH = [
  { value: 0, label: 'Off' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 300, label: '5m' },
];
