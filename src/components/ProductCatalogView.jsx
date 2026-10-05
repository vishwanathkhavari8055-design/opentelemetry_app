import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  disableCatalogResource,
  enableCatalogResource,
  fetchCatalogCategories,
  fetchCatalogResources,
  removeCatalogResource,
} from '../services/api';
// SignalChecklist is no longer imported here — the table's Telemetry column is
// gone. It is still exported and still used by the register dialog's validation
// report and by the details drawer, so it has not become dead code.
import RegisterResourceDialog from './catalog/RegisterResourceDialog';
import ResourceDetailsDrawer, { agoLabel } from './catalog/ResourceDetailsDrawer';
import Toast from './common/Toast';
import useBackdropDismiss from './common/useBackdropDismiss';

/**
 * Product Catalog — the registry of every monitored resource.
 *
 * ─── What this screen actually controls ────────────────────────────────────
 *
 * It is not a list of links. Disabling a row here removes that resource's
 * telemetry from Logs, Traces and Metrics across the whole application, because
 * the backend folds the registry into the WHERE clause of every one of those
 * queries. That is why the destructive-looking actions are separated: Disable is
 * reversible and instant, Remove unregisters (and, in the default filter mode,
 * makes the telemetry visible again — which is the opposite of what "remove"
 * suggests, so the confirmation says so in as many words).
 *
 * ─── Filtering happens on the server ───────────────────────────────────────
 *
 * The toolbar's three controls are sent as query parameters rather than applied
 * to a cached array. The backend owns the registry and reports per-category
 * counts from it; filtering here as well would eventually disagree with those
 * counts, and the disagreement would be silent.
 */

/** Slow poll so a Last Seen column does not go stale while someone watches it.
 *  The backend serves Last Seen from a TTL cache and batches its refresh into
 *  one query per identifier, so this costs a request, not a query storm. */
const POLL_MS = 30_000;

const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All statuses' },
  { value: 'ENABLED', label: 'Enabled' },
  { value: 'DISABLED', label: 'Disabled' },
];

const LS_CATEGORY = 'observability-ui:catalog:category:v1';

export default function ProductCatalogView({ activeOrg }) {
  const [categories, setCategories] = useState([]);
  const [resources, setResources] = useState([]);
  const [filterMode, setFilterMode] = useState(null);
  const [supported, setSupported] = useState(true);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(() => {
    try { return localStorage.getItem(LS_CATEGORY) || 'ALL'; } catch { return 'ALL'; }
  });
  const [status, setStatus] = useState('ALL');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  /** Row id currently mid-request, so its buttons can disable individually
   *  rather than freezing the whole table. */
  const [pendingId, setPendingId] = useState(null);

  const [registering, setRegistering] = useState(false);
  const [detailsFor, setDetailsFor] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);

  useEffect(() => {
    try { localStorage.setItem(LS_CATEGORY, category); } catch { /* not persisted */ }
  }, [category]);

  // Debounce the search box: it filters server-side, so typing "postgres" would
  // otherwise be eight requests, and their responses can arrive out of order.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (signal, { refresh = false } = {}) => {
    const [list, cats] = await Promise.all([
      fetchCatalogResources({
        search: debouncedSearch, category, status, refresh, signal,
      }),
      // Counts change with every registration, so the two are always fetched
      // together — a stale count next to a fresh table reads as a bug.
      fetchCatalogCategories({ signal }),
    ]);
    setResources(list.items);
    setSupported(list.supported);
    setFilterMode(list.filterMode);
    setCategories(cats.items);
  }, [debouncedSearch, category, status]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');

    load(controller.signal)
      .then(() => { if (!cancelled) setLoading(false); })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Could not load the Product Catalog.');
        setLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
    // activeOrg is not read here, but it changes what the backend returns — it
    // must stay a dependency or switching tenant would leave another org's rows.
     
  }, [load, activeOrg, reloadTick]);

  // Keep Last Seen moving, but only while the tab is visible: a background tab
  // polling forever is pure waste, and the visibility handler covers coming back.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    let timer = null;
    const tick = () => { loadRef.current().catch(() => { /* keep what we have */ }); };
    const start = () => { if (timer == null) timer = setInterval(tick, POLL_MS); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') { tick(); start(); } else stop();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  /**
   * Run a row action, then refetch.
   *
   * Refetch rather than patch the row in place: the registry is the only source
   * of truth, and enabling a resource can also move it in or out of the current
   * status filter. Patching would leave a row visible that no longer matches
   * what the screen claims to be showing.
   */
  const runAction = async (id, action, describe) => {
    setPendingId(id);
    setError('');
    try {
      const result = await action(id);
      setNotice(result?.message || describe);
      await load(undefined, { refresh: true });
    } catch (err) {
      setError(err.message || `Could not ${describe.toLowerCase()}.`);
    } finally {
      setPendingId(null);
    }
  };

  const manualRefresh = () => {
    setNotice('');
    setError('');
    setReloadTick((t) => t + 1);
  };

  const enabledCount = useMemo(
    () => resources.filter((r) => r.status === 'ENABLED').length,
    [resources],
  );

  const isEmpty = !loading && !error && resources.length === 0;
  const hasFilters = !!debouncedSearch || category !== 'ALL' || status !== 'ALL';

  return (
    <div className="pc-view">
      <header className="pc-head">
        <div className="pc-head-title">
          <h1 className="pc-title">Product Catalog</h1>
          <p className="pc-subtitle">
            The registry of monitored resources. OpenObserve is the source of truth —
            a resource can only be registered once it is emitting telemetry.
          </p>
        </div>

        <div className="pc-toolbar">
          <div className="iam-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
            <input
              type="text"
              value={search}
              placeholder="Search resources"
              aria-label="Search resources"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select
            className="ae-select pc-filter"
            value={category}
            aria-label="Filter by category"
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="ALL">All categories</option>
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}{c.registeredCount ? ` (${c.registeredCount})` : ''}
              </option>
            ))}
          </select>

          <select
            className="ae-select pc-filter"
            value={status}
            aria-label="Filter by status"
            onChange={(e) => setStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>

          <button
            type="button"
            className="results-bar-btn"
            onClick={manualRefresh}
            title="Refresh"
            aria-label="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>

          <button
            type="button"
            className="alerts-btn-primary"
            onClick={() => setRegistering(true)}
            disabled={!supported}
            title={supported
              ? 'Register a new resource'
              : 'Registration needs the OpenObserve backend'}
          >Register Resource</button>
        </div>
      </header>

      {!supported && (
        <output className="alerts-banner alerts-banner--error native-el">
          <span className="alerts-banner-text">
            The Product Catalog needs the OpenObserve backend to validate resources.
            Existing registrations are listed, but nothing new can be registered
            while <code>openobserve.enabled=false</code>.
          </span>
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

      <div className="pc-table">
        <div className="pc-row pc-row--head">
          <span>Category</span>
          {/* PRODUCT sits between Category and the microservice, matching the
              registration order: category → product → microservice. */}
          <span>Product</span>
          <span>Resource Name</span>
          <span>Version</span>
          <span>Status</span>
          {/* No Telemetry column. The per-signal checklist is still in the details
              drawer's Visibility section, where it has room for the distinction
              that matters — "switched off" versus "never emitted" — which three
              ticks in a table cell could not express anyway. */}
          <span>Last Seen</span>
          <span>Actions</span>
        </div>

        <div className="pc-body">
          {loading && <div className="iam-state">Loading…</div>}

          {isEmpty && (
            <div className="iam-state">
              {hasFilters
                ? 'No registered resource matches these filters.'
                : 'Nothing registered yet. Click Register Resource to add the first one — '
                  + 'until then, Logs, Traces and Metrics behave exactly as they always have.'}
            </div>
          )}

          {!loading && resources.map((resource) => {
            const enabled = resource.status === 'ENABLED';
            const rowBusy = pendingId === resource.id;
            return (
              <div className="pc-row" key={resource.id}>
                <span className="pc-category" title={resource.categoryLabel}>
                  {resource.categoryLabel || resource.category}
                </span>

                {/* An em-dash rather than blank for the categories with no product
                    list: blank reads as missing data, and this is a legitimate
                    "not applicable". */}
                <span className="pc-product" title={resource.productLabel || 'No product'}>
                  {resource.productLabel || <span className="pc-dim">—</span>}
                </span>

                <span className="pc-name" title={resource.resolvedName || resource.resourceName}>
                  {resource.resourceName}
                  {/* Shown only when they differ: the registered identifier is
                      what actually governs filtering, and a silent mismatch
                      between it and the label is how a catalog stops describing
                      the telemetry it claims to. */}
                  {resource.resolvedName && resource.resolvedName !== resource.resourceName && (
                    <span className="pc-resolved" title="The identifier telemetry uses">
                      {resource.resolvedName}
                    </span>
                  )}
                </span>

                <span className="pc-version" title={resource.version || 'No version recorded'}>
                  {resource.version || <span className="pc-dim">—</span>}
                </span>

                <span>
                  <span className={`pc-status pc-status--${enabled ? 'on' : 'off'}`}>
                    <span className="pc-status-dot" aria-hidden="true" />
                    {enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </span>

                <span className="pc-lastseen" title={resource.lastSeen || 'Never seen'}>
                  {resource.lastSeen
                    ? (agoLabel(resource.lastSeenAgoSec) || new Date(resource.lastSeen).toLocaleString())
                    : <span className="pc-dim">—</span>}
                </span>

                <span className="pc-actions">
                  {enabled ? (
                    <button
                      type="button" className="iam-switch-btn"
                      disabled={rowBusy}
                      onClick={() => runAction(resource.id, disableCatalogResource,
                        `${resource.resourceName} disabled`)}
                      title="Hide this resource's telemetry across Logs, Traces and Metrics"
                    >Disable</button>
                  ) : (
                    <button
                      type="button" className="iam-switch-btn"
                      disabled={rowBusy}
                      onClick={() => runAction(resource.id, enableCatalogResource,
                        `${resource.resourceName} enabled`)}
                      title="Show this resource's telemetry again"
                    >Enable</button>
                  )}
                  <button
                    type="button" className="iam-switch-btn"
                    onClick={() => setDetailsFor(resource)}
                    title="Matched identifiers and timestamps"
                  >Details</button>
                  <button
                    type="button" className="iam-switch-btn pc-danger"
                    disabled={rowBusy}
                    onClick={() => setConfirmRemove(resource)}
                    title="Unregister this resource"
                  >Remove</button>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <footer className="iam-foot">
        <span className="iam-foot-total">
          {resources.length} resource{resources.length === 1 ? '' : 's'}
          {resources.length > 0 && (
            <span className="pc-dim"> · {enabledCount} enabled</span>
          )}
        </span>
        <span className="iam-foot-right">
          {/* Worth stating plainly: what Disabled does is not obvious, and it
              differs between the two backend modes. */}
          {filterMode === 'ENABLED_ONLY' ? (
            <span className="pc-dim">
              Only registered, enabled resources appear in Logs, Traces and Metrics.
            </span>
          ) : (
            <span className="pc-dim">
              Disabled resources are hidden from Logs, Traces and Metrics. Anything
              not registered here is unaffected.
            </span>
          )}
        </span>
      </footer>

      {/* Fixed-position, so it sits outside the table's flow rather than pushing it
          down and back up again the way the inline banner did. */}
      <Toast message={notice} onDismiss={() => setNotice('')} />

      {registering && (
        <RegisterResourceDialog
          categories={categories}
          defaultCategory={category === 'ALL' ? undefined : category}
          onCancel={() => setRegistering(false)}
          onRegistered={(created) => {
            setRegistering(false);
            setNotice(`${created.resourceName} registered under ${created.categoryLabel}.`);
            manualRefresh();
          }}
        />
      )}

      {detailsFor && (
        <ResourceDetailsDrawer
          resource={detailsFor}
          onClose={() => setDetailsFor(null)}
        />
      )}

      {confirmRemove && (
        <RemoveConfirmDialog
          resource={confirmRemove}
          filterMode={filterMode}
          busy={pendingId === confirmRemove.id}
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const target = confirmRemove;
            setConfirmRemove(null);
            runAction(target.id, removeCatalogResource, `${target.resourceName} removed`);
          }}
        />
      )}
    </div>
  );
}

/**
 * Remove confirmation.
 *
 * Spells out the consequence rather than asking "are you sure", because the
 * consequence is genuinely counter-intuitive: in the default filter mode,
 * removing a DISABLED resource makes its telemetry reappear everywhere. Someone
 * reaching for Remove to make a noisy service go away would achieve the exact
 * opposite, and no amount of "are you sure" would warn them.
 */
function RemoveConfirmDialog({ resource, filterMode, busy, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const wasDisabled = resource.status === 'DISABLED';
  const reappears = wasDisabled && filterMode !== 'ENABLED_ONLY';
  const backdropRef = useBackdropDismiss(() => { if (!busy) onCancel(); });

  return (
    <dialog
      open
      ref={backdropRef}
      className="alerts-modal-backdrop native-el"
      aria-modal="true"
      aria-label="Remove resource"
    >
      <div className="alerts-modal">
        <div className="alerts-modal-head">
          <h2 className="alerts-modal-title">Remove {resource.resourceName}?</h2>
          <button
            type="button" className="alerts-modal-x" onClick={onCancel}
            disabled={busy} aria-label="Close"
          >×</button>
        </div>
        <div className="alerts-modal-body">
          <p className="pc-confirm-text">
            This unregisters the resource from the catalog. Its telemetry in
            OpenObserve is not deleted or affected in any way.
          </p>
          {reappears && (
            <p className="pc-confirm-warn">
              It is currently <strong>disabled</strong>, and only registered resources
              can be hidden — so removing it will make its logs, traces and metrics
              appear again across the application. To keep it hidden, leave it
              registered and disabled.
            </p>
          )}
          <p className="ae-hint">
            You can register it again at any time, as long as it is still emitting.
          </p>
        </div>
        <div className="alerts-modal-foot">
          <button
            type="button" className="alerts-btn-ghost" onClick={onCancel} disabled={busy}
          >Cancel</button>
          <button
            type="button" className="alerts-btn-primary pc-btn-danger"
            onClick={onConfirm} disabled={busy}
          >{busy ? 'Removing…' : 'Remove'}</button>
        </div>
      </div>
    </dialog>
  );
}

RemoveConfirmDialog.propTypes = {
  resource: PropTypes.shape({
    id: PropTypes.string.isRequired,
    resourceName: PropTypes.string.isRequired,
    status: PropTypes.string,
  }).isRequired,
  filterMode: PropTypes.string,
  busy: PropTypes.bool,
  onCancel: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
};

ProductCatalogView.propTypes = {
  /** Identifier of the organization every request is scoped to. Changing it
   *  refetches, because the catalog is a per-tenant inventory. */
  activeOrg: PropTypes.string,
};
