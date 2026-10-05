import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatCount } from '../../../utils/format';
import { TELEMETRY_WINDOW_LABEL } from './useServiceTelemetry';

/**
 * Step 1 of the alert wizard: pick the ONE resource the alert watches.
 *
 *   ⌕ Search for a service            ☐ Only services with telemetry
 *   › Applications              15
 *     ● SSOservice        logs 240K  traces 18K
 *     ○ NotifyService     logs 475   traces —
 *     ○ LegacyBatchSvc    no telemetry
 *   › Platform                   0
 *   › AI Services                2
 *
 * Deliberately the same tree the Logs sidebar shows (components/logs/ProductTree),
 * because it answers the same question — "which registered resource" — and an
 * operator who has learned to find a service in one place should not have to
 * learn a second taxonomy to alert on it. What differs is the SELECTION MODEL:
 * that tree ticks many services into a query, this one picks exactly one target,
 * so the control is a radio group and there is no category-level "select all".
 *
 * ─── Why it does not reuse ProductTree ──────────────────────────────────────
 *
 * ProductTree derives its checkbox state from the Logs query text and cross-refs
 * every row against log-discovery counts for the current time range. Neither
 * exists here — a wizard has no query and no time range — and threading two
 * meanings through one component is how a shared widget becomes unowned. This is
 * a separate, smaller component over the same `useCatalog()` data.
 *
 * ─── Disabled resources are shown, not hidden ───────────────────────────────
 *
 * Greyed and unselectable, as in the Logs tree. Hiding them makes a DISABLED
 * registration indistinguishable from one nobody ever made, and the two call for
 * opposite actions — go and enable it, versus go and register it.
 *
 * ─── Live telemetry, per signal ─────────────────────────────────────────────
 *
 * Each row carries what that service actually produced in the discovery window,
 * as two separate counts — see useServiceTelemetry for why logs and traces are
 * never merged into one "is it live" flag. Registering a service, or its first
 * logs arriving, shows up here within the poll interval without a reload.
 *
 * A service with NO telemetry is marked but stays SELECTABLE, which is where this
 * parts company with the Logs tree (which disables absent rows). There, ticking
 * an absent service produces an empty result set, so the control is genuinely
 * useless. Here you are describing a future condition: alerting on a service that
 * is quiet right now — a batch job, a failover path, something just deployed — is
 * a legitimate and common thing to want. The row warns; it does not refuse.
 */

const IconSearch = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />
  </svg>
);

/** The identifier telemetry is actually filtered on — the operator's label is only a label. */
export const resourceKey = (r) => (r ? (r.resolvedName || r.resourceName) : '');

/** Does this resource match the search term? */
const matches = (r, q) => !q
  || (r.resourceName || '').toLowerCase().includes(q)
  || (r.resolvedName || '').toLowerCase().includes(q);

/**
 * Group a category's resources by product, product-less ones first.
 *
 * <p>Mirrors ProductTree: Applications registers through a product tier, the other
 * categories do not, so those render as a flat list with no extra level invented
 * for them.</p>
 */
const groupByProduct = (resources) => {
  const groups = new Map();
  resources.forEach((r) => {
    const key = r.productLabel || r.product || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const out = [];
  if (groups.has(null)) out.push({ product: null, resources: groups.get(null) });
  groups.forEach((list, key) => { if (key !== null) out.push({ product: key, resources: list }); });
  return out;
};

const pendingCategoryText = (category, loading) => {
  const s = category.registeredCount === 1 ? '' : 's';
  if (loading) {
    return `Loading ${category.registeredCount} registered service${s}…`;
  }
  return `The catalog reports ${category.registeredCount} service${s} here but returned none of them — the registry read is degraded. Retrying.`;
};

export default function ServiceCatalogPicker({
  categories, loading, error, degraded, selectedId, onSelect, onNavigateToCatalog,
  telemetry, telemetryStatus, logsStatus, tracesStatus,
}) {
  const [filter, setFilter] = useState('');
  const [openCats, setOpenCats] = useState(() => new Set());

  /**
   * Hide registered services that produced nothing in the discovery window.
   *
   * <p>OFF by default, and it has to be: discovery answering late or not at all
   * would otherwise empty the tree on arrival, which reads as "nothing is
   * registered" — the one statement this screen must never make by accident. As
   * an opt-in it is the useful shortcut on an estate where most registrations are
   * stale, and the count pill switches to the filtered number so the category
   * never claims more rows than it is showing.</p>
   */
  const [liveOnly, setLiveOnly] = useState(false);

  const q = filter.trim().toLowerCase();

  /** What this service produced, or null if discovery has not placed it. */
  const signalsFor = (resource) => telemetry.get(resourceKey(resource)) || null;

  /**
   * Has this service been confirmed silent?
   *
   * <p>Only ever true once discovery actually answered. While it is loading or
   * down, absence from the map is not evidence of anything, and saying "no
   * telemetry" on that basis is how a correctly wired service comes to look
   * broken.</p>
   */
  const isSilent = (resource) => telemetryStatus === 'ready' && !signalsFor(resource);

  /**
   * Open the category holding the current selection, once, on mount.
   *
   * <p>Stepping BACK from step 2 must not land on a collapsed tree with the chosen
   * service out of sight — that reads as "nothing is selected" and invites the user
   * to pick again. Keyed on the category rather than the id, so re-selecting inside
   * the same category does not fight the user's own collapse.</p>
   */
  const selectedCategory = useMemo(() => {
    if (!selectedId) return null;
    const hit = categories.find((c) => c.resources.some((r) => r.id === selectedId));
    return hit ? hit.code : null;
  }, [categories, selectedId]);

  useEffect(() => {
    if (!selectedCategory) return;
    setOpenCats((prev) => (prev.has(selectedCategory)
      ? prev
      : new Set(prev).add(selectedCategory)));
  }, [selectedCategory]);

  const cats = useMemo(() => categories.map((category) => {
    // A category whose own name matches shows everything under it; otherwise it is
    // narrowed to the resources that match themselves.
    const catMatches = !q || (category.label || '').toLowerCase().includes(q);
    const bySearch = catMatches
      ? category.resources
      : category.resources.filter((r) => matches(r, q));

    // The telemetry filter applies AFTER the search and independently of it, so
    // "only live" plus a search term means both, not either.
    const shown = liveOnly && telemetryStatus === 'ready'
      ? bySearch.filter((r) => telemetry.has(resourceKey(r)))
      : bySearch;

    return {
      category,
      shown,
      // While a filter is on, the badge counts what is on screen. A category
      // reading "15" over three visible rows is a bug report waiting to happen.
      //
      // Unfiltered, it is the SERVER's own `registeredCount`, not the length of
      // the rows we happen to hold. The two endpoints behind this can disagree —
      // see isCoherent in useCatalog — and when they do, the count is the half
      // that is right.
      count: (q || liveOnly) ? shown.length : (category.registeredCount ?? category.resources.length),
      hidden: (!catMatches && bySearch.length === 0)
        // A category emptied by the telemetry filter still shows, at 0 — the
        // taxonomy staying put is what makes the filter's effect legible.
        || false,
    };
  }).filter((c) => !c.hidden), [categories, q, liveOnly, telemetry, telemetryStatus]);

  const toggleCat = (code) => setOpenCats((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  /**
   * One signal's count as a pill.
   *
   * <p>Three states, not two: a number, a dash for "this signal reported nothing",
   * and nothing at all while discovery is still in flight. The dash is a claim —
   * it says we asked and the answer was none — so it is only drawn once that
   * signal has actually answered.</p>
   */
  const signalPill = (label, count, status, serviceName) => {
    if (status === 'loading') return null;
    const has = count != null;
    const text = has ? formatCount(count) : '—';
    let title = `${label} discovery returned nothing, so this service's ${label} volume is unknown.`;
    if (status !== 'unavailable') {
      title = has
        ? `${serviceName} produced ${Number(count).toLocaleString()} ${label} in the ${TELEMETRY_WINDOW_LABEL}`
        : `${serviceName} produced no ${label} in the ${TELEMETRY_WINDOW_LABEL}`;
    }

    return (
      <span
        className={`awp-sig awp-sig--${label} ${has ? 'is-live' : 'is-quiet'}`}
        title={title}
      >
        <span className="awp-sig-label">{label}</span>
        <span className="awp-sig-count">{text}</span>
      </span>
    );
  };

  /** One registered resource: a radio, its label, its identifier and its signals. */
  const resourceRow = (resource) => {
    const off = resource.status !== 'ENABLED';
    const name = resourceKey(resource);
    const checked = resource.id === selectedId;
    const signals = signalsFor(resource);
    const silent = !off && isSilent(resource);

    let title;
    if (off) {
      title = `${resource.resourceName} is DISABLED in the Product Catalog — its telemetry is `
        + 'hidden everywhere, so an alert on it would never fire. Enable it in '
        + 'Settings → Product Catalog to use it here.';
    } else if (silent) {
      title = `${resource.resourceName} is registered as service_name="${name}", which produced `
        + `no logs and no traces in the ${TELEMETRY_WINDOW_LABEL}. You can still alert on it — `
        + 'a batch job or a failover path is quiet by design — but check the spelling if you '
        + 'expected data.';
    } else {
      title = `Alert on service_name="${name}"`;
    }

    return (
      <label
        key={resource.id}
        className={`awp-res ${off ? 'is-off' : ''} ${silent ? 'is-silent' : ''} ${checked ? 'is-on' : ''}`}
        title={title}
      >
        <input
          type="radio"
          name="aw-service"
          checked={checked}
          disabled={off}
          onChange={() => onSelect(resource)}
        />
        <span className="awp-res-name">{resource.resourceName}</span>
        {/* Only when the two differ — it is what the alert query will actually
            match on, and a silent mismatch is how an alert stops seeing its service. */}
        {resource.resolvedName && resource.resolvedName !== resource.resourceName && (
          <span className="awp-res-id" title="The identifier telemetry uses">
            {resource.resolvedName}
          </span>
        )}
        {off && <span className="awp-off-tag">off</span>}

        {/* Per-signal volume. Not drawn for a disabled resource: the catalog is
            already hiding its telemetry everywhere, so a count here would be
            describing data the rest of the app refuses to show. */}
        {!off && (
          <span className="awp-signals">
            {silent
              ? <span className="awp-quiet-tag" title={title}>no telemetry</span>
              : (
                <>
                  {signalPill('logs', signals?.logs, logsStatus, name)}
                  {signalPill('traces', signals?.traces, tracesStatus, name)}
                </>
              )}
          </span>
        )}
      </label>
    );
  };

  return (
    <div className="awp">
      <div className="awp-tools">
        <div className="awp-search">
          <IconSearch />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search for a service"
            aria-label="Search for a service"
          />
        </div>

        {/* Offered only once discovery has answered. A checkbox that would blank
            the tree because we cannot see any telemetry yet is a trap, and one
            that silently does nothing is worse. */}
        {telemetryStatus === 'ready' && (
          <label className="awp-live-toggle" title={`Hide services that produced no logs and no traces in the ${TELEMETRY_WINDOW_LABEL}`}>
            <input
              type="checkbox"
              checked={liveOnly}
              onChange={(e) => setLiveOnly(e.target.checked)}
            />
            <span>Only services with telemetry</span>
          </label>
        )}
      </div>

      <div className="awp-tree" role="radiogroup" aria-label="Service to alert on">
        {/* A failed load must not empty the tree — "we could not ask" is a much
            weaker statement than "nothing is registered", and the two look
            identical once the list is blank. */}
        {error && (
          <div className="awp-note awp-note--warn">Product Catalog unavailable — {error}</div>
        )}

        {/* Stated once at the top as well as inside each affected category: with
            every category collapsed — the default — the per-category notes are
            all hidden, and a tree that is quietly a minute stale should say so
            where you can see it. */}
        {degraded && !error && (
          <div className="awp-note awp-note--warn">
            The registry read came back incomplete, so these are the last rows that
            loaded. Retrying in the background.
          </div>
        )}

        {loading && cats.length === 0 && <div className="awp-empty">Loading catalog…</div>}

        {!loading && q && cats.length === 0 && (
          <div className="awp-empty">No category or service matches “{filter}”.</div>
        )}

        {cats.map(({ category, shown, count }) => {
          // A live filter forces the node open: a match hidden behind a collapsed
          // row reads as no match at all, so the caret and aria-expanded follow
          // this rather than the open set alone.
          const isOpen = openCats.has(category.code) || !!q;
          // Emptiness of what is RENDERED, not of the registry: a category whose
          // rows were all filtered out has to explain itself too, and the note
          // below reads differently for the three cases.
          const empty = shown.length === 0;
          const emptyByFilter = empty && category.resources.length > 0;
          /**
           * The category says it holds rows, and we have none of them.
           *
           * <p>Either they are still arriving — the catalog read takes tens of
           * seconds on this deployment — or the read came back degraded. Either
           * way "No services registered here yet" is a FALSE statement, and it is
           * the one that sends someone off to register a service they already
           * have. This is the case that made the picker look broken.</p>
           */
          const pending = empty && !emptyByFilter
            && (category.registeredCount ?? 0) > 0;

          return (
            <div
              key={category.code}
              className={`awp-cat ${isOpen ? 'is-open' : ''} ${empty ? 'is-empty' : ''}`}
            >
              <button
                type="button"
                className="awp-cat-head"
                onClick={() => toggleCat(category.code)}
                aria-expanded={isOpen}
                title={category.description || category.label}
              >
                <span className="awp-caret" aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
                <span className="awp-cat-name">{category.label}</span>
                <span
                  className="awp-count"
                  title={count === category.resources.length
                    ? `${category.resources.length} registered`
                    : `${count} of ${category.resources.length} registered match the current filters`}
                >{count}</span>
              </button>

              {isOpen && (
                <div className="awp-cat-body">
                  {/* Two different statements, deliberately not merged: one says
                      the registry holds nothing here, the other says everything it
                      holds was filtered out. Conflating them sends someone off to
                      register a service they already have. */}
                  {emptyByFilter && (
                    <div className="awp-note">
                      {liveOnly
                        ? `All ${category.resources.length} registered here produced no telemetry in the ${TELEMETRY_WINDOW_LABEL}.`
                        : `Nothing under ${category.label} matches the search.`}
                    </div>
                  )}

                  {pending && (
                    <div className="awp-note">
                      {pendingCategoryText(category, loading)}
                    </div>
                  )}

                  {empty && !emptyByFilter && !pending && (
                    <div className="awp-note">
                      No services registered under {category.label} yet.
                      {onNavigateToCatalog && (
                        <>
                          {' '}
                          <button
                            type="button" className="awp-note-link" onClick={onNavigateToCatalog}
                          >Open Product Catalog</button>
                          {' to register one.'}
                        </>
                      )}
                    </div>
                  )}

                  {groupByProduct(shown).map((group) => (
                    group.product === null ? (
                      <div className="awp-res-list" key="__direct__">
                        {group.resources.map(resourceRow)}
                      </div>
                    ) : (
                      <div className="awp-product" key={group.product}>
                        <div className="awp-product-head" title={group.product}>
                          <span className="awp-product-name">{group.product}</span>
                          <span className="awp-count">{group.resources.length}</span>
                        </div>
                        <div className="awp-res-list">{group.resources.map(resourceRow)}</div>
                      </div>
                    )
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

ServiceCatalogPicker.propTypes = {
  /** From useCatalog(): every category, each carrying its registered resources. */
  categories: PropTypes.arrayOf(PropTypes.shape({
    code: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    description: PropTypes.string,
    resources: PropTypes.array.isRequired,
  })).isRequired,
  loading: PropTypes.bool,
  error: PropTypes.string,
  /** True when the catalog's two endpoints disagreed and these rows are cached. */
  degraded: PropTypes.bool,
  /** Catalog id of the chosen resource, or null. */
  selectedId: PropTypes.string,
  /** (resource) — the whole catalog row, so the wizard keeps its label AND identifier. */
  onSelect: PropTypes.func.isRequired,
  /** Optional jump to Settings → Product Catalog, offered inside empty categories. */
  onNavigateToCatalog: PropTypes.func,
  /** From useServiceTelemetry(): resolved service name → {logs, traces} volumes. */
  telemetry: PropTypes.instanceOf(Map),
  /** Whether ANY signal has answered — gates every claim that a service is silent. */
  telemetryStatus: PropTypes.oneOf(['loading', 'ready', 'unavailable']),
  /** Per-signal state, so one signal being down does not mute the other's count. */
  logsStatus: PropTypes.oneOf(['loading', 'ready', 'unavailable']),
  tracesStatus: PropTypes.oneOf(['loading', 'ready', 'unavailable']),
};

ServiceCatalogPicker.defaultProps = {
  // An empty map rather than undefined: every read here is `telemetry.get(…)`,
  // and a caller that has not wired discovery up yet should get "unknown", not
  // a crash.
  telemetry: new Map(),
  telemetryStatus: 'loading',
  logsStatus: 'loading',
  tracesStatus: 'loading',
};
