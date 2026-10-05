import React, { useMemo } from 'react';
import PropTypes from 'prop-types';

import { buildFolderTree, collapseSingleChild, pathToUid } from './folderTree';

/**
 * Choose a folder one level at a time: `DLHLnM Org. -> Microservice Overview`.
 *
 * ─── Why not the one flat `<select>` of full paths ──────────────────────────
 *
 * That is still the right control for the per-row "move this dashboard" picker in
 * the catalog table, where the job is to identify a folder you already have in
 * mind out of all seventy-nine of them, and a searchable one-line list beats
 * three dependent dropdowns.
 *
 * Registering is the opposite job. You are placing a dashboard somewhere, the
 * decision is made level by level, and it mirrors what the person will see on the
 * Dashboards screen. A flat list also forces the reader to parse
 * "Monitoring / OpenObserver / DLHLnM Org. / DLH Services / Apache Kafka" as text
 * to work out where it sits, and there are eighty of those to scan past.
 *
 * ─── Any level is a destination ─────────────────────────────────────────────
 *
 * Grafana folders hold dashboards at every depth, so each select is a valid final
 * answer and the next one down is optional. That is why the deeper selects offer
 * "(register here)" as their empty option rather than a "choose…" that would read
 * as an unfinished form.
 */
export default function FolderCascadePicker({ id, folders, value, disabled, onChange }) {
  // keepEmpty: this is where a dashboard is PUT, and an empty folder is the most
  // likely destination of all. No registrations are passed for the same reason —
  // what is already in a folder has no bearing on whether you may file into it.
  const tree = useMemo(() => buildFolderTree(folders, [], { keepEmpty: true }), [folders]);

  /**
   * Where the first dropdown starts.
   *
   * When `grafana.allowed-folder-uids` narrows the backend to ONE subtree — the
   * intended setup, pointed at this application's own parent folder — every
   * folder on offer descends from a single root, and offering that root as the
   * first choice is a dropdown with one option in it. Skipping it puts the ORGS
   * in the first dropdown and their subfolders in the second, which is how the
   * placement is actually decided.
   *
   * Derived, not configured: with the allow-list empty the whole instance is on
   * offer, there are dozens of roots, nothing collapses, and the picker starts at
   * the top exactly as before. Nothing here knows a folder's name.
   */
  const start = useMemo(() => collapseSingleChild(tree.roots), [tree.roots]);

  /**
   * The selects to draw, derived from `value` rather than held as state.
   *
   * One entry per level already chosen, plus one more whenever the deepest choice
   * has children left to offer. Deriving it means the parent's `value` is the
   * only truth: clearing the folder from outside collapses the cascade, and there
   * is no second copy of the path to fall out of step.
   */
  const levels = useMemo(() => {
    // A value ABOVE the collapsed start — one of the skipped levels — is still a
    // legitimate folder to be filed under, so fall back to the true roots rather
    // than showing the cascade as though nothing were chosen.
    let roots = start.roots;
    let trail = pathToUid(roots, value);
    if (value && !trail.length) {
      roots = tree.roots;
      trail = pathToUid(roots, value);
    }
    const out = [];
    let nodes = roots;
    let parentUid = 'root';
    for (const uid of trail) {
      out.push({ id: parentUid, options: nodes, selected: uid });
      nodes = nodes.find((node) => node.uid === uid)?.children || [];
      parentUid = uid;
    }
    if (nodes.length) out.push({ id: parentUid, options: nodes, selected: '' });
    return out;
  }, [tree.roots, start.roots, value]);

  return (
    <div className="gd-cascade">
      {levels.map((level, index) => (
        <select
          // Keyed by the parent uid (or 'root' for the top level) rather than
          // the selection or index. This avoids remounting the select on every
          // change, which would lose the keyboard focus mid-cascade.
          key={level.id}
          id={index === 0 ? id : undefined}
          className="uem-select gd-cascade-step"
          value={level.selected}
          disabled={disabled}
          aria-label={index === 0 ? 'Folder' : `Subfolder, level ${index + 1}`}
          onChange={(e) => onChange(e.target.value || levels[index - 1]?.selected || '')}
        >
          {/* Level 0 has nothing chosen yet, so its empty option is a prompt.
              Deeper down, empty means "stop here" — the parent IS the answer. */}
          <option value="">
            {index === 0 ? 'Choose a folder…' : '(register here)'}
          </option>
          {level.options.map((node) => (
            <option key={node.uid} value={node.uid} title={node.path}>
              {node.title}
              {node.children.length > 0 ? ' ›' : ''}
            </option>
          ))}
        </select>
      ))}
    </div>
  );
}

FolderCascadePicker.propTypes = {
  /** Put on the first select, so an outside <label htmlFor> reaches the cascade. */
  id: PropTypes.string,
  /** Flat rows from GET /api/dashboards/folders; the tree is rebuilt from them. */
  folders: PropTypes.arrayOf(PropTypes.object).isRequired,
  /** The chosen folder uid, at whatever depth. '' when nothing is chosen. */
  value: PropTypes.string,
  disabled: PropTypes.bool,
  /** Called with the newly chosen folder uid. */
  onChange: PropTypes.func.isRequired,
};
