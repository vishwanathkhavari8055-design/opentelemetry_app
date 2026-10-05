/**
 * THE dashboard renderer. One function turns ANY Grafana dashboard JSON into a
 * Scenes object tree:
 *
 *   EmbeddedScene
 *   ├── SceneTimeRange
 *   ├── SceneVariableSet          (interpolation only — never rendered)
 *   └── SceneGridLayout
 *       ├── SceneGridRow
 *       │   └── SceneGridItem
 *       │       └── VizPanel
 *       │           └── (SceneDataTransformer ->) SceneQueryRunner
 *       └── SceneGridItem
 *           └── VizPanel
 *               └── SceneQueryRunner
 *
 * Everything it needs — title, time range, variables, rows, panels, ids, plugin
 * ids, grid positions, options, fieldConfig, datasources, targets — is read out
 * of the JSON at runtime.
 *
 * ─── There is deliberately NO per-dashboard code anywhere ───────────────────
 *
 * Registering a UID in Settings -> Dashboard Catalog is the ENTIRE process for
 * adding a dashboard to this application. Dashboard A and dashboard B go through
 * the very same call below; nothing branches on which one is being shown. That is
 * the property to protect when editing this file.
 *
 * ─── Defensive by construction ──────────────────────────────────────────────
 *
 * A panel that cannot be built becomes one error tile; an unsupported plugin
 * becomes a placeholder; a variable that will not resolve is skipped. One bad
 * panel never costs you the other nineteen — which matters because this renders
 * dashboards authored by other teams, in Grafana, without review.
 */

import {
  ConstantVariable,
  CustomVariable,
  DataSourceVariable,
  EmbeddedScene,
  IntervalVariable,
  QueryVariable,
  SceneDataTransformer,
  SceneGridItem,
  SceneGridLayout,
  SceneGridRow,
  SceneTimeRange,
  SceneVariableSet,
  TextBoxVariable,
  VizPanel,
  sceneGraph,
} from '@grafana/scenes';
import { VariableHide } from '@grafana/data';

import {
  DEFAULT_DS_TYPE,
  getMixedProxyDataSource,
  getProxyDataSource,
  isUnqueryableRef,
  prepareDashboardDatasources,
} from './datasources';
import {
  canonicalPluginId, panelSkipsData, resolvePluginId, UNSUPPORTED_PLUGIN_ID,
} from './panelRegistry';
import { DYNAMIC_TEXT_PLUGIN_ID } from './panelDynamicText.jsx';
import { expandDashboardDatasourcePanels } from './dashboardDatasource.js';
import { AWAITS_QUERY_OPTION } from './panelAnswer.js';
import { InterpolatingQueryRunner, PROM_LIKE } from './queryRunner';
import { PROM_DEFAULT_MIN_INTERVAL, PROM_MIN_INTERVAL_TIERS } from './minInterval';

/**
 * A panel's Scene key. Derived from the Grafana panel id so a rendered panel has
 * a stable identity across re-renders and time-range changes — React reconciles
 * on it, and a key that changed per render would remount every panel (and re-run
 * every query) on every refresh.
 */
const panelKey = (id) => `panel-${id}`;
const rowKey = (id) => `row-${id}`;

/** Panels with no id of their own still need a unique, stable-per-session key. */
let anonymousPanelCounter = 0;
const nextAnonymousKey = () => `panel-anon-${anonymousPanelCounter++}`;

const DEFAULT_GRID_POS = { x: 0, y: 0, w: 12, h: 8 };

/**
 * The minimum step to impose when the panel names none of its own.
 *
 * Applied when ANY resolved target is Prometheus-like, including on a mixed
 * panel. That asymmetry is deliberate: a Prometheus target given too fine a
 * step fails the whole query, while a target of any other type given a slightly
 * coarser one still returns its data — and the other types on these dashboards
 * (Infinity, Druid) carry their own time bounds inside the query and do not read
 * the step at all.
 */
function defaultMinInterval(queries) {
  return queries.some((query) => PROM_LIKE.has(query.datasource?.type))
    ? PROM_DEFAULT_MIN_INTERVAL
    : undefined;
}

/**
 * The tier table to hand the runner, or undefined to leave its floor fixed.
 *
 * Only when the floor is OURS. A panel that names its own "Min interval" gets
 * no tiers, so nothing this file decides can override an authored value —
 * exactly as in Grafana, where a panel's "Min interval" wins outright.
 */
function minIntervalTiers(panel, queries) {
  if (panel.interval) return undefined;
  return defaultMinInterval(queries) ? PROM_MIN_INTERVAL_TIERS : undefined;
}

/**
 * Drop undefined keys.
 *
 * Scenes builds a variable's state as `{...defaults, ...yourState}`, and an
 * explicit `undefined` OVERRIDES the default rather than falling through to it.
 * Passing `intervals: undefined` to IntervalVariable would therefore wipe out its
 * built-in interval list. Stripping undefined first is what lets the builder mean
 * "only if the dashboard specified it".
 */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeFieldConfig(fieldConfig) {
  if (!fieldConfig || typeof fieldConfig !== 'object') return { defaults: {}, overrides: [] };
  return {
    defaults: fieldConfig.defaults && typeof fieldConfig.defaults === 'object'
      ? fieldConfig.defaults : {},
    overrides: Array.isArray(fieldConfig.overrides) ? fieldConfig.overrides : [],
  };
}

// ─── Queries ────────────────────────────────────────────────────────────────

/**
 * The panel's query runner, or null when there is nothing runnable to send.
 *
 * Returning null rather than an empty runner matters: a runner with no queries
 * still puts the panel into a loading-then-empty cycle, and a runner carrying an
 * unexecutable target produces a panel-wide error for a query the dashboard never
 * really meant to run.
 */
function makeQueryRunner(panel, ds) {
  const panelRef = ds.resolve(panel.datasource);
  const queries = runnableQueries(panel, ds, panelRef);

  if (!queries.length) {
    return null;
  }

  return new InterpolatingQueryRunner(compact({
    datasource: runnerDatasourceRef(queries, panelRef),
    queries,
    // Resolution must follow panel WIDTH, exactly as Grafana does. A fixed value
    // here forces a coarser step and visibly decimates every series — on these
    // dashboards a hardcoded 500 turned a 10s step into 30s and threw away two
    // thirds of every graph, while looking entirely plausible.
    maxDataPointsFromWidth: panel.maxDataPoints == null,
    maxDataPoints: panel.maxDataPoints ?? undefined,
    // The panel's own "Min interval" first, then Grafana's default for the
    // datasource type. Never nothing: see PROM_DEFAULT_MIN_INTERVAL for what an
    // unfloored, width-derived step does to a Prometheus panel on a short range.
    minInterval: panel.interval || defaultMinInterval(queries),
    // Widens that floor as the window widens. Absent (panel's own interval, or
    // a non-Prometheus panel) the runner behaves exactly as before.
    minIntervalTiers: minIntervalTiers(panel, queries),
    cacheTimeout: panel.cacheTimeout || undefined,
  }));
}

/** The panel's targets as executable queries, each carrying its resolved datasource. */
function runnableQueries(panel, ds, panelRef) {
  return (panel.targets || [])
    // Grafana skips hidden targets; running them would add phantom series to the
    // legend and the tooltip.
    .filter((target) => !target?.hide)
    .map((target, index) => {
      // A per-target datasource wins over the panel's — which is what makes a
      // "-- Mixed --" panel work with no special-casing anywhere.
      const targetRef = target?.datasource !== undefined
        ? ds.resolve(target.datasource) : panelRef;
      return {
        refId: target?.refId || String.fromCodePoint(65 + index),
        ...target,
        datasource: targetRef,
      };
    })
    // Drop what cannot be executed: server-side expressions, and Grafana's own
    // built-in datasource. Both answer /api/ds/query with an error, and both
    // appear in real dashboards on panels that are otherwise fine — a text
    // panel's vestigial target is the common one.
    .filter((query) => !query.datasource?.unqueryable
      && !isUnqueryableRef(query.datasource));
}

/** The datasource the runner itself points at, registering the proxies it needs. */
function runnerDatasourceRef(queries, panelRef) {
  // ── One datasource, or several? ───────────────────────────────────────────
  //
  // Decided from the RESOLVED targets rather than from the panel's own
  // `-- Mixed --` marker, because the two do not always agree and it is the
  // targets that get executed: a mixed panel whose targets all resolve to one
  // datasource is a plain panel, and a panel with no marker at all can still
  // carry targets from two of them.
  //
  // The distinction is not cosmetic. SceneQueryRunner rewrites any target whose
  // datasource disagrees with the runner's, so a runner pointed at one of
  // several sends every target there — silently, and to a datasource that
  // answers with nothing rather than with an error. That is what left the OSS
  // Engine Overview KPI row showing "--" for its Prometheus-backed numbers
  // while its Infinity-backed ones were fine.
  const distinctUids = new Set(
    queries.map((query) => query.datasource?.uid).filter(Boolean),
  );

  if (distinctUids.size > 1) {
    // Every uid needs its own proxy: the mixed runner does not query through
    // them, but Scenes resolves the refs on the targets and would otherwise hit
    // an unregistered uid.
    for (const query of queries) {
      if (query.datasource?.uid) {
        getProxyDataSource(query.datasource.uid, query.datasource.type);
      }
    }
    return getMixedProxyDataSource().getRef();
  }
  // Make sure a proxy exists for whatever we ended up pointing at.
  const effectiveRef = queries[0]?.datasource ?? panelRef;
  if (effectiveRef?.uid && !effectiveRef.mixed) {
    getProxyDataSource(effectiveRef.uid, effectiveRef.type);
  }
  return effectiveRef?.mixed ? undefined : effectiveRef;
}

/**
 * The panel's data provider: the query runner, wrapped in a transformer when the
 * panel declares transformations. Transformations are registered globally (see
 * ./transformations.js); an unknown one is skipped by @grafana/data rather than
 * throwing.
 */
function makeDataProvider(panel, ds) {
  const runner = makeQueryRunner(panel, ds);
  if (!runner) return undefined;
  const transformations = Array.isArray(panel.transformations) ? panel.transformations : [];
  if (!transformations.length) return runner;
  return new SceneDataTransformer({ $data: runner, transformations });
}

// ─── Panels ─────────────────────────────────────────────────────────────────

function makeVizPanel(panel, ds) {
  const pluginId = resolvePluginId(panel.type, panel.title);
  const unsupported = pluginId === UNSUPPORTED_PLUGIN_ID;

  // A library panel arrives as a STUB with no type and no targets — Grafana
  // resolves it at render time, which this renderer does not do. Say so plainly
  // instead of rendering an empty tile that looks like missing data.
  const isLibraryPanel = !!panel.libraryPanel;

  const options = baseVizOptions(panel, unsupported || isLibraryPanel, isLibraryPanel);

  if (panel.repeat) warnRepeat(panel);

  // No data provider for a panel that renders none. Three cases: the
  // placeholder (must not fire a query it cannot render), a library panel
  // (a stub with no real targets), and a panel type that is static by nature
  // — a text panel still carries a `targets` array, and running it is what
  // turned static text into an error tile. See panelRegistry.panelSkipsData.
  const $data = unsupported || isLibraryPanel || panelSkipsData(pluginId)
    ? undefined
    : makeDataProvider(panel, ds);

  return new VizPanel({
    key: panel.id != null ? panelKey(panel.id) : nextAnonymousKey(),
    pluginId: isLibraryPanel ? UNSUPPORTED_PLUGIN_ID : pluginId,
    title: panel.title || '',
    description: panel.description || undefined,
    // A dynamic text panel with a query holds its script until that query has
    // answered — see AWAITS_QUERY_OPTION. Only this renderer knows whether there
    // IS a query: Scenes hands a panel that has not queried yet exactly what it
    // hands one that never will, `{ state: Done, series: [] }`.
    options: $data ? withQueryAwait(options, pluginId) : options,
    fieldConfig: normalizeFieldConfig(panel.fieldConfig),
    displayMode: panel.transparent ? 'transparent' : 'default',
    // Grafana's own rule for an untitled panel: no header row, just one that
    // appears on hover. Without it every untitled panel reserves an empty strip
    // above its content — which is what pushed OSS Engine Overview's KPI row,
    // Service Health table and Alerts list down and clipped their bottoms. The
    // time overrides keep the header because it is where their badge is shown.
    hoverHeader: !panel.title && !panel.timeFrom && !panel.timeShift,
    $data,
  });
}

/** The panel's own options, or the placeholder's description of what it stands in for. */
function baseVizOptions(panel, placeholder, isLibraryPanel) {
  if (placeholder) {
    return {
      originalPluginId: isLibraryPanel
        ? `library panel "${panel.libraryPanel?.name ?? ''}"`
        : panel.type,
    };
  }
  return panel.options && typeof panel.options === 'object' ? panel.options : {};
}

/**
 * Repeats are a Grafana-side expansion this renderer does not perform. The
 * panel still renders, just once. Worth knowing about, not worth failing over.
 */
function warnRepeat(panel) {
  console.info(
    `[dashboards] panel "${panel.title || panel.id}" repeats over "$${panel.repeat}" — `
    + 'rendering a single instance.',
  );
}

/** A queried dynamic text panel holds its script until the query answers. */
function withQueryAwait(options, pluginId) {
  return canonicalPluginId(pluginId) === DYNAMIC_TEXT_PLUGIN_ID
    ? { ...options, [AWAITS_QUERY_OPTION]: true }
    : options;
}

/** A tile reporting a panel this renderer could not build at all. */
function makeBrokenPanel(panel, err) {
  console.error(`[dashboards] could not build panel "${panel?.title ?? panel?.id}"`, err);
  return new VizPanel({
    key: panel?.id != null ? panelKey(panel.id) : nextAnonymousKey(),
    pluginId: UNSUPPORTED_PLUGIN_ID,
    title: panel?.title || 'Panel',
    options: {
      originalPluginId: `${panel?.type ?? 'unknown'} — ${err?.message ?? 'build failed'}`,
    },
    fieldConfig: { defaults: {}, overrides: [] },
  });
}

function makeGridItem(panel, ds) {
  const pos = typeof panel?.gridPos === 'object'
    ? panel.gridPos : DEFAULT_GRID_POS;
  let body;
  try {
    body = makeVizPanel(panel, ds);
  } catch (err) {
    body = makeBrokenPanel(panel, err);
  }
  return new SceneGridItem({
    x: pos.x ?? 0,
    y: pos.y ?? 0,
    width: pos.w ?? DEFAULT_GRID_POS.w,
    height: pos.h ?? DEFAULT_GRID_POS.h,
    body,
  });
}

// ─── Layout ─────────────────────────────────────────────────────────────────

function makeGridRow(panel, ds) {
  const pos = panel.gridPos || {};
  const collapsed = !!panel.collapsed;
  return new SceneGridRow({
    key: panel.id != null ? rowKey(panel.id) : undefined,
    title: panel.title || '',
    y: pos.y ?? 0,
    isCollapsible: true,
    isCollapsed: collapsed,
    children: collapsed ? (panel.panels || []).map((p) => makeGridItem(p, ds)) : [],
  });
}

/**
 * Build the grid children, preserving rows as real collapsible sections.
 *
 * Per the dashboard schema an EXPANDED row owns the panels that follow it at the
 * top level (until the next row), while a COLLAPSED row carries them inline in
 * `row.panels`. Getting this wrong is not subtle in one direction and very subtle
 * in the other: treat a collapsed row as expanded and it adopts the next row's
 * panels, silently moving twenty panels into the wrong section.
 */
function buildLayoutChildren(panels, ds) {
  const children = [];
  let currentRow = null;

  for (const panel of panels || []) {
    if (!panel || typeof panel !== 'object') continue;

    if (panel.type === 'row') {
      const row = makeGridRow(panel, ds);
      children.push(row);
      // A collapsed row's panels live inline, so it must NOT adopt whatever
      // follows it at the top level.
      currentRow = panel.collapsed ? null : row;
      continue;
    }

    const item = makeGridItem(panel, ds);
    if (currentRow) {
      currentRow.setState({ children: [...currentRow.state.children, item] });
    } else {
      children.push(item);
    }
  }

  return children;
}

// ─── Variables ──────────────────────────────────────────────────────────────

function variableHide(variable) {
  switch (variable.hide) {
    case 1:
    case 'label':
      return VariableHide.hideLabel;
    case 2:
    case 'variable':
      return VariableHide.hideVariable;
    default:
      return VariableHide.dontHide;
  }
}

/** A variable's saved current selection, if it has a usable one. */
function currentValue(variable) {
  const current = variable?.current;
  if (current?.value === undefined || current?.value === null || current?.value === '') {
    return undefined;
  }
  return current.value;
}

/**
 * Dashboard template variables -> Scenes variables.
 *
 * This is what makes `host="$host"` become `host="actual-host"` before a query
 * leaves the browser (see ./queryRunner.js). Without a variable set the literal
 * "$host" reaches the datasource and the panel returns NOTHING while looking
 * perfectly healthy — the single most confusing failure mode in this stack.
 *
 * Every Grafana variable type is handled. An unknown type is skipped with a
 * warning rather than throwing: a dashboard with one exotic variable still
 * renders everything else.
 */
function buildVariables(dashboard, ds) {
  const list = dashboard?.templating?.list || [];
  const variables = [];

  for (const variable of list) {
    if (!variable?.name) continue;
    try {
      const built = buildVariable(variable, ds);
      if (built) variables.push(built);
    } catch (err) {
      // A variable that cannot be built must not take the dashboard with it.
      // Panels depending on it will show their own query error.
      console.error(`[dashboards] could not build variable "${variable.name}"`, err);
    }
  }

  return variables.length ? new SceneVariableSet({ variables }) : undefined;
}

/** One dashboard variable -> its Scenes variable, or undefined when it is skipped. */
function buildVariable(variable, ds) {
  const common = {
    name: variable.name,
    label: variable.label || undefined,
    description: variable.description || undefined,
    hide: variableHide(variable),
  };
  const queryText = typeof variable.query === 'string'
    ? variable.query : variable.query?.query ?? '';

  const builder = Object.hasOwn(VARIABLE_BUILDERS, variable.type)
    ? VARIABLE_BUILDERS[variable.type] : undefined;
  if (builder) return builder(variable, common, queryText, ds);

  console.warn(
    `[dashboards] variable "${variable.name}" has unsupported type `
    + `"${variable.type}" — skipped.`,
  );
  return undefined;
}

/** Scenes variable builders, keyed by Grafana variable type. */
const VARIABLE_BUILDERS = {
  query: (variable, common, queryText, ds) => new QueryVariable(compact({
    ...common,
    datasource: ds.resolve(variable.datasource),
    // The query AS SAVED — an object stays an object. Only Prometheus
    // stores a string; Neo4j, SQL, Druid and Infinity store their own
    // query model, and flattening that to its `.query` key (which most
    // of them do not have) sent an empty string and left the variable
    // with no options. See ./variableQuery.js.
    query: variable.query && typeof variable.query === 'object'
      ? variable.query : queryText,
    regex: variable.regex || '',
    // Grafana encodes refresh as 0=never, 1=on load, 2=on time change.
    refresh: variable.refresh ?? 1,
    sort: variable.sort ?? 0,
    isMulti: !!variable.multi,
    includeAll: !!variable.includeAll,
    allValue: variable.allValue || undefined,
    // Restore the dashboard's saved selection; otherwise start on "All"
    // when the dashboard offers it, matching a fresh Grafana load.
    value: currentValue(variable) ?? (variable.includeAll ? '$__all' : undefined),
  })),

  custom: (variable, common, queryText) => new CustomVariable(compact({
    ...common,
    query: queryText,
    isMulti: !!variable.multi,
    includeAll: !!variable.includeAll,
    allValue: variable.allValue || undefined,
    value: currentValue(variable),
  })),

  textbox: (variable, common, queryText) => new TextBoxVariable(compact({
    ...common,
    value: currentValue(variable) ?? queryText ?? '',
  })),

  constant: (variable, common, queryText) => new ConstantVariable(compact({
    ...common,
    hide: VariableHide.hideVariable, // constants are never pickable
    value: queryText || currentValue(variable) || '',
  })),

  interval: (variable, common, queryText) => new IntervalVariable(compact({
    ...common,
    intervals: queryText
      ? queryText.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    value: currentValue(variable),
    autoEnabled: !!variable.auto,
    autoMinInterval: variable.auto_min || undefined,
    autoStepCount: variable.auto_count || undefined,
  })),

  datasource: (variable, common, queryText, ds) => {
    // Datasource references were already resolved to concrete UIDs when the
    // scene was built, so this variable only matters for TEXT that spells it
    // out (`$DS_PROM` inside a query string). A DataSourceVariable keeps it
    // pickable; if that cannot be built, a constant at least interpolates.
    const pluginId = typeof variable.query === 'string'
      ? variable.query : variable.query?.type;
    try {
      return new DataSourceVariable(compact({
        ...common,
        pluginId,
        regex: variable.regex || '',
        value: currentValue(variable),
      }));
    } catch {
      return new ConstantVariable(compact({
        ...common,
        hide: VariableHide.hideVariable,
        value: String(currentValue(variable) ?? ds.defaultRef?.uid ?? ''),
      }));
    }
  },

  adhoc: (variable) => {
    // Ad-hoc filters need datasource-specific tag key/value lookups the
    // proxy does not implement. Skipping keeps the dashboard usable.
    console.warn(
      `[dashboards] ad-hoc filter variable "${variable.name}" is not supported — skipped.`,
    );
    return undefined;
  },
};

// ─── The builder ────────────────────────────────────────────────────────────

/**
 * Convert a Grafana dashboard JSON model into a Scenes EmbeddedScene.
 *
 * @param {object} dashboard  dashboard JSON, exactly as Grafana returns it
 * @param {object} datasources resolver from prepareDashboardDatasources()
 * @returns {EmbeddedScene}
 */
export function buildDashboardScene(source, datasources) {
  if (!source || typeof source !== 'object') {
    throw new Error('Invalid dashboard JSON: expected an object.');
  }
  // `-- Dashboard --` panels take their source panel's query. Idempotent, and a
  // no-op returning the same object for a dashboard that uses none.
  const dashboard = expandDashboardDatasourcePanels(source);
  if (dashboard.panels != null && !Array.isArray(dashboard.panels)) {
    throw new Error('Invalid dashboard JSON: "panels" must be an array.');
  }

  const ds = datasources ?? {
    // Only reachable if a caller skips prepareDashboardDatasources(). Takes
    // explicit { uid, type } references at face value; cannot resolve names or
    // ${DS_X}, which is why the async path below is what the app actually uses.
    defaultRef: null,
    resolve: (ref) => (typeof ref === 'object' && ref?.uid && !String(ref.uid).includes('$')
      ? { uid: ref.uid, type: ref.type || DEFAULT_DS_TYPE }
      : null),
  };

  const timeRange = new SceneTimeRange(compact({
    from: dashboard.time?.from || 'now-6h',
    to: dashboard.time?.to || 'now',
    timeZone: dashboard.timezone && dashboard.timezone !== '' ? dashboard.timezone : undefined,
    weekStart: dashboard.weekStart || undefined,
  }));

  const variables = buildVariables(dashboard, ds);

  const scene = new EmbeddedScene({
    $timeRange: timeRange,
    $variables: variables,
    // NO controls, deliberately. The time picker and the refresh control live in
    // THIS application's own toolbar (DashboardToolbar), and the variable row is
    // not rendered either — so the user never sees any Grafana chrome, only panels.
    //
    // `$variables` above is still built and still ACTIVE: hiding the row removes
    // the pickers, not the variables. Every `$service` / `$DS_X` in a query is
    // interpolated exactly as before, from the dashboard's saved current values.
    // (Dropping the variable set instead would send the literal "$service" to the
    // datasource and every panel would go quietly empty — see buildVariables().)
    //
    // The trade: a variable a viewer used to be able to change is now fixed at the
    // value Grafana has saved for it. Dashboards here are read-only renderings of
    // what Grafana holds, so that value is the authored one; change it in Grafana.
    controls: undefined,
    body: new SceneGridLayout({
      // Read-only: this application renders dashboards, it does not author them.
      // Grafana remains the single place a dashboard is edited, which is what
      // stops the two from ever disagreeing about a panel.
      isDraggable: false,
      isResizable: false,
      // Query a panel when it first scrolls into view, not on open. These
      // dashboards run to 37 panels (Airflow) and 33 (Trino, MinIO) against a
      // screen that holds about six, so opening one fired thirty-odd queries for
      // panels nobody had looked at yet — through a browser that will only carry
      // six at a time, so the visible ones queued behind the invisible ones.
      //
      // Scenes' LazyLoader latches: a panel that has loaded STAYS loaded and
      // keeps its data when it scrolls back off, so this defers the first query
      // and never re-fires one. It observes with a 100px margin, so a panel is
      // already loading by the time it reaches the edge of the viewport.
      //
      // Nothing here waits for "all panels loaded": the toolbar's spinner
      // tracks the DEFINITION fetch, each panel reports its own state, and no
      // panel reads another's result (variables interpolate from the values
      // Grafana saved). There is no export or snapshot path to miss the panels
      // that have not rendered yet — the one feature this would quietly break.
      isLazy: true,
      children: buildLayoutChildren(dashboard.panels, ds),
    }),
  });

  // Handles the app's toolbar reaches for. Kept OFF scene state deliberately —
  // they are application plumbing, not part of the scene model.
  //
  // NOTE: do not read `__timeRange` to DRIVE the scene. Use sceneTimeRangeOf()
  // below, which asks the scene graph. See its note for why the difference bites.
  scene.__timeRange = timeRange;
  scene.__dashboardUid = dashboard.uid;
  scene.__dashboardTitle = dashboard.title;
  scene.__defaultTime = {
    from: dashboard.time?.from || 'now-6h',
    to: dashboard.time?.to || 'now',
  };
  scene.__defaultRefresh = dashboard.refresh || '';

  return scene;
}

/**
 * The scene's LIVE time range — the object its panels actually read.
 *
 * Always ask the scene graph rather than reading a handle stashed at build time.
 * `sceneGraph.getTimeRange()` resolves the same object a SceneQueryRunner resolves
 * when it builds a request, which is the only object worth writing to: a stashed
 * reference is correct only as long as nothing in the graph re-parents or replaces
 * `$timeRange`, and when that assumption breaks it breaks SILENTLY. The toolbar's
 * picker moves, the write lands on an orphaned object, no panel re-queries, and
 * the control simply appears not to work.
 *
 * Returns undefined for a scene that has none, so callers can fall back rather
 * than throw.
 */
export function sceneTimeRangeOf(scene) {
  if (!scene) return undefined;
  try {
    return sceneGraph.getTimeRange(scene);
  } catch (err) {
    // Only reachable for a scene with no time range in its ancestry, which this
    // builder always provides — so this is a guard, not a path.
    console.warn('[dashboards] scene has no resolvable time range', err);
    return scene.__timeRange;
  }
}

/**
 * The same builder, with datasource resolution done first.
 *
 * Resolving `${DS_X}` variables and legacy datasource NAMES needs the live
 * datasource catalog, which is a network call — so this async wrapper is what the
 * application calls.
 */
export async function buildDashboardSceneAsync(source) {
  // Expanded BEFORE datasource preparation, so the proxies registered are the
  // ones the `-- Dashboard --` panels will actually query through.
  const dashboard = expandDashboardDatasourcePanels(source);
  const datasources = await prepareDashboardDatasources(dashboard);
  return buildDashboardScene(dashboard, datasources);
}
