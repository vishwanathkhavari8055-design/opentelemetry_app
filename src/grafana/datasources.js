/**
 * Dynamic datasource resolution and registration.
 *
 * A generic dashboard renderer cannot know in advance which datasources a
 * dashboard references — that is exactly the thing that changes from one
 * registered UID to the next. So instead of one configured datasource, this
 * module:
 *
 *   1. scans a dashboard's JSON for every datasource reference it makes,
 *   2. resolves the awkward forms Grafana allows (a bare NAME, a `${DS_X}`
 *      template variable, a missing reference meaning "the default"),
 *   3. registers one ProxyDataSource per distinct UID with Scenes, so
 *      SceneQueryRunner can resolve it by uid at query time.
 *
 * ─── Nothing here is configured, and that is the point ──────────────────────
 *
 * There is no default datasource UID in this file. An earlier version of this
 * code (the standalone proof of concept) carried one, and it was a latent bug: it
 * named a datasource on one specific Grafana instance, so the same code pointed
 * at any other instance would resolve every unresolvable reference to a UID that
 * did not exist. The default is now DERIVED per dashboard — its own first
 * concrete reference, else a Prometheus datasource from the live catalog, else
 * whatever the catalog's first entry is — so this works against any Grafana
 * without being told anything.
 */

import { sceneUtils } from '@grafana/scenes';

import { fetchDashboardDatasources } from '../services/dashboardsApi';
import { ProxyDataSource } from './ProxyDataSource';

/**
 * Plugin type assumed when a reference names a UID but no type.
 *
 * A TYPE name, not an instance id — nothing about it is deployment-specific, and
 * it only labels the outgoing request. Prometheus because it is what the great
 * majority of panels on these dashboards use, and because Grafana resolves the
 * real type from the UID anyway.
 */
export const DEFAULT_DS_TYPE = 'prometheus';

/** uid -> ProxyDataSource. Also the guard against double-registration. */
const proxies = new Map();

/**
 * Cached `{ uid, name, type }` list from the backend.
 *
 * Short-lived rather than once per session: resolving a NAME or a `${DS_X}`
 * variable is a question about what Grafana holds NOW, and a datasource added
 * or renamed there has to resolve on the next dashboard open — not on the next
 * full page reload, which is what a session-long cache made it wait for.
 */
let catalogPromise = null;
let catalogFetchedAt = 0;
/** The last catalog that actually arrived, kept for when a refetch fails. */
let lastGoodCatalog = [];
export const CATALOG_MAX_AGE_MS = 60_000;

/**
 * The uid the mixed proxy is registered under.
 *
 * Grafana's own spelling, so a dashboard that already names it in a panel
 * reference resolves to the same object rather than to a second one.
 */
export const MIXED_DS_UID = '-- Mixed --';

/**
 * The one proxy a MULTI-DATASOURCE panel runs through.
 *
 * A panel whose targets span more than one datasource cannot be pointed at any
 * one of them: SceneQueryRunner rewrites every target that disagrees with the
 * runner's datasource, so pointing it at the first target's datasource sends
 * ALL the others there too — see the note in ProxyDataSource's constructor.
 * This proxy declares `meta.mixed`, which is the flag that tells Scenes to
 * leave each target's own datasource alone.
 *
 * Nothing else about it is special. Its `query()` is the same one every other
 * proxy uses, and each target reaches Grafana carrying the datasource the
 * dashboard gave it — which is exactly what Grafana's own /api/ds/query expects
 * from a mixed panel.
 */
export function getMixedProxyDataSource() {
  return getProxyDataSource(MIXED_DS_UID, 'mixed', { mixed: true });
}

/**
 * Get — creating and registering on first use — the proxy for a UID.
 * Safe to call repeatedly with the same uid.
 */
export function getProxyDataSource(uid, type = DEFAULT_DS_TYPE, { mixed = false } = {}) {
  const key = String(uid);
  const existing = proxies.get(key);
  if (existing) return existing;

  const dataSource = new ProxyDataSource(type || DEFAULT_DS_TYPE, key, { mixed });
  try {
    sceneUtils.registerRuntimeDataSource({ dataSource });
  } catch (err) {
    // Scenes throws when a uid is already registered, which can only happen if
    // something else registered it first. Reuse rather than fail the dashboard.
    console.warn(`[dashboards] datasource uid "${key}" was already registered`, err);
  }
  proxies.set(key, dataSource);
  return dataSource;
}

export function knownProxies() {
  return Array.from(proxies.values());
}

/**
 * The datasources the backend is willing to describe. Never throws.
 *
 * Refetched once it is older than {@link CATALOG_MAX_AGE_MS}; concurrent callers
 * share one request.
 */
export function loadDatasourceCatalog({ maxAgeMs = CATALOG_MAX_AGE_MS } = {}) {
  if (!catalogPromise || Date.now() - catalogFetchedAt > maxAgeMs) {
    catalogFetchedAt = Date.now();
    catalogPromise = fetchDashboardDatasources()
      .then((list) => {
        lastGoodCatalog = Array.isArray(list) ? list : [];
        return lastGoodCatalog;
      })
      .catch((err) => {
        // A missing catalog only costs NAME and ${DS_X} resolution; explicit
        // { uid, type } references — the overwhelmingly common case — still work.
        // The previous catalog is still the best answer available, and a blip
        // must not un-resolve references that resolved a minute ago.
        console.warn('[dashboards] could not load the datasource catalog', err);
        catalogFetchedAt = 0; // retry on the next open rather than in a minute
        return lastGoodCatalog;
      });
  }
  return catalogPromise;
}

// ─── Reference shapes ───────────────────────────────────────────────────────

const isTemplateRef = (value) => typeof value === 'string' && value.includes('$');

/** `${DS_PROM}` / `$DS_PROM` -> `DS_PROM` */
function templateVarName(value) {
  const match = /^\$\{?([A-Za-z0-9_-]+)\}?$/.exec(String(value).trim());
  return match ? match[1] : null;
}

/**
 * Grafana's "no datasource" sentinels.
 *
 * `-- Mixed --` means each target carries its own, so the panel-level reference
 * is meaningless and the scene builder resolves targets individually.
 * `__expr__` / `-100` are server-side expressions, which this renderer does not
 * implement — those targets are left alone and fail visibly on their own panel
 * rather than silently poisoning the whole dashboard.
 */
const MIXED_UIDS = new Set(['-- Mixed --', 'mixed', '-- Dashboard --', 'dashboard']);
const EXPRESSION_UIDS = new Set(['__expr__', '-100', '-- Expression --', 'expr']);

/**
 * Grafana's OWN built-in datasource — `{ type: 'datasource', uid: 'grafana' }`.
 *
 * Not a datasource in any useful sense: it is how Grafana serves random-walk test
 * data, dashboard-list panels, annotation lists and the vestigial `targets` entry
 * that a TEXT panel carries. It cannot execute a normal query, and asking it to
 * answers HTTP 400 "unknown query type" — which is exactly how a static text
 * panel ended up rendering as a failed panel.
 *
 * Treated as a sentinel, like the expression and mixed uids: never proxied, and
 * any target pointing at it is dropped before the query is built.
 */
const BUILT_IN_UIDS = new Set(['grafana', '-- Grafana --', '-100000']);

export function isExpressionRef(ref) {
  const uid = typeof ref === 'string' ? ref : ref?.uid;
  return uid != null && EXPRESSION_UIDS.has(String(uid));
}

/** Whether a reference points at Grafana's own built-in datasource. */
export function isBuiltInRef(ref) {
  const uid = typeof ref === 'string' ? ref : ref?.uid;
  if (uid != null && BUILT_IN_UIDS.has(String(uid))) {
    return true;
  }
  // `type: 'datasource'` is how Grafana spells its built-in in recent dashboard
  // schemas — the uid varies, the type does not.
  return typeof ref === 'object' && ref !== null && ref.type === 'datasource';
}

/** A reference this application can never send a query to. */
export function isUnqueryableRef(ref) {
  return isExpressionRef(ref) || isBuiltInRef(ref);
}

// ─── Dashboard scanning ─────────────────────────────────────────────────────

function eachPanel(panels, visit) {
  for (const panel of panels || []) {
    visit(panel);
    // Collapsed rows carry their panels inline.
    if (Array.isArray(panel?.panels)) eachPanel(panel.panels, visit);
  }
}

/** Every raw datasource reference the dashboard JSON makes, in no order. */
function collectRawRefs(dashboard) {
  const refs = [];
  eachPanel(dashboard?.panels, (panel) => {
    if (panel?.datasource !== undefined) refs.push(panel.datasource);
    for (const target of panel?.targets || []) {
      if (target?.datasource !== undefined) refs.push(target.datasource);
    }
  });
  for (const variable of dashboard?.templating?.list || []) {
    if (variable?.datasource !== undefined) refs.push(variable.datasource);
  }
  for (const annotation of dashboard?.annotations?.list || []) {
    if (annotation?.datasource !== undefined) refs.push(annotation.datasource);
  }
  return refs;
}

/**
 * Prepare every datasource one dashboard needs, and hand back a resolver.
 *
 * Called once before the scene is built: it fetches the catalog (once per
 * session), works out what each reference means, and registers a proxy for each
 * distinct UID. `resolve()` afterwards is SYNCHRONOUS, which is what the scene
 * builder needs — a builder that had to await per panel could not construct the
 * tree in one pass.
 *
 * @returns {Promise<{ resolve: (ref: any) => object, defaultRef: object, unresolved: string[] }>}
 */
export async function prepareDashboardDatasources(dashboard) {
  const catalog = await loadDatasourceCatalog();
  const byUid = new Map(catalog.map((ds) => [ds.uid, ds]));
  const byName = new Map(catalog.map((ds) => [ds.name, ds]));
  // Every datasource of a given type, not just the first one seen.
  //
  // This used to keep only the first, which made the type fallback below depend
  // on the ORDER the backend happened to return the catalog in. That is not a
  // theoretical concern on this deployment: it carries FIVE
  // yesoreyeram-infinity-datasource entries — "OpenObserve" plus
  // "yesoreyeram-infinity-datasource"[-1][-2][-3] — and two registered
  // dashboards (Microservice Monitoring - Database and - Trends) save an EMPTY
  // `current` for their DS_INFINITY variable, so all eighteen of their panels
  // resolve through that fallback alone. It lands on the right one today only
  // because the catalog happens to arrive sorted by name and "OpenObserve"
  // sorts before "yesoreyeram-…". Re-order the backend's response and eighteen
  // panels quietly start querying an unconfigured datasource — which shows up
  // as empty panels, not as an error.
  const byTypeAll = new Map();
  for (const ds of catalog) {
    if (!byTypeAll.has(ds.type)) byTypeAll.set(ds.type, []);
    byTypeAll.get(ds.type).push(ds);
  }

  // Datasource-TYPE template variables: `${DS_PROM}` resolves through these.
  // Grafana stores the picked datasource in `current.value` (a UID in recent
  // versions, a NAME in older exports), with `query` naming the plugin type —
  // enough to pick a sensible datasource of that type when nothing is current.
  const dsVars = new Map();
  for (const variable of dashboard?.templating?.list || []) {
    if (variable?.type !== 'datasource') continue;
    dsVars.set(variable.name, {
      currentValue: variable.current?.value ?? variable.current?.text,
      pluginType: typeof variable.query === 'string' ? variable.query : variable.query?.type,
    });
  }

  const unresolved = [];

  function fromCatalogValue(value, pluginType) {
    if (value) {
      const hit = byUid.get(value) || byName.get(value);
      if (hit) return { uid: hit.uid, type: hit.type };
    }
    if (pluginType) {
      const hit = pickByType(pluginType, { warn: true });
      if (hit) return { uid: hit.uid, type: hit.type };
    }
    return null;
  }

  /**
   * The one datasource of `pluginType` to use when a `${DS_X}` variable saved no
   * selection of its own.
   *
   * Sorted by name so the answer is the same on every load regardless of the
   * order the catalog arrived in — an unstable answer here means a dashboard
   * that works this morning and is empty this afternoon, with nothing in the UI
   * to say why. When there is more than one candidate the choice is genuinely a
   * guess, so it is logged: the fix is to open the dashboard in Grafana and save
   * a real selection for the variable, and that message is what tells someone
   * that is what is needed.
   */
  function pickByType(pluginType, { warn = false } = {}) {
    const candidates = byTypeAll.get(pluginType);
    if (!candidates?.length) return null;
    const sorted = [...candidates].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (warn && sorted.length > 1) {
      console.warn(
        `[dashboards] "${pluginType}" has ${sorted.length} datasources and the dashboard `
        + `saved no selection — using "${sorted[0].name}" (${sorted[0].uid}). Others: `
        + `${sorted.slice(1).map((d) => d.name).join(', ')}. Save the datasource variable's `
        + 'value in Grafana to make this explicit.',
      );
    }
    return sorted[0];
  }

  /**
   * The dashboard's own default.
   *
   * Its first real panel reference, then a Prometheus datasource from the
   * catalog, then the catalog's first entry. Computed BEFORE the rest are
   * resolved so a dashboard stays internally consistent even when the catalog is
   * unavailable — every unresolvable reference then lands on the same place the
   * dashboard's own panels point at, rather than on nothing.
   */
  const defaultRef = (() => {
    for (const raw of collectRawRefs(dashboard)) {
      if (raw && typeof raw === 'object' && raw.uid && !isTemplateRef(raw.uid)
          && !MIXED_UIDS.has(String(raw.uid)) && !isUnqueryableRef(raw)) {
        return { uid: raw.uid, type: raw.type || byUid.get(raw.uid)?.type || DEFAULT_DS_TYPE };
      }
    }
    const prometheus = pickByType(DEFAULT_DS_TYPE);
    if (prometheus) return { uid: prometheus.uid, type: prometheus.type };
    const first = catalog[0];
    // Null rather than a made-up uid: a panel with no resolvable datasource shows
    // its own query error, which is the truth. Inventing a uid would produce a
    // confident-looking "no data" instead.
    return first ? { uid: first.uid, type: first.type } : null;
  })();

  /** Work out the concrete `{ uid, type }` a raw reference means. */
  function resolveRef(ref) {
    // 1. Nothing said -> the dashboard's default.
    if (ref === undefined || ref === null || ref === '') {
      return defaultRef;
    }

    // 2. Expressions and Grafana's own built-in: hand back untouched and marked.
    // The scene builder drops targets pointing at these rather than sending them
    // — neither can be executed through /api/ds/query.
    if (isUnqueryableRef(ref)) {
      const uid = typeof ref === 'string' ? ref : ref?.uid;
      const type = typeof ref === 'object' ? ref?.type : '__expr__';
      return { uid, type, unqueryable: true };
    }

    // 3. A bare string: either "$DS_X" or a legacy datasource NAME.
    if (typeof ref === 'string') return resolveStringRef(ref);

    // 4. An object reference `{ uid, type }`.
    return resolveObjectRef(ref);
  }

  /** The catalogue entry a `$DS_X` template reference's variable currently points at. */
  function fromTemplateVar(templateRef) {
    const varName = templateVarName(templateRef);
    const variable = varName ? dsVars.get(varName) : null;
    return fromCatalogValue(variable?.currentValue, variable?.pluginType);
  }

  /** Record a reference nothing matched and fall back to the default. */
  function fallBack(ref) {
    unresolved.push(ref);
    return defaultRef;
  }

  function resolveStringRef(ref) {
    if (isTemplateRef(ref)) {
      return fromTemplateVar(ref) || fallBack(ref);
    }
    const hit = byName.get(ref) || byUid.get(ref);
    if (hit) return { uid: hit.uid, type: hit.type };
    return fallBack(ref);
  }

  function resolveObjectRef(ref) {
    const uid = ref.uid;
    if (uid == null || uid === '') {
      const hit = ref.type ? pickByType(ref.type) : null;
      return hit ? { uid: hit.uid, type: hit.type } : defaultRef;
    }
    if (MIXED_UIDS.has(String(uid))) {
      return { uid: String(uid), type: ref.type || 'mixed', mixed: true };
    }
    if (isTemplateRef(uid)) {
      const hit = fromTemplateVar(uid)
        || (ref.type ? fromCatalogValue(null, ref.type) : null);
      return hit || fallBack(uid);
    }
    const known = byUid.get(uid);
    return { uid, type: ref.type || known?.type || DEFAULT_DS_TYPE };
  }

  // Register a proxy for every distinct concrete uid this dashboard can reach,
  // plus the default, so SceneQueryRunner never misses one at query time.
  const wanted = new Map();
  const remember = (resolved) => {
    if (resolved?.uid && !resolved.mixed && !resolved.unqueryable
        && !isUnqueryableRef(resolved)) {
      wanted.set(resolved.uid, resolved.type);
    }
  };
  remember(defaultRef);
  for (const raw of collectRawRefs(dashboard)) remember(resolveRef(raw));
  for (const [uid, type] of wanted) getProxyDataSource(uid, type);

  if (unresolved.length) {
    console.warn(
      `[dashboards] could not resolve ${[...new Set(unresolved)].join(', ')} — falling back to `
      + `${defaultRef?.uid ?? 'no datasource'}`,
    );
  }

  return { resolve: resolveRef, defaultRef, unresolved: [...new Set(unresolved)] };
}

/**
 * A minimal DataSourceSrv for anything that bypasses Scenes' own runtime registry
 * — @grafana/ui internals, default-datasource lookups. Resolving by uid through
 * the same proxy map keeps exactly one query path in the application.
 */
export function createDataSourceSrv() {
  return {
    get: async (ref) => {
      const uid = typeof ref === 'string' ? ref : ref?.uid;
      const type = typeof ref === 'object' ? ref?.type : undefined;
      if (!uid) {
        // Nothing to resolve. Rejecting is right: the caller asked for "the
        // default datasource" and this application does not have one — every
        // datasource comes from the dashboard being rendered.
        throw new Error('No datasource reference given');
      }
      return getProxyDataSource(uid, type);
    },
    getInstanceSettings: (ref) => {
      const uid = typeof ref === 'string' ? ref : ref?.uid;
      const ds = uid ? proxies.get(String(uid)) : undefined;
      return ds
        ? { uid: ds.uid, name: ds.name, type: ds.type, meta: ds.meta, jsonData: {} }
        : undefined;
    },
    getList: () => knownProxies().map((ds) => ({ uid: ds.uid, name: ds.name, type: ds.type })),
    reload: () => {},
  };
}
