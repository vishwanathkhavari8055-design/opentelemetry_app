import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';

import {
  fetchDashboardHealth,
  fetchDashboardRegistrations,
  fetchGrafanaFolders,
  syncDashboardRegistration,
  unregisterDashboard,
  updateDashboardRegistration,
} from '../../services/dashboardsApi';
import RegisterDashboardDialog from './RegisterDashboardDialog';
import { folderLabel } from './folderTree';
import Toast from '../common/Toast';

/**
 * Dashboard Catalog — which Grafana dashboards this application exposes.
 *
 * Lives in Settings, beside Product Catalog, because it is the same kind of
 * thing: a registry an administrator curates that decides what everyone else can
 * see. Registering here is what makes a dashboard appear as a tile on the
 * Dashboards screen; nothing appears there that is not registered here.
 *
 * ─── Why this is a flat table and not the Dashboards screen's tree ──────────
 *
 * The Dashboards screen browses Grafana's folder hierarchy, because a viewer is
 * looking for one dashboard and the folders are how they know where it is. This
 * screen is the opposite job: an administrator auditing what is registered, where
 * it ended up, and what is disabled. That question is answered by one sortable
 * list of every row at once — a hierarchy would hide most of the registry behind
 * clicks and make "which dashboard is in the wrong folder" impossible to see.
 * The Folder column carries the placement, and it is editable in place.
 *
 * ─── What this screen does NOT do ───────────────────────────────────────────
 *
 * It stores no dashboard. Grafana holds the definition, and every open re-reads
 * it, so a panel edited in Grafana changes here on the next open. Unregistering
 * deletes nothing and hides nothing in Grafana — it only removes the tile.
 *
 * That is worth knowing while reading the actions below, because it is what makes
 * Remove safe enough to offer without a confirmation dialog: nothing is
 * destroyed, and putting it back is two clicks. Contrast the Product Catalog,
 * where Remove changes what telemetry is visible across Logs, Traces and Metrics
 * and therefore does confirm.
 *
 * ─── Reads are unconditional, writes are not ────────────────────────────────
 *
 * The registry lists even when Grafana is unreachable — what is registered is
 * this application's own state, and hiding it would make an unreachable Grafana
 * look like an empty catalog. Registering needs Grafana, so the button says why
 * when it cannot be used.
 */
export default function DashboardCatalogView({ activeOrg }) {
  const [rows, setRows] = useState([]);
  const [folders, setFolders] = useState([]);
  const [foldersMessage, setFoldersMessage] = useState('');
  const [health, setHealth] = useState(null);

  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  /** UID currently mid-request, so its own buttons disable rather than the table. */
  const [pendingUid, setPendingUid] = useState(null);
  const [registering, setRegistering] = useState(false);

  const load = useCallback(async (signal) => {
    const [registry, folderList, healthResult] = await Promise.all([
      fetchDashboardRegistrations({ signal }),
      // Never fatal: the table is readable without it, and only the register
      // dialog and the per-row folder picker need the list.
      fetchGrafanaFolders({ signal }).catch(() => null),
      fetchDashboardHealth({ signal }).catch(() => null),
    ]);
    setRows(registry?.items || []);
    setFolders(folderList?.items || []);
    setFoldersMessage(folderList?.message || '');
    setHealth(healthResult);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');

    load(controller.signal)
      .then(() => { if (!cancelled) setLoading(false); })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Could not load the Dashboard Catalog.');
        setLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
    // `activeOrg` is not READ in this effect, and is a dependency anyway: under
    // grafana.registry.scope=ORG it changes what the backend returns, so dropping
    // it would leave another organization's rows in the table after a switch.
  }, [load, activeOrg, reloadTick]);

  const refresh = () => { setNotice(''); setError(''); setReloadTick((tick) => tick + 1); };

  /**
   * Run a row action, then refetch.
   *
   * Refetch rather than patch the row: the registry is the only source of truth,
   * and a move changes display order as well as folder. Patching locally would
   * leave the table showing an order the backend does not agree with.
   */
  const runAction = async (uid, action, describe) => {
    setPendingUid(uid);
    setError('');
    try {
      const result = await action();
      setNotice(result?.message || describe);
      await load();
    } catch (err) {
      setError(err.message || `Could not ${describe.toLowerCase()}.`);
    } finally {
      setPendingUid(null);
    }
  };

  // Filtered here, not server-side: the whole registry is a few dozen rows that
  // are already in memory, so a request per keystroke would be pure latency.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => [row.title, row.uid, row.folderTitle, row.grafanaFolderTitle]
      .some((field) => field && String(field).toLowerCase().includes(needle)));
  }, [rows, search]);

  const notConfigured = health?.supported === false;
  const canRegister = !notConfigured && folders.length > 0;

  return (
    <div className="gd-catalog">
      <header className="gd-cat-head">
        <div className="gd-head-title">
          <h1 className="gd-title">Dashboard Catalog</h1>
        </div>

        <div className="gd-cat-toolbar">
          <div className="iam-search">
            <svg
              width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
            <input
              type="text"
              value={search}
              placeholder="Search dashboards"
              aria-label="Search dashboards"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="results-bar-btn"
            onClick={refresh}
            title="Refresh"
            aria-label="Refresh"
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            >
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>

          <button
            type="button"
            className="alerts-btn-primary"
            onClick={() => setRegistering(true)}
            disabled={!canRegister}
            title={canRegister
              ? 'Register a Grafana dashboard by its UID'
              : 'Registration needs a configured, reachable Grafana'}
          >Register Dashboard</button>
        </div>
      </header>

      {notConfigured && (
        <output className="alerts-banner alerts-banner--error native-el">
          <span className="alerts-banner-text">
            {health.message} Existing registrations are listed below, but nothing new can
            be registered and no dashboard can be opened until Grafana is configured.
          </span>
        </output>
      )}

      {/* Grafana IS configured but its folders could not be listed — a bad token,
          or an unreachable host. Distinct from the banner above, and it is the
          message that tells them apart. */}
      {!notConfigured && folders.length === 0 && foldersMessage && (
        <output className="alerts-banner alerts-banner--error native-el">
          <span className="alerts-banner-text">{foldersMessage}</span>
        </output>
      )}

      {error && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">{error}</span>
          <button
            type="button" className="alerts-banner-x"
            onClick={() => setError('')} aria-label="Dismiss"
          >×</button>
        </div>
      )}

      <div className="gd-table">
        <div className="gd-row gd-row--head">
          <span>Order</span>
          <span>Dashboard</span>
          <span>UID</span>
          <span>Folder</span>
          <span>Status</span>
          <span>Actions</span>
        </div>

        <div className="gd-body">
          {loading && <div className="iam-state">Loading…</div>}

          {!loading && filtered.length === 0 && (
            <div className="iam-state">
              {rows.length === 0
                ? 'Nothing registered yet. Click Register Dashboard to add the first one — '
                  + 'until then the Dashboards screen is empty.'
                : `Nothing matches “${search}”.`}
            </div>
          )}

          {!loading && filtered.map((row) => {
            const rowBusy = pendingUid === row.uid;
            return (
              <div className="gd-row" key={row.uid}>
                {/* Committed on blur, not per keystroke: a three-digit order would
                    otherwise be three PATCHes whose responses can land out of
                    order, and the last one to arrive would win. */}
                <span>
                  <input
                    className="gd-order"
                    type="number"
                    min={0}
                    defaultValue={row.displayOrder}
                    disabled={rowBusy}
                    aria-label={`Display order for ${row.title}`}
                    onBlur={(e) => {
                      const next = Number(e.target.value);
                      if (Number.isFinite(next) && next !== row.displayOrder) {
                        runAction(
                          row.uid,
                          () => updateDashboardRegistration(row.uid, { displayOrder: next }),
                          `${row.title} reordered`,
                        );
                      }
                    }}
                  />
                </span>

                <span className="gd-name" title={row.title || row.uid}>
                  {row.title || <em className="gd-dim">untitled</em>}
                </span>

                <span><code className="gd-uid">{row.uid}</code></span>

                <span className="gd-folder">
                  {/* Changing this moves the dashboard to another tile on the
                      Dashboards screen. */}
                  <select
                    className="ae-select"
                    value={row.folderUid || ''}
                    disabled={rowBusy || folders.length === 0}
                    aria-label={`Folder for ${row.title}`}
                    onChange={(e) => runAction(
                      row.uid,
                      () => updateDashboardRegistration(row.uid, { folderUid: e.target.value }),
                      `Moved ${row.title}`,
                    )}
                  >
                    {/* Its current folder may not be in the offered list — an
                        allow-list narrowed since it was registered, or a folder
                        deleted in Grafana. Keeping it as an option means the row
                        still shows where it is filed instead of snapping to
                        whatever happens to be first. */}
                    {!folders.some((folder) => folder.uid === row.folderUid) && (
                      <option value={row.folderUid || ''}>
                        {row.folderTitle || 'Ungrouped'}
                      </option>
                    )}
                    {/* The whole Grafana tree, each folder shown by its full path
                        — so "Default Org." is distinguishable from any other
                        folder of that name under a different parent. */}
                    {folders.map((folder) => (
                      <option key={folder.uid} value={folder.uid} title={folderLabel(folder)}>
                        {folderLabel(folder)}
                      </option>
                    ))}
                  </select>
                  {row.folderMismatch && (
                    <span
                      className="gd-mismatch"
                      title="Where this dashboard actually lives in Grafana"
                    >
                      in Grafana: {row.grafanaFolderTitle}
                    </span>
                  )}
                </span>

                <span>
                  <span className={`gd-status-chip gd-status-chip--${row.enabled ? 'on' : 'off'}`}>
                    <span className="gd-status-dot" aria-hidden="true" />
                    {row.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </span>

                <span className="gd-actions">
                  <button
                    type="button"
                    className="iam-switch-btn"
                    disabled={rowBusy}
                    onClick={() => runAction(
                      row.uid,
                      () => updateDashboardRegistration(row.uid, { enabled: !row.enabled }),
                      `${row.title} ${row.enabled ? 'disabled' : 'enabled'}`,
                    )}
                    title={row.enabled
                      ? 'Hide it from the Dashboards screen, keeping the registration'
                      : 'Show it on the Dashboards screen again'}
                  >{row.enabled ? 'Disable' : 'Enable'}</button>

                  <button
                    type="button"
                    className="iam-switch-btn"
                    disabled={rowBusy || notConfigured}
                    onClick={() => runAction(
                      row.uid,
                      () => syncDashboardRegistration(row.uid),
                      `Re-read ${row.uid} from Grafana`,
                    )}
                    title="Re-read the title and Grafana folder from Grafana"
                  >Sync</button>

                  {/* No confirmation, deliberately: this deletes nothing and hides
                      nothing in Grafana, and re-registering is two clicks. See the
                      note at the top of this file. */}
                  <button
                    type="button"
                    className="iam-switch-btn gd-danger"
                    disabled={rowBusy}
                    onClick={() => runAction(
                      row.uid,
                      () => unregisterDashboard(row.uid),
                      `Unregistered ${row.title}`,
                    )}
                    title="Remove from this application — the Grafana dashboard is untouched"
                  >Remove</button>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <Toast message={notice} onDismiss={() => setNotice('')} />

      {registering && (
        <RegisterDashboardDialog
          folders={folders}
          foldersMessage={foldersMessage}
          onCancel={() => setRegistering(false)}
          onRegistered={(created) => {
            setRegistering(false);
            setNotice(`Registered “${created.title}” into ${created.folderTitle}.`);
            refresh();
          }}
        />
      )}
    </div>
  );
}

DashboardCatalogView.propTypes = {
  /** Identifier of the organization every request is scoped to. */
  activeOrg: PropTypes.string,
};
