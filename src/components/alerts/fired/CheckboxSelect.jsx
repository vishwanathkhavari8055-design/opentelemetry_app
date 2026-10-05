import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * A dropdown whose panel holds checkboxes — pick any number of options.
 *
 * ─── Why not reuse common/ServiceMultiSelect ───────────────────────────────
 *
 * It is the same idea and was the first thing I reached for, but two of its
 * behaviours are wrong for a short enum list:
 *
 *   • It sorts options alphabetically and floats the selected ones to the top.
 *     For a service list out of a hundred, that is exactly right. For severity it
 *     destroys the only ordering that means anything — disaster before critical
 *     before warning — and a ladder in alphabetical order is worse than no order.
 *   • It opens with a focused search box. With four or five fixed options that is
 *     a control to dismiss rather than a way in.
 *
 * Its styles also live in `logs-query.css`, so reusing it would pull a logs
 * stylesheet into the alerts screen.
 *
 * ─── Deliberately local for now ────────────────────────────────────────────
 *
 * This sits next to its first caller rather than in `common/`, with its CSS in
 * `alerts-enterprise.css`. A component in `common/` whose styles only load on one
 * screen is a trap for whoever imports it second.
 *
 * There IS now a second caller — AlertEditor's Destinations field, which is a
 * genuine multi-select over a short list in the caller's own order. It was left
 * here rather than promoted to `common/` because both callers are alerts
 * screens, so the file is already in the right feature; and because every
 * stylesheet is imported globally from `index.css`, so the CSS split that the
 * note above warns about does not actually bite. Promote it (with its styles)
 * when a caller outside `components/alerts/` appears.
 *
 * ─── Order is preserved exactly as given ───────────────────────────────────
 *
 * No sorting at all, selected or otherwise. The caller's order IS the meaning.
 */
export default function CheckboxSelect({
  options, value, onChange, allLabel, noun, ariaLabel, disabled,
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const faceRef = useRef(null);

  const selected = useMemo(() => new Set(value || []), [value]);

  // Close on click-outside and on Escape. Both matter: a dropdown that only
  // closes by clicking its own button strands itself open behind whatever the
  // user clicked next.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        // Focus goes back to the button, or the tab order restarts from the top
        // of the document for anyone using a keyboard.
        faceRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setCursor(0);
      requestAnimationFrame(() => menuRef.current?.focus());
    }
  }, [open]);

  const toggle = (optionValue) => {
    const next = new Set(selected);
    if (next.has(optionValue)) next.delete(optionValue); else next.add(optionValue);
    // Additive: the previous selection is copied, never replaced, so ticking a
    // second option cannot silently drop the first.
    //
    // Emitted in the CALLER'S order, not selection order, so the value the
    // backend receives is stable regardless of which box was ticked first.
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  };

  const onMenuKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => {
        const next = e.key === 'ArrowDown' ? c + 1 : c - 1;
        return (next + options.length) % options.length;
      });
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (cursor >= 0 && options[cursor]) toggle(options[cursor].value);
    }
  };

  const count = selected.size;
  let face;
  if (count === 0) {
    face = allLabel;
  } else if (count === 1) {
    face = options.find((o) => o.value === Array.from(selected)[0])?.label
          || Array.from(selected)[0];
  } else {
    face = `${count} ${noun}`;
  }

  const selectedLabels = options
    .filter((o) => selected.has(o.value))
    .map((o) => o.label)
    .join(', ');

  return (
    <div className={`cbs ${disabled ? 'is-disabled' : ''}`} ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={faceRef}
        type="button"
        className={`cbs-face ${open ? 'is-open' : ''} ${count ? 'has-value' : ''}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={count ? selectedLabels : ariaLabel}
      >
        <span className="cbs-face-text">{face}</span>
        <span className="cbs-caret" aria-hidden="true" style={count > 0 ? { marginLeft: '1.2rem' } : undefined}>▾</span>
      </button>
      {count > 0 && (
        <button
          type="button"
          className="cbs-clear"
          style={{ position: 'absolute', right: '1.4rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: 0 }}
          aria-label={`Clear ${ariaLabel}`}
          title="Clear"
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

      {open && (
        <div
          className="cbs-menu" role="menu"
          aria-label={ariaLabel}
          tabIndex={-1}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          <div className="cbs-actions">
            <span className="cbs-count">
              {count > 0 ? `${count} of ${options.length} selected` : `${options.length} options`}
            </span>
            {count < options.length && (
              <button
                type="button" className="cbs-link"
                onClick={() => onChange(options.map((o) => o.value))}
              >Select all</button>
            )}
            {count > 0 && (
              <button type="button" className="cbs-link" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>

          <div className="cbs-list">
            {options.map((option, i) => {
              const isOn = selected.has(option.value);
              return (
                <label
                  className={`cbs-item ${isOn ? 'is-on' : ''} ${i === cursor ? 'is-cursor' : ''}`}
                  key={option.value}
                  onMouseEnter={() => setCursor(i)}
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => toggle(option.value)}
                  />
                  {/* The tone dot ties the option to the same colour the table
                      uses for that value, so the filter and the rows agree at a
                      glance instead of needing to be cross-read. */}
                  {option.tone && (
                    <span className={`cbs-dot cbs-dot--${option.tone}`} aria-hidden="true" />
                  )}
                  <span className="cbs-item-text">{option.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

CheckboxSelect.propTypes = {
  /** Options in the order they must appear. That order is not sorted. */
  options: PropTypes.arrayOf(PropTypes.shape({
    value: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    /** Optional colour key for the leading dot, e.g. a severity name. */
    tone: PropTypes.string,
  })).isRequired,
  /** Selected values. Empty means "no filter", shown as {@code allLabel}. */
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
  /** Face text when nothing is selected, e.g. "All severities". */
  allLabel: PropTypes.string.isRequired,
  /** Plural noun for the multi-selection face, e.g. "severities". */
  noun: PropTypes.string.isRequired,
  ariaLabel: PropTypes.string.isRequired,
  disabled: PropTypes.bool,
};
