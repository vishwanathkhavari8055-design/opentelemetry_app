import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * Auto-refresh control sitting to the right of "Run query": a clock button
 * that shows the active interval, opening a short menu of choices.
 *
 * `value` is seconds; 0 means off. The container owns the timer — this only
 * picks the number, so pausing rules (don't poll while a query is in flight,
 * don't poll an absolute range into staleness, don't poll off page 1) stay in one
 * place rather than being split across a dropdown and an effect.
 *
 * When the container HAS paused, it says why through `pausedReason` and this shows
 * it. For a while that absolute-range rule was documented here but implemented
 * nowhere, which is the worst of both: the screen polled a fixed window forever,
 * redrawing identical rows, and looked broken to anyone expecting new logs.
 */

const OPTIONS = [
  { secs: 0,    label: 'Off' },
  { secs: 5,    label: '5 sec' },
  { secs: 10,   label: '10 sec' },
  { secs: 15,   label: '15 sec' },
  { secs: 30,   label: '30 sec' },
  { secs: 60,   label: '1 min' },
  { secs: 300,  label: '5 min' },
  { secs: 900,  label: '15 min' },
  { secs: 1800, label: '30 min' },
  { secs: 3600, label: '1 hour' },
];

/** Compact form for the button face: "30s", "5m", "1h". */
const shortLabel = (secs) => {
  if (!secs) return '';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${secs / 60}m`;
  return `${secs / 3600}h`;
};

/** Hover text for the button: off, paused (and why), or the live cadence. */
const buttonTitle = (value, paused, pausedReason) => {
  if (!value) return 'Auto-refresh is off';
  if (paused) return `Auto-refresh ${shortLabel(value)} — ${pausedReason}`;
  return `Auto-refreshing every ${shortLabel(value)}`;
};

export default function RefreshIntervalPicker({ value, onChange, pausedReason }) {
  // An interval is set but the container is not polling. Shown, not hidden: a
  // clock reading "5s" over a table that never reloads is indistinguishable from
  // a broken screen, and the two pauses that cause it are both recoverable by the
  // user — go back to page 1, or choose a relative range.
  const paused = !!(value && pausedReason);
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

  return (
    <div className="rip" ref={rootRef}>
      <button
        type="button"
        className={`tb-btn ${value ? 'is-active' : ''} ${paused ? 'is-paused' : ''} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={buttonTitle(value, paused, pausedReason)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.3 5.7" />
          <path d="M20 4v7h-7" />
        </svg>
        {value > 0 && <span className="rip-value">{shortLabel(value)}</span>}
      </button>

      {open && (
        <div className="rip-menu" role="menu">
          {paused && <div className="rip-note">{pausedReason}</div>}
          {OPTIONS.map((o) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={value === o.secs}
              key={o.secs}
              className={`rip-item ${value === o.secs ? 'is-active' : ''}`}
              onClick={() => { onChange(o.secs); setOpen(false); }}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

RefreshIntervalPicker.propTypes = {
  /** Seconds between automatic re-runs; 0 disables it. */
  value: PropTypes.number.isRequired,
  onChange: PropTypes.func.isRequired,
  /**
   * Why the container is not polling despite `value` being set; '' when it is.
   * The container owns the pausing rules, so it also owns explaining them.
   */
  pausedReason: PropTypes.string,
};
