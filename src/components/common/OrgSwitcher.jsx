import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * Organization picker for the app header.
 *
 * Switching org re-scopes EVERY screen, not just IAM — on this instance
 * `default` has 638 streams and `DLH` has 12,655, so it changes what logs,
 * traces, metrics and the Home totals are about. That's why the control lives
 * in the global header rather than inside the IAM screen.
 */
export default function OrgSwitcher({ organizations, value, onChange, onOpen, loading }) {
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

  // Show the human name, fall back to the identifier. Before the list loads we
  // still have the persisted identifier, so the header never flashes empty.
  const active = organizations.find((o) => o.identifier === value);
  const face = active?.name || value || 'default';
  const buttonTitle = active?.identifier
    ? `Organization: ${face} (${active.identifier})`
    : `Organization: ${face}`;

  return (
    <div className="orgsw" ref={rootRef}>
      <button
        type="button"
        className={`orgsw-face ${open ? 'is-open' : ''}`}
        onClick={() => {
          const next = !open;
          setOpen(next);
          // Re-check the list the moment it's about to be read. Organizations
          // are created and deleted in OpenObserve, so opening the menu is the
          // one instant where a stale list is guaranteed to be noticed.
          if (next && onOpen) onOpen();
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={buttonTitle}
      >
        <span className="orgsw-face-text">{face}</span>
        <span className="orgsw-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="orgsw-menu" role="listbox">
          <div className="orgsw-head">Organization</div>
          {loading && organizations.length === 0 && (
            <div className="orgsw-empty">Loading…</div>
          )}
          {!loading && organizations.length === 0 && (
            <div className="orgsw-empty">No organizations available.</div>
          )}
          {organizations.map((o) => (
            <button
              type="button"
              role="option"
              aria-selected={o.identifier === value}
              key={o.identifier}
              className={`orgsw-item ${o.identifier === value ? 'is-active' : ''}`}
              onClick={() => { onChange(o.identifier); setOpen(false); }}
            >
              <span className="orgsw-item-name">{o.name || o.identifier}</span>
              {/* The identifier is what actually goes on the wire, and names
                  are not unique — showing both avoids picking the wrong one. */}
              <span className="orgsw-item-id" title={o.identifier}>{o.identifier}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

OrgSwitcher.propTypes = {
  organizations: PropTypes.arrayOf(PropTypes.shape({
    identifier: PropTypes.string,
    name: PropTypes.string,
    type: PropTypes.string,
  })).isRequired,
  /** Active org identifier. */
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
  /** Called when the menu opens, to refresh the list before it's read. */
  onOpen: PropTypes.func,
  loading: PropTypes.bool,
};
