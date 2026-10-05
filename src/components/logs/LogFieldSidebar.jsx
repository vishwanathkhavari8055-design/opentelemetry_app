import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import ProductTree from './ProductTree';
import { formatCount } from '../../utils/format';

/**
 * Left-hand field explorer on the Logs screen.
 *
 * Top of the column is the stream selector, then a field filter box, then the
 * list of fields discovered in the sampled rows, then a pager. Expanding a
 * field shows its top values with hit counts; clicking a value appends
 * `field='value'` to the query editor and re-runs — which is how you narrow a
 * query without hand-writing the clause.
 *
 * Fields come from the sample rows the container already fetches for the
 * histogram — no dedicated schema endpoint is involved, so the list reflects
 * exactly the fields present in the matching data (a field that is null across
 * every sampled row simply doesn't appear, which is the useful behaviour when
 * you're hunting for what's actually populated).
 *
 * The whole column collapses to a thin rail via the edge handle, for when the
 * table needs the width.
 */

/** Keys we never surface on the LOGS screen: internal ids and the normalised
 *  aliases api.js adds on top of the wire shape (they'd show up as duplicates
 *  of the dotted keys). The Traces screen passes its own set — it has a
 *  different wire shape, and there `serviceName` and `traceId` are exactly the
 *  fields you want to explore. */
const DEFAULT_HIDDEN_FIELDS = new Set([
  'id', 'message', 'severity', 'serviceName', 'traceId', 'timestamp',
]);

/** How many distinct values to list under an expanded field. */
const TOP_VALUES = 8;

/** The field whose values come from discovery rather than the sample.
 *
 * Every other field's values are derived from the 500-row sample, which is
 * honest for exploring but wrong for services: a service that logged twice
 * today simply isn't in the sample, so it was invisible here even though the
 * discovery endpoint knows about it. `service.name` therefore renders the full
 * authoritative list with real counts, and as CHECKBOXES, because selecting
 * several is the normal thing to want. */
const SERVICE_FIELDS = new Set(['service.name', 'service_name', 'serviceName']);

/** Fields per page in the list. Matches the density of the reference UI —
 *  enough that most streams fit in one or two pages. */
const FIELDS_PER_PAGE = 25;

/** Longest value string we'll show in full before truncating with an ellipsis. */
const MAX_VALUE_LEN = 60;

const truncate = (s) =>
  s.length > MAX_VALUE_LEN ? `${s.slice(0, MAX_VALUE_LEN)}…` : s;

/**
 * The `service.name` value list: every discovered service, with a filter box
 * and checkboxes. Scrolls rather than truncating — "+6 more values" is useless
 * when the one you want is in the 6.
 */
function ServiceValues({ services, selected, onToggle, loading }) {
  const [q, setQ] = useState('');
  const selectedSet = useMemo(() => new Set(selected || []), [selected]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? services.filter((s) => s.name.toLowerCase().includes(needle))
      : services;
    // Ticked services float to the top so a selection can't scroll out of
    // sight behind a hundred others.
    return [...list].sort((a, b) => {
      const d = (selectedSet.has(b.name) ? 1 : 0) - (selectedSet.has(a.name) ? 1 : 0);
      if (d !== 0) return d;
      return (b.count || 0) - (a.count || 0);
    });
  }, [services, q, selectedSet]);

  return (
    <div className="fieldbar-values fieldbar-values--services">
      <input
        type="text"
        className="fb-svc-filter"
        value={q}
        placeholder={`Filter ${services.length} services…`}
        aria-label="Filter services"
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="fb-svc-list">
        {services.length === 0 && (
          <div className="fieldbar-empty">
            {loading ? 'Loading services…' : 'No services discovered.'}
          </div>
        )}
        {services.length > 0 && visible.length === 0 && (
          <div className="fieldbar-empty">No service matches “{q}”.</div>
        )}
        {visible.map((s) => (
          <label
            className={`fb-svc ${selectedSet.has(s.name) ? 'is-on' : ''}`}
            key={s.name}
            title={`${s.name} — ${(s.count ?? 0).toLocaleString()} logs`}
          >
            <input
              type="checkbox"
              checked={selectedSet.has(s.name)}
              onChange={() => onToggle(s.name)}
            />
            <span className="fb-svc-name">{s.name}</span>
            <span className="fb-svc-n">{s.count == null ? '' : formatCount(s.count)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
ServiceValues.propTypes = {
  services: PropTypes.array.isRequired,
  selected: PropTypes.arrayOf(PropTypes.string),
  onToggle: PropTypes.func.isRequired,
  loading: PropTypes.bool,
};

export default function LogFieldSidebar({
  rows, collapsed, onToggleCollapsed,
  streams, stream, onStreamChange,
  services = [], selectedServices = [], servicesLoading,
  onToggleService, onToggleCategory,
  catalogCategories = [], catalogLoading, catalogError, onNavigateToCatalog,
  onValueClick, onRefresh, loading,
  hiddenFields = DEFAULT_HIDDEN_FIELDS,
}) {
  const [fieldQuery, setFieldQuery] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [page, setPage] = useState(0);

  // Field inventory + per-field value tallies in a single pass over the sample.
  // Recomputed only when the sample changes; with a 500-row sample and ~30
  // fields this is a few thousand map writes — cheap enough to not bother
  // memoising harder than useMemo.
  const fields = useMemo(() => {
    const byField = new Map();
    (rows || []).forEach((row) => {
      Object.entries(row || {}).forEach(([key, raw]) => {
        if (hiddenFields.has(key)) return;
        if (raw == null || raw === '') return;
        if (typeof raw === 'object') return; // nested shapes aren't value-listable
        const value = String(raw);
        let entry = byField.get(key);
        if (!entry) { entry = { name: key, count: 0, values: new Map() }; byField.set(key, entry); }
        entry.count += 1;
        entry.values.set(value, (entry.values.get(value) || 0) + 1);
      });
    });

    return Array.from(byField.values())
      .map((f) => ({
        name: f.name,
        count: f.count,
        distinct: f.values.size,
        top: Array.from(f.values.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, TOP_VALUES)
          .map(([value, n]) => ({ value, n })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, hiddenFields]);

  const visible = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    return q ? fields.filter((f) => f.name.toLowerCase().includes(q)) : fields;
  }, [fields, fieldQuery]);

  const pageCount = Math.max(1, Math.ceil(visible.length / FIELDS_PER_PAGE));
  // A shrinking list (new sample, or a narrower filter) can strand the pager
  // past the end; clamp rather than render an empty page.
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);
  useEffect(() => { setPage(0); }, [fieldQuery]);

  const pageFields = visible.slice(page * FIELDS_PER_PAGE, (page + 1) * FIELDS_PER_PAGE);

  if (collapsed) {
    return (
      <button
        type="button"
        className="fieldbar-handle fieldbar-handle--collapsed"
        onClick={onToggleCollapsed}
        title="Show fields"
        aria-label="Show fields"
      >
        ›
      </button>
    );
  }

  return (
    <aside className="fieldbar">
      {/* Stream selector. This deployment's /api/logs serves one logs stream,
          so the list has a single entry — it's rendered anyway because it is
          where the reference UI puts the query's scope, and a second stream
          would appear here without any other change. Filtering by service is
          done in the query editor (service_name='…'), same as OpenObserve. */}
      <div className="fieldbar-scope">
        <select
          className="fieldbar-stream"
          id="stream-select"
          value={stream}
          onChange={(e) => onStreamChange(e.target.value)}
          aria-label="Stream"
          title={streams.length > 1
            ? 'Stream to query'
            : 'This backend exposes a single logs stream'}
        >
          {streams.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        {/* Service filter. Sits under the stream because it is the same kind of
            thing — the scope of the query — and because the field list below is
            built from a SAMPLE of matching rows, so it can never be a reliable
            way to discover a low-volume service. This list comes from the
            discovery endpoint instead. Ticking a box rewrites the query's
            service_name clauses, so the editor always shows what is applied. */}
        {/* The separate "All services" dropdown lived here. Both screens now
            select services through the products tree and the `service.name`
            checkbox list in the field list below, so this was an unreachable
            branch. common/ServiceMultiSelect.jsx is still on disk if a third
            screen ever wants it. */}
      </div>

      <div className="fieldbar-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.6-3.6" />
        </svg>
        <input
          type="text"
          value={fieldQuery}
          onChange={(e) => setFieldQuery(e.target.value)}
          placeholder="Search for a field"
          aria-label="Search for a field"
        />
      </div>

      <div className="fieldbar-list">
        {/* The Product Catalog sits above the discovered fields: a registered
            resource is a facet of the same data, and "which resource" is the
            coarser question you ask first. */}
        {onToggleService && (
          <ProductTree
            categories={catalogCategories}
            catalogLoading={catalogLoading}
            catalogError={catalogError}
            services={services}
            selected={selectedServices}
            onToggleService={onToggleService}
            onToggleCategory={onToggleCategory}
            onNavigateToCatalog={onNavigateToCatalog}
            loading={servicesLoading}
            filter={fieldQuery}
          />
        )}

        {loading && fields.length === 0 && (
          <div className="fieldbar-empty">Loading fields…</div>
        )}
        {!loading && fields.length === 0 && (
          <div className="fieldbar-empty">No fields — no matching logs in this window.</div>
        )}
        {fields.length > 0 && visible.length === 0 && (
          <div className="fieldbar-empty">No field matches “{fieldQuery}”.</div>
        )}

        {pageFields.map((f) => {
          const isOpen = expanded === f.name;
          return (
            <div className={`fieldbar-field ${isOpen ? 'is-open' : ''}`} key={f.name}>
              <button
                type="button"
                className="fieldbar-field-head"
                onClick={() => setExpanded(isOpen ? null : f.name)}
                aria-expanded={isOpen}
                title={`${f.name} — ${f.distinct} distinct value${f.distinct === 1 ? '' : 's'} in the sample`}
              >
                <span className="fieldbar-caret" aria-hidden="true">{isOpen ? '⌄' : '›'}</span>
                <span className="fieldbar-field-name">{f.name}</span>
                <span className="fieldbar-field-count">
                  {SERVICE_FIELDS.has(f.name) && onToggleService ? services.length : f.distinct}
                </span>
              </button>

              {isOpen && SERVICE_FIELDS.has(f.name) && onToggleService && (
                <ServiceValues
                  services={services}
                  selected={selectedServices}
                  onToggle={onToggleService}
                  loading={servicesLoading}
                />
              )}

              {isOpen && !(SERVICE_FIELDS.has(f.name) && onToggleService) && (
                <div className="fieldbar-values">
                  {f.top.map(({ value, n }) => (
                    <button
                      type="button"
                      className="fieldbar-value"
                      key={value}
                      onClick={() => onValueClick?.(f.name, value)}
                      title={`Add ${f.name}='${value}' to the query`}
                    >
                      <span className="fieldbar-value-text">{truncate(value)}</span>
                      <span className="fieldbar-value-n">{n}</span>
                    </button>
                  ))}
                  {f.distinct > f.top.length && (
                    <div className="fieldbar-values-more">
                      +{f.distinct - f.top.length} more value
                      {f.distinct - f.top.length === 1 ? '' : 's'}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="fieldbar-foot">
        <button
          type="button"
          className="fieldbar-foot-btn"
          onClick={() => setPage(0)}
          disabled={page === 0}
          aria-label="First page of fields"
          title="First page"
        >«</button>
        {Array.from({ length: pageCount }, (_, i) => (
          <button
            type="button"
            key={i}
            className={`fieldbar-foot-page ${i === page ? 'is-current' : ''}`}
            onClick={() => setPage(i)}
            aria-current={i === page ? 'page' : undefined}
          >{i + 1}</button>
        ))}
        <button
          type="button"
          className="fieldbar-foot-btn"
          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          disabled={page >= pageCount - 1}
          aria-label="Next page of fields"
          title="Next page"
        >»</button>
        <button
          type="button"
          className="fieldbar-foot-btn fieldbar-foot-refresh"
          onClick={onRefresh}
          aria-label="Re-sample the field list"
          title="Re-sample the field list"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>
      </div>

      <button
        type="button"
        className="fieldbar-handle"
        onClick={onToggleCollapsed}
        title="Hide fields"
        aria-label="Hide fields"
      >
        ‹
      </button>
    </aside>
  );
}

LogFieldSidebar.propTypes = {
  /** Sample rows the field list is derived from. */
  rows: PropTypes.array,
  collapsed: PropTypes.bool.isRequired,
  onToggleCollapsed: PropTypes.func.isRequired,
  streams: PropTypes.arrayOf(PropTypes.string).isRequired,
  stream: PropTypes.string.isRequired,
  onStreamChange: PropTypes.func.isRequired,
  /** Service names + counts from discovery — NOT derived from the visible rows. */
  services: PropTypes.array,
  selectedServices: PropTypes.arrayOf(PropTypes.string),
  servicesLoading: PropTypes.bool,
  /** (serviceName) — toggle one service. Omit to hide the catalog tree. */
  onToggleService: PropTypes.func,
  /** (categoryCode, select) — toggle every enabled resource in a category. */
  onToggleCategory: PropTypes.func,
  /** From useCatalog() — the registry the tree renders. */
  catalogCategories: PropTypes.array,
  catalogLoading: PropTypes.bool,
  catalogError: PropTypes.string,
  /** Optional jump to the Product Catalog screen, offered in empty categories. */
  onNavigateToCatalog: PropTypes.func,
  /** (fieldName, value) — the container appends it to the query and re-runs. */
  onValueClick: PropTypes.func,
  onRefresh: PropTypes.func.isRequired,
  loading: PropTypes.bool,
  /** Field names to omit. Defaults to the logs screen's alias set. */
  hiddenFields: PropTypes.instanceOf(Set),
};
