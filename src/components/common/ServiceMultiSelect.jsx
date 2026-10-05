import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { formatCount } from '../../utils/format';

/**
 * Checkbox dropdown for picking one or more services.
 *
 * Shared by the Logs and Traces screens. The list is supplied by the caller and
 * should come from a discovery endpoint, NOT from the rows currently on screen:
 * deriving it from a sampled page silently hides every low-volume service, and
 * the whole point of this control is finding the quiet one.
 *
 * Selection is a plain array of raw backend service names — never
 * display-formatted, because the value goes straight back into a query.
 */

export default function ServiceMultiSelect({
  options, value, onChange, loading, label, placeholder, disabled,
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  // Index of the keyboard-highlighted row; -1 = nothing highlighted.
  const [cursor, setCursor] = useState(-1);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const selected = useMemo(() => new Set(value || []), [value]);

  // Callers pass either plain names (Traces) or {name, count} (Logs, which has
  // a per-service COUNT from the discovery query). Normalising here keeps both
  // working off one component instead of forking it.
  const entries = useMemo(() => (options || []).map((o) => (
    typeof o === 'string' ? { name: o, count: null } : { name: o?.name, count: o?.count ?? null }
  )).filter((o) => o.name), [options]);

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

  // Focus the filter on open — with a hundred-plus services, typing is the
  // only practical way to find one.
  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else setFilter('');
  }, [open]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? entries.filter((o) => o.name.toLowerCase().includes(q))
      : entries;
    // Selected services float to the top so what you've picked stays visible
    // instead of scrolling away under a long alphabetical list.
    return [...list].sort((a, b) => {
      const d = (selected.has(b.name) ? 1 : 0) - (selected.has(a.name) ? 1 : 0);
      return d !== 0 ? d : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [entries, filter, selected]);

  // Typing changes what's under the cursor, so reset it rather than leaving it
  // pointing at whatever row happens to now occupy that index.
  useEffect(() => { setCursor(visible.length ? 0 : -1); }, [filter, visible.length]);

  const toggle = (name) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    // Additive by construction: the previous selection is copied, never
    // replaced, so ticking a second service never drops the first.
    onChange(Array.from(next));
  };

  /** Select-all applies to what's VISIBLE — with a filter active, "all" means
   *  the matches you can see, not the whole hundred-service list. */
  const selectAllVisible = () => {
    const next = new Set(selected);
    visible.forEach((o) => next.add(o.name));
    onChange(Array.from(next));
  };

  const onSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!visible.length) return;
      setCursor((c) => {
        const next = e.key === 'ArrowDown' ? c + 1 : c - 1;
        return (next + visible.length) % visible.length;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cursor >= 0 && visible[cursor]) toggle(visible[cursor].name);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (cursor < 0 || !listRef.current) return;
    const el = listRef.current.children[cursor];
    if (el?.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const count = selected.size;
  let face = placeholder || 'All services';
  if (count === 1) {
    face = Array.from(selected)[0];
  } else if (count > 1) {
    face = `${count} services`;
  }

  return (
    <div className={`sms ${disabled ? 'is-disabled' : ''}`} ref={rootRef}>
      {label && <span className="sms-label">{label}</span>}

      <button
        type="button"
        className={`sms-face ${open ? 'is-open' : ''} ${count ? 'has-value' : ''}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={count ? Array.from(selected).join(', ') : 'Filter by service'}
      >
        <span className="sms-face-text">{face}</span>
        {count > 0 && (
          <button
            type="button"
            className="sms-clear"
            aria-label="Clear service filter"
            title="Clear service filter"
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onChange([]);
              }
            }}
          >×</button>
        )}
        <span className="sms-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="sms-menu" role="menu">
          <div className="sms-search">
            <input
              ref={searchRef}
              type="text"
              value={filter}
              placeholder="Filter services…"
              aria-label="Filter services"
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>

          <div className="sms-actions">
            <span className="sms-count">
              {loading ? 'Loading…' : `${entries.length} available`}
              {count > 0 && ` · ${count} selected`}
            </span>
            {visible.length > 0 && (
              <button type="button" className="sms-link" onClick={selectAllVisible}>
                {filter.trim() ? 'Select matches' : 'Select all'}
              </button>
            )}
            {count > 0 && (
              <button type="button" className="sms-link" onClick={() => onChange([])}>
                Clear all
              </button>
            )}
          </div>

          <div className="sms-list" ref={listRef}>
            {entries.length === 0 && (
              <div className="sms-empty">
                {loading ? 'Loading services…' : 'No services discovered in the window.'}
              </div>
            )}
            {entries.length > 0 && visible.length === 0 && (
              <div className="sms-empty">No service matches “{filter}”.</div>
            )}
            {visible.map((o, i) => {
              const { name } = o;
              const isOn = selected.has(name);
              return (
                <label
                  className={`sms-item ${isOn ? 'is-on' : ''} ${i === cursor ? 'is-cursor' : ''}`}
                  key={name}
                  title={o.count != null ? `${name} — ${o.count.toLocaleString()} logs` : name}
                  onMouseEnter={() => setCursor(i)}
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => toggle(name)}
                  />
                  <span className="sms-item-text">{name}</span>
                  {o.count != null && (
                    <span className="sms-item-count">{formatCount(o.count)}</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

ServiceMultiSelect.propTypes = {
  /** Raw backend service names from a discovery endpoint — either plain
   *  strings, or {name, count} when the caller has per-service counts. */
  options: PropTypes.arrayOf(PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.shape({ name: PropTypes.string, count: PropTypes.number }),
  ])).isRequired,
  /** Currently selected raw names. Empty array = no filter (all services). */
  value: PropTypes.arrayOf(PropTypes.string).isRequired,
  onChange: PropTypes.func.isRequired,
  loading: PropTypes.bool,
  label: PropTypes.string,
  placeholder: PropTypes.string,
  disabled: PropTypes.bool,
};
