/**
 * How coarse a Prometheus query's step is allowed to get.
 *
 * Its own module, with no @grafana imports, for two reasons: ./buildScene.js and
 * ./queryRunner.js both need it and neither should own it, and a rule this easy
 * to get subtly wrong deserves a test that runs without a DOM.
 */

/**
 * Grafana's OWN default minimum step for a Prometheus datasource, and the floor
 * this application applies on a SHORT range.
 *
 * Grafana's Prometheus plugin reads it from the datasource's "Scrape interval"
 * (`jsonData.timeInterval`) and falls back to this when it is not set —
 * `this.interval = instanceSettings.jsonData.timeInterval || '15s'`. Every
 * Prometheus query Grafana sends is floored by it.
 *
 * This application cannot read `timeInterval`: its datasource catalog is
 * `{ uid, name, type }` and nothing more, deliberately (see ./datasources.js).
 * So it applies the same fallback — and it is NOT cosmetic.
 *
 * Without a floor the step is whatever the panel's WIDTH implies, and on a short
 * time range that goes below a second: a 5-minute range in a quarter-width panel
 * works out at 500ms. This datasource answers such a query with
 *
 *     400 bad_data: Invalid time format: .
 *
 * so the panel does not render a coarse graph — it renders an ERROR, while the
 * same panel in Grafana is fine because Grafana floored the step at 15s. Every
 * sub-second step is rejected, and every fractional-second one (1.5s and up
 * included); only whole seconds are accepted.
 */
export const PROM_DEFAULT_MIN_INTERVAL = '15s';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The floor, widened for wider windows.
 *
 * 15s is exactly right on a short range and the most expensive thing this
 * datasource can be asked for on a long one. The step follows panel WIDTH (see
 * `maxDataPointsFromWidth` in ./buildScene.js), so a full-width panel over six
 * hours asks for ~1440 evaluation steps to draw ~1900 pixels of line. Measured
 * against the live backend, the same query over the same window returning the
 * same ~280 bytes of data:
 *
 *      15s step -> 1440 steps -> 12.4s
 *      60s step ->  360 steps ->  3.9s
 *     300s step ->   72 steps ->  2.8s
 *
 * Nothing about the picture needs that many points, so the floor rises with the
 * range. It only ever RAISES a step, and only where the width-derived one is
 * finer — see pickMinInterval().
 *
 * The first tier is Grafana's own 15s, unchanged, so a short zoomed-in window is
 * byte-for-byte what it is today. That case is real and has to keep working:
 * zooming into fifteen minutes is how an incident gets looked at.
 *
 * Tiers are read in order; the first whose `maxRangeMs` the window does not
 * exceed wins.
 */
export const PROM_MIN_INTERVAL_TIERS = Object.freeze([
  Object.freeze({ maxRangeMs: 1 * HOUR_MS, minInterval: PROM_DEFAULT_MIN_INTERVAL }),
  Object.freeze({ maxRangeMs: 6 * HOUR_MS, minInterval: '60s' }),
  Object.freeze({ maxRangeMs: Infinity, minInterval: '300s' }),
]);

/**
 * The floor for a window of `rangeMs`.
 *
 * Rounded to the nearest second before it is compared, and that is not
 * decoration. Grafana resolves `now-1h` → `now` INCLUSIVELY, so the range it
 * hands a query is 3600001ms — one millisecond past the hour. Compared exactly,
 * every "Last 1 hour" in the toolbar would fall through to the next tier and
 * quietly lose the resolution it has always had, which is the one regression
 * this tiering must not cause. Rounding also absorbs the sub-second jitter of an
 * absolute range dragged out on a graph.
 *
 * Widest tier for anything past the table, and for a range that is missing,
 * negative or not a number — a bad range must not silently become a 15s step
 * over a year, which is the one combination that can hang the datasource.
 */
export function pickMinInterval(rangeMs, tiers = PROM_MIN_INTERVAL_TIERS) {
  const widest = tiers.at(-1);
  if (!Number.isFinite(rangeMs) || rangeMs < 0) return widest.minInterval;
  const whole = Math.round(rangeMs / 1000) * 1000;
  return (tiers.find((tier) => whole <= tier.maxRangeMs) ?? widest).minInterval;
}
