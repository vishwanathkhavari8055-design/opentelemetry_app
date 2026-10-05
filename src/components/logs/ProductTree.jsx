import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatCount } from '../../utils/format';

/**
 * Product Catalog tree at the top of the field list.
 *
 *   › Applications                2
 *     ☑ SSOservice             240K
 *     ☐ NotifyService          475
 *   › Platform                    0
 *       No resources registered yet.
 *   › DLH                         1
 *     ☐ dlhbackendservice       11K
 *
 * ─── This used to be a hardcoded table ─────────────────────────────────────
 *
 * It rendered `src/config/products.js`: a hand-maintained Category → Product →
 * Service list. Two levels are gone with it — the middle "product" tier existed
 * only to make a long static list readable, and the registry has no such
 * concept. A resource is what an operator registers, enables and disables, so a
 * resource is what the tree shows.
 *
 * The important change is not cosmetic. The old tree described what someone
 * believed was monitored, and ticking a box in it changed nothing about what the
 * backend would return — a service missing from the table was still fully
 * visible on every screen. Now the same registry that fills this tree also
 * scopes every Logs, Traces and Metrics query, so what you see here is what is
 * actually being enforced.
 *
 * ─── Selection is still read back from the query ───────────────────────────
 *
 * Unchanged, and load-bearing: ticking a resource writes
 * `service_name='…'` into the query exactly as clicking a value in the field
 * list does, and the checkbox state is derived from the query text. The tree
 * holds no selection state of its own, so it cannot disagree with the editor.
 *
 * ─── Disabled resources are shown, not hidden ──────────────────────────────
 *
 * Greyed and unselectable. Hiding them would make a disabled resource
 * indistinguishable from one nobody ever registered, and those call for
 * opposite actions — enable it, versus go and register it.
 */

/** Hover text for one registered resource row — why it looks the way it does. */
function resourceTitle(resource, name, { isDisabled, present, count, discovery }) {
  if (isDisabled) {
    return `${resource.resourceName} is DISABLED in the Product Catalog — its logs, `
      + 'traces and metrics are hidden everywhere. Enable it in Product Catalog to use it here.';
  }
  if (present) {
    return `service_name="${name}" — ${(count ?? 0).toLocaleString()} logs in this time range`;
  }
  if (discovery === 'ready') {
    return `${resource.resourceName} is registered as service_name="${name}", which reported `
      + 'nothing in the selected time range. Widen the range to check.';
  }
  return `${resource.resourceName} — service discovery `
    + `${discovery === 'loading' ? 'is still loading' : 'is unavailable'}, so its status is unknown.`;
}

/** What discovery can say about availability: 'loading', 'ready' or 'unavailable'. */
function discoveryState(loading, services) {
  if (loading) return 'loading';
  return (services || []).length ? 'ready' : 'unavailable';
}

/** Does this resource match the sidebar's search term? */
const resourceMatches = (resource, q) => !q
  || (resource.resourceName || '').toLowerCase().includes(q)
  || (resource.resolvedName || '').toLowerCase().includes(q);

export default function ProductTree({
  categories, catalogLoading, catalogError, services, selected,
  onToggleService, onToggleCategory, loading, filter, onNavigateToCatalog,
}) {
  const [openCats, setOpenCats] = useState(() => new Set());

  const q = (filter || '').trim().toLowerCase();
  const selectedSet = useMemo(() => new Set(selected || []), [selected]);

  /** Discovered log counts, by exact service name. */
  const countsByName = useMemo(() => {
    const map = new Map();
    (services || []).forEach((s) => {
      const name = typeof s === 'string' ? s : s?.name;
      if (name) map.set(name, typeof s === 'string' ? null : (s.count ?? null));
    });
    return map;
  }, [services]);

  /**
   * Whether we can say anything about availability at all.
   *
   * An empty discovery list is NOT evidence a resource is gone — far more often
   * discovery itself failed or has not returned. Treating the two the same
   * painted every registered resource as missing, which sends people looking in
   * exactly the wrong place.
   */
  const discovery = discoveryState(loading, services);

  const cats = useMemo(() => categories.map((category) => {
    // A category whose own name matches shows everything in it; otherwise its
    // resources are narrowed to those that match themselves.
    const catMatches = !q || (category.label || '').toLowerCase().includes(q);
    const shown = catMatches
      ? category.resources
      : category.resources.filter((r) => resourceMatches(r, q));

    const selectable = category.enabled
      .map((r) => r.resolvedName || r.resourceName)
      .filter(Boolean);
    const selectedCount = selectable.filter((n) => selectedSet.has(n)).length;

    return {
      category,
      shown,
      selectable,
      selectedCount,
      hidden: !catMatches && shown.length === 0,
    };
  }).filter((c) => !c.hidden), [categories, selectedSet, q]);

  const toggleCatOpen = (key) => setOpenCats((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  /** One registered resource. */
  const resourceRow = (resource) => {
    const name = resource.resolvedName || resource.resourceName;
    const isDisabled = resource.status !== 'ENABLED';
    const count = countsByName.get(name);
    // "Present" means the discovery window actually reported this name. A
    // registered resource can be legitimately absent from a 15-minute window.
    const present = countsByName.has(name);
    const checked = !isDisabled && selectedSet.has(name);

    const title = resourceTitle(resource, name, { isDisabled, present, count, discovery });
    let absentClass = '';
    if (!isDisabled && !present) {
      absentClass = discovery === 'ready' ? 'is-absent is-missing' : 'is-absent is-unknown';
    }

    return (
      <label
        className={`pt-service ${isDisabled ? 'is-off-catalog' : ''} ${absentClass} ${checked ? 'is-on' : ''}`}
        key={resource.id}
        title={title}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={isDisabled || !present}
          onChange={() => onToggleService(name)}
        />
        <span className="pt-service-name">{resource.resourceName}</span>
        {/* Only when the two differ — it is the identifier actually filtered on,
            and a silent mismatch is how a filter stops matching its label. */}
        {resource.resolvedName && resource.resolvedName !== resource.resourceName && (
          <span className="pt-env" title="The identifier telemetry uses">{resource.resolvedName}</span>
        )}
        {isDisabled && <span className="pt-off-tag">off</span>}
        <span className="pt-service-count">{present ? formatCount(count) : '—'}</span>
      </label>
    );
  };

  return (
    <div className="pt-tree">
      {catalogError && (
        <div className="pt-note pt-note--warn">
          Product Catalog unavailable — {catalogError}
        </div>
      )}

      {q && cats.length === 0 && (
        <div className="fieldbar-empty">No category or resource matches “{filter}”.</div>
      )}

      {cats.map(({
        category, shown, selectable, selectedCount,
      }) => {
        // A live filter forces the node open: a match hidden behind a collapsed
        // node reads as no match at all, so the caret and aria-expanded have to
        // follow this rather than the open set alone.
        const isOpen = openCats.has(category.code) || !!q;
        const empty = category.resources.length === 0;
        const all = selectable.length > 0 && selectedCount === selectable.length;
        const some = selectedCount > 0 && !all;

        return (
          <div
            className={`fieldbar-field pt-root ${isOpen ? 'is-open' : ''} ${empty ? 'is-empty' : ''}`}
            key={category.code}
          >
            <div className="pt-cat-head">
              {/* The category checkbox selects every enabled resource under it.
                  It sits OUTSIDE the expander button — nesting an input inside a
                  <button> is invalid HTML and the click would be swallowed. */}
              <input
                type="checkbox"
                className="pt-check"
                checked={all}
                ref={(el) => { if (el) el.indeterminate = some; }}
                disabled={selectable.length === 0}
                onChange={() => onToggleCategory(category.code, !all)}
                aria-label={`${all ? 'Clear' : 'Select'} all resources in ${category.label}`}
                title={(() => {
                  if (!selectable.length) return 'No enabled resources in this category';
                  return `${all ? 'Clear' : 'Select'} all ${selectable.length} enabled resource(s)`;
                })()}
              />
              <button
                type="button"
                className="fieldbar-field-head pt-cat-btn"
                onClick={() => toggleCatOpen(category.code)}
                aria-expanded={isOpen}
                title={`${category.label} — ${category.description || ''}`}
              >
                <span className="fieldbar-caret" aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
                <span className="fieldbar-field-name">{category.label}</span>
                <span className="fieldbar-field-count">{category.resources.length}</span>
              </button>
            </div>

            {isOpen && (
              <div className="pt-products">
                {catalogLoading && empty && (
                  <div className="fieldbar-empty">Loading catalog…</div>
                )}

                {/* Two different statements, deliberately not merged: one says
                    the registry holds nothing here, the other says we could not
                    ask about availability. Conflating them made a correct
                    registration look broken. */}
                {!catalogLoading && empty && (
                  <div className="pt-note">
                    No resources registered under {category.label} yet.
                    {onNavigateToCatalog && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="pt-note-link"
                          onClick={onNavigateToCatalog}
                        >Open Product Catalog</button>
                        {' to register one.'}
                      </>
                    )}
                  </div>
                )}

                {!empty && discovery === 'unavailable' && (
                  <div className="pt-note pt-note--warn">
                    Service discovery returned nothing — counts and availability below are unknown.
                  </div>
                )}

                {/* GROUPED BY PRODUCT — category → product → microservice, the
                    same shape a registration is made in. Only products that
                    actually hold a registration appear: rendering all sixteen of
                    Applications' products with fifteen empty would bury the one
                    that matters.

                    Resources with no product (Tools, Databases, Platform, DLH)
                    render directly under the category, exactly as before, so those
                    four categories are visually unchanged. */}
                {shown.length > 0 && groupByProduct(shown).map((group) => (
                  group.product === null ? (
                    <div className="pt-services pt-services--direct" key="__direct__">
                      {group.resources.map(resourceRow)}
                    </div>
                  ) : (
                    <div className="pt-product" key={group.product}>
                      <div className="pt-product-head" title={group.product}>
                        <span className="pt-product-name">{group.product}</span>
                        <span className="fieldbar-field-count">{group.resources.length}</span>
                      </div>
                      <div className="pt-services">{group.resources.map(resourceRow)}</div>
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Group a category's resources by product, preserving order.
 *
 * <p>Product-less resources come FIRST, under a null key, so the four categories
 * that have no product list keep rendering exactly as they did — a flat list with
 * no extra level introduced for them. Products then follow in the order the
 * resources arrived, which is registration order, matching the catalog table.</p>
 */
function groupByProduct(resources) {
  const groups = new Map();
  resources.forEach((r) => {
    const key = r.productLabel || r.product || null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  // null first, then insertion order.
  const out = [];
  if (groups.has(null)) out.push({ product: null, resources: groups.get(null) });
  groups.forEach((list, key) => {
    if (key !== null) out.push({ product: key, resources: list });
  });
  return out;
}

ProductTree.propTypes = {
  /** From useCatalog(): all six categories, each with its registered resources. */
  categories: PropTypes.arrayOf(PropTypes.shape({
    code: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    description: PropTypes.string,
    resources: PropTypes.array.isRequired,
    enabled: PropTypes.array.isRequired,
  })).isRequired,
  catalogLoading: PropTypes.bool,
  catalogError: PropTypes.string,
  /** Discovered services as {name, count} — supplies counts and tells the tree
   *  which registered resources actually reported in the current time range. */
  services: PropTypes.array,
  /** Service names currently in the query, read back so the tree is stateless. */
  selected: PropTypes.arrayOf(PropTypes.string),
  /** (serviceName) — toggle one resource in the query. */
  onToggleService: PropTypes.func.isRequired,
  /** (categoryCode, select) — add or remove every enabled resource in a category. */
  onToggleCategory: PropTypes.func.isRequired,
  /** True while service discovery is in flight. */
  loading: PropTypes.bool,
  /** The sidebar's field-search term; also narrows categories and resources. */
  filter: PropTypes.string,
  /** Optional jump to the Product Catalog screen, offered in empty categories. */
  onNavigateToCatalog: PropTypes.func,
};
