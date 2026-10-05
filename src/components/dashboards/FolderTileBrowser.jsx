import React from 'react';
import PropTypes from 'prop-types';

/**
 * One level of the folder tree, as a breadcrumb and a grid of tiles.
 *
 * Drives the Dashboards screen. It owns the breadcrumb and the FOLDER tiles only
 * — what a folder's dashboards look like is the caller's business, so the same
 * navigation can be reused by a screen that renders them differently.
 *
 * Navigation is a list of uids held by the caller, not by this component: the
 * screens above already keep their position in local state so that leaving for
 * another tab and coming back returns you where you were.
 */
export default function FolderTileBrowser({
  rootLabel, trail, nodes, onNavigate, folders, actions, children,
}) {
  const here = nodes.length ? nodes[nodes.length - 1] : null;
  // At the top level the heading names the folder the tiles below actually belong
  // to — the deepest level collapseSingleChild() skipped — rather than repeating
  // the screen's own name from the breadcrumb. For this deployment that reads
  // "OpenObserver", which is the folder Grafana says those tiles are in.
  const heading = here || trail[trail.length - 1];

  return (
    <>
      <header className="gd-head">
        <div className="gd-head-title">
          <nav className="gd-crumbs" aria-label="Breadcrumb">
            {here ? (
              <button
                type="button" className="gd-crumb-link"
                onClick={() => onNavigate([])}
              >{rootLabel}</button>
            ) : (
              <span className="gd-crumb-current">{rootLabel}</span>
            )}

            {/* The levels collapseSingleChild() skipped. Shown, because the path
                is what tells the user WHICH "Default Org." they are looking at —
                but not clickable, since there is no level to go back to. */}
            {trail.map((node) => (
              <React.Fragment key={node.uid}>
                <span aria-hidden="true">/</span>
                <span className="gd-crumb-ghost" title={node.path}>{node.title}</span>
              </React.Fragment>
            ))}

            {nodes.map((node, index) => (
              <React.Fragment key={node.uid || 'ungrouped'}>
                <span aria-hidden="true">/</span>
                {index === nodes.length - 1 ? (
                  <span className="gd-crumb-current">{node.title}</span>
                ) : (
                  <button
                    type="button"
                    className="gd-crumb-link"
                    onClick={() => onNavigate(nodes.slice(0, index + 1).map((n) => n.uid))}
                  >{node.title}</button>
                )}
              </React.Fragment>
            ))}
          </nav>

          <h1 className="gd-title">{heading ? heading.title : rootLabel}</h1>
          {/* A count, or nothing. The top level used to explain how Grafana nests
              its folders, which is a sentence the tiles below already demonstrate
              — and the caller prints the totals in its own footer, so repeating
              them here would only push the tiles further down the screen. */}
          {here && (
            <p className="gd-subtitle">
              {describe(folders.length, here.dashboards.length)}
            </p>
          )}
        </div>
        {actions}
      </header>

      {/* Folder tiles and dashboard tiles share ONE scroll region. Two
          independently scrolling grids in the same column is the layout that made
          a folder holding both show a few pixels of each. */}
      <div className="gd-scroll">
        {folders.length > 0 && (
        <div className="gd-tiles">
          {folders.map((node) => (
            <button
              type="button"
              key={node.uid || 'ungrouped'}
              className="gd-tile gd-tile--folder"
              onClick={() => onNavigate([...nodes.map((n) => n.uid), node.uid])}
              title={node.path}
            >
              <span className="gd-tile-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                  <path
                    d="M2.5 5.5A1.5 1.5 0 0 1 4 4h4.2l1.6 2H18a1.5 1.5 0 0 1 1.5 1.5v9A1.5
                       1.5 0 0 1 18 18H4a1.5 1.5 0 0 1-1.5-1.5v-11Z"
                    stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span className="gd-tile-name">{node.title}</span>
              <span className="gd-tile-count">
                <strong>{node.total}</strong>
                {node.total === 1 ? ' dashboard' : ' dashboards'}
                {node.children.length > 0 && (
                  <> · <strong>{node.children.length}</strong>
                    {node.children.length === 1 ? ' folder' : ' folders'}
                  </>
                )}
              </span>
              {/* A viewer cannot see disabled registrations, so the gap between
                  this tile's count and the catalog's would be unexplainable. */}
              {node.disabled > 0 && (
                <span className="gd-tile-note">{node.disabled} disabled</span>
              )}
            </button>
          ))}
        </div>
        )}

        {children}
      </div>
    </>
  );
}

const describe = (folderCount, dashboardCount) => {
  const parts = [];
  if (folderCount) parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
  parts.push(`${dashboardCount} dashboard${dashboardCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
};

/** A node of buildFolderTree(). Recursive, so `children` stays loosely typed. */
const nodeShape = PropTypes.shape({
  uid: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  path: PropTypes.string,
  children: PropTypes.array.isRequired,
  dashboards: PropTypes.array.isRequired,
  total: PropTypes.number.isRequired,
  disabled: PropTypes.number,
});

FolderTileBrowser.propTypes = {
  /** The top of the breadcrumb — this screen's own name. */
  rootLabel: PropTypes.string.isRequired,
  /** Levels collapseSingleChild() skipped, shown but not navigable. */
  trail: PropTypes.arrayOf(nodeShape).isRequired,
  /** Ancestors then the open folder; empty at the top level. */
  nodes: PropTypes.arrayOf(nodeShape).isRequired,
  /** Called with the new uid path. */
  onNavigate: PropTypes.func.isRequired,
  /** Subfolders to tile at this level. */
  folders: PropTypes.arrayOf(nodeShape).isRequired,
  /** Buttons for the header's right-hand side. */
  actions: PropTypes.node,
  /** How this screen renders the open folder's dashboards. */
  children: PropTypes.node,
};
