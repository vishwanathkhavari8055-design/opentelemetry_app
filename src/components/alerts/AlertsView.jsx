import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  fetchAlerts, fetchAlertFolders, createAlertFolder, deleteAlertFolder,
  deleteAlert, setAlertEnabled, cloneAlert, triggerAlert,
} from '../../services/api';
import { DEFAULT_FOLDER_ID, alertTypeLabel, formatFrequency, formatMinutes, formatTimestamp }
  from './alertModel';
import AlertEditor from './AlertEditor';
import AlertWizard from './wizard/AlertWizard';
import AlertImport from './AlertImport';
import ConfirmDialog from './ConfirmDialog';
import Toast from '../common/Toast';
import { usePermissions } from '../../auth/usePermissions';
import { PERMISSIONS } from '../../auth/constants';

/**
 * Alerts screen: folders rail on the left, alert list on the right.
 *
 * Three tabs over one list — All, Scheduled, Real time — filtered SERVER-SIDE
 * via `alertType`, not by narrowing an already-fetched array. That matters
 * because the list is paged upstream: filtering a page of 50 client-side would
 * show "3 scheduled alerts" when there are 300, which is a wrong answer rather
 * than a slow one.
 *
 * The screen owns three modes (list / editor / import) instead of routing,
 * matching how the rest of this app handles drill-downs (see LogsView's inner
 * trace mode). Returning from the editor refetches, so a save made there is
 * reflected without the user reloading.
 *
 * Everything here reads and writes OpenObserve directly through the backend.
 * There is no local copy of an alert, so a definition created in OpenObserve's
 * own UI appears on the next fetch and one created here appears there
 * immediately.
 */

const TABS = [
  { key: 'all',       label: 'All',       apiType: 'all' },
  { key: 'scheduled', label: 'Scheduled', apiType: 'scheduled' },
  { key: 'realtime',  label: 'Realtime',  apiType: 'realtime' },
];

const LS_TAB = 'observability-ui:alerts:tab:v1';
const PAGE_SIZES = [10, 20, 50, 100];

/** Zero-padded row number, matching the reference's "01, 02, …". */
const rowNo = (i) => String(i + 1).padStart(2, '0');

/* ── small presentational pieces ────────────────────────────────────────── */

const IconSearch = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />
  </svg>
);

const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
  </svg>
);

const IconUpload = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" />
  </svg>
);

const IconEdit = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const IconCopy = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
);

const IconPlay = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 4l14 8-14 8V4Z" />
  </svg>
);

const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" /><path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
  </svg>
);

/**
 * Reusable on/off switch, same visual as the Logs toolbar's.
 *
 * `role="switch"` rather than a pressed button: a screen reader then announces
 * "on"/"off", which is what this control means, instead of "pressed", which for
 * the On column would read as "the row is selected".
 *
 * `busy` is separate from `disabled` even though both block the click. They are
 * two different sentences — "a write is in flight, wait" versus "you do not have
 * permission" — and the CSS draws them differently. An unlabelled switch (the On
 * column) gets its accessible name from `title`, so that string has to carry the
 * state, not just the action.
 */
function Switch({ on, onToggle, label, title, disabled, busy }) {
  const text = title || label;
  return (
    <button
      type="button"
      className={`tb-switch ${on ? 'is-on' : ''} ${busy ? 'is-busy' : ''}`}
      onClick={onToggle}
      disabled={disabled || busy}
      title={text}
      aria-label={label ? undefined : text}
      role="switch"
      aria-checked={!!on}
      aria-busy={busy || undefined}
    >
      <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
      {label ? <span>{label}</span> : null}
    </button>
  );
}
Switch.propTypes = {
  on: PropTypes.bool,
  onToggle: PropTypes.func.isRequired,
  label: PropTypes.string,
  title: PropTypes.string,
  disabled: PropTypes.bool,
  busy: PropTypes.bool,
};

/** Loading / error / empty body, shared by all three column layouts. */
function TableState({ loading, error, empty, emptyLabel }) {
  if (!loading && !error && !empty) return null;
  let body = emptyLabel;
  if (loading) body = 'Loading…';
  else if (error) body = <span className="alerts-state-error">{error}</span>;
  return <div className="alerts-state">{body}</div>;
}
TableState.propTypes = {
  loading: PropTypes.bool,
  error: PropTypes.string,
  empty: PropTypes.bool,
  emptyLabel: PropTypes.string,
};

/** Footer: total, range, page size and pagers. Mirrors the IAM footer. */
function TableFooter({ total, page, pageSize, setPage, setPageSize }) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  return (
    <div className="iam-foot">
      <span className="iam-foot-total">{total} Alert{total === 1 ? '' : 's'}</span>
      <span className="iam-foot-right">
        <span className="iam-foot-range">
          Showing <strong>{from}</strong> - <strong>{to}</strong> of <strong>{total}</strong>
        </span>
        <label className="iam-foot-size">
          Records per page{' '}
          <select
            value={pageSize}
            aria-label="Records per page"
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button
          type="button" className="iam-pager" aria-label="Previous page"
          onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
        >‹</button>
        <button
          type="button" className="iam-pager" aria-label="Next page"
          onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage}
        >›</button>
      </span>
    </div>
  );
}
TableFooter.propTypes = {
  total: PropTypes.number.isRequired,
  page: PropTypes.number.isRequired,
  pageSize: PropTypes.number.isRequired,
  setPage: PropTypes.func.isRequired,
  setPageSize: PropTypes.func.isRequired,
};

/** New-folder dialog. */
function FolderDialog({ onCancel, onCreate, busy, error }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = (e) => {
    e.preventDefault();
    if (name.trim() && !busy) onCreate({ name: name.trim(), description: description.trim() });
  };

  return (
    <dialog open className="alerts-modal-backdrop native-el" aria-modal="true" aria-label="New folder">
      <form className="alerts-modal" onSubmit={submit}>
        <div className="alerts-modal-head">
          <h2 className="alerts-modal-title">New Folder</h2>
          <button type="button" className="alerts-modal-x" onClick={onCancel} aria-label="Close">×</button>
        </div>
        <div className="alerts-modal-body">
          <div className="ae-stack">
            <label className="ae-stack-label" htmlFor="fld-name">Name <span className="ae-req">*</span></label>
            <input
              id="fld-name" ref={inputRef} className="ae-input" value={name}
              onChange={(e) => setName(e.target.value)} placeholder="Folder name" maxLength={100}
            />
          </div>
          <div className="ae-stack">
            <label className="ae-stack-label" htmlFor="fld-desc">Description</label>
            <input
              id="fld-desc" className="ae-input" value={description}
              onChange={(e) => setDescription(e.target.value)} placeholder="Optional" maxLength={200}
            />
          </div>
          {error && <div className="ae-error">{error}</div>}
        </div>
        <div className="alerts-modal-foot">
          <button type="button" className="alerts-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="alerts-btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
FolderDialog.propTypes = {
  onCancel: PropTypes.func.isRequired,
  onCreate: PropTypes.func.isRequired,
  busy: PropTypes.bool,
  error: PropTypes.string,
};

/* ── the screen ─────────────────────────────────────────────────────────── */

export default function AlertsView({ activeOrg }) {
  // 'list' | 'wizard' | 'editor' | 'import'
  //
  // CREATING an alert opens the three-step wizard; EDITING one opens the
  // single-screen editor. Two modes rather than one because they are two
  // different jobs: the first time you do not yet know which fields exist and
  // want to be walked through them, and every time after you want to change one
  // number without paging past three screens to reach it.
  const [mode, setMode] = useState('list');
  const [editingId, setEditingId] = useState(null);

  /**
   * May this user change the rule set?
   *
   * <p>Reaching this screen at all needs VIEW_ALERT_RULES; WRITING needs this, and
   * the two are separate on purpose. That is what makes "read-only rules list" a
   * real, supported state rather than an accident — granting the view permission
   * without this one produces a browsable list whose every mutating control is
   * simply absent, with no other code change.</p>
   *
   * <p>Controls are OMITTED rather than disabled. A greyed-out "New alert" invites
   * someone to ask which button unlocks it; an absent one reads as "not my job".
   * The exception is a control that already has a `disabled` state for a different
   * reason (`busy`), where adding a second meaning would be confusing.</p>
   */
  const { can } = usePermissions();
  const canConfigure = can(PERMISSIONS.CONFIGURE_ALERTS);

  const [tab, setTab] = useState(() => {
    try {
      const t = localStorage.getItem(LS_TAB);
      return TABS.some((x) => x.key === t) ? t : 'all';
    } catch { return 'all'; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_TAB, tab); } catch { /* not persisted */ }
  }, [tab]);

  const [folders, setFolders] = useState([]);
  const [folderSearch, setFolderSearch] = useState('');
  const [activeFolder, setActiveFolder] = useState(DEFAULT_FOLDER_ID);
  // When on, the list ignores the folder selection and shows every folder.
  const [allFolders, setAllFolders] = useState(false);

  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /**
   * The outcome of the last write, as a floating bottom-right toast —
   * `{ tone: 'success'|'error', message }`, or null.
   *
   * ONE piece of state for both outcomes, and one toast rendering it, so a
   * failure can never be shown next to the stale success of the write before it.
   * That was the flaw in doing this with two: an inline error bar at the top and
   * a green toast at the bottom could be on screen at the same time, saying
   * opposite things about the same click.
   *
   * The full-width banner this replaces pushed the table down and let it spring
   * back when it went, which moved rows under the pointer between "Enable" and
   * the next click. `.alerts-banner` is still used on the fired-alerts tab, but
   * only for genuinely persistent conditions — see the note on Toast.
   */
  const [toast, setToast] = useState(null);
  const notifyOk = useCallback((message) => setToast({ tone: 'success', message }), []);
  const notifyFail = useCallback((message) => setToast({ tone: 'error', message }), []);
  const [reloadTick, setReloadTick] = useState(0);

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const [showFolderDialog, setShowFolderDialog] = useState(false);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState('');
  const [confirm, setConfirm] = useState(null); // { title, body, confirmLabel, onConfirm }
  // Ids with an in-flight row action, so its buttons disable individually
  // rather than the whole table freezing.
  const [busyIds, setBusyIds] = useState(() => new Set());

  const markBusy = useCallback((id, on) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  /* ── folders ───────────────────────────────────────────────────────────── */

  const loadFolders = useCallback(async (signal) => {
    try {
      const res = await fetchAlertFolders({ signal });
      const items = res.items || [];
      // OpenObserve does not materialise its root folder until something
      // references it, so a fresh org lists nothing. The rail must still offer
      // it — it is where alerts land by default — so it is synthesised when the
      // backend did not return it.
      const hasDefault = items.some((f) => f.folderId === DEFAULT_FOLDER_ID);
      const full = hasDefault ? items : [
        { folderId: DEFAULT_FOLDER_ID, name: 'default', description: '' },
        ...items,
      ];
      // "default" first, then alphabetical — the reference orders it that way
      // and it is the folder most alerts are in.
      full.sort((a, b) => {
        if (a.folderId === DEFAULT_FOLDER_ID) return -1;
        if (b.folderId === DEFAULT_FOLDER_ID) return 1;
        return (a.name || '').localeCompare(b.name || '');
      });
      setFolders(full);
    } catch (err) {
      if (err.name === 'AbortError') return;
      // A failed folder fetch must not take the alert list with it — the list is
      // fetched independently and is the more important half of the screen.
      console.error('Alert folders unavailable:', err);
      setFolders([{ folderId: DEFAULT_FOLDER_ID, name: 'default', description: '' }]);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadFolders(controller.signal);
    return () => controller.abort();
  }, [loadFolders, activeOrg, reloadTick]);

  const visibleFolders = useMemo(() => {
    const q = folderSearch.trim().toLowerCase();
    if (!q) return folders;
    return folders.filter((f) => (f.name || '').toLowerCase().includes(q));
  }, [folders, folderSearch]);

  /* ── alert list ────────────────────────────────────────────────────────── */

  const apiType = TABS.find((t) => t.key === tab)?.apiType || 'all';

  useEffect(() => {
    if (mode !== 'list') return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');

    fetchAlerts({
      // Empty folder means "every folder" on the backend, which is exactly what
      // the All Folders switch asks for.
      folder: allFolders ? '' : activeFolder,
      alertType: apiType,
      search: search.trim(),
      signal: controller.signal,
    })
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        if (!res.supported) setError('Alerts require the OpenObserve backend.');
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Request failed.');
        setRows([]);
        setLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
  }, [mode, activeFolder, allFolders, apiType, search, activeOrg, reloadTick]);

  // Any change to what is being listed invalidates the page number — page 3 of
  // the previous filter is meaningless under the new one.
  useEffect(() => { setPage(0); }, [tab, activeFolder, allFolders, search, activeOrg]);

  const pageRows = useMemo(
    () => rows.slice(page * pageSize, (page + 1) * pageSize),
    [rows, page, pageSize],
  );

  /* ── row actions ───────────────────────────────────────────────────────── */

  /**
   * Run a write, then refetch.
   *
   * The refetch is the point: OpenObserve is the only store, so the way to know
   * what an alert looks like after a write is to ask, not to patch local state
   * and hope it matches.
   */
  const runAction = useCallback(async (id, label, fn) => {
    markBusy(id, true);
    setToast(null);
    try {
      const res = await fn();
      notifyOk(res?.message || `${label} succeeded.`);
      reload();
    } catch (err) {
      notifyFail(`${label} failed — ${err.message}`);
    } finally {
      markBusy(id, false);
    }
  }, [markBusy, reload, notifyOk, notifyFail]);

  const onToggleEnabled = (row) => runAction(
    row.alertId,
    row.enabled ? 'Disabling alert' : 'Enabling alert',
    () => setAlertEnabled(row.alertId, !row.enabled),
  );

  const onClone = (row) => runAction(
    row.alertId, 'Clone', () => cloneAlert(row.alertId, { folderId: row.folderId }),
  );

  const onTriggerNow = (row) => setConfirm({
    title: row.realTime ? 'Send a test notification?' : 'Evaluate alert now?',
    // Worded per type: a realtime alert has no schedule to ignore, and for one
    // this is a destination test rather than a re-evaluation.
    body: row.realTime
      ? `“${row.name}” is a realtime alert, so it has no schedule to run early. `
        + 'This asks OpenObserve to fire it once now, which is the only way to check '
        + 'from here that its destination actually delivers. It WILL notify that '
        + 'destination for real.'
      : `“${row.name}” will be evaluated immediately, ignoring its schedule. `
        + 'If its conditions are met it WILL notify its destinations.',
    confirmLabel: row.realTime ? 'Send test' : 'Evaluate now',
    danger: false,
    onConfirm: () => {
      setConfirm(null);
      runAction(row.alertId, 'Trigger', () => triggerAlert(row.alertId));
    },
  });

  const onDelete = (row) => setConfirm({
    title: 'Delete alert?',
    body: `“${row.name}” will be removed from OpenObserve. This cannot be undone, `
      + 'and anything relying on it will stop being monitored.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => {
      setConfirm(null);
      runAction(row.alertId, 'Delete', () => deleteAlert(row.alertId));
    },
  });

  const onDeleteFolder = (folder) => setConfirm({
    title: 'Delete folder?',
    body: `“${folder.name}” will be removed. OpenObserve refuses to delete a `
      + 'folder that still contains alerts, so move or delete those first.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: async () => {
      setConfirm(null);
      setToast(null);
      try {
        await deleteAlertFolder(folder.folderId);
        if (activeFolder === folder.folderId) setActiveFolder(DEFAULT_FOLDER_ID);
        notifyOk('Folder deleted.');
        reload();
      } catch (err) {
        notifyFail(`Delete folder failed — ${err.message}`);
      }
    },
  });

  const onCreateFolder = async ({ name, description }) => {
    setFolderBusy(true);
    setFolderError('');
    try {
      await createAlertFolder({ name, description });
      setShowFolderDialog(false);
      notifyOk(`Folder “${name}” created.`);
      reload();
    } catch (err) {
      setFolderError(err.message);
    } finally {
      setFolderBusy(false);
    }
  };

  /* ── editor / import modes ─────────────────────────────────────────────── */

  const openEditor = (alertId) => {
    setEditingId(alertId || null);
    setMode('editor');
  };

  const leaveSubView = (result) => {
    setMode('list');
    setEditingId(null);
    if (result?.message) notifyOk(result.message);
    // Always refetch on return, even without a message: the user may have saved
    // and then navigated, and a stale list is the one thing this screen must
    // never show.
    reload();
  };

  if (mode === 'wizard') {
    return (
      <AlertWizard
        folders={folders}
        // Same rule the editor follows: creating from the "All" view has no
        // folder in mind, so the alert lands in the root rather than in
        // whichever folder happened to be highlighted.
        initialFolderId={allFolders ? DEFAULT_FOLDER_ID : activeFolder}
        onClose={() => leaveSubView(null)}
        onSaved={leaveSubView}
      />
    );
  }

  if (mode === 'editor') {
    return (
      <AlertEditor
        alertId={editingId}
        folders={folders}
        initialFolderId={allFolders ? DEFAULT_FOLDER_ID : activeFolder}
        onClose={() => leaveSubView(null)}
        onSaved={leaveSubView}
      />
    );
  }

  if (mode === 'import') {
    return (
      <AlertImport
        folders={folders}
        initialFolderId={allFolders ? DEFAULT_FOLDER_ID : activeFolder}
        onClose={() => leaveSubView(null)}
        onImported={leaveSubView}
        onFolderCreated={reload}
      />
    );
  }

  /* ── list mode ─────────────────────────────────────────────────────────── */

  const isEmpty = !loading && !error && rows.length === 0;
  const emptyLabel = search.trim()
    ? `Nothing matches “${search.trim()}”.`
    : 'No data available';

  const tableClass = `alerts-table alerts-table--${tab}`;
  const showWindowCols = tab !== 'realtime';
  const showTypeCol = tab === 'all';

  return (
    <div className="alerts-view">
      <div className="alerts-body">
        {/* ── Folders rail ─────────────────────────────────────────────── */}
        <aside className="alerts-rail" aria-label="Alert folders">
          <div className="alerts-rail-head">
            <h2 className="alerts-rail-title">Folders</h2>
            {canConfigure && (
              <button
                type="button"
                className="results-bar-btn"
                onClick={() => { setFolderError(''); setShowFolderDialog(true); }}
                title="New folder"
                aria-label="New folder"
              >+</button>
            )}
          </div>

          <div className="iam-search alerts-rail-search">
            <IconSearch />
            <input
              type="text"
              value={folderSearch}
              placeholder="Search Folder"
              aria-label="Search Folder"
              onChange={(e) => setFolderSearch(e.target.value)}
            />
          </div>

          <div className="alerts-rail-list">
            {visibleFolders.length === 0 && (
              <div className="orgsw-empty">No folders match.</div>
            )}
            {visibleFolders.map((f) => {
              const isActive = !allFolders && f.folderId === activeFolder;
              return (
                <div
                  key={f.folderId}
                  className={`alerts-folder ${isActive ? 'is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="alerts-folder-btn"
                    title={f.description || f.name}
                    style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left', display: 'flex', alignItems: 'center', cursor: 'pointer' }}
                    onClick={() => { setAllFolders(false); setActiveFolder(f.folderId); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setAllFolders(false);
                        setActiveFolder(f.folderId);
                      }
                    }}
                  >
                    <span className="alerts-folder-name">{f.name || f.folderId}</span>
                  </button>
                  {/* The root folder cannot be deleted in OpenObserve, so it
                      gets no button rather than one that always fails. */}
                  {f.folderId !== DEFAULT_FOLDER_ID && canConfigure && (
                    <button
                      type="button"
                      className="alerts-folder-x"
                      title={`Delete folder “${f.name}”`}
                      aria-label={`Delete folder ${f.name}`}
                      onClick={(e) => { e.stopPropagation(); onDeleteFolder(f); }}
                    >×</button>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* ── Main column ──────────────────────────────────────────────── */}
        <section className="alerts-main">
          <header className="alerts-head">
            {/* "Alert Rules", not "Alerts": AlertsShell's title bar above already
                names the screen, and this is the card title for one of its two
                tabs — the same relationship a Settings tab's title has to the
                word "Settings" over it. An h2 for the same reason: the h1 is the
                screen title, and two of them on one screen is a heading outline
                that says the page has two subjects. */}
            <h2 className="alerts-title">Alert Rules</h2>

            <div className="tv-tabs" role="tablist" aria-label="Alert type">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`tv-tab ${tab === t.key ? 'is-active' : ''}`}
                  onClick={() => setTab(t.key)}
                >{t.label}</button>
              ))}
            </div>

            <div className="alerts-head-right">
              <div className="iam-search">
                <IconSearch />
                <input
                  type="text"
                  value={search}
                  placeholder="Search Alert"
                  aria-label="Search Alert"
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <Switch
                on={allFolders}
                onToggle={() => setAllFolders((v) => !v)}
                label="All Folders"
                title="List alerts across every folder"
              />

              <button
                type="button" className="results-bar-btn" onClick={reload}
                title="Refresh" aria-label="Refresh"
              ><IconRefresh /></button>

              {canConfigure && (
                <>
                  <button
                    type="button" className="alerts-btn-ghost"
                    onClick={() => setMode('import')}
                  ><IconUpload /> Import</button>

                  <button
                    type="button" className="alerts-btn-primary"
                    onClick={() => setMode('wizard')}
                  >New alert</button>
                </>
              )}
            </div>
          </header>

          {/* No banner here any more, in either direction — both outcomes are the
              one toast at the end of this render. The table is what this card is
              for, and it now starts directly under the header on every load
              rather than one bar down on the loads that follow a write. */}

          <div className={tableClass}>
            <div className="alerts-row alerts-row--head">
              <span aria-label="Enabled">On</span>
              <span>#</span>
              <span>Name</span>
              <span>Owner</span>
              {showWindowCols && <span>Look back window</span>}
              {showWindowCols && <span>Check every</span>}
              <span>Last Triggered At</span>
              <span>Last Satisfied At</span>
              {showTypeCol && <span>Type</span>}
              <span>Status</span>
              <span>Actions</span>
            </div>

            <div className="alerts-body-rows">
              <TableState loading={loading} error={error} empty={isEmpty} emptyLabel={emptyLabel} />
              {pageRows.map((row, i) => {
                const busy = busyIds.has(row.alertId);
                return (
                  <div
                    className={`alerts-row ${row.enabled ? '' : 'is-disabled'}`}
                    key={row.alertId || row.name || i}
                  >
                    <span>
                      {/* Enabling or disabling a rule changes whether it fires, so it
                          is a configuration write like any other. Here the switch is
                          DISABLED rather than removed: it is also the column that
                          reports current state, and dropping it would leave a
                          read-only viewer unable to see which rules are live. */}
                      <Switch
                        on={row.enabled}
                        busy={busy}
                        disabled={!canConfigure}
                        onToggle={() => onToggleEnabled(row)}
                        title={(() => {
                          if (busy) {
                            return row.enabled
                              ? `Disabling “${row.name}”…`
                              : `Enabling “${row.name}”…`;
                          }
                          if (!canConfigure) {
                            return `${row.enabled ? 'Enabled' : 'Disabled'} — you do not `
                              + 'have permission to change this';
                          }
                          return row.enabled
                            ? `Disable “${row.name}”`
                            : `Enable “${row.name}”`;
                        })()}
                      />
                    </span>
                    <span className="alerts-num">{rowNo(page * pageSize + i)}</span>
                    {/* The name opens the EDITOR, so it is only interactive for a
                        user who may edit. Without the grant it stays plain text
                        rather than a button-shaped element that refuses — the editor
                        is a write surface and has no read-only mode. */}
                    {canConfigure ? (
                      <button
                        type="button"
                        className="alerts-name native-el"
                        title={row.description || row.name}
                        onClick={() => openEditor(row.alertId)}
                      >{row.name}</button>
                    ) : (
                      <span className="alerts-name alerts-name--static"
                        title={row.description || row.name}>{row.name}</span>
                    )}
                    <span className="alerts-owner" title={row.owner || ''}>{row.owner || '—'}</span>
                    {showWindowCols && (
                      <span className="alerts-mono">{formatMinutes(row.period)}</span>
                    )}
                    {showWindowCols && (
                      <span className="alerts-mono">{formatFrequency(row)}</span>
                    )}
                    <span className="alerts-dim">{formatTimestamp(row.lastTriggeredAt)}</span>
                    <span className="alerts-dim">{formatTimestamp(row.lastSatisfiedAt)}</span>
                    {showTypeCol && (
                      <span>
                        <span className={`alerts-type alerts-type--${row.alertType || 'scheduled'}`}>
                          {alertTypeLabel(row.alertType)}
                        </span>
                      </span>
                    )}
                    <span className="alerts-dim">
                      {row.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <span>
                      {/* Every action in this cell writes — edit, clone, trigger a
                          real notification, delete — so the whole group is omitted
                          together rather than each control being gated separately.
                          The row keeps its cell so the grid stays aligned with the
                          header. */}
                      <span className="alerts-actions">
                        {canConfigure && (
                          <>
                        <button
                          type="button" className="alerts-action" disabled={busy}
                          onClick={() => openEditor(row.alertId)}
                          title="Edit" aria-label={`Edit ${row.name}`}
                        ><IconEdit /></button>
                        <button
                          type="button" className="alerts-action" disabled={busy}
                          onClick={() => onClone(row)}
                          title="Clone" aria-label={`Clone ${row.name}`}
                        ><IconCopy /></button>
                        {/* Shown for realtime alerts TOO, which was not the
                            original behaviour. The reasoning for hiding it — a
                            realtime alert has no schedule, so "evaluate now"
                            looked meaningless — turned out to be backwards:
                            OpenObserve accepts a trigger on a realtime alert
                            (200 "Alert triggered"), and because realtime alerts
                            are evaluated in the ingestion path rather than by
                            the scheduler, this button is the ONLY way to test
                            one from here. Hiding it removed the single tool that
                            could prove whether a realtime alert's destination
                            works at all. */}
                        <button
                          type="button" className="alerts-action" disabled={busy}
                          onClick={() => onTriggerNow(row)}
                          title={row.realTime
                            ? 'Send a test notification now (realtime alerts are not scheduled)'
                            : 'Evaluate now'}
                          aria-label={`Evaluate ${row.name} now`}
                        ><IconPlay /></button>
                        <button
                          type="button" className="alerts-action alerts-action--danger" disabled={busy}
                          onClick={() => onDelete(row)}
                          title="Delete" aria-label={`Delete ${row.name}`}
                        ><IconTrash /></button>
                          </>
                        )}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <TableFooter
            total={rows.length}
            page={page}
            pageSize={pageSize}
            setPage={setPage}
            setPageSize={setPageSize}
          />
        </section>
      </div>

      {/* Outside the panel, because it is fixed-position and belongs to the
          screen rather than to the table that raised it — same placement as the
          Toast in IamView. Green and self-dismissing for a success, red and
          waiting to be dismissed for a failure; see components/common/Toast. */}
      <Toast
        tone={toast?.tone}
        message={toast?.message || ''}
        onDismiss={() => setToast(null)}
      />

      {showFolderDialog && (
        <FolderDialog
          busy={folderBusy}
          error={folderError}
          onCancel={() => setShowFolderDialog(false)}
          onCreate={onCreateFolder}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={confirm.onConfirm}
        />
      )}
    </div>
  );
}

AlertsView.propTypes = {
  /** Active organization. Not read directly — it changes what the backend
   *  returns, so it is a fetch dependency. */
  activeOrg: PropTypes.string,
};
