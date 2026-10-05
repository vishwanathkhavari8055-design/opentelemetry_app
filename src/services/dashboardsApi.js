/**
 * Dashboard Catalog client.
 *
 * The browser talks ONLY to this service's `/api/dashboards` endpoints, never to
 * Grafana. That is not a layering preference — every Grafana call needs a
 * service-account token, and a token reachable from here is a token any user can
 * read out of the network tab and replay against the whole Grafana instance. So
 * the token lives on the backend and these ten functions are the entire surface
 * the frontend has.
 *
 * ─── Why this is its own module ─────────────────────────────────────────────
 *
 * `services/api.js` is the telemetry client: logs, traces, metrics, alerts — all
 * reading OpenObserve through the lib. This reads Grafana through the same lib.
 * They share the base URL and the org parameter (imported below, not copied) and
 * nothing else, and keeping them apart means the Dashboards screen cannot be
 * broken by an edit to the logs client or the other way round.
 *
 * ─── Errors carry the backend's own sentence ────────────────────────────────
 *
 * The backend answers registration failures with messages an administrator can
 * act on ("No dashboard with UID 'x' exists in Grafana…"). Those are surfaced
 * verbatim rather than replaced with "registration failed", because the whole
 * value of the message is the part a generic one would throw away. `status` is
 * kept on the Error so a caller can still branch on 404 versus 409.
 */

import { getApiBase, getOrg } from './api';

/** Everything below hangs off this one path. */
const root = () => `${getApiBase()}/dashboards`;

/**
 * fetch() with the active organization appended.
 *
 * A local copy of what api.js does for its own requests — deliberately, because
 * the alternative is exporting that module's internals. Under the backend's
 * default GLOBAL registry scope the parameter is ignored, but sending it keeps
 * this client correct if a deployment switches to ORG scope, and it keeps the
 * backend's per-request org logging consistent with every other screen.
 */
const dashFetch = (url, options) => {
  const org = getOrg();
  if (!org) return fetch(url, options);
  const sep = url.includes('?') ? '&' : '?';
  return fetch(`${url}${sep}org=${encodeURIComponent(org)}`, options);
};

/** Drop empty params so the URL says only what the caller actually asked for. */
const qs = (params) => {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });
  const text = search.toString();
  return text ? `?${text}` : '';
};

const failure = async (response) => {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error || body?.message || '';
  } catch {
    // Non-JSON body — a proxy error page, most likely. The status is all we have.
  }
  const error = new Error(detail || `Request failed (HTTP ${response.status})`);
  error.status = response.status;
  return error;
};

const readJson = async (path, { signal, ...params } = {}) => {
  const response = await dashFetch(`${root()}${path}${qs(params)}`, { signal });
  if (!response.ok) throw await failure(response);
  return response.json();
};

const writeJson = async (path, method, body) => {
  const response = await dashFetch(`${root()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  // DELETE and PATCH always answer with a body here, but a 204 from a proxy in
  // front of the service would otherwise throw on an empty parse.
  const text = await response.text();
  return text ? JSON.parse(text) : {};
};

// ─── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Whether the feature is configured, and against which Grafana.
 *
 * Answers the one question a blank Dashboards screen raises: is Grafana
 * unconfigured, or is the catalog simply empty? The two look identical and need
 * completely different fixes, so both screens read this before deciding what
 * their empty state should say.
 */
export const fetchDashboardHealth = ({ signal } = {}) => readJson('/health', { signal });

// ─── Registry ───────────────────────────────────────────────────────────────

/** Registered dashboards. `enabledOnly` gives just what a viewer may open. */
export const fetchDashboardRegistrations = ({ enabledOnly, folderUid, signal } = {}) =>
  readJson('/registry', { enabledOnly: enabledOnly ? 'true' : '', folderUid, signal });

/**
 * The folder tiles, with their counts.
 *
 * Counted by the backend next to the rows being counted, so a tile and the list
 * it opens onto can never disagree. Deriving them here from the registration list
 * would be one less request and one more way for the two to drift.
 */
export const fetchDashboardFolderTiles = ({ signal } = {}) =>
  readJson('/registry/folder-summary', { signal });

/**
 * Grafana folders a dashboard may be filed under — the whole tree.
 *
 * Nested folders included, each row carrying `path` ("Monitoring / OpenObserver /
 * Default Org."), `depth` and `parentUid` alongside `uid` and `title`. Read live
 * on every load, so a folder created in Grafana appears here on the next refresh
 * with nothing to configure.
 *
 * Render `path`, not `title`: titles are not unique across a nested instance, and
 * two parents each holding a "Default Org." would otherwise offer two options
 * that read identically. Rows arrive sorted by path, which places each child
 * directly after its parent.
 */
export const fetchGrafanaFolders = ({ signal } = {}) => readJson('/folders', { signal });

/** Grafana dashboards not registered yet — candidates for the register form. */
export const fetchRegisterableDashboards = ({ folderUid, query, signal } = {}) =>
  readJson('/available', { folderUid, query, signal });

/** File a Grafana dashboard UID under a folder. Validated server-side. */
export const registerDashboard = ({ uid, folderUid, enabled, displayOrder }) =>
  writeJson('/registry', 'POST', { uid, folderUid, enabled, displayOrder });

/** Move to another folder, enable/disable, or reorder. Omitted fields are left alone. */
export const updateDashboardRegistration = (uid, { folderUid, enabled, displayOrder } = {}) =>
  writeJson(`/registry/${encodeURIComponent(uid)}`, 'PATCH', { folderUid, enabled, displayOrder });

/** Re-read the title and Grafana folder from Grafana. */
export const syncDashboardRegistration = (uid) =>
  writeJson(`/registry/${encodeURIComponent(uid)}/refresh`, 'POST');

/** Unregister. The dashboard itself is untouched in Grafana. */
export const unregisterDashboard = (uid) =>
  writeJson(`/registry/${encodeURIComponent(uid)}`, 'DELETE');

// ─── Render path ────────────────────────────────────────────────────────────

/**
 * A registered dashboard's live definition.
 *
 * Read fresh from Grafana on every open — nothing about a dashboard's contents is
 * stored anywhere in this application, which is what stops a panel here from ever
 * disagreeing with the same panel in Grafana. Gated on the registry server-side,
 * so a disabled or unregistered UID is refused here even though it exists in
 * Grafana.
 */
export const fetchDashboardDefinition = (uid, { signal } = {}) =>
  readJson(`/registry/${encodeURIComponent(uid)}/definition`, { signal });

/**
 * Run panel queries.
 *
 * The payload is Grafana's own `/api/ds/query` shape, passed through by the
 * backend — which is what lets one code path serve every datasource type on the
 * instance, because Grafana executes them, not us.
 */
export const runDashboardQuery = async (payload, { signal } = {}) => {
  const response = await dashFetch(`${root()}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // Passed through so a panel can actually CANCEL its query — see the note in
    // ProxyDataSource. Without it, changing the time range on a fourteen-panel
    // dashboard leaves fourteen abandoned queries running against Grafana.
    signal,
  });
  if (!response.ok) throw await failure(response);
  const body = await response.json();
  // Unwrapped here so the datasource layer sees exactly Grafana's own
  // `{ results: {...} }` shape and needs no knowledge of this envelope.
  return { results: body?.results ?? {} };
};

/** Datasources, as `{ uid, name, type }` — the backend returns nothing else. */
export const fetchDashboardDatasources = async ({ type, signal } = {}) => {
  const body = await readJson('/datasources', { type, signal });
  return Array.isArray(body?.items) ? body.items : [];
};

/** Values of a Prometheus label, backing a dashboard's template variables. */
export const fetchDashboardLabelValues = async ({ uid, label, metric, from, to }) => {
  const body = await readJson(
    `/datasources/${encodeURIComponent(uid)}/label-values`,
    { label, metric, from, to },
  );
  return Array.isArray(body?.values) ? body.values : [];
};
