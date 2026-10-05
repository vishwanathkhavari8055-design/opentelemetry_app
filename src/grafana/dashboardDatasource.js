/**
 * Grafana's `-- Dashboard --` datasource: a panel that reuses ANOTHER panel's
 * query results instead of running its own.
 *
 * In Grafana this is a browser-side datasource — the panel subscribes to the
 * source panel's results and never reaches /api/ds/query. It is saved as
 *
 *     "datasource": { "type": "datasource", "uid": "-- Dashboard --" },
 *     "targets": [{ "panelId": 4, "withTransforms": true, … }]
 *
 * and nothing in that reference can be sent to Grafana: the `datasource` type is
 * how Grafana spells its own built-ins, so this renderer dropped the targets as
 * unqueryable and the panel came up empty.
 *
 * Resolved here, before the scene is built, by giving the panel the source
 * panel's datasource and targets (and, with `withTransforms`, its
 * transformations first). The result is one extra query rather than a shared
 * one — the same data, from the same datasource, read out of the dashboard as it
 * stands in Grafana right now, so repointing the source panel repoints this one.
 *
 * Pure, and free of @grafana imports, so `npm test` can pin it down directly.
 */

const DASHBOARD_UIDS = new Set(['-- Dashboard --', 'dashboard']);

/** Whether a datasource reference is Grafana's `-- Dashboard --`. */
export function isDashboardDatasourceRef(ref) {
  const uid = typeof ref === 'string' ? ref : ref?.uid;
  return uid != null && DASHBOARD_UIDS.has(String(uid));
}

function collectById(panels, byId) {
  for (const panel of panels || []) {
    if (panel && typeof panel === 'object') {
      if (panel.id != null) byId.set(String(panel.id), panel);
      collectById(panel.panels, byId);
    }
  }
  return byId;
}

/**
 * One panel, with a `-- Dashboard --` reference replaced by its source's query.
 *
 * Follows a chain (A reuses B which reuses C) up to a fixed depth, and leaves the
 * panel exactly as it was when the source is missing or the chain loops — it
 * then renders with no data, which is also what Grafana shows for a dangling
 * reference.
 */
function resolvePanel(panel, byId, depth = 0) {
  if (!panel || typeof panel !== 'object' || depth > 8) return panel;
  const targets = Array.isArray(panel.targets) ? panel.targets : [];
  const reusing = isDashboardDatasourceRef(panel.datasource)
    || (targets.length > 0 && targets.every((t) => isDashboardDatasourceRef(t?.datasource)));
  if (!reusing) return panel;

  const link = targets.find((t) => t?.panelId != null);
  if (!link) return panel;
  const found = byId.get(String(link.panelId));
  if (!found || found === panel) return panel;
  const source = resolvePanel(found, byId, depth + 1);
  if (isDashboardDatasourceRef(source.datasource)) return panel;

  const inherited = link.withTransforms && Array.isArray(source.transformations)
    ? source.transformations : [];
  const own = Array.isArray(panel.transformations) ? panel.transformations : [];

  return {
    ...panel,
    datasource: source.datasource,
    targets: Array.isArray(source.targets) ? source.targets : [],
    transformations: [...inherited, ...own],
    // The query's resolution belongs to the source: Grafana reuses its RESULT,
    // which was computed at the source panel's interval.
    interval: panel.interval || source.interval,
    maxDataPoints: panel.maxDataPoints ?? source.maxDataPoints,
  };
}

function mapPanels(panels, byId) {
  if (!Array.isArray(panels)) return panels;
  let changed = false;
  const next = panels.map((panel) => {
    let out = resolvePanel(panel, byId);
    if (out && Array.isArray(out.panels)) {
      const inner = mapPanels(out.panels, byId);
      if (inner !== out.panels) out = { ...out, panels: inner };
    }
    if (out !== panel) changed = true;
    return out;
  });
  return changed ? next : panels;
}

/**
 * The dashboard with every `-- Dashboard --` panel pointed at its source's
 * query. Returns the SAME object when no panel uses it, which is every
 * dashboard registered when this was written.
 */
export function expandDashboardDatasourcePanels(dashboard) {
  if (!dashboard || typeof dashboard !== 'object' || !Array.isArray(dashboard.panels)) {
    return dashboard;
  }
  const byId = collectById(dashboard.panels, new Map());
  const panels = mapPanels(dashboard.panels, byId);
  return panels === dashboard.panels ? dashboard : { ...dashboard, panels };
}
