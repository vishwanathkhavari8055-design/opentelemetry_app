import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * Single-select dropdown with a filter box and a scrolling list.
 *
 * The single-choice sibling of ServiceMultiSelect, and deliberately built to
 * look and behave like it — same filter-on-open, same arrow/Enter/Escape
 * handling, same capped-and-scrolled list. Two controls that do the same job in
 * different corners of one product should not feel different.
 *
 * It exists because a native `<select>` stops being usable past a few dozen
 * options: this instance reports ~2,000 metric streams, and the only way to
 * reach `catalina_connector_connectiontimeout` in a native list is to scroll
 * for it. There is no way to filter a native select.
 *
 * ── Why the menu is position:fixed ────────────────────────────────────────
 *
 * ServiceMultiSelect positions its menu absolutely, which is fine on the Logs
 * toolbar — nothing above it scrolls. This control is used inside the alert
 * editor's LEFT COLUMN, which is `overflow-y: auto`. An absolutely-positioned
 * child of a scroll container is clipped by it, so the bottom of a 260px menu
 * opened near the fold would simply be cut off. Fixed positioning is measured
 * from the trigger's viewport rect instead, so no ancestor can clip it; the
 * trade-off is that the position must be recomputed while anything scrolls,
 * which is what the listener below does.
 *
 * The menu is NOT portalled to document.body, on purpose: this UI also ships as
 * a Web Component (see wc-entry.jsx), and moving nodes outside the component's
 * own subtree takes them out of its injected style scope.
 */

/** Menu height cap. Matches .sms-list so both pickers scroll at the same point. */
const MAX_MENU_H = 300;
/** Gap between the trigger and the menu. */
const GAP = 4;

export default function SearchableSelect({
  options, value, onChange, placeholder, searchPlaceholder, emptyLabel,
  loading, disabled, allowClear, missingSuffix, ariaLabel, id, className,
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  // Index of the keyboard-highlighted row; -1 = nothing highlighted.
  const [cursor, setCursor] = useState(-1);
  const [pos, setPos] = useState(null);

  const rootRef = useRef(null);
  const faceRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  // Callers pass plain strings or {value,label}; normalising here means one
  // component serves both instead of two near-identical ones.
  const entries = useMemo(() => (options || [])
    .map((o) => (typeof o === 'string'
      ? { value: o, label: o }
      : { value: o?.value, label: o?.label ?? o?.value }))
    .filter((o) => o.value != null && o.value !== ''), [options]);

  const known = useMemo(() => new Set(entries.map((e) => e.value)), [entries]);

  /**
   * A saved value that is no longer in the option list is kept and pinned to the
   * top rather than being dropped.
   *
   * An alert may name a stream that has since been deleted, or a column the
   * stream's schema no longer reports. Silently blanking it on open would let a
   * user "just fix the name" and unknowingly repoint or erase a live alert's
   * condition. Marking it visibly is the honest behaviour.
   */
  const missing = value && !known.has(value);

  /** Recompute the menu rect from the trigger. */
  const place = useCallback(() => {
    const el = faceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP;
    const above = r.top - GAP;
    // Open upward only when there is genuinely more room there, so the menu
    // does not flip about on small scroll changes.
    const up = below < 180 && above > below;
    setPos({
      left: r.left,
      width: r.width,
      top: up ? undefined : r.bottom + GAP,
      bottom: up ? window.innerHeight - r.top + GAP : undefined,
      maxHeight: Math.max(140, Math.min(MAX_MENU_H, up ? above : below)),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Reposition while ANY ancestor scrolls — capture:true is what makes an
  // inner scroll container's event reach this listener.
  useEffect(() => {
    if (!open) return undefined;
    const onScrollOrResize = () => place();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      // The menu is a sibling of the face in the DOM, so one containment check
      // on the shared root covers both.
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Focus the filter on open; clear it on close so the next open starts fresh
  // rather than showing a list still narrowed by a forgotten query.
  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
    else { setFilter(''); setPos(null); }
  }, [open]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? entries.filter((o) => o.label.toLowerCase().includes(q))
      : entries;
    if (missing && (!q || String(value).toLowerCase().includes(q))) {
      return [{ value, label: `${value} ${missingSuffix}`, isMissing: true }, ...list];
    }
    return list;
  }, [entries, filter, missing, value, missingSuffix]);

  // Typing changes what sits at each index, so put the cursor back on the first
  // row instead of leaving it on an unrelated one.
  useEffect(() => {
    setCursor(visible.length ? 0 : -1);
  }, [filter, visible.length]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    if (cursor < 0 || !listRef.current) return;
    const el = listRef.current.children[cursor];
    if (el?.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (next) => {
    onChange(next);
    setOpen(false);
    // Return focus to the trigger so keyboard users are not dropped back to the
    // top of the document.
    requestAnimationFrame(() => faceRef.current?.focus());
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
      if (cursor >= 0 && visible[cursor]) pick(visible[cursor].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      requestAnimationFrame(() => faceRef.current?.focus());
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const onFaceKeyDown = (e) => {
    if (['ArrowDown', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const faceText = value
    ? (entries.find((o) => o.value === value)?.label
      || `${value} ${missingSuffix}`)
    : (placeholder || 'Select…');

  let countText = 'Loading…';
  if (!loading) {
    countText = filter.trim() ? `${visible.length} of ${entries.length}` : `${entries.length} available`;
  }

  return (
    <div className={`ssel ${className || ''} ${disabled ? 'is-disabled' : ''}`} ref={rootRef}>
      <button
        type="button"
        id={id}
        ref={faceRef}
        className={`ssel-face ${open ? 'is-open' : ''} ${value ? 'has-value' : ''} ${missing ? 'is-missing' : ''}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onFaceKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={value || placeholder || ''}
      >
        <span className="ssel-face-text">{faceText}</span>
        {allowClear && value && !disabled && (
          <button
            type="button"
            className="ssel-clear"
            aria-label="Clear selection"
            title="Clear selection"
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onChange('');
              }
            }}
          >×</button>
        )}
        <span className="ssel-caret" aria-hidden="true">▾</span>
      </button>

      {open && pos && (
        <div
          className="ssel-menu"
          role="listbox"
          aria-label={ariaLabel}
          style={{
            left: pos.left,
            width: pos.width,
            top: pos.top,
            bottom: pos.bottom,
          }}
        >
          <div className="ssel-search">
            <input
              ref={searchRef}
              type="text"
              value={filter}
              placeholder={searchPlaceholder || 'Search…'}
              aria-label={searchPlaceholder || 'Search options'}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>

          <div className="ssel-actions">
            <span className="ssel-count">{countText}</span>
          </div>

          <div className="ssel-list" ref={listRef} style={{ maxHeight: pos.maxHeight }}>
            {entries.length === 0 && !missing && (
              <div className="ssel-empty">
                {loading ? 'Loading…' : (emptyLabel || 'Nothing available.')}
              </div>
            )}
            {(entries.length > 0 || missing) && visible.length === 0 && (
              <div className="ssel-empty">No match for “{filter}”.</div>
            )}
            {visible.map((o, i) => (
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`ssel-item ${o.value === value ? 'is-on' : ''} ${i === cursor ? 'is-cursor' : ''} ${o.isMissing ? 'is-missing' : ''}`}
                key={`${o.value}-${i}`}
                title={o.label}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(o.value)}
              >
                <span className="ssel-item-text">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

SearchableSelect.propTypes = {
  /** Plain strings, or {value,label} when the two differ. */
  options: PropTypes.arrayOf(PropTypes.oneOfType([
    PropTypes.string,
    PropTypes.shape({ value: PropTypes.string, label: PropTypes.string }),
  ])),
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  /** Face text when nothing is chosen. */
  placeholder: PropTypes.string,
  searchPlaceholder: PropTypes.string,
  /** Shown when the option list itself is empty. */
  emptyLabel: PropTypes.string,
  loading: PropTypes.bool,
  disabled: PropTypes.bool,
  /** Adds an × to unset the value. */
  allowClear: PropTypes.bool,
  /** Suffix marking a value that is no longer in the option list. */
  missingSuffix: PropTypes.string,
  ariaLabel: PropTypes.string,
  id: PropTypes.string,
  className: PropTypes.string,
};

SearchableSelect.defaultProps = {
  missingSuffix: '(not in list)',
};
