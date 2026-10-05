import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { updateIamUser } from '../../services/api';
import useBackdropDismiss from '../common/useBackdropDismiss';

/**
 * "Update User" — edit an existing organization member.
 *
 * Email is READ-ONLY and shown as text rather than a disabled input, because it
 * is the identity OpenObserve keys the user on: there is no rename, only delete
 * and re-create. A greyed-out box would imply otherwise.
 *
 * Only fields the user actually changed are sent. OpenObserve treats a supplied
 * null as "clear this", so submitting the whole form every time would blank a
 * last name that the form had simply loaded empty.
 *
 * Password changes are behind an explicit toggle and are never pre-filled. The
 * value is held in component state for the life of the drawer and is not logged
 * anywhere — the backend logs that a change occurred, not what it was.
 *
 * Attribution caveat, which the drawer states in plain sight: this deployment
 * authenticates to OpenObserve with one shared service account, so OpenObserve's
 * audit trail records that account as the editor rather than whoever clicked
 * Save. That is the reason creating users is still not offered here — see
 * IamService on the backend.
 */

const ROLES = [
  { value: 'admin',  label: 'Admin' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'user',   label: 'User' },
];

/** Mirrors OpenObserve's own minimum so a rejection is caught before the call. */
const MIN_PASSWORD = 8;

export default function UserEditDrawer({ user, onCancel, onSaved }) {
  const [firstName, setFirstName] = useState(user.firstName || '');
  const [lastName, setLastName] = useState(user.lastName || '');
  const [role, setRole] = useState((user.role || 'user').toLowerCase());
  const [changePassword, setChangePassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  /**
   * The root user is deliberately not editable here.
   *
   * OpenObserve rejects role changes on it, and demoting the only root account
   * would lock everyone out of the instance — including this service. Showing
   * the fields disabled with a reason beats a save that fails.
   */
  const isRoot = (user.role || '').toLowerCase() === 'root';

  // Role is not in ROLES for a root or service_account user; keep whatever the
  // server reported selectable so the control is never blank.
  const roleOptions = useMemo(() => {
    if (ROLES.some((r) => r.value === role)) return ROLES;
    return [{ value: role, label: role.charAt(0).toUpperCase() + role.slice(1) }, ...ROLES];
  }, [role]);

  /**
   * What the dialog's single notice panel says, most consequential first.
   *
   * There is one panel rather than one per note because the dialog is specced at a
   * fixed height in each of its two states, and stacking panels is what pushes the
   * body into a scroll. Order: a failed save first (it is the only one the user has
   * to act on), then the pending password replacement, then why root's role control
   * is dead, then the standing attribution caveat.
   */
  let notice;
  if (error) {
    notice = { kind: 'error', text: error };
  } else if (changePassword) {
    notice = {
      kind: 'warn',
      text: `Saving replaces this user's password immediately. They are not
             notified, so tell them out of band.`.replace(/\s+/g, ' '),
    };
  } else if (isRoot) {
    notice = {
      kind: 'info',
      text: `The root user's role cannot be changed — demoting the only root
             account would lock everyone out of the instance.`.replace(/\s+/g, ' '),
    };
  } else {
    notice = {
      kind: 'info',
      text: `Recorded in OpenObserve against this deployment's shared service
             account rather than your own login, because that is the credential
             the backend authenticates with.`.replace(/\s+/g, ' '),
    };
  }

  const dirty = firstName !== (user.firstName || '')
    || lastName !== (user.lastName || '')
    || role !== (user.role || 'user').toLowerCase()
    || (changePassword && newPassword.length > 0);

  const submit = async (e) => {
    e.preventDefault();
    setError('');

    if (changePassword) {
      if (newPassword.length < MIN_PASSWORD) {
        setError(`The new password must be at least ${MIN_PASSWORD} characters.`);
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('The two passwords do not match.');
        return;
      }
    }

    // Send only what changed — see the note on why a full submit is unsafe.
    const payload = {};
    if (firstName !== (user.firstName || '')) payload.firstName = firstName;
    if (lastName !== (user.lastName || '')) payload.lastName = lastName;
    if (role !== (user.role || '').toLowerCase()) payload.role = role;
    if (changePassword) {
      payload.changePassword = true;
      payload.newPassword = newPassword;
    }

    if (Object.keys(payload).length === 0) {
      onCancel();
      return;
    }

    setBusy(true);
    try {
      const res = await updateIamUser(user.email, payload);
      onSaved({
        message: res?.message || `${user.email} updated.`,
        passwordChanged: !!changePassword,
      });
    } catch (err) {
      setError(err.message || 'Could not update this user.');
      setBusy(false);
    }
  };

  const backdropRef = useBackdropDismiss(() => { if (!busy) onCancel(); });

  return (
    <dialog
      open
      ref={backdropRef}
      className="uem-backdrop native-el"
      aria-modal="true"
      aria-label="Update user"
    >
      {/* Two elements, because the spec box is transparent with 2px of padding and
          the dark surface sits inside it. The outer element carries the size;
          `.uem-inner` is the panel you can actually see.

          `uem--pw` is what switches it to the taller Change Password dimensions —
          the two states are specced at different sizes, so the box has to know
          which one it is in rather than sizing to its content. */}
      <form className={`uem ${changePassword ? 'uem--pw' : ''}`} onSubmit={submit}>
        <div className="uem-inner">
          <header className="uem-head">
            <h2 className="uem-title">Update User</h2>
            <button
              type="button" className="uem-x" onClick={onCancel}
              disabled={busy} aria-label="Close"
            >×</button>
          </header>

          <div className="uem-body">
            {/* Label · colon · field, on one three-column grid so the colons line
                up down the form and every control starts at the same x. */}
            <div className="uem-row">
              <span className="uem-label">Email</span>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                <span className="uem-value">{user.email}</span>
                <span className="uem-note">email cannot be changed.</span>
              </div>
            </div>

            <div className="uem-row">
              <label className="uem-label" htmlFor="usr-first">First Name</label>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                <input
                  id="usr-first" ref={firstRef} className="uem-input" value={firstName}
                  placeholder="Enter First Name"
                  disabled={busy} maxLength={100} autoComplete="off"
                  onChange={(e) => setFirstName(e.target.value)}
                />
              </div>
            </div>

            <div className="uem-row">
              <label className="uem-label" htmlFor="usr-last">Last Name</label>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                <input
                  id="usr-last" className="uem-input" value={lastName}
                  placeholder="Enter Last Name"
                  disabled={busy} maxLength={100} autoComplete="off"
                  onChange={(e) => setLastName(e.target.value)}
                />
              </div>
            </div>

            <div className="uem-row">
              <label className="uem-label" htmlFor="usr-role">Role</label>
              <span className="uem-colon" aria-hidden="true">:</span>
              <div className="uem-field">
                <select
                  id="usr-role" className="uem-select" value={role}
                  disabled={busy || isRoot}
                  onChange={(e) => setRole(e.target.value)}
                >
                  {roleOptions.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* ONE panel, always, in this one slot.

                The dialog is specced at a fixed height, so a note cannot claim a
                panel of its own without pushing the body into a scroll. Four things
                want to say something here, so the slot shows the single most
                consequential one — see `notice` above for the order and why.
                Keeping the error in this slot also guarantees it is on screen: an
                error appended below the fields would land in the scrolled-off
                region exactly when the form is at its tallest. */}
            <div
              className={`uem-info uem-info--${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : undefined}
            >
              <span className="uem-info-icon" aria-hidden="true">
                {notice.kind === 'info' ? 'i' : '!'}
              </span>
              <p className="uem-info-text">{notice.text}</p>
            </div>

            <button
              type="button"
              className={`tb-switch uem-switch ${changePassword ? 'is-on' : ''}`}
              onClick={() => {
                const next = !changePassword;
                setChangePassword(next);
                // Never keep a typed password around after the toggle is turned
                // back off.
                if (!next) { setNewPassword(''); setConfirmPassword(''); }
              }}
              disabled={busy}
              aria-pressed={changePassword}
            >
              <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
              <span>Change Password</span>
            </button>

            {changePassword && (
              <>
                <div className="uem-row">
                  <label className="uem-label" htmlFor="usr-pw">New Password</label>
                  <span className="uem-colon" aria-hidden="true">:</span>
                  <div className="uem-field">
                    <input
                      id="usr-pw" type="password" className="uem-input" value={newPassword}
                      placeholder={`At least ${MIN_PASSWORD} characters`}
                      disabled={busy} autoComplete="new-password"
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                  </div>
                </div>
                <div className="uem-row">
                  <label className="uem-label" htmlFor="usr-pw2">Confirm Password</label>
                  <span className="uem-colon" aria-hidden="true">:</span>
                  <div className="uem-field">
                    <input
                      id="usr-pw2" type="password" className="uem-input" value={confirmPassword}
                      placeholder="Re-enter New Password"
                      disabled={busy} autoComplete="new-password"
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                  </div>
                </div>
              </>
            )}

          </div>

          <footer className="uem-foot">
            <button
              type="button" className="uem-btn uem-btn--ghost" onClick={onCancel} disabled={busy}
            >Cancel</button>
            <button
              type="submit" className="uem-btn uem-btn--primary"
              disabled={busy || !dirty}
              title={dirty ? undefined : 'Nothing has changed'}
            >{busy ? 'Updating…' : 'Update'}</button>
          </footer>
        </div>
      </form>
    </dialog>
  );
}

UserEditDrawer.propTypes = {
  user: PropTypes.shape({
    email: PropTypes.string.isRequired,
    firstName: PropTypes.string,
    lastName: PropTypes.string,
    role: PropTypes.string,
  }).isRequired,
  onCancel: PropTypes.func.isRequired,
  /** Called with { message, passwordChanged } after a successful save. */
  onSaved: PropTypes.func.isRequired,
};
