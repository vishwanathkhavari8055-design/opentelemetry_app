// ---------------------------------------------------------------------------
// Variable interpolation for panel queries.
//
// In real Grafana, interpolation happens inside each datasource plugin's
// applyTemplateVariables(), which core's runRequest calls. Scenes deliberately
// does NOT do it: SceneQueryRunner.prepareRequests() clones the raw targets and
// hands them straight to the datasource. In a standalone app with a proxy
// datasource that means a query written as
//
//     node_cpu_seconds_total{host="$host"}
//
// would reach Prometheus with the literal string "$host" in it and quietly
// return nothing at all — the single most confusing failure mode in this whole
// stack, because the panel looks fine and simply has no data.
//
// So this subclass interpolates at request time, in the browser, right before
// the request leaves for the BFF:
//
//   * State keeps the RAW queries. That matters: SceneQueryRunner's
//     VariableDependencyConfig watches the `queries` state path for `$name`
//     references, and that is what makes a panel re-query automatically when
//     the user picks a different variable value. Interpolating into state would
//     erase the dependency and freeze the panel on its first value.
//   * `$__interval` / `$__interval_ms` resolve correctly, because we interpolate
//     AFTER super.prepareRequests() has computed them into request.scopedVars.
//   * Unknown variables (`$__rate_interval` and friends) are left untouched by
//     design — Grafana's own Prometheus backend expands those server-side.
// ---------------------------------------------------------------------------

import { SceneQueryRunner, sceneGraph } from '@grafana/scenes';
import { rangeUtil } from '@grafana/data';

import { pickMinInterval } from './minInterval';

/**
 * Keys whose values must never be interpolated. `datasource` is already fully
 * resolved by grafana/datasources.js before the scene is built, and refId/key
 * are identifiers rather than user-authored text.
 */
const SKIP_KEYS = new Set(['datasource', 'refId', 'key', 'hide', 'intervalMs', 'maxDataPoints']);

/**
 * Prometheus-compatible datasource types.
 *
 * They get Prometheus escaping rules here, and Prometheus's minimum step in
 * ./buildScene.js — which imports this set rather than keeping its own, so the
 * two can never drift into disagreeing about what "Prometheus-like" means.
 */
export const PROM_LIKE = new Set([
  'prometheus', 'grafana-amazonprometheus-datasource', 'mimir', 'thanos',
]);

// Grafana's own Prometheus escaping, reproduced so a multi-value variable
// renders as PromQL's `(a|b|c)` alternation instead of Scenes' default glob
// `{a,b,c}` — which Prometheus does not understand and which would silently
// match nothing.
function promRegularEscape(value) {
  return typeof value === 'string' ? value.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`) : value;
}

// The character class is Grafana's own, with the two redundant backslashes it
// carries (before `[` and `'`) dropped — both are literal inside a class, so the
// matched set is byte-for-byte the same. Everything else here, including the
// quadrupled backslashes, is deliberately identical to Grafana's
// promSpecialRegexEscape: a multi-value variable has to reach Prometheus escaped
// exactly the way Grafana would have escaped it, or the label matcher silently
// matches nothing.
function promSpecialRegexEscape(value) {
  return typeof value === 'string'
    ? value.replaceAll('\\', String.raw`\\\\`).replace(/[$^*{}[\]'+?.()|]/g, String.raw`\\$&`)
    : value;
}

export function prometheusFormat(value, variable) {
  if (!variable?.multi && !variable?.includeAll) {
    return promRegularEscape(value);
  }
  if (typeof value === 'string') {
    return promSpecialRegexEscape(value);
  }
  if (!Array.isArray(value)) {
    return promRegularEscape(value);
  }
  const escaped = value.map(promSpecialRegexEscape);
  return escaped.length === 1 ? escaped[0] : `(${escaped.join('|')})`;
}

/**
 * Deep-interpolate the strings of one query target.
 *
 * A generic builder cannot know which field of a target holds the query — it is
 * `expr` for Prometheus, `rawSql` for SQL datasources, `query` for others, and
 * `legendFormat` / `alias` are interpolated too. Walking every string is the
 * only datasource-agnostic answer, and it is safe: a string with no `$name` in
 * it comes back byte-identical.
 */
export function interpolateDeep(model, value, scopedVars, format, depth = 0) {
  if (depth > 8) return value; // paranoia against a cyclic target object

  if (typeof value === 'string') {
    if (!value.includes('$') && !value.includes('[[')) return value;
    return sceneGraph.interpolate(model, value, scopedVars, format);
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateDeep(model, v, scopedVars, format, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SKIP_KEYS.has(k) ? v : interpolateDeep(model, v, scopedVars, format, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Re-floor one request's step for the window it actually covers.
 *
 * Scenes computes the step once, from `state.minInterval` — a fixed string. The
 * TIME RANGE is not fixed: the toolbar's picker moves it on a live scene, so the
 * floor has to be chosen per request, here, where the range being queried is in
 * hand. `state.minIntervalTiers` carries the table (see PROM_MIN_INTERVAL_TIERS
 * in ./buildScene.js); without one this is a no-op and the request is exactly
 * what Scenes built.
 *
 * Recomputed with rangeUtil.calculateInterval — the same call Scenes itself
 * makes — so a tiered request and an untiered one differ in the floor and in
 * nothing else. calculateInterval takes the MAX of the floor and the
 * width-derived step, so a tier can only ever coarsen, never refine.
 */
function applyMinIntervalTiers(request, timeRange, model) {
  const tiers = model.state.minIntervalTiers;
  if (!request || !tiers?.length) return;

  const range = timeRange.state.value;
  const rangeMs = range.to.valueOf() - range.from.valueOf();
  const minInterval = pickMinInterval(rangeMs, tiers);

  const norm = rangeUtil.calculateInterval(range, request.maxDataPoints, minInterval);
  if (norm.intervalMs === request.intervalMs) return;

  request.interval = norm.interval;
  request.intervalMs = norm.intervalMs;
  request.scopedVars = {
    ...request.scopedVars,
    __interval: { text: norm.interval, value: norm.interval },
    __interval_ms: { text: String(norm.intervalMs), value: norm.intervalMs },
  };
}

/**
 * A SceneQueryRunner that interpolates dashboard variables into its queries
 * before they are sent. Drop-in replacement — same state, same options.
 */
export class InterpolatingQueryRunner extends SceneQueryRunner {
  prepareRequests(timeRange, ds) {
    const prepared = super.prepareRequests(timeRange, ds);

    // BEFORE interpolation, deliberately: this rewrites `$__interval` in
    // request.scopedVars, and the targets below are interpolated FROM those.
    // Re-flooring afterwards would leave a query's `[$__interval]` window
    // disagreeing with the step the query is actually evaluated at.
    applyMinIntervalTiers(prepared.primary, timeRange, this);

    const format = PROM_LIKE.has(ds?.type) ? prometheusFormat : undefined;
    const apply = (request) => {
      if (!request?.targets?.length) return request;
      try {
        request.targets = request.targets.map((t) =>
          interpolateDeep(this, t, request.scopedVars, format)
        );
      } catch (err) {
        // A variable that cannot be resolved must cost us this panel's data at
        // worst, never the whole dashboard. Send the raw targets and let the
        // backend's error surface in the panel.
        console.warn('[scene] variable interpolation failed for a query', err);
      }
      return request;
    };

    apply(prepared.primary);
    for (const secondary of prepared.secondaries || []) apply(secondary);
    return prepared;
  }
}
