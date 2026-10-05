import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * The "Past 15 Minutes" control in the toolbar: a button showing the active
 * window, opening a panel with a Relative preset grid and an Absolute
 * from/to pair.
 *
 * The value is a plain object so the container can hand it straight to the
 * query without a second translation step:
 *
 *   { mode: 'relative', relative: '15m' }
 *   { mode: 'absolute', from: '2026-08-03T12:45', to: '2026-08-03T13:00' }
 *
 * Relative windows are sent to the backend as `now-15m`, which its
 * TimeRangeParser understands directly; absolute ones are converted to ISO by
 * the container. Relative is the default because a log screen is almost always
 * asking "what is happening now", and a relative window keeps answering that
 * on every re-run while an absolute one silently goes stale.
 */

/** Preset grid, grouped the way OpenObserve groups it. */
const GROUPS = [
  { label: 'Minutes', unit: 'm', values: [1, 5, 10, 15, 30, 45] },
  { label: 'Hours',   unit: 'h', values: [1, 2, 3, 6, 8, 12] },
  { label: 'Days',    unit: 'd', values: [1, 2, 3, 4, 5, 6] },
  { label: 'Weeks',   unit: 'w', values: [1, 2, 3, 4, 5, 6] },
  { label: 'Months',  unit: 'M', values: [1, 2, 3, 4, 5, 6] },
];

const UNIT_NOUN = { m: 'Minute', h: 'Hour', d: 'Day', w: 'Week', M: 'Month' };

/** "15m" → "Past 15 Minutes" */
export const relativeLabel = (rel) => {
  const m = /^(\d+)([mhdwM])$/.exec(rel || '');
  if (!m) return 'Past 15 Minutes';
  const [, n, unit] = m;
  const noun = UNIT_NOUN[unit] || 'Minute';
  return `Past ${n} ${noun}${Number(n) === 1 ? '' : 's'}`;
};

/** Compact "03 Aug 12:45" for the absolute-range button label. */
const shortStamp = (local) => {
  if (!local) return '—';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
};

export const rangeLabel = (value) => (
  value.mode === 'absolute'
    ? `${shortStamp(value.from)} → ${shortStamp(value.to)}`
    : relativeLabel(value.relative)
);

export default function TimeRangePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(value.mode === 'absolute' ? 'absolute' : 'relative');
  // Absolute inputs are staged locally and only committed by Apply. Editing
  // them live would re-run the query on every keystroke, and a half-typed
  // datetime is a range nobody asked for.
  const [draftFrom, setDraftFrom] = useState(value.from || '');
  const [draftTo, setDraftTo] = useState(value.to || '');
  const rootRef = useRef(null);

  // Close on outside click / Escape — a dropdown that only closes via its own
  // button strands the user when they click past it.
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

  // Re-stage the drafts whenever the panel opens, so it reflects the committed
  // range rather than whatever was abandoned last time.
  useEffect(() => {
    if (open) {
      setDraftFrom(value.from || '');
      setDraftTo(value.to || '');
      setTab(value.mode === 'absolute' ? 'absolute' : 'relative');
    }
  }, [open, value.mode, value.from, value.to]);

  const pickRelative = (rel) => {
    onChange({ mode: 'relative', relative: rel, from: '', to: '' });
    setOpen(false);
  };

  const applyAbsolute = () => {
    if (!draftFrom && !draftTo) return;
    onChange({ mode: 'absolute', relative: value.relative, from: draftFrom, to: draftTo });
    setOpen(false);
  };

  return (
    <div className="trp" ref={rootRef}>
      <button
        type="button"
        className={`trp-btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Change the time range"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        {rangeLabel(value)}
        <span className="trp-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <dialog open className="trp-panel native-el" aria-label="Time range">
          <div className="trp-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'relative'}
              className={`trp-tab ${tab === 'relative' ? 'is-active' : ''}`}
              onClick={() => setTab('relative')}
            >Relative</button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'absolute'}
              className={`trp-tab ${tab === 'absolute' ? 'is-active' : ''}`}
              onClick={() => setTab('absolute')}
            >Absolute</button>
          </div>

          {tab === 'relative' ? (
            <div className="trp-groups">
              {GROUPS.map((g) => (
                <div className="trp-group" key={g.label}>
                  <div className="trp-group-label">{g.label}</div>
                  <div className="trp-group-grid">
                    {g.values.map((n) => {
                      const rel = `${n}${g.unit}`;
                      const active = value.mode === 'relative' && value.relative === rel;
                      return (
                        <button
                          type="button"
                          key={rel}
                          className={`trp-preset ${active ? 'is-active' : ''}`}
                          onClick={() => pickRelative(rel)}
                        >{n}</button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="trp-absolute">
              <label className="trp-field">
                <span>From</span>
                <input
                  type="datetime-local"
                  step="1"
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                />
              </label>
              <label className="trp-field">
                <span>To</span>
                <input
                  type="datetime-local"
                  step="1"
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                />
              </label>
              <div className="trp-absolute-actions">
                <button
                  type="button"
                  className="trp-clear"
                  onClick={() => { setDraftFrom(''); setDraftTo(''); }}
                >Clear</button>
                <button
                  type="button"
                  className="trp-apply"
                  onClick={applyAbsolute}
                  disabled={!draftFrom && !draftTo}
                >Apply</button>
              </div>
              <p className="trp-note">
                An absolute range is fixed — auto-refresh will keep re-running it
                over the same window.
              </p>
            </div>
          )}
        </dialog>
      )}
    </div>
  );
}

TimeRangePicker.propTypes = {
  value: PropTypes.shape({
    mode: PropTypes.oneOf(['relative', 'absolute']).isRequired,
    relative: PropTypes.string,
    /** `datetime-local` strings, i.e. local wall time with no zone suffix. */
    from: PropTypes.string,
    to: PropTypes.string,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
};
