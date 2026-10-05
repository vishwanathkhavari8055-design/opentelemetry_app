/**
 * "Open that other dashboard" — one request, raised from anywhere inside a
 * rendered scene, answered by whichever screen owns the dashboard navigation.
 *
 * ─── The Grafana feature this exists for ────────────────────────────────────
 *
 * Real dashboards drill down. A topology node, a table row, a legend entry —
 * clicking it takes you to the dashboard for that thing. In Grafana that works
 * because everything is one Angular/React app behind one router, so a panel can
 * simply say `locationService.push('/d/<uid>')` (or render `<a href="/d/<uid>">`,
 * which is what a data link compiles to) and the router does the rest.
 *
 * Here there is no router, the dashboard is a `uid` held in a React state hook,
 * and the panel that wants to navigate is either deep inside a Scenes tree or —
 * for a dynamic text panel — inside a SANDBOXED IFRAME on an opaque origin,
 * which cannot reach this application at all. Neither can call `setOpenUid`.
 *
 * So the request travels as data: a panel raises it, this module carries it, and
 * the screen holding the state decides what to do about it — including refusing
 * it, which matters because a dashboard that exists in Grafana is NOT necessarily
 * registered in this application's catalog. Grafana would happily open it; here
 * the backend will not serve it, and telling the user that is far better than
 * opening a viewer that fails.
 *
 * ─── Deliberately not a URL ────────────────────────────────────────────────
 *
 * The app's shell routes by `tab` and has no history integration, so this is a
 * plain listener rather than a route change. The parsing below still speaks
 * Grafana's URL vocabulary — `/d/<uid>/<slug>?from=…&to=…` — because that is the
 * vocabulary the dashboards themselves are authored in, and rewriting them is not
 * an option: they are read live out of Grafana on every open.
 */

/**
 * A Grafana dashboard URL, in the forms one actually appears in.
 *
 * Absolute (`https://grafana.example/d/uid/slug`), root-relative (`/d/uid`) and
 * bare (`d/uid`) all reach here — panels are authored against all three. The
 * leading `(?:^|\/)` is what stops `/somethingd/uid` from matching.
 */
export const DASHBOARD_PATH_PATTERN = /(?:^|\/)d\/([A-Za-z0-9_-]{1,64})(?:\/([^/?#]*))?(?:[?#]|$)/;

/**
 * Read a dashboard target out of a URL, or null when it is not one.
 *
 * Null is a normal answer, not a failure: a panel's script may hand over any
 * link it likes, and "this is not a dashboard" is what the caller needs to know
 * to leave it alone rather than swallow the click.
 *
 * @param {string} raw a URL, path, or fragment of one
 * @returns {{uid: string, slug: string, params: URLSearchParams,
 *            range: {from: string, to: string}|null}|null}
 */
export function parseDashboardTarget(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const match = DASHBOARD_PATH_PATTERN.exec(text);
  if (!match) return null;

  const queryStart = text.indexOf('?');
  const hashStart = text.indexOf('#');
  const end = hashStart > -1 ? hashStart : text.length;
  const params = new URLSearchParams(
    queryStart > -1 && queryStart < end ? text.slice(queryStart + 1, end) : '',
  );

  // Grafana carries the drill-down's time window in the link. Honouring it is
  // the difference between "show me THAT service during THIS incident" and
  // "show me that service over its own default window", which is usually the
  // last six hours and hides the thing that was just clicked on.
  const from = params.get('from');
  const to = params.get('to');

  return {
    uid: match[1],
    slug: match[2] || '',
    params,
    range: from && to ? { from, to } : null,
  };
}

/** Everyone currently willing to answer a navigation request. */
const listeners = new Set();

/**
 * Listen for navigation requests. Returns the unsubscribe.
 *
 * More than one listener is allowed and all of them are called — this is a
 * notification, not a router with one winner. In practice the Dashboards screen
 * is the only subscriber; a second one would be a second screen that can show a
 * dashboard, and it should get the request too.
 */
export function onDashboardNavigation(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Ask for a dashboard to be opened.
 *
 * @param {string|object} target a URL/path, or an already-parsed target
 * @returns {boolean} whether anything was listening AND the target was a
 *   dashboard. False means the caller should leave the click alone — nothing
 *   happened, so swallowing it would be a dead control.
 */
export function requestDashboardNavigation(target) {
  const parsed = typeof target === 'string' ? parseDashboardTarget(target) : target;
  if (!parsed?.uid) {
    console.warn('[dashboards] ignored a navigation request that names no dashboard', target);
    return false;
  }
  if (!listeners.size) {
    console.warn(
      `[dashboards] nothing is listening for navigation — "${parsed.uid}" was not opened.`,
    );
    return false;
  }
  for (const listener of listeners) {
    try {
      listener(parsed);
    } catch (err) {
      // One bad listener must not cost the others the request.
      console.error('[dashboards] a navigation listener threw', err);
    }
  }
  return true;
}
