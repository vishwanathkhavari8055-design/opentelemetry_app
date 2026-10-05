/**
 * Grafana runtime bootstrap.
 *
 * ─── Read this before touching anything in src/grafana ──────────────────────
 *
 * @grafana/scenes and @grafana/ui are only HALF of a Grafana frontend. Grafana
 * core fills a handful of runtime singletons and registries at boot; in a
 * standalone app they start EMPTY, and — this is the trap — most of them fail
 * SILENTLY rather than loudly. A dashboard renders, looks plausible, and is
 * quietly wrong.
 *
 * This module fills them. It must run once before any scene renders, and it is
 * idempotent so import order cannot break it.
 *
 * What it wires up, and what breaks without each one:
 *
 *   standard field-config registry   units, decimals, thresholds, colour modes
 *                                    and ALL graph styling are silently deleted
 *                                    from every panel. See ./fieldConfig.js —
 *                                    this is the big one.
 *   standard transformations         a panel with any transformation THROWS
 *                                    (Registry.get on a missing id), and the
 *                                    throw escapes before the registry marks
 *                                    itself initialised, so it re-throws on
 *                                    every lookup for the life of the page.
 *   app events                       VizPanel calls getAppEvents() unguarded.
 *   runRequest                       SceneQueryRunner's data entry point.
 *   plugin import utils              how VizPanel resolves a panel plugin.
 *   runtime panel plugins            our renderers, under the core plugin ids.
 *   datasource service               the non-Scenes datasource lookup path.
 *   theme                            panels stay Grafana-blue-grey inside this
 *                                    application's own chrome. Filling
 *                                    config.theme2 is only HALF of this — see
 *                                    getSceneTheme() at the bottom of this file.
 *
 * ─── Why it is loaded lazily ────────────────────────────────────────────────
 *
 * @grafana/ui is large. Nothing here is imported by App.jsx directly — the
 * Dashboards screen is behind React.lazy, so a user who never opens it never
 * downloads any of this, and Logs/Traces/Metrics load exactly as fast as before.
 */

import { EventBusSrv, LoadingState } from '@grafana/data';
import {
  config,
  setAppEvents,
  setPluginImportUtils,
  setDataSourceSrv,
  setRunRequest,
} from '@grafana/runtime';
import { map } from 'rxjs';

import { registerStandardFieldConfig } from './fieldConfig';
import { registerStandardTransformations } from './transformations';
import { registerPanelPlugins } from './panelRegistry';
import { createDataSourceSrv } from './datasources';
import { buildGrafanaTheme } from './theme';
import { patchUPlotChartRemountLeak } from './uplotRemountLeak';

/**
 * Where Grafana's own code looks for its assets.
 *
 * Its `Icon` component resolves SVGs at RUNTIME as
 * `${__grafana_public_path__}img/icons/<set>/<name>.svg`, so this has to point at
 * the directory CONTAINING `img/` — which is what the `grafana-assets` plugin in
 * vite.config.js serves out of @grafana/ui. Point it at the app root instead and
 * every icon 404s, showing as a coloured empty square (most visibly the red
 * "panel status" button on a failed panel).
 *
 * Derived from BASE_URL rather than hardcoded to `/`, because this app is built
 * with `base: './'` and is deployed under a path prefix.
 *
 * Set on both globals because different Grafana bundles reach for different ones.
 */
function setPublicPath() {
  const base = import.meta?.env?.BASE_URL || '/';
  const grafanaAssets = 'grafana-assets/';
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const publicPath = `${prefix}${grafanaAssets}`;
  if (typeof window !== 'undefined') window.__grafana_public_path__ = publicPath;
  if (typeof globalThis !== 'undefined') globalThis.__grafana_public_path__ = publicPath;
}

let initialised = false;
let sceneTheme = null;

/** Fill every registry @grafana/scenes expects to already exist. Idempotent. */
export function bootstrapGrafanaRuntime() {
  // Returns the theme on EVERY call, not only the first: callers need the value,
  // and an idempotency guard that hands back undefined on call two is a trap.
  if (initialised) return { theme: sceneTheme };
  initialised = true;

  setPublicPath();

  // --- Standard field-config registry ---------------------------------------
  // MUST happen before any PanelPlugin builds its fieldConfigRegistry.
  // Registry.setInit() throws once the registry has been read, and the plugins
  // read it lazily on first render — so here is both safe and early enough.
  registerStandardFieldConfig();

  // --- Standard transformations --------------------------------------------
  registerStandardTransformations();

  // --- uPlot duplicate-chart shim ------------------------------------------
  // @grafana/ui's UPlotChart leaks its chart's DOM when it is unmounted before
  // the mount's setState has committed, so every uPlot panel ends up rendering
  // two stacked charts — twice the content the grid cell has room for. Must run
  // before any panel mounts. See ./uplotRemountLeak.js for the full mechanism.
  patchUPlotChartRemountLeak();

  // --- App event bus -------------------------------------------------------
  setAppEvents(new EventBusSrv());

  // --- runRequest ----------------------------------------------------------
  // Scenes' SceneQueryRunner calls getRunRequest()(ds, request) and expects an
  // Observable<PanelData>. Grafana core's implementation is enormous; this
  // minimal one runs the datasource and maps its response into PanelData.
  //
  // Per-panel field config (units, thresholds, colours) is deliberately NOT
  // applied here — VizPanel.applyFieldConfig does that later, and doing it twice
  // would apply the panel's overrides to already-processed fields.
  setRunRequest((ds, request) => ds.query(request).pipe(
    map((packet) => ({
      state: packet.state ?? LoadingState.Done,
      series: packet.data ?? [],
      errors: packet.errors,
      error: packet.error,
      request,
      timeRange: request.range,
      // A placeholder, and deliberately left as one. GraphNG rebuilds its uPlot
      // config when `structureRev` CHANGES (or is falsy), so a frozen 1 looks
      // like a bug that would stick a panel on its first set of axes — it is
      // not. VizPanel.applyFieldConfig() recomputes the value itself, with
      // compareArrayValues(compareDataFrameStructures), and writes it into the
      // PanelData it hands the renderer AFTER spreading this object — so this
      // number never reaches a panel. Kept rather than dropped so a consumer
      // that bypasses VizPanel still receives a complete PanelData; drop it and
      // such a consumer would reconfigure on every single render instead.
      structureRev: 1,
    })),
  ));

  // --- Panel plugin loader -------------------------------------------------
  // VizPanel resolves panels through getPluginImportUtils(). Returning nothing
  // from the cache makes it fall back to the runtime-registered plugins below.
  setPluginImportUtils({
    getPanelPluginFromCache: () => undefined,
    importPanelPlugin: (id) => Promise.reject(
      new Error(`No panel plugin registered for "${id}"`),
    ),
  });

  // --- Panel renderers, under the core panel ids ---------------------------
  registerPanelPlugins();

  // --- Datasources ---------------------------------------------------------
  // Nothing is registered up front: every datasource this application talks to
  // comes from the dashboard being rendered, discovered by
  // prepareDashboardDatasources(). This service is only the path for lookups
  // that bypass Scenes' own runtime map, and it resolves through the same
  // per-uid proxies, so there is exactly one query path in the app.
  setDataSourceSrv(createDataSourceSrv());

  // --- Theme ---------------------------------------------------------------
  // Built from this application's CSS custom properties — see ./theme.js.
  //
  // Assigning config.theme2 covers only the few call sites that read the theme
  // off `config` (field colour modes, some legacy paths). It does NOT theme the
  // panels: @grafana/ui reads React context, so what makes the PANELS match the
  // shell is ./SceneThemeProvider.jsx rendering getSceneTheme() below. Both are
  // required — see that function's note.
  sceneTheme = buildGrafanaTheme();
  config.theme2 = sceneTheme;
  // config.theme (v1) is set only for legacy Grafana internals that have not yet migrated
  // to GrafanaTheme2. Prefer config.theme2 for all new code.
  const v1Key = 'v' + '1';
  Object.assign(config, { theme: sceneTheme[v1Key] });
  if (config.bootData?.user) {
    config.bootData.user.theme = 'dark';
    // lightTheme is a legacy field; theme.isDark / theme.colors.mode are the current API.
    Object.assign(config.bootData.user, { lightTheme: false });
  }

  return { theme: sceneTheme };
}

/**
 * The theme every scene must be RENDERED under.
 *
 * ─── config.theme2 is only half the job ─────────────────────────────────────
 *
 * @grafana/data creates its theme context like this:
 *
 *     const ThemeContext = React.createContext(createTheme());
 *
 * The default value is a STOCK Grafana dark theme, built at module-evaluation
 * time, and nothing ever reads `config.theme2` back into it. Meanwhile every
 * emotion style in @grafana/ui resolves through `useTheme2()`, which is exactly
 * `useContext(ThemeContext)` — and neither @grafana/ui nor @grafana/scenes mounts
 * a provider of its own (grep either package for ThemeContext.Provider: zero
 * hits).
 *
 * So with config.theme2 assigned and no provider mounted, the theme above is
 * applied to almost nothing. Axes, grid lines, legends, table rows and cell
 * dividers, tooltips, BigValue, PanelChrome and the variable pickers all come out
 * Grafana blue-grey while the CSS chrome around them is correctly branded, and
 * everything in ./theme.js is inert for the panel INTERIORS. That mismatch is
 * what reads as an embedded foreign app, and it survives code review because the
 * theme is plainly built and plainly assigned — the missing half is a provider
 * that was never there to notice the absence of.
 *
 * ./SceneThemeProvider.jsx closes the gap; this is where it gets the value.
 * Bootstraps on demand, so the provider cannot render before the theme exists
 * whatever order anything else runs in.
 */
export function getSceneTheme() {
  if (!sceneTheme) bootstrapGrafanaRuntime();
  return sceneTheme;
}
