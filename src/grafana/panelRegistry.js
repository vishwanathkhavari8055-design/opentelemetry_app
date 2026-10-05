// ---------------------------------------------------------------------------
// Panel plugin registry.
//
// The single place that decides which Grafana panel plugin ids this app can
// render. `buildDashboardScene` asks this module and nothing else, so adding
// support for a new visualization is:
//
//   1. write the renderer + PanelPlugin (grafana/panelsExtra.jsx, or its own
//      module when it needs more than a component — grafana/panelDynamicText.jsx),
//   2. add one line to PANEL_PLUGINS below.
//
// No dashboard-specific code is involved at any point, and no dashboard needs
// to change. Anything not listed here renders as the unsupported placeholder,
// with its plugin id logged once — the dashboard's other panels are unaffected.
// ---------------------------------------------------------------------------

import { sceneUtils } from '@grafana/scenes';

import { timeseriesPanelPlugin, statPanelPlugin } from './panels.jsx';
import {
  tablePanelPlugin,
  gaugePanelPlugin,
  barGaugePanelPlugin,
  pieChartPanelPlugin,
  barChartPanelPlugin,
  textPanelPlugin,
  unsupportedPanelPlugin,
  reportUnsupportedPanel,
  UNSUPPORTED_PLUGIN_ID,
} from './panelsExtra.jsx';
import { dynamicTextPanelPlugin, DYNAMIC_TEXT_PLUGIN_ID } from './panelDynamicText.jsx';

export { UNSUPPORTED_PLUGIN_ID, reportUnsupportedPanel };

/** Grafana plugin id -> the PanelPlugin that renders it. */
const PANEL_PLUGINS = {
  timeseries: timeseriesPanelPlugin,
  stat: statPanelPlugin,
  table: tablePanelPlugin,
  gauge: gaugePanelPlugin,
  bargauge: barGaugePanelPlugin,
  piechart: pieChartPanelPlugin,
  barchart: barChartPanelPlugin,
  text: textPanelPlugin,
  // The community "Dynamic Text" / "Business Text" panel: a Handlebars template
  // plus the panel author's own script, both run inside a sandboxed iframe. See
  // ./panelDynamicText.jsx for why the sandbox and what it costs.
  [DYNAMIC_TEXT_PLUGIN_ID]: dynamicTextPanelPlugin,
};

/**
 * Legacy / renamed plugin ids that a modern renderer handles faithfully enough
 * to use directly. These are Grafana's own successor mappings — the angular
 * "graph" panel became "timeseries", "singlestat" became "stat", and so on —
 * so an older dashboard renders rather than showing a placeholder.
 */
const PLUGIN_ALIASES = {
  graph: 'timeseries',
  'graph-old': 'timeseries',
  singlestat: 'stat',
  'grafana-singlestat-panel': 'stat',
  'table-old': 'table',
};

/**
 * Panels that render no data, and must therefore not be given a query runner.
 *
 * Grafana marks these with `skipDataQuery` in the plugin's own meta, which is not
 * something a runtime-registered PanelPlugin can express — so the list lives here
 * and {@link panelSkipsData} is what the scene builder asks.
 *
 * This is not an optimisation. A text panel in a real dashboard still carries a
 * `targets` array, and its datasource is usually Grafana's built-in
 * `{ type: 'datasource', uid: 'grafana' }` — which answers a query with HTTP 400
 * "unknown query type". Running it therefore turned a perfectly good static text
 * panel into an error tile, complete with the red status button Grafana puts in a
 * failed panel's header. The panel had nothing to query in the first place.
 */
const SKIP_DATA_PLUGINS = new Set([
  'text',
  UNSUPPORTED_PLUGIN_ID,
]);

/**
 * Whether this plugin renders without data.
 *
 * @param {string} pluginId a canonical or alias plugin id
 */
export function panelSkipsData(pluginId) {
  return SKIP_DATA_PLUGINS.has(canonicalPluginId(pluginId));
}

let registered = false;

/** Register every renderer with Scenes. Idempotent. */
export function registerPanelPlugins() {
  if (registered) return;
  registered = true;

  for (const [pluginId, plugin] of Object.entries(PANEL_PLUGINS)) {
    sceneUtils.registerRuntimePanelPlugin({ pluginId, plugin });
  }
  sceneUtils.registerRuntimePanelPlugin({
    pluginId: UNSUPPORTED_PLUGIN_ID,
    plugin: unsupportedPanelPlugin,
  });
}

/** Plugin ids this app can render, for the UI to advertise. */
export function supportedPanelTypes() {
  return Object.keys(PANEL_PLUGINS);
}

/** Resolve an alias to its canonical id (or return the id unchanged). */
export function canonicalPluginId(pluginId) {
  const id = String(pluginId || '');
  return PLUGIN_ALIASES[id] ?? id;
}

export function isPanelSupported(pluginId) {
  return Object.hasOwn(PANEL_PLUGINS, canonicalPluginId(pluginId));
}

/**
 * The plugin id a panel should actually be rendered with.
 *
 * Returns the canonical id when supported, otherwise the placeholder id — and
 * logs the unsupported plugin exactly once so it is visible without flooding
 * the console on a dashboard with twenty of them.
 */
export function resolvePluginId(pluginId, panelTitle) {
  const canonical = canonicalPluginId(pluginId);
  if (Object.hasOwn(PANEL_PLUGINS, canonical)) {
    return canonical;
  }
  reportUnsupportedPanel(pluginId, panelTitle);
  return UNSUPPORTED_PLUGIN_ID;
}
