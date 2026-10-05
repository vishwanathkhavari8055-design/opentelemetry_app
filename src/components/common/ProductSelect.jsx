import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { PRODUCTS, describeProductServices, unclaimedServices } from '../../config/products';
import { formatCount } from '../../utils/format';

/**
 * Product picker for the logs scope panel.
 *
 * Choosing a product selects every one of its services that actually exists in
 * telemetry, so someone who owns a product gets its logs without knowing which
 * `service_name` values it emits — which is the whole point, given the emitted
 * names rarely match what the product team calls them.
 *
 * The panel lists each service with its log count, and greys out any the
 * registry declares but telemetry doesn't have. That gap is shown rather than
 * hidden: a product quietly missing a service looks identical to a product
 * that is simply quiet, and only one of those is a bug worth chasing.
 */
export default function ProductSelect({ services, value, onChange, loading }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = PRODUCTS.find((p) => p.key === value) || null;

  // Per-product rollup, so the menu can show coverage before you commit to a
  // selection — "5 of 6 services · 1.5M logs" is the thing that tells you the
  // mapping is healthy.
  const summaries = useMemo(() => PRODUCTS.map((p) => {
    const rows = describeProductServices(p.key, services);
    const present = rows.filter((r) => r.present);
    const total = present.reduce((sum, r) => (r.count == null ? sum : sum + r.count), 0);
    return { product: p, rows, presentCount: present.length, total };
  }), [services]);

  const unclaimed = useMemo(() => unclaimedServices(services), [services]);
  const activeRows = active ? summaries.find((s) => s.product.key === active.key)?.rows : null;

  let titleText = 'Filter by product';
  if (active) {
    const familyPrefix = active.family ? `${active.family} · ` : '';
    titleText = `${familyPrefix}${active.name} — ${active.description}`;
  }

  return (
    <div className="prod" ref={rootRef}>
      <button
        type="button"
        className={`prod-face ${open ? 'is-open' : ''} ${active ? 'has-value' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={titleText}
      >
        <span className="prod-face-text">{active ? active.name : 'All products'}</span>
        {active && (
          <button
            type="button"
            className="prod-clear"
            aria-label="Clear product filter"
            title="Clear product filter"
            onClick={(e) => { e.stopPropagation(); onChange(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); e.stopPropagation(); onChange(null);
              }
            }}
          >×</button>
        )}
        <span className="prod-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="prod-menu" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={!value}
            className={`prod-item ${!value ? 'is-active' : ''}`}
            onClick={() => { onChange(null); setOpen(false); }}
          >
            <span className="prod-item-name">All products</span>
            <span className="prod-item-sub">
              {loading ? 'loading…' : `${(services || []).length} services`}
            </span>
          </button>

          {summaries.map(({ product, presentCount, total }) => (
            <button
              type="button"
              role="option"
              aria-selected={value === product.key}
              key={product.key}
              className={`prod-item ${value === product.key ? 'is-active' : ''}`}
              onClick={() => { onChange(product.key); setOpen(false); }}
              title={product.description}
            >
              <span className="prod-item-name">
                {product.family && <span className="prod-item-family">{product.family}</span>}
                {product.name}
              </span>
              <span className="prod-item-desc">{product.description}</span>
              <span className="prod-item-sub">
                {presentCount} of {product.services.length} services
                {total > 0 && ` · ${formatCount(total)} logs`}
              </span>
            </button>
          ))}

          {unclaimed.length > 0 && (
            <div className="prod-note">
              {unclaimed.length} service{unclaimed.length === 1 ? '' : 's'} not mapped to any
              product — still reachable under “All products”.
            </div>
          )}
        </div>
      )}

      {/* Coverage for the active product, always visible so a service that
          silently stopped reporting is noticeable rather than just absent. */}
      {activeRows && (
        <ul className="prod-services">
          {activeRows.map((r) => {
            let rowTitle = `${r.label} — no service_name matches "${r.service || r.label}"`;
            let rowCount = 'not found';
            if (r.present) {
              const envSuffix = r.env ? ` (${r.env})` : '';
              rowTitle = `${r.label} → service_name="${r.name}"${envSuffix}`;
              rowCount = r.count == null ? '—' : formatCount(r.count);
            }
            return (
              <li
                className={`prod-service ${r.present ? '' : 'is-missing'}`}
                key={r.label}
                title={rowTitle}
              >
                <span className="prod-service-name">{r.label}</span>
                {/* Environment is shown when the entry is not the default
                    deployment, so a dev-only service isn't mistaken for prod. */}
                {r.env && <span className="prod-service-env">{r.env}</span>}
                <span className="prod-service-count">{rowCount}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

ProductSelect.propTypes = {
  /** Discovered services — strings or {name, count}. */
  services: PropTypes.array,
  /** Active product key, or null for all. */
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  loading: PropTypes.bool,
};
