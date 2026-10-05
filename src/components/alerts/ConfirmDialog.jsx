import React, { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import useBackdropClose from './useBackdropClose';

/**
 * Confirmation modal for the destructive and outward-facing actions on the
 * Alerts screen: deleting an alert or folder, and triggering an evaluation.
 *
 * Triggering is in that list on purpose. It is not destructive, but it CAN send
 * real notifications to real people the moment it is clicked, which makes it
 * exactly as unrecoverable as a delete from the recipient's point of view.
 *
 * Deliberately not window.confirm(): this UI ships as a Web Component embedded
 * in host applications, and a native modal blocks the host's event loop too.
 */
export default function ConfirmDialog({
  title, body, confirmLabel, cancelLabel, danger, busy, onCancel, onConfirm,
}) {
  const cancelRef = useRef(null);
  // Clicking the backdrop cancels; clicks inside the panel do not.
  const backdropRef = useBackdropClose(onCancel);

  // Focus lands on CANCEL, not confirm — for a destructive prompt the safe
  // option should be the one a stray Enter hits.
  useEffect(() => { cancelRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <dialog
      open
      ref={backdropRef}
      className="alerts-modal-backdrop native-el"
      aria-modal="true"
      aria-label={title}
    >
      <div className="alerts-modal">
        <div className="alerts-modal-head">
          <h2 className="alerts-modal-title">{title}</h2>
          <button type="button" className="alerts-modal-x" onClick={onCancel} aria-label="Close">×</button>
        </div>
        <div className="alerts-modal-body">
          <p style={{ fontSize: '0.84rem', lineHeight: 1.55, color: 'var(--text-secondary)' }}>
            {body}
          </p>
        </div>
        <div className="alerts-modal-foot">
          <button
            type="button" ref={cancelRef} className="alerts-btn-ghost"
            onClick={onCancel} disabled={busy}
          >{cancelLabel || 'Cancel'}</button>
          <button
            type="button"
            className="alerts-btn-primary"
            onClick={onConfirm}
            disabled={busy}
            style={danger ? {
              background: 'var(--error-color)',
              borderColor: 'var(--error-color)',
            } : undefined}
          >{busy ? 'Working…' : (confirmLabel || 'Confirm')}</button>
        </div>
      </div>
    </dialog>
  );
}

ConfirmDialog.propTypes = {
  title: PropTypes.string.isRequired,
  body: PropTypes.string.isRequired,
  confirmLabel: PropTypes.string,
  cancelLabel: PropTypes.string,
  /** Styles the confirm button as destructive. */
  danger: PropTypes.bool,
  busy: PropTypes.bool,
  onCancel: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
};
