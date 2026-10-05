/**
 * The portal hand-off, end to end: AuthProvider + AuthGate + SsoLanding, with
 * the SSO exchange answered by authService's built-in mock (the default until
 * the backend endpoint exists), so no network is involved.
 *
 * What is guarded, and why:
 *  - A complete portal link (?role&tenantCode&refKey) opens the app as the role
 *    the link carries; an unrecognised role is REFUSED, never defaulted.
 *  - A cold open, or a half-filled link, lands on a failure card that says
 *    which parameters were missing — "it's broken" vs. "the link needs X".
 *  - "Try again" re-reads the URL, so fixing the link and retrying signs in.
 *  - Sign-out says goodbye and does NOT sign straight back in from the URL
 *    still in the address bar; "Sign in again" does.
 *  - A reload without the URL context restores the session from storage (from
 *    the access token, or via the refresh token when access has expired).
 *  - The renewal timer: a near-expiry token is renewed silently, and an
 *    expired refresh token ends the session with a "session expired" notice.
 *  - RequirePermission hides admin-only children from the operator.
 */
import '../../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { AuthProvider, useAuth, AUTH_STATUS } = await import('../../../../../src/auth/AuthContext.jsx');
const { default: AuthGate } = await import('../../../../../src/auth/AuthGate.jsx');
const { default: RequirePermission } = await import('../../../../../src/auth/RequirePermission.jsx');
const { PERMISSIONS, STORAGE_KEYS, TOKEN_CONFIG } = await import('../../../../../src/auth/constants.js');
const { issueToken } = await import('../../../../../src/auth/jwtService.js');

const h = React.createElement;

const setUrl = (search = '', hash = '') => window.history.replaceState(null, '', `/${search}${hash}`);
const now = () => Math.floor(Date.now() / 1000);

/** What the protected app shows: who is signed in, and a sign-out control. */
function Inside() {
  const auth = useAuth();
  return h('div', null,
    h('p', null, `signed in as ${auth.role} for ${auth.tenantCode}`),
    h('p', null, `name ${auth.user.displayName}`),
    h('p', null, `can configure: ${auth.can(PERMISSIONS.CONFIGURE_ALERTS)}`),
    h(RequirePermission, { permission: PERMISSIONS.MANAGE_USERS, fallback: h('p', null, 'no user admin') },
      h('p', null, 'user admin')),
    h(RequirePermission, { anyOf: [PERMISSIONS.VIEW_LOGS, PERMISSIONS.MANAGE_USERS] }, h('p', null, 'any ok')),
    h(RequirePermission, { allOf: [PERMISSIONS.VIEW_LOGS, PERMISSIONS.MANAGE_USERS] }, h('p', null, 'all ok')),
    h('button', { type: 'button', onClick: auth.logout }, 'Log me out'),
    h('button', { type: 'button', onClick: auth.clearError }, 'Clear error'));
}

const mount = () => render(h(AuthProvider, null, h(AuthGate, null, h(Inside))));

/** A stored session, as a previous tab would have left it. */
function storeSession({ accessTtl = TOKEN_CONFIG.ACCESS_TTL_SECONDS, refreshTtl = TOKEN_CONFIG.REFRESH_TTL_SECONDS, role = 'OPERATOR', user } = {}) {
  const claims = { sub: 'u1', username: 'jane.doe', role, name: 'Jane Doe', tenant: 'Primary' };
  const t = now();
  if (accessTtl != null) sessionStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, issueToken({ ...claims, type: 'access' }, t, accessTtl));
  if (refreshTtl != null) sessionStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, issueToken({ ...claims, type: 'refresh' }, t, refreshTtl));
  if (user) sessionStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
}

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); setUrl(); });
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); setUrl(); });

describe('portal hand-off', () => {
  it('opens the app as the administrator the link names', async () => {
    setUrl('?role=superadministrator&tenantCode=Primary&refKey=qgit6fmspn7ebu&lang=en');
    mount();
    await screen.findByText('signed in as ADMIN for Primary');
    // A reference key is not a name: the role label stands in for it.
    assert.ok(screen.getByText('name Administrator'));
    assert.ok(screen.getByText('can configure: true'));
    assert.ok(screen.getByText('user admin'));
    assert.ok(screen.getByText('all ok'));
    // The session is tab-scoped.
    assert.ok(sessionStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN));
    assert.equal(localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN), null);
  });

  it('opens a read-only operator, with admin-only controls withheld', async () => {
    setUrl('?role=operator&tenantCode=Primary&ssoUserName=jane.doe');
    mount();
    await screen.findByText('signed in as OPERATOR for Primary');
    assert.ok(screen.getByText('name Jane Doe'));
    assert.ok(screen.getByText('can configure: false'));
    assert.ok(screen.getByText('no user admin'));
    assert.ok(screen.getByText('any ok'));
    assert.equal(screen.queryByText('all ok'), null);
  });

  it('refuses a role it does not recognise, with the tenant and role shown', async () => {
    setUrl('?role=wizard&tenantCode=Primary&refKey=abc&lang=en');
    mount();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /Role “wizard” is not recognised by this application/);
    assert.ok(screen.getByText(/map this role to Administrator or Operator/));
    assert.ok(screen.getByText('Tenant'));
    assert.ok(screen.getByText('wizard'));
    assert.ok(screen.getByText('Reference'));
    assert.ok(screen.getByText('Language'));
    assert.equal(screen.queryByText(/signed in as/), null);
    // "Clear error" is outside the gate, so this is the only way out: retry.
    assert.ok(screen.getByRole('button', { name: 'Try again' }));
  });

  it('tells a cold open to come from the portal, and lists what is missing', async () => {
    mount();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /must be opened from the portal/);
    const missing = screen.getByText(/Missing from the link/);
    assert.deepEqual([...missing.querySelectorAll('code')].map((c) => c.textContent), ['role', 'tenantCode', 'refKey']);
    assert.ok(screen.getByText(/Open it from your portal/));
  });

  it('calls a half-filled link incomplete, and signs in once the link is fixed', async () => {
    setUrl('?tenantCode=Primary');
    mount();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /missing part of your sign-in details/);
    assert.deepEqual([...screen.getByText(/Missing from the link/).querySelectorAll('code')].map((c) => c.textContent), ['role', 'refKey']);

    setUrl('?role=admin&tenantCode=Primary&refKey=k1');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('signed in as ADMIN for Primary');
  });

  it('says goodbye on sign-out, stays out, and signs in again on request', async () => {
    setUrl('?role=operator&tenantCode=Primary&refKey=k1');
    mount();
    await screen.findByText(/signed in as OPERATOR/);
    fireEvent.click(screen.getByRole('button', { name: 'Log me out' }));
    assert.ok(await screen.findByRole('heading', { name: 'You have signed out' }));
    assert.equal(sessionStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN), null);
    // The URL still carries the SSO context; nothing signs back in by itself.
    await new Promise((r) => { setTimeout(r, 20); });
    assert.equal(screen.queryByText(/signed in as/), null);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await screen.findByText(/signed in as OPERATOR/);
  });

  it('throws a developer error when useAuth is used outside the provider', () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.throws(() => render(h(Inside)), /useAuth must be used within an <AuthProvider>/);
    } finally {
      console.error = originalError;
    }
  });

  it('exposes the lifecycle states', () => {
    assert.deepEqual(Object.keys(AUTH_STATUS), ['INITIALIZING', 'AUTHENTICATED', 'UNAUTHENTICATED']);
  });
});

describe('stored session', () => {
  it('restores a live session on a reload without the URL context', async () => {
    storeSession();
    mount();
    await screen.findByText('signed in as OPERATOR for Primary');
    assert.ok(screen.getByText('name Jane Doe'));
  });

  it('renews through the refresh token when the access token has expired', async () => {
    storeSession({ accessTtl: -10 });
    const expiredAccess = sessionStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    mount();
    await screen.findByText('signed in as OPERATOR for Primary');
    assert.notEqual(sessionStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN), expiredAccess);
  });

  it('treats an unusable stored session as none', async () => {
    storeSession({ accessTtl: -10, refreshTtl: -10 });
    mount();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /must be opened from the portal/);
    assert.equal(sessionStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN), null, 'the dead session is cleared');
  });

  it('falls through when the refresh token names no role this app knows', async () => {
    storeSession({ accessTtl: -10, role: 'WIZARD' });
    mount();
    assert.match((await screen.findByRole('alert')).textContent, /must be opened from the portal/);
  });

  it('renews a nearly expired access token silently, before it lapses', async () => {
    // 30s left is inside the 60s renewal skew, so the timer fires at once.
    storeSession({ accessTtl: 30 });
    const original = sessionStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    mount();
    await screen.findByText('signed in as OPERATOR for Primary');
    await waitFor(() => assert.notEqual(sessionStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN), original));
    assert.ok(screen.getByText(/signed in as OPERATOR/));
  });

  it('ends the session with a notice when the refresh token has run out', async () => {
    storeSession({ accessTtl: 30, refreshTtl: -1 });
    mount();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /Your session has expired/);
    assert.ok(screen.getByText(/Reopen the application from the portal to start a new session/));
  });

  it('ends the session when renewal itself is refused', async () => {
    // A refresh "token" that is really an access token: valid and unexpired,
    // but refresh() rejects anything not typed as a refresh token.
    const t = now();
    const claims = { sub: 'u1', username: 'jane.doe', role: 'OPERATOR', name: 'Jane Doe', tenant: 'Primary' };
    sessionStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, issueToken({ ...claims, type: 'access' }, t, 30));
    sessionStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, issueToken({ ...claims, type: 'access' }, t, 3600));
    mount();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /Your session has expired\./);
  });
});
