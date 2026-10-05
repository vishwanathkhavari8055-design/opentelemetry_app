import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchIamUsers, fetchServiceAccounts } from '../services/api';
import UserEditDrawer from './iam/UserEditDrawer';
import ProductCatalogView from './ProductCatalogView';
import DashboardCatalogView from './dashboards/DashboardCatalogView';
import ResourceUsageView from './resources/ResourceUsageView';
import Toast from './common/Toast';

/**
 * Settings screen: Users, Service Accounts, Organizations, Product Catalog,
 * Dashboard Catalog and Resources.
 *
 * Named "Settings" everywhere the user can see it; the code keeps the `iam-`
 * prefix because the route key, the permission (VIEW_IAM), the deep links and
 * the persisted tab all key on it, and two other stylesheets hang their layout
 * off `.iam-main`.
 *
 * Users and Service Accounts are scoped to the ACTIVE ORGANIZATION — the
 * backend derives that from the `org` param api.js attaches to every request,
 * so switching org in the header changes what these tables show without this
 * component knowing anything about it. Organizations is deliberately global:
 * it's the list you switch between.
 *
 * Read-only. The "New user" / "New service account" / "New organization"
 * buttons in the reference UI are absent rather than present-and-disabled,
 * because this deployment talks to OpenObserve with one shared service account
 * — a user created here would be attributed to that account, not to whoever
 * clicked. See IamService on the backend for the same note.
 */

const SUB_TABS = [
  { key: 'users',    label: 'Users' },
  { key: 'accounts', label: 'Service Accounts' },
  { key: 'orgs',     label: 'Organizations' },
  // Directly under Organizations, because that is what it belongs to: the
  // catalog is a per-tenant inventory, keyed by org, and the same resource name
  // registered in two organizations means two different things. It used to be a
  // top-level rail item, which put a tenant-scoped registry at the same level as
  // Logs and Traces and gave no hint that switching org changed its contents.
  { key: 'catalog',  label: 'Product Catalog' },
  // Directly beside Product Catalog, because it is the same KIND of screen: a
  // registry an administrator curates that decides what everyone else can see.
  // Product Catalog decides which resources' telemetry appears in Logs, Traces
  // and Metrics; this one decides which Grafana dashboards are reachable on the
  // Dashboards screen. Neither stores what it points at — OpenObserve and Grafana
  // respectively stay the source of truth — and both are administrator decisions,
  // which is why they sit behind the same VIEW_IAM grant rather than next to the
  // screens they govern.
  { key: 'dashboard-catalog', label: 'Dashboard Catalog' },
  // CPU, memory, disk and NFS storage, from one backend call
  // (GET /api/infrastructure/utilization). NOT one scope: CPU and memory measure
  // the tiotopenobserve pods against their configured limits, disk and NFS are
  // cluster-wide, and each card prints which — see the scope note at the top of
  // components/resources/ResourceUsageView. It used to read OpenObserve's own
  // self-monitoring metrics through the PromQL passthrough; that source stopped
  // being written and blanked three of the four cards.
  { key: 'analysis', label: 'Resources' },
];

const LS_TAB = 'observability-ui:iam:tab:v1';

/** Search box placeholder per sub-tab; anything else is the Organizations tab. */
const SEARCH_LABELS = { users: 'Search User', accounts: 'Search Service Account' };

/** How many numbered buttons the pager shows before it starts to slide. */
const PAGE_WINDOW = 5;

/** Serial number, as the reference shows it: 1, 2, 3 — not zero-padded. */
const rowNo = (i) => String(i + 1);

/** Shared empty/loading/error body so all three tables behave identically. */
function TableState({ loading, error, empty, emptyLabel, colSpan }) {
  if (!loading && !error && !empty) return null;
  let body = emptyLabel;
  if (loading) body = 'Loading…';
  else if (error) body = <span className="iam-state-error">{error}</span>;
  return (
    <div className="iam-state" style={{ gridColumn: `1 / -1` }} data-colspan={colSpan}>
      {body}
    </div>
  );
}
TableState.propTypes = {
  loading: PropTypes.bool,
  error: PropTypes.string,
  empty: PropTypes.bool,
  emptyLabel: PropTypes.string,
  colSpan: PropTypes.number,
};

/**
 * Filled triangle, optionally with the bar that makes it "jump to the end".
 * One shape mirrored for the two directions, so all four buttons carry exactly
 * the same weight of ink — four hand-drawn paths never quite do.
 */
function PagerIcon({ kind }) {
  const rightward = kind === 'next' || kind === 'last';
  const capped = kind === 'first' || kind === 'last';
  return (
    <svg
      width="9" height="9" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"
      style={rightward ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M10.4 0.9v10.2L3.1 6z" />
      {capped && <rect x="1" y="0.9" width="1.7" height="10.2" rx="0.4" />}
    </svg>
  );
}
PagerIcon.propTypes = { kind: PropTypes.oneOf(['first', 'prev', 'next', 'last']).isRequired };

/**
 * Footer pager: |◀ ◀ 1 2 ▶ ▶|, bottom-right, exactly as the reference draws it.
 *
 * The window slides rather than listing every page, because the tables behind it
 * are unbounded — an org with 40 pages would otherwise push the arrows off the
 * panel.
 */
function TablePager({ total, page, pageSize, setPage }) {
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const start = Math.max(0, Math.min(page - Math.floor(PAGE_WINDOW / 2), lastPage - PAGE_WINDOW + 1));
  const pages = [];
  for (let p = Math.max(0, start); p <= Math.min(lastPage, Math.max(0, start) + PAGE_WINDOW - 1); p += 1) {
    pages.push(p);
  }

  return (
    <div className="iam-foot">
      <nav className="iam-pagerbar" aria-label="Pagination">
        <button
          type="button" className="iam-pager" aria-label="First page"
          onClick={() => setPage(0)} disabled={page === 0}
        ><PagerIcon kind="first" /></button>
        <button
          type="button" className="iam-pager" aria-label="Previous page"
          onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
        ><PagerIcon kind="prev" /></button>

        {pages.map((p) => (
          <button
            key={p}
            type="button"
            className={`iam-pager ${p === page ? 'is-current' : ''}`}
            onClick={() => setPage(p)}
            aria-label={`Page ${p + 1}`}
            aria-current={p === page ? 'page' : undefined}
          >{p + 1}</button>
        ))}

        <button
          type="button" className="iam-pager" aria-label="Next page"
          onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage}
        ><PagerIcon kind="next" /></button>
        <button
          type="button" className="iam-pager" aria-label="Last page"
          onClick={() => setPage(lastPage)} disabled={page >= lastPage}
        ><PagerIcon kind="last" /></button>
      </nav>
    </div>
  );
}
TablePager.propTypes = {
  total: PropTypes.number.isRequired,
  page: PropTypes.number.isRequired,
  pageSize: PropTypes.number.isRequired,
  setPage: PropTypes.func.isRequired,
};

/** U+FEFF, written as a code point so the source file stays plain ASCII. */
const BOM = String.fromCodePoint(0xFEFF);

/** One CSV field, quoted only when it has to be. */
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export default function IamView({
  activeOrg, onOrgChange,
  organizations, organizationsLoading, onRefreshOrganizations,
  requestedSection,
}) {
  const [tab, setTab] = useState(() => {
    try {
      const t = localStorage.getItem(LS_TAB);
      return SUB_TABS.some((s) => s.key === t) ? t : 'users';
    } catch { return 'users'; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_TAB, tab); } catch { /* not persisted */ }
  }, [tab]);

  // Deep link from elsewhere in the app — the Logs sidebar's "open the catalog"
  // jump, which used to be a top-level tab change and now has to reach a section
  // inside this screen. Keyed on the token rather than the section name so the
  // same jump works twice in a row: the caller bumps a nonce, and landing on the
  // section does not prevent the user navigating away and coming back.
  useEffect(() => {
    if (!requestedSection) return;
    if (SUB_TABS.some((s) => s.key === requestedSection.section)) {
      setTab(requestedSection.section);
    }
  }, [requestedSection]);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize] = useState(20);

  const [data, setData] = useState({ users: null, accounts: null, orgs: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  // The user currently open in the Update User drawer, or null.
  const [editingUser, setEditingUser] = useState(null);
  const [notice, setNotice] = useState('');

  // Reset paging and the search box whenever the view changes underneath —
  // page 3 of Users is meaningless once you're looking at Organizations, and a
  // stale filter would silently hide rows in the new tab.
  useEffect(() => { setPage(0); setSearch(''); setNotice(''); }, [tab, activeOrg]);

  // Organizations are NOT fetched here. App owns that list — it polls, and
  // refreshes on tab focus and when the header switcher opens — and the header
  // and this table must never disagree about which organizations exist. The
  // other two tabs are org-scoped and belong to this screen.
  const fetcher = useMemo(() => ({
    users: fetchIamUsers,
    accounts: fetchServiceAccounts,
  }[tab]), [tab]);

  useEffect(() => {
    if (!fetcher) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');

    fetcher({ signal: controller.signal })
      .then((res) => {
        if (cancelled) return;
        setData((d) => ({ ...d, [tab]: res }));
        if (res?.supported === false) {
          setError('Settings requires the OpenObserve backend.');
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Request failed.');
        setLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
    // activeOrg is not read here, but it changes what the backend returns —
    // it must stay a dependency or switching org would leave stale rows.
     
  }, [tab, fetcher, activeOrg, reloadTick]);

  // Memoised so the `?? []` fallback doesn't hand useMemo a fresh array
  // identity on every render and defeat the filter's memoisation.
  const allRows = useMemo(
    () => (tab === 'orgs' ? organizations : data[tab]?.items) || [],
    [tab, organizations, data],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) => Object.values(r).some(
      (v) => v != null && String(v).toLowerCase().includes(q),
    ));
  }, [allRows, search]);

  const pageRows = useMemo(
    () => filtered.slice(page * pageSize, (page + 1) * pageSize),
    [filtered, page, pageSize],
  );

  // The catalog brings its own toolbar, filters and paging, so it replaces the
  // shared header/table/footer rather than being wrapped in them — two search
  // boxes and two footers on one screen would be a worse outcome than leaving it
  // where it was. iam.css flattens its header and table into this panel so it
  // still reads as one card. The dashboard catalog is the same (dashboards.css
  // flattens it), and Analysis brings its own heading and scroll area.
  let embeddedView = null;
  if (tab === 'catalog') {
    embeddedView = <ProductCatalogView key={activeOrg || 'default'} activeOrg={activeOrg} />;
  } else if (tab === 'dashboard-catalog') {
    embeddedView = <DashboardCatalogView key={activeOrg || 'default'} activeOrg={activeOrg} />;
  } else if (tab === 'analysis') {
    embeddedView = <ResourceUsageView activeOrg={activeOrg} />;
  }

  const heading = SUB_TABS.find((s) => s.key === tab)?.label || 'Users';
  const searchLabel = SEARCH_LABELS[tab] || 'Search Organization';

  const isBusy = tab === 'orgs' ? organizationsLoading : loading;
  const isEmpty = !isBusy && !error && filtered.length === 0;
  const emptyLabel = allRows.length === 0
    ? 'No data available'
    : `Nothing matches “${search}”.`;

  /**
   * Export button on Organizations, as in the reference. Built here from the
   * rows already on screen rather than from a backend endpoint, so what lands in
   * the file is exactly what the current search shows.
   */
  const exportOrgsCsv = () => {
    const head = ['Sl.No', 'Name', 'Identifier', 'Type'];
    const body = filtered.map((o, i) => [i + 1, o.name, o.identifier, o.type]);
    const csv = [head, ...body].map((r) => r.map(csvCell).join(',')).join('\r\n');
    // The BOM is what makes Excel read the file as UTF-8 rather than as the
    // local codepage, which otherwise mangles non-ASCII organization names.
    const url = URL.createObjectURL(new Blob([BOM + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `organizations-${activeOrg || 'all'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="iam-view">
      {/* Screen title bar. Reads "Settings"; the rail item, the permission and
          the persisted tab key all still say iam. */}
      <header className="iam-topbar">
        <h1 className="iam-topbar-title">Settings</h1>
      </header>

      <div className="iam-shell">
        {/* Horizontal tab strip above the panel, as in the reference. */}
        <nav className="iam-tabs" aria-label="Settings sections">
          {SUB_TABS.map((t) => (
            <button
              type="button"
              key={t.key}
              className={`iam-tab ${tab === t.key ? 'is-active' : ''}`}
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
              // The strip never scrolls — the tabs share the width and ellipsise
              // their labels instead — so on a narrow window the full label has to
              // be reachable some other way.
              title={t.label}
            >{t.label}</button>
          ))}
        </nav>

        <section className="iam-main">
          {embeddedView || (
          <>
          <header className="iam-head">
            <h2 className="iam-title">{heading}</h2>
            <div className="iam-head-right">
              {tab === 'orgs' && (
                <button
                  type="button"
                  className="iam-export"
                  onClick={exportOrgsCsv}
                  disabled={filtered.length === 0}
                  title="Download these rows as CSV"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v12" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M4 19h16" />
                  </svg>
                  Export
                </button>
              )}
              <div className="iam-search">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.6-3.6" />
                </svg>
                <input
                  type="text"
                  value={search}
                  placeholder={searchLabel}
                  aria-label={searchLabel}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                />
              </div>
              <button
                type="button"
                className="results-bar-btn"
                onClick={() => {
                  if (tab === 'orgs') onRefreshOrganizations();
                  else setReloadTick((t) => t + 1);
                }}
                title="Refresh"
                aria-label="Refresh"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 11a8 8 0 1 0-2.3 5.7" />
                  <path d="M20 4v7h-7" />
                </svg>
              </button>
            </div>
          </header>

          {tab === 'users' && (
            <div className="iam-table iam-table--users">
              <div className="iam-row iam-row--head">
                <span>Sl.No</span><span>Email</span><span>First Name</span>
                <span>Last Name</span><span>Role</span><span>Created</span>
                <span>Action</span>
              </div>
              <div className="iam-body">
                <TableState loading={isBusy} error={error} empty={isEmpty} emptyLabel={emptyLabel} />
                {pageRows.map((u, i) => (
                  <div className="iam-row" key={u.email || i}>
                    <span className="iam-num">{rowNo(page * pageSize + i)}</span>
                    <span className="iam-email" title={u.email}>{u.email || '—'}</span>
                    <span>{u.firstName || '—'}</span>
                    <span>{u.lastName || '—'}</span>
                    <span>
                      <span className={`iam-role iam-role--${(u.role || '').toLowerCase()}`}>
                        {u.role ? u.role.charAt(0).toUpperCase() + u.role.slice(1) : '—'}
                      </span>
                    </span>
                    <span className="iam-dim" title={u.createdAt || ''}>
                      {u.createdAt ? new Date(u.createdAt).toLocaleString() : '—'}
                    </span>
                    <span>
                      {/* Externally-managed users (SSO/LDAP) are owned by the
                          identity provider — editing them here would either fail
                          or be overwritten on their next sign-in. */}
                      {u.external ? (
                        <span className="iam-dim" title="Managed by an external identity provider">
                          External
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="iam-icon-btn"
                          onClick={() => setEditingUser(u)}
                          title={`Update ${u.email}`}
                          aria-label={`Update ${u.email}`}
                        >
                          {/* Pencil resting on an open square, as drawn: the
                              square is the record, the pencil breaks out of its
                              top-right corner. */}
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M20 13.2V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.8" />
                            <path d="M17.4 3.3a1.9 1.9 0 0 1 2.7 2.7l-8.1 8.1-3.3.8.8-3.3z" />
                          </svg>
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'accounts' && (
            <div className="iam-table iam-table--accounts">
              <div className="iam-row iam-row--head">
                <span>Sl.No</span><span>Email</span><span>Description</span><span>Token</span>
              </div>
              <div className="iam-body">
                <TableState loading={isBusy} error={error} empty={isEmpty} emptyLabel={emptyLabel} />
                {pageRows.map((a, i) => (
                  <div className="iam-row" key={a.email || i}>
                    <span className="iam-num">{rowNo(page * pageSize + i)}</span>
                    <span className="iam-email" title={a.email}>{a.email || '—'}</span>
                    <span>{a.description || '—'}</span>
                    {/* Never the token value — see IamResponseDTO.ServiceAccount. */}
                    <span className="iam-dim">
                      {a.hasToken ? 'Set — view in OpenObserve' : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'orgs' && (
            <div className="iam-table iam-table--orgs">
              <div className="iam-row iam-row--head">
                <span>Sl.No</span><span>Name</span><span>Identifier</span>
                <span>Type</span><span>Action</span>
              </div>
              <div className="iam-body">
                <TableState loading={isBusy} error={error} empty={isEmpty} emptyLabel={emptyLabel} />
                {pageRows.map((o, i) => {
                  const isActive = o.identifier === activeOrg;
                  return (
                    <div className={`iam-row ${isActive ? 'is-active-org' : ''}`} key={o.identifier || i}>
                      <span className="iam-num">{rowNo(page * pageSize + i)}</span>
                      <span title={o.name}>{o.name || '—'}</span>
                      <span className="iam-ident" title={o.identifier}>{o.identifier || '—'}</span>
                      <span>
                        <span className={`iam-type iam-type--${(o.type || '').toLowerCase()}`}>
                          {o.type ? o.type.charAt(0).toUpperCase() + o.type.slice(1) : '—'}
                        </span>
                      </span>
                      <span>
                        {isActive ? (
                          <span className="iam-active-chip">Active</span>
                        ) : (
                          <button
                            type="button"
                            className="iam-switch-btn"
                            onClick={() => onOrgChange(o.identifier)}
                            title={`Switch every screen to ${o.name}`}
                          >Switch to</button>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <TablePager
            total={filtered.length}
            page={page}
            pageSize={pageSize}
            setPage={setPage}
          />
          </>
          )}
        </section>
      </div>

      {/* Outside the panel, because it is fixed-position and belongs to the screen
          rather than to whichever tab raised it. */}
      <Toast message={notice} onDismiss={() => setNotice('')} />

      {editingUser && (
        <UserEditDrawer
          user={editingUser}
          onCancel={() => setEditingUser(null)}
          onSaved={({ message }) => {
            setEditingUser(null);
            setNotice(message);
            // Refetch rather than patching the row: OpenObserve is the only
            // store, so what the table shows next should be what it now holds.
            setReloadTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

IamView.propTypes = {
  /** Identifier of the organization every request is currently scoped to. */
  activeOrg: PropTypes.string,
  /** Switch the whole app to another organization. */
  onOrgChange: PropTypes.func.isRequired,
  /** Live org list, owned by App so the header and this table always agree. */
  organizations: PropTypes.array,
  organizationsLoading: PropTypes.bool,
  /** {section, nonce} — opens that Settings section. See the effect above for the nonce. */
  requestedSection: PropTypes.shape({
    section: PropTypes.string,
    nonce: PropTypes.number,
  }),
  onRefreshOrganizations: PropTypes.func.isRequired,
};
