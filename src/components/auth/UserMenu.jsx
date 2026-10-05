/**
 * Authenticated top bar: product identity on the left, the signed-in user with
 * a role badge and a logout control on the right. Sits above the existing
 * TabBar; it doesn't touch the app's own navigation.
 *
 * Two shapes, same behaviour:
 *   variant="bar"    (default) the full sticky top bar — logo + identity.
 *   variant="inline"           only the identity cluster (badge + account
 *                              chip + popover), for hosting inside another
 *                              strip. Used on the Dashboard tab, where the top
 *                              bar is hidden to give the embedded dashboard the
 *                              whole viewport — the controls move into the tab
 *                              bar so Sign out is never out of reach.
 */
import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useAuth } from '../../auth/AuthContext';
import { usePermissions } from '../../auth/usePermissions';
// White-on-transparent mark, 150×24. It relies on the dark bar behind it —
// every opaque pixel in the file is white, so it would vanish on a light
// background. If a light theme is ever added, this needs a dark variant
// swapped in via prefers-color-scheme, not a CSS filter.
import logoUrl from '../../assets/logo.png';

/** Lowercased word tokens of a label — for redundancy comparison. */
function words(text = '') {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * True when the role label adds nothing next to the display name, i.e. every
 * word of the role already appears in the name:
 *   "Administrator"  + "Administrator"    → true  (identical)
 *   "Operator"       + "Trinity Operator" → true  (contained)
 *   "Operator"       + "Vishwa Vittal"    → false (name says nothing of the role)
 * Word-set (not substring) matching, so "Operator" doesn't spuriously match a
 * name like "Cooperator".
 */
function roleEchoesName(roleLabel, displayName) {
  const roleWords = words(roleLabel);
  if (!roleWords.length) return false;
  const nameWords = new Set(words(displayName));
  return roleWords.every((w) => nameWords.has(w));
}

/** First-letter avatar from a display name. */
function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts.at(-1)[0]).toUpperCase();
}

export default function UserMenu({ variant = 'bar', actions = null, onHome = null }) {
  const { user, logout } = useAuth();
  const { isAdmin } = usePermissions();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const accessLabel = isAdmin ? 'Full access' : 'Read-only access';

  // The badge and the chip can say the same thing twice — "ADMINISTRATOR  A
  // Administrator", "OPERATOR  T Trinity Operator" — because both built-in
  // accounts carry their role in their display name. Suppress the badge whenever
  // the name already states the role, rather than deleting it outright: a user
  // like "Vishwa Vittal" still gets the role cue. Nothing is lost when it's
  // hidden — the role stays on the chip's tooltip and in the account popover.
  const roleIsRedundant = roleEchoesName(user.roleLabel, user.displayName);

  const identity = (
    <div className="app-topbar-user" ref={menuRef}>
      {user.roleLabel && !roleIsRedundant && (
        <span
          className={`role-badge ${isAdmin ? 'role-badge--admin' : 'role-badge--operator'}`}
          title={accessLabel}
        >
          {user.roleLabel}
        </span>
      )}

      <button
        type="button"
        className="user-chip"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user.displayName}`}
        title={`${user.roleLabel} — ${accessLabel}`}
      >
        <span className="user-avatar" aria-hidden="true">
          {initials(user.displayName)}
        </span>
        <span className="user-chip-name">{user.displayName}</span>
        <span className="user-chip-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="user-popover" role="menu">
          <div className="user-popover-head">
            <span className="user-popover-name">{user.displayName}</span>
            <span className="user-popover-meta">@{user.username}</span>
            {user.email && <span className="user-popover-meta">{user.email}</span>}
            {/* Always here, so hiding the redundant badge never loses the role. */}
            <span className="user-popover-meta">
              {user.roleLabel} · {accessLabel}
            </span>
          </div>
          <div className="user-popover-divider" />
          <button
            type="button"
            className="user-popover-item user-popover-item--danger"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              logout();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );

  if (variant === 'inline') return identity;

  return (
    <header className="app-topbar">
      <div className="app-topbar-brand">
        {/* A real <button>, not a click handler on the <img>: the brand is a
            navigation control, so it has to be focusable and operable from the
            keyboard. The CSS strips the button chrome so it still reads as
            just the logo. Falls back to a plain image when no handler is
            supplied — the login page and auth splash have nowhere to go. */}
        {onHome ? (
          <button
            type="button"
            className="app-topbar-logo-btn"
            onClick={onHome}
            title="Go to Home"
            aria-label="Go to Home"
          >
            <img
              className="app-topbar-logo"
              src={logoUrl}
              alt="MONITOR — Logging and Monitoring Tool"
            />
          </button>
        ) : (
          <img
            className="app-topbar-logo"
            src={logoUrl}
            alt="MONITOR — Logging and Monitoring Tool"
          />
        )}
      </div>

      {/* Slot for global controls (the organization switcher). They belong
          inside this bar, to the LEFT of the identity cluster — wrapping
          <UserMenu> in another flex container instead would move the brand,
          because .app-shell > .app-topbar is a direct-child rule. */}
      {actions && <div className="app-topbar-actions">{actions}</div>}

      {identity}
    </header>
  );
}

UserMenu.propTypes = {
  /** "bar" = full sticky top bar; "inline" = identity cluster only. */
  variant: PropTypes.oneOf(['bar', 'inline']),
  /** Rendered in the bar's right cluster, before the identity. Ignored when
   *  variant is "inline" (there is no bar to place them in). */
  actions: PropTypes.node,
  /** Makes the logo a Home link. Omit to render it as a plain image. */
  onHome: PropTypes.func,
};
