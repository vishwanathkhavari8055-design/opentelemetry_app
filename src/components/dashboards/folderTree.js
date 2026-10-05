import PropTypes from 'prop-types';

/**
 * How a Grafana folder reads in a picker.
 *
 * Grafana's folders are a TREE — this instance nests four deep, with the folders
 * the catalog cares about ("Default Org.", "DLH Services", "Apache Kafka") sitting
 * under `Monitoring / OpenObserver`. A native `<select>` cannot render a tree, and
 * an indented title is no help once the dropdown collapses to the chosen row: the
 * indentation is gone and "Default Org." is back to being ambiguous.
 *
 * So the hierarchy travels in the TEXT. Every option shows its full path, which
 * makes each one unambiguous whether the list is open or closed, keeps the choice
 * legible in the collapsed select, and — because the backend sorts by path — puts
 * every child directly under its parent.
 *
 * `<optgroup>` was the other candidate and does not fit: it nests exactly one
 * level and its labels are not selectable, while these folders are both nested
 * deeper than that and selectable at every level.
 *
 * This applies to the catalog table's "move this dashboard" picker, where the job
 * is to pick one known folder out of all of them. REGISTERING is a different job
 * and uses a different control — see FolderCascadePicker.
 */
export const folderLabel = (folder) => folder?.path || folder?.title || folder?.uid || '';

/** One row of GET /api/dashboards/folders. */
export const folderShape = PropTypes.shape({
  uid: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  /** Titles from the root down, " / "-joined. Absent on an older backend. */
  path: PropTypes.string,
  /** 0 at the root. Absent on an older backend. */
  depth: PropTypes.number,
  parentUid: PropTypes.string,
});

/**
 * ─── The tree, as something you can walk ────────────────────────────────────
 *
 * The pickers above put the hierarchy in the TEXT because a `<select>` cannot
 * hold a tree. The BROWSE screens have no such constraint: a grid of tiles plus a
 * breadcrumb is a tree, so they navigate it one level at a time —
 * `OpenObserver -> DLHLnM Org. -> DLH Services -> Apache Airflow -> a dashboard`.
 *
 * Everything below is pure, so both screens (Dashboards, and Dashboard Catalog in
 * Settings) build the same shape from the same two responses and cannot drift.
 * NOTHING here names a folder or a dashboard: the levels are whatever Grafana's
 * `/folders` says they are, and a folder created or moved in Grafana changes this
 * on the next refresh with no code to touch.
 */

/** Grafana's own name for "no folder"; the API sends `""`, not null. */
const NO_FOLDER = '';

const nodeFromFolder = (folder) => ({
  uid: folder.uid,
  title: folder.title,
  path: folder.path || folder.title,
  depth: folder.depth ?? 0,
  parentUid: folder.parentUid || NO_FOLDER,
  children: [],
  dashboards: [],
  /** Dashboards in this folder AND every folder under it. */
  total: 0,
  /** Registered but disabled, from the folder summary. Viewer-only annotation. */
  disabled: 0,
});

/**
 * A home for a registration whose folder Grafana does not list.
 *
 * Happens two ways: the folder was deleted in Grafana, or the folders call failed
 * outright. Either way the dashboard is still registered and must still be
 * reachable, so it gets a root-level node built from the title the registry
 * remembers. This is also the graceful degradation path — with no folders at all,
 * every registration lands in one of these and the screen falls back to exactly
 * the flat one-tile-per-folder grid it had before there was a tree.
 */
const detachedNode = (folderUid, folderTitle) => ({
  uid: folderUid,
  title: folderTitle || 'Ungrouped',
  path: folderTitle || 'Ungrouped',
  depth: 0,
  parentUid: NO_FOLDER,
  children: [],
  dashboards: [],
  total: 0,
  disabled: 0,
  /** Not part of Grafana's tree — see above. */
  detached: true,
});

/** displayOrder is the administrator's chosen order; title only breaks ties. */
const byDisplayOrder = (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0)
  || String(a.title || a.uid).localeCompare(String(b.title || b.uid));

const byTitle = (a, b) => String(a.title).localeCompare(String(b.title));

/**
 * Fold `/folders` and `/registry` into one navigable tree.
 *
 * @param folders       rows from GET /api/dashboards/folders (the whole tree)
 * @param registrations rows from GET /api/dashboards/registry
 * @param keepEmpty     true keeps folders holding nothing — what the register
 *                      dialog's folder picker wants, because you register INTO an
 *                      empty folder. false (the Dashboards screen) drops any
 *                      branch with no dashboard anywhere under it, which is that
 *                      screen's existing contract: a tile exists because
 *                      something was registered, and disappears when the last one
 *                      is removed. Without it its first screen would be all 39 of
 *                      this instance's root folders, nearly all of them empty.
 * @param summary       rows from /registry/folder-summary, for the disabled count
 * @returns { roots, byUid }
 */
export function buildFolderTree(folders, registrations, { keepEmpty = false, summary } = {}) {
  const byUid = new Map();
  (folders || []).forEach((folder) => {
    if (folder?.uid) byUid.set(folder.uid, nodeFromFolder(folder));
  });

  const detached = new Map();
  (registrations || []).forEach((row) => {
    const folderUid = row.folderUid || NO_FOLDER;
    let node = byUid.get(folderUid);
    if (!node) {
      node = detached.get(folderUid) || detachedNode(folderUid, row.folderTitle);
      detached.set(folderUid, node);
    }
    node.dashboards.push(row);
  });

  (summary || []).forEach((tile) => {
    const node = byUid.get(tile.folderUid || NO_FOLDER) || detached.get(tile.folderUid || NO_FOLDER);
    // total - enabled, not a field of its own: a viewer cannot see disabled rows,
    // so without this the two counts differ for no visible reason.
    if (node) node.disabled = Math.max(0, (tile.total || 0) - (tile.enabled || 0));
  });

  // A parentUid Grafana did not also list — permissions can filter an ancestor
  // out — leaves the child as a root rather than dropping it off the screen.
  const roots = [];
  byUid.forEach((node) => {
    const parent = node.parentUid ? byUid.get(node.parentUid) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  });
  detached.forEach((node) => roots.push(node));

  // Depth-first, with a guard: a parent cycle would otherwise recurse forever,
  // and this data comes off a network call rather than out of this process.
  const seen = new Set();
  const measure = (node) => {
    if (seen.has(node)) return 0;
    seen.add(node);
    node.children.sort(byTitle);
    node.dashboards.sort(byDisplayOrder);
    node.total = node.dashboards.length
      + node.children.reduce((sum, child) => sum + measure(child), 0);
    if (!keepEmpty) node.children = node.children.filter((child) => child.total > 0);
    return node.total;
  };
  roots.sort(byTitle);
  roots.forEach(measure);

  return {
    roots: keepEmpty ? roots : roots.filter((node) => node.total > 0),
    byUid,
  };
}

/**
 * Skip the levels that carry no information.
 *
 * The folders this deployment registers into sit under `Monitoring /
 * OpenObserver`, so the literal top of the pruned tree is a chain of nodes with
 * one child each and no dashboards of their own — screens whose only possible
 * action is "click the one tile". Descending through them lands the user on the
 * first level that actually branches, which is what makes `OpenObserver` the root
 * of the Dashboards screen without `OpenObserver` appearing anywhere in this
 * codebase.
 *
 * Stops at any node that branches OR holds a dashboard itself, so nothing
 * reachable is ever skipped past, and the skipped nodes are returned as `trail`
 * so the breadcrumb can still show the full path.
 */
export function collapseSingleChild(roots) {
  const trail = [];
  let level = roots || [];
  while (level.length === 1 && level[0].children.length > 0 && level[0].dashboards.length === 0) {
    trail.push(level[0]);
    level = level[0].children;
  }
  return { trail, roots: level };
}

/**
 * Resolve a uid path to the nodes along it.
 *
 * Returns the ancestors and the target, or `[]` if the path no longer exists —
 * which is not an error case but the normal one after a refresh that removed the
 * last dashboard from the folder the user was standing in. Callers treat an empty
 * result as "go back to the top" rather than rendering a dead level.
 */
export function resolvePath(roots, path) {
  const nodes = [];
  let level = roots || [];
  for (const uid of path || []) {
    const node = level.find((candidate) => candidate.uid === uid);
    if (!node) return [];
    nodes.push(node);
    level = node.children;
  }
  return nodes;
}

/**
 * The uid path down to one folder, or `[]` if it is not in this tree.
 *
 * Lets a screen restore its position — or a dialog open with the folder the
 * caller was already looking at preselected — from nothing but a uid, which is
 * all the registry stores.
 */
export function pathToUid(roots, uid) {
  if (!uid) return [];
  const walk = (nodes, trail) => {
    for (const node of nodes) {
      const next = [...trail, node.uid];
      if (node.uid === uid) return next;
      const found = walk(node.children, next);
      if (found.length) return found;
    }
    return [];
  };
  return walk(roots || [], []);
}
