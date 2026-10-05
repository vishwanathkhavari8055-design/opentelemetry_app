import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

import { fetchRegisterableDashboards, registerDashboard } from '../../services/dashboardsApi';
import { folderLabel, folderShape } from './folderTree';
import FolderCascadePicker from './FolderCascadePicker';
import useBackdropDismiss from '../common/useBackdropDismiss';

/**
 * "Register Dashboard" — pick the folder, name the Grafana UID, register it.
 *
 * Uses the same dialog chrome as Register Resource and Update User (the `uem-`
 * modal), so Settings has one kind of dialog rather than a second one that merely
 * resembles the first.
 *
 * ─── Two inputs, and the folder is the one that matters ─────────────────────
 *
 * The UID says WHICH dashboard. The folder says where it appears in THIS
 * application — which tile it joins on the Dashboards screen. They are
 * independent: filing a dashboard that lives in Grafana's "Monitoring" folder
 * under a different tile here is a legitimate thing to want, and the registry
 * records both so the difference stays visible instead of one silently
 * overwriting the other.
 *
 * The folder is chosen a level at a time — `DLHLnM Org. -> Microservice Overview`
 * — by FolderCascadePicker, which is where that choice of control is argued. Any
 * level is a valid destination, because Grafana folders hold dashboards at every
 * depth.
 *
 * ─── The picker is discovery, not identity ──────────────────────────────────
 *
 * Choosing a folder lists that folder's UNREGISTERED dashboards, so the common
 * case is two clicks and no typing. But a UID typed by hand is always accepted,
 * whichever folder it physically lives in — otherwise filing a dashboard under a
 * tile other than its Grafana folder would be impossible, and that is exactly the
 * case the two-folder model exists for.
 *
 * ─── There is no client-side pre-check ──────────────────────────────────────
 *
 * The server resolves the UID against Grafana on register and answers 404 with a
 * sentence naming the problem. A pre-check here would only move that same answer
 * earlier while adding a second thing to keep in step with the backend's rules.
 */
export default function RegisterDashboardDialog({
  folders, defaultFolderUid, foldersMessage, onCancel, onRegistered,
}) {
  // Guarded: a preselected uid Grafana no longer lists would leave the cascade
  // showing nothing chosen while the form believed a folder was set, and Register
  // would then fail server-side for a reason the screen never showed.
  const [folderUid, setFolderUid] = useState(() => {
    if (defaultFolderUid && folders.some((folder) => folder.uid === defaultFolderUid)) {
      return defaultFolderUid;
    }
    return folders.length === 1 ? folders[0].uid : '';
  });
  const [uid, setUid] = useState('');
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState('');

  const [candidates, setCandidates] = useState([]);
  const [browsing, setBrowsing] = useState(false);

  // Candidates for the chosen folder. Refetched per folder rather than loaded
  // whole: this Grafana instance holds hundreds of dashboards across ~80 folders
  // once nesting is counted, so "load them all and filter locally" is a
  // multi-second stall for a list the user will only ever look at one folder of.
  //
  // Scoped to the folder ITSELF, not its subtree. Each subfolder is selectable in
  // its own right, so browsing "OpenObserver" and being shown its grandchildren
  // would only blur which folder a Register click actually files into.
  useEffect(() => {
    if (!folderUid) {
      setCandidates([]);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setBrowsing(true);
    fetchRegisterableDashboards({ folderUid, signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        setCandidates(result?.items || []);
        setBrowsing(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // A failed lookup costs the PICKER only — typing a UID still works — so it
        // is not surfaced as a form error that would look like a refusal.
        console.warn('[dashboards] could not list registerable dashboards', err);
        setCandidates([]);
        setBrowsing(false);
      });
    return () => { cancelled = true; controller.abort(); };
  }, [folderUid]);

  const uidRef = useRef(null);
  useEffect(() => { uidRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !registering) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, registering]);

  // The PATH, not the bare title: "Unregistered dashboards in Default Org." is
  // ambiguous on a nested instance, where more than one parent can hold a folder
  // by that name.
  const folderTitle = useMemo(
    () => folderLabel(folders.find((folder) => folder.uid === folderUid)),
    [folders, folderUid],
  );

  const trimmedUid = uid.trim();
  const canSubmit = !!folderUid && trimmedUid.length > 0 && !registering;

  const submit = async (event, explicitUid) => {
    event?.preventDefault?.();
    const target = (explicitUid ?? trimmedUid).trim();
    if (!folderUid || !target) return;
    setRegistering(true);
    setError('');
    try {
      const created = await registerDashboard({ uid: target, folderUid });
      onRegistered(created);
    } catch (err) {
      // Where "No dashboard with UID 'x' exists in Grafana…" and the duplicate
      // report surface. Shown verbatim — the backend's message names the fix, and
      // a generic "registration failed" would throw away the only useful part.
      setError(err.message || 'Could not register this dashboard.');
      setRegistering(false);
    }
  };

  const backdropRef = useBackdropDismiss(() => { if (!registering) onCancel(); });

  return (
    <dialog
      open
      ref={backdropRef}
      className="uem-backdrop native-el"
      aria-modal="true"
      aria-label="Register dashboard"
    >
      <form className="uem uem--reg gd-dialog" onSubmit={submit}>
        <div className="uem-inner">
          <header className="uem-head">
            <h2 className="uem-title">Register Dashboard</h2>
            <button
              type="button" className="uem-x" onClick={onCancel}
              disabled={registering} aria-label="Close"
            >×</button>
          </header>

          <div className="uem-body">
            <div className="uem-row">
              <label className="uem-label" htmlFor="gd-folder">
                Folder <span className="uem-req">*</span>
              </label>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                {/* One dropdown per level — Org, then folder, then subfolder —
                    because registering is a placement decision made level by
                    level, and it mirrors what the Dashboards screen will show. */}
                <FolderCascadePicker
                  id="gd-folder"
                  folders={folders}
                  value={folderUid}
                  disabled={registering || folders.length === 0}
                  onChange={(next) => { setFolderUid(next); setError(''); }}
                />
                {folderUid && (
                  <p className="uem-note gd-cascade-path">{folderTitle}</p>
                )}
              </div>
            </div>

            <div className="uem-row">
              <label className="uem-label" htmlFor="gd-uid">
                Dashboard UID <span className="uem-req">*</span>
              </label>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                <input
                  id="gd-uid"
                  ref={uidRef}
                  className="uem-input"
                  value={uid}
                  disabled={registering}
                  maxLength={64}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="From the Grafana URL: /d/<uid>/<slug>"
                  onChange={(e) => { setUid(e.target.value); setError(''); }}
                />
              </div>
            </div>

            {/* Folders could not be listed — Grafana unreachable, or not
                configured. Said here rather than left as an empty dropdown that
                looks like a broken form. */}
            {folders.length === 0 && foldersMessage && (
              <div className="uem-info uem-info--error">
                <span className="uem-info-icon" aria-hidden="true">!</span>
                <p className="uem-info-text">{foldersMessage}</p>
              </div>
            )}

            {folderUid && (
              <div className="gd-candidates">
                <div className="gd-candidates-head">
                  <span>
                    Unregistered dashboards in <b>{folderTitle}</b>
                  </span>
                  {!browsing && <span className="gd-count">{candidates.length}</span>}
                </div>

                {browsing && <p className="uem-note">Searching Grafana…</p>}

                {!browsing && candidates.length === 0 && (
                  <p className="uem-note">
                    Every dashboard in this folder is already registered — or the folder is
                    empty. You can still paste any UID above.
                  </p>
                )}

                {!browsing && candidates.length > 0 && (
                  <ul className="gd-candidate-list">
                    {candidates.map((candidate) => (
                      <li key={candidate.uid}>
                        <span className="gd-candidate-title" title={candidate.title}>
                          {candidate.title}
                        </span>
                        <code className="gd-candidate-uid">{candidate.uid}</code>
                        <button
                          type="button"
                          className="iam-switch-btn"
                          disabled={registering}
                          onClick={(e) => submit(e, candidate.uid)}
                          title={`Register ${candidate.title} into ${folderTitle}`}
                        >Register</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {error && (
              <div className="uem-info uem-info--error" role="alert">
                <span className="uem-info-icon" aria-hidden="true">!</span>
                <p className="uem-info-text">{error}</p>
              </div>
            )}
          </div>

          <footer className="uem-foot">
            <button
              type="button" className="uem-btn uem-btn--ghost" onClick={onCancel}
              disabled={registering}
            >Cancel</button>
            <button
              type="submit"
              className="uem-btn uem-btn--primary"
              disabled={!canSubmit}
            >{registering ? 'Registering…' : 'Register'}</button>
          </footer>
        </div>
      </form>
    </dialog>
  );
}

RegisterDashboardDialog.propTypes = {
  /**
   * From GET /api/dashboards/folders — Grafana owns this list, and it is the
   * whole tree: nested folders are offered alongside root ones.
   */
  folders: PropTypes.arrayOf(folderShape).isRequired,
  /** Preselect a folder, e.g. the one the table is currently filtered to. */
  defaultFolderUid: PropTypes.string,
  /** Why the folder list is empty, when it is. */
  foldersMessage: PropTypes.string,
  onCancel: PropTypes.func.isRequired,
  /** Called with the created registration after a successful register. */
  onRegistered: PropTypes.func.isRequired,
};
