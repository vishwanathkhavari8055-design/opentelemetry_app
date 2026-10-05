/**
 * Infinity datasource queries: run them through Infinity's BACKEND parser.
 *
 * ─── The problem this solves ────────────────────────────────────────────────
 *
 * The Infinity datasource (`yesoreyeram-infinity-datasource`) is one of the few
 * Grafana plugins that can parse a response in EITHER place, and which one it
 * uses is saved on the query as `parser`:
 *
 *   · `parser: "backend"`   — Infinity's Go code fetches the URL and turns the
 *                             response into data frames, server-side. What comes
 *                             back from /api/ds/query is a finished frame.
 *   · `parser: ""`/"simple" — the DEFAULT. Infinity's Go code still fetches the
 *                             URL, but hands the raw body back untouched in
 *                             `meta.custom.data` with ZERO fields on the frame.
 *                             Infinity's BROWSER plugin is what parses it.
 *
 * This application renders dashboards with @grafana/scenes and its own proxy
 * datasource — Infinity's browser plugin is not loaded and cannot be. So a query
 * saved with the default parser reaches us as a frame with no fields, and the
 * panel renders "No data" while the very same panel in Grafana shows numbers.
 * The response is a 200 with the rows visibly present under `meta.custom.data`,
 * which is why this reads as an empty dashboard rather than as a failure.
 *
 * It is invisible until someone registers a dashboard authored that way: a query
 * only gets `parser: "backend"` if whoever built it went and picked it, so
 * whether a dashboard works here comes down to a checkbox in Grafana that has
 * nothing to do with this application.
 *
 * ─── The fix, and why it is this one ────────────────────────────────────────
 *
 * Ask for the backend parser on the way out. It is the same Go implementation
 * Grafana itself uses whenever an Infinity query runs without a browser — alert
 * rules, recorded queries, reporting — so it is not a re-implementation of
 * anything and it stays correct as Infinity is upgraded. It honours
 * `root_selector`, `columns`, `filterExpression` and `computed_columns` exactly
 * as the frontend parser does.
 *
 * The alternative — reimplementing Infinity's frontend parsing here — would mean
 * carrying a copy of another plugin's selector semantics and keeping it in step
 * with it forever, silently drifting the day it stopped matching.
 *
 * ─── Scope: only the queries that are broken today ──────────────────────────
 *
 * `uql`, `groq` and `sqlite` parsers are ALSO implemented in Infinity's Go
 * backend and already return finished frames, so they are left exactly as
 * authored. Only an absent or `simple` parser is rewritten — the one case that
 * cannot work in this renderer at all. Every Infinity query on every dashboard
 * registered here when this was written already carried `parser: "backend"`,
 * which is precisely why those dashboards work and a newly registered one did
 * not.
 */

/** Infinity's plugin id. Matched loosely — see {@link isInfinityQuery}. */
export const INFINITY_PLUGIN_ID = 'yesoreyeram-infinity-datasource';

/**
 * Parser values that mean "the browser plugin will do it".
 *
 * `undefined` and `null` land here too: the field is simply absent on a query
 * saved before Infinity gained the setting, and absent means default means
 * frontend.
 */
const FRONTEND_PARSERS = new Set(['', 'simple']);

/**
 * Query types the Go backend cannot produce at all.
 *
 * `series` generates data from an expression in the browser and has no URL to
 * fetch; `global-q` resolves a saved query client-side. Rewriting either would
 * turn a panel that renders nothing into a panel that ERRORS, which is worse.
 * Left alone deliberately.
 */
const FRONTEND_ONLY_TYPES = new Set(['series', 'global-q']);

/**
 * Whether a datasource reference (or bare type string) names Infinity.
 *
 * Substring rather than equality: Infinity has shipped under
 * `yesoreyeram-infinity-datasource` and, on some builds, a vendor-prefixed
 * variant of the same id. Both are the same plugin with the same parser split.
 */
export function isInfinityQuery(ref) {
  const type = typeof ref === 'string' ? ref : ref?.type;
  return typeof type === 'string' && type.includes('infinity');
}

/**
 * The target as it should leave the browser.
 *
 * Returns the SAME object when nothing needs changing, so this can be mapped
 * over every target of every datasource type without allocating.
 *
 * @param {object} target        one query target, already interpolated
 * @param {string} [fallbackType] the proxy's own plugin type, used when the
 *   target carries no datasource of its own
 */
export function withInfinityBackendParser(target, fallbackType) {
  if (!target || typeof target !== 'object') return target;
  if (!isInfinityQuery(target.datasource ?? fallbackType)) return target;

  const parser = target.parser == null ? '' : String(target.parser);
  if (!FRONTEND_PARSERS.has(parser)) return target;
  if (FRONTEND_ONLY_TYPES.has(target.type)) return target;

  return { ...target, parser: 'backend' };
}

/**
 * A root_selector this code is willing to follow.
 *
 * Infinity accepts JSONata here as well as a plain dotted path. Anything with a
 * bracket, a parenthesis or a wildcard in it is an expression, and guessing at
 * what it selects would be how {@link unparsedFrameReason} starts crying wolf.
 */
const PLAIN_PATH = /^[\w-]+(\.[\w-]+)*$/;

/** Marks "this selector is beyond us" — distinct from "it selected nothing". */
const UNKNOWN = Symbol('unknown-selector');

/** Follow a dotted root_selector into the raw response. */
function selectRows(raw, rootSelector) {
  const selector = rootSelector == null ? '' : String(rootSelector).trim();
  if (!selector) return raw;
  if (!PLAIN_PATH.test(selector)) return UNKNOWN;

  let cursor = raw;
  for (const segment of selector.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = Array.isArray(cursor) && /^\d+$/.test(segment)
      ? cursor[Number(segment)]
      : cursor[segment];
  }
  return cursor;
}

/**
 * Why a frame came back with no fields, when the response plainly carried rows.
 *
 * The rewrite above removes the cause we know about, but "a plugin that parses in
 * the browser" is a shape this renderer can meet again — a new datasource type, a
 * query the Go parser declines, an Infinity upgrade that changes the split. When
 * that happens the panel must SAY so, because the alternative is what sent
 * somebody to compare this screen against Grafana panel by panel to discover that
 * an empty dashboard was never empty.
 *
 * ─── Biased hard towards silence ────────────────────────────────────────────
 *
 * A query that legitimately matched nothing ALSO comes back with zero fields, and
 * on this stack it comes back with `meta.custom.data` populated too — OpenObserve
 * answers an empty search with a full envelope whose `hits` is `[]`. So "there is
 * raw data attached" is not evidence of anything; the row array itself has to be
 * non-empty. Follow the query's own `root_selector` to find it, and say nothing
 * at all when the selector is an expression this code cannot follow.
 *
 * Getting this backwards would be worse than the bug it reports: an error banner
 * on every panel whose query happens to match nothing right now.
 *
 * @param {object} frameJson a frame in Grafana's wire format
 * @param {object} [target]  the query that produced it, for its root_selector
 * @returns {string|null} a sentence for the panel, or null when all is well
 */
export function unparsedFrameReason(frameJson, target) {
  if ((frameJson?.schema?.fields?.length ?? 0) > 0) return null;

  const custom = frameJson?.schema?.meta?.custom;
  const raw = custom?.data;
  if (raw == null || typeof raw !== 'object') return null;

  // The echoed query is the fallback: Infinity returns the target it actually
  // executed, which is the same root_selector by another route.
  const rows = selectRows(raw, target?.root_selector ?? custom?.query?.root_selector);
  // Deliberately narrow: a non-empty ARRAY of rows and nothing else counts. An
  // object here is as likely to be the response envelope as it is to be data.
  if (rows === UNKNOWN || !Array.isArray(rows) || rows.length === 0) return null;

  return `the datasource returned ${rows.length} row(s) that nothing parsed into fields. `
    + 'Its browser plugin normally does that, and this application does not load one. '
    + 'For an Infinity query, set that query\'s Parser to "Backend" in Grafana.';
}
