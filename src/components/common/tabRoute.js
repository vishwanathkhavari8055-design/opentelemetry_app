// Extension spelled out, here and in navModel's own import, so that this chain
// resolves under Node's ESM loader as well as Vite's — which is what lets
// test/tabRoute.test.mjs import it directly, with no bundler and no DOM.
import { NAV_ITEMS, navItemForTab, resolveNavTarget } from './navModel.js';

/**
 * The address-bar half of navigation: which screen a URL names, and which URL
 * names a screen.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * `tab` was React state and nothing else, so it lived exactly as long as the
 * page did. A reload — the browser's, the ErrorBoundary's "Reload" button, or
 * the portal re-opening the app — put the user back on Home no matter which
 * screen they had been reading. Every other durable choice in this shell is
 * already persisted (the active org, the Logs page size, the Settings
 * sub-tab); the screen itself was the one thing that was not.
 *
 * ─── Why the hash, and not localStorage ─────────────────────────────────────
 *
 * localStorage would restore the tab, but it makes the CURRENT screen a
 * property of the browser profile rather than of the page: two windows open on
 * two screens would each reload into whatever the other one wrote last. The
 * fragment is per-page-load by construction, so two windows stay independent,
 * and it costs nothing else — the URL becomes linkable ("send me the Traces
 * screen") and the Back button starts meaning something.
 *
 * ─── Why the fragment, and not the query string ─────────────────────────────
 *
 * Two reasons, both hard constraints rather than taste:
 *
 *  • The query string is the SSO hand-off (`?role=…&tenantCode=…&refKey=…`, see
 *    auth/ssoParams.js) and the Logs share link (`?q=…&period=…`). Writing a
 *    routing parameter into it means editing a string two other features own.
 *  • A path segment (`/traces`) would need the server to serve index.html for
 *    every unknown path. The app is mounted under a portal path it does not
 *    control, so that rewrite rule is not ours to add.
 *
 * The fragment is owned by nobody — with ONE exception this module honours:
 * readSsoParams also accepts its parameters from a `#…?…` fragment, for a host
 * that mounts the app behind a hash route. So the query part of the fragment is
 * PRESERVED on every write ({@link hashForTab}); only the path part is ours.
 *
 * Pure string → string. No React and no `window`: the caller passes the hash in
 * and puts the result back, which is what lets every case below be asserted in
 * test/tabRoute.test.mjs without a DOM.
 */

/** Where the app lands with nothing in the URL to say otherwise. */
export const DEFAULT_TAB = 'home';

/**
 * Is this a key some screen actually answers to?
 *
 * <p>Resolved through the nav table rather than a list kept here, so a screen
 * added to NAV_ITEMS (or moved into a group) becomes linkable with no edit to
 * this file. Anything else — a typo, a stale link to a removed screen, a
 * fragment the host page put there for its own purposes — is not routable, and
 * callers fall back to {@link DEFAULT_TAB}.</p>
 */
export const isRoutableTab = (key, items = NAV_ITEMS) => Boolean(key)
  && Boolean(navItemForTab(key, items));

/** The part of a fragment after `?`, or '' — the SSO parameters, when present. */
const hashQuery = (hash = '') => {
  const idx = hash.indexOf('?');
  return idx === -1 ? '' : hash.slice(idx + 1);
};

/** `s` without leading or trailing `/` — an index scan, so no regex backtracking. */
const trimSlashes = (s) => {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === '/') start += 1;
  while (end > start && s[end - 1] === '/') end -= 1;
  return s.slice(start, end);
};

/** The part of a fragment before `?`, with the leading `#` and any `/` trimmed. */
const hashPath = (hash = '') => {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const idx = body.indexOf('?');
  return trimSlashes(idx === -1 ? body : body.slice(0, idx));
};

/**
 * The screen a URL fragment names, or '' when it names none.
 *
 * <p>Deliberately forgiving about the shapes a fragment can arrive in —
 * `#/traces`, `#traces`, `#/traces/`, `#/TRACES`, `#/traces?role=admin` all
 * mean Traces — because these get hand-edited, pasted into chat and rewritten
 * by portals. Only the FIRST segment is read here; what follows it names a
 * drill-down WITHIN that screen and is read by {@link traceFromHash}.</p>
 *
 * <p>Returns '' rather than a default so the caller can tell "the URL said
 * nothing" from "the URL said Home" — the difference between leaving the
 * fragment alone and writing one.</p>
 *
 * @param {string} hash a `location.hash` value
 * @returns {string} a tab key the shell can render, or ''
 */
export const tabFromHash = (hash = '', items = NAV_ITEMS) => {
  const [first = ''] = hashPath(hash).split('/');
  if (!first) return '';
  let key;
  // A fragment can carry percent-escapes; a malformed one throws rather than
  // returning the raw text, and an unroutable key is the right answer for it.
  try { key = decodeURIComponent(first); } catch { return ''; }
  key = key.trim().toLowerCase();
  if (!isRoutableTab(key, items)) return '';
  // Same resolution the rail uses: asking for a GROUP lands on its first
  // section, because a group is a heading with no screen behind it.
  return resolveNavTarget(key, items);
};

/** The segment that introduces a trace drill-down: `#/logs/trace/<id>`. */
const TRACE_SEGMENT = 'trace';

/**
 * What a trace id is allowed to look like coming OFF a URL.
 *
 * <p>Not a format check — OpenTelemetry ids are 32 hex characters, but this app
 * displays whatever the backend returns and guessing narrower than the backend
 * would make a legitimate id unroutable. This is the weaker question: is this
 * one opaque token, safe to put in a query parameter and back into a path? A
 * value with a slash, a space or a `#` in it is not, and is dropped rather than
 * forwarded to the spans endpoint.</p>
 */
const TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The trace a fragment drills into, or '' when it names none.
 *
 * <p>`#/logs/trace/4bf92f…` and `#/traces/trace/4bf92f…` are the two that
 * occur: a trace opened from a log line, and one opened from a span row. The
 * screen differs, the drill-down is the same shape, so it is spelled the same
 * way in both — which is what lets ONE writer ({@link hashForTab}) and one
 * reader serve both instead of a rule per screen.</p>
 *
 * <p>Says nothing about WHICH screen is open; {@link tabFromHash} answers that,
 * and the caller pairs them. A trace id sitting under a tab that has no trace
 * view is simply never asked for.</p>
 *
 * @param {string} hash a `location.hash` value
 * @returns {string} a trace id, or ''
 */
export const traceFromHash = (hash = '') => {
  const [, segment, raw] = hashPath(hash).split('/');
  if (!raw || (segment || '').toLowerCase() !== TRACE_SEGMENT) return '';
  let id;
  try { id = decodeURIComponent(raw); } catch { return ''; }
  id = id.trim();
  return TRACE_ID.test(id) ? id : '';
};

/**
 * The fragment that names `tab` — and the trace open on it, when there is one —
 * keeping whatever query the current fragment holds.
 *
 * <p>That carry-over is the whole reason this is a function and not a template
 * literal at the call site. If the app is mounted behind a hash route, the SSO
 * context is in the fragment's query — and dropping it here would mean the next
 * reload has no identity to sign in with, which is a blank landing page rather
 * than a wrong screen. Preserving it costs one string concat.</p>
 *
 * <p>`trace` is the id of an OPEN trace detail, not of a selected row: it is
 * what the screen is currently showing instead of its table, so that a reload
 * reopens the same trace rather than the list it was reached from. Blank for
 * every screen that is not showing one, which is most of them.</p>
 *
 * @param {string} tab the tab key to encode
 * @param {string} [currentHash] the live `location.hash`, for its query part
 * @param {string} [trace] the open trace's id, when the screen is showing one
 * @returns {string} a fragment including the leading `#`
 */
export const hashForTab = (tab, currentHash = '', trace = '') => {
  const query = hashQuery(currentHash);
  // An id this module would refuse to read back is not written: a fragment that
  // cannot round-trip is worse than none, because it survives in a pasted link
  // and fails on someone else's screen.
  const drill = trace && TRACE_ID.test(trace)
    ? `/${TRACE_SEGMENT}/${encodeURIComponent(trace)}`
    : '';
  const queryStr = query ? `?${query}` : '';
  return `#/${encodeURIComponent(tab)}${drill}${queryStr}`;
};

export default tabFromHash;
