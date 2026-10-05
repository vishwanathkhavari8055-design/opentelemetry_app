/**
 * The two screens the session state is rendered on: SsoLanding (in flight,
 * failed, signed out) and UserMenu (the signed-in identity and Sign out).
 *
 * Driven through the real AuthContext.Provider with a hand-built value, so the
 * states the built-in SSO mock can never produce — a slow exchange, a network
 * failure, the frame between states — are reachable too. The full hand-off is
 * covered by AuthContext.test.mjs.
 *
 * What is guarded, and why:
 *  - A fast hand-off shows NOTHING; only a slow one shows the splash, so a
 *    portal link lands on Home without passing through a login-looking page.
 *  - Each failure cause gets its own next step (retry for an outage, the
 *    portal for an expired session), and "Try again" calls retry.
 *  - UserMenu hides a role badge that only repeats the display name but keeps
 *    it for a name that says nothing of the role; the popover always states
 *    the role and access, and Sign out calls logout and closes it.
 */
import '../../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { default: AuthContext } = await import('../../../../../src/auth/AuthContext.jsx');
const { AUTH_ERRORS } = await import('../../../../../src/auth/authService.js');
const { default: SsoLanding } = await import('../../../../../src/components/auth/SsoLanding.jsx');
const { default: UserMenu } = await import('../../../../../src/components/auth/UserMenu.jsx');

const h = React.createElement;

afterEach(cleanup);

/** A context value shaped like AuthProvider's, with a call log. */
function authValue(overrides = {}) {
  const calls = [];
  const value = {
    status: 'UNAUTHENTICATED',
    isInitializing: false,
    isAuthenticated: false,
    isSubmitting: false,
    user: null,
    role: null,
    tenantCode: '',
    error: null,
    signedOut: false,
    sso: { role: '', tenantCode: '', refKey: '', lang: '' },
    retry: () => calls.push('retry'),
    logout: () => calls.push('logout'),
    clearError: () => calls.push('clearError'),
    can: () => false,
    ...overrides,
  };
  return { value, calls };
}

const withAuth = (value, child) => h(AuthContext.Provider, { value }, child);

describe('SsoLanding', () => {
  it('shows nothing during a fast hand-off, and a splash only once it drags', async () => {
    const { value } = authValue({ isInitializing: true });
    const { container, rerender } = render(withAuth(value, h(SsoLanding)));
    assert.equal(container.innerHTML, '');
    const splash = await screen.findByRole('status', {}, { timeout: 2000 });
    assert.match(splash.textContent, /Opening your workspace…/);
    // Validation ends: the splash goes with it.
    rerender(withAuth(authValue({ error: { code: AUTH_ERRORS.NETWORK, message: 'Could not reach the sign-in service.' } }).value, h(SsoLanding)));
    assert.equal(screen.queryByText('Opening your workspace…') === null, true);
  });

  it('treats an outage as temporary and retries on request', () => {
    const { value, calls } = authValue({
      error: { code: AUTH_ERRORS.SERVICE_UNAVAILABLE, message: 'The sign-in service is unavailable.' },
      sso: { role: 'admin', tenantCode: 'Primary', refKey: '', lang: '' },
    });
    render(withAuth(value, h(SsoLanding)));
    assert.match(screen.getByRole('alert').textContent, /sign-in service is unavailable/);
    assert.ok(screen.getByText(/usually temporary/));
    // Only the context the link carried is listed.
    assert.ok(screen.getByText('Tenant'));
    assert.equal(screen.queryByText('Reference') === null, true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    assert.deepEqual(calls, ['retry']);
  });

  it('gives each failure cause its own next step', () => {
    const cases = [
      [AUTH_ERRORS.SSO_REJECTED, /Sign in to the portal again/],
      [AUTH_ERRORS.SESSION_EXPIRED, /start a new session/],
      [AUTH_ERRORS.UNKNOWN, /Try again, or reopen the application/],
    ];
    for (const [code, hint] of cases) {
      render(withAuth(authValue({ error: { code, message: `failed: ${code}`, details: { missing: ['lang'] } } }).value, h(SsoLanding)));
      assert.ok(screen.getByText(hint), code);
      // A key without a friendly label is shown as-is.
      assert.equal(screen.getByText(/Missing from the link/).querySelector('code').textContent, 'lang');
      cleanup();
    }
  });

  it('keeps the card from rendering empty between states', () => {
    render(withAuth(authValue().value, h(SsoLanding)));
    assert.match(screen.getByRole('status').textContent, /Opening your workspace…/);
    assert.equal(screen.queryByRole('button') === null, true);
  });
});

describe('UserMenu', () => {
  const ADMIN = {
    id: 'sso_k1', username: 'qgit6fmspn7ebu', role: 'ADMIN', roleLabel: 'Administrator',
    displayName: 'Administrator', email: '', tenantCode: 'Primary',
  };
  const OPERATOR = {
    id: 'u2', username: 'vishwa.vittal', role: 'OPERATOR', roleLabel: 'Operator',
    displayName: 'Vishwa Vittal', email: 'v@example.com', tenantCode: 'Primary',
  };

  it('renders nothing without a signed-in user', () => {
    const { container } = render(withAuth(authValue().value, h(UserMenu)));
    assert.equal(container.innerHTML, '');
  });

  it('drops a badge that repeats the name, and still states the role in the popover', () => {
    const { value } = authValue({ user: ADMIN, role: 'ADMIN' });
    render(withAuth(value, h(UserMenu)));
    assert.equal(screen.queryByTitle('Full access') === null, true);
    const chip = screen.getByRole('button', { name: 'Account menu for Administrator' });
    assert.equal(chip.getAttribute('title'), 'Administrator — Full access');
    assert.match(chip.textContent, /^A/);
    fireEvent.click(chip);
    const menu = screen.getByRole('menu');
    assert.match(menu.textContent, /@qgit6fmspn7ebu/);
    assert.match(menu.textContent, /Administrator · Full access/);
    // The brand is a plain image without an onHome handler.
    assert.equal(screen.queryByRole('button', { name: 'Go to Home' }) === null, true);
  });

  it('keeps the badge for a name that says nothing of the role, and signs out', () => {
    const { value, calls } = authValue({ user: OPERATOR, role: 'OPERATOR' });
    let home = 0;
    render(withAuth(value, h(UserMenu, { onHome: () => { home += 1; }, actions: h('span', null, 'org picker') })));
    const badge = screen.getByTitle('Read-only access');
    assert.equal(badge.textContent, 'Operator');
    assert.ok(screen.getByText('org picker'));
    fireEvent.click(screen.getByRole('button', { name: 'Go to Home' }));
    assert.equal(home, 1);

    const chip = screen.getByRole('button', { name: 'Account menu for Vishwa Vittal' });
    assert.match(chip.textContent, /^VV/);
    fireEvent.click(chip);
    assert.equal(chip.getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText('v@example.com'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    assert.deepEqual(calls, ['logout']);
    assert.equal(screen.queryByRole('menu') === null, true);
  });

  it('closes the popover on Escape and on a click outside, but not inside', () => {
    const { value } = authValue({ user: OPERATOR, role: 'OPERATOR' });
    render(h('div', null, h('p', null, 'page'), withAuth(value, h(UserMenu, { variant: 'inline' }))));
    // Inline: identity only, no bar.
    assert.equal(document.querySelector('header.app-topbar') === null, true);
    const chip = screen.getByRole('button', { name: /Account menu/ });
    fireEvent.click(chip);
    fireEvent.keyDown(document, { key: 'Enter' });
    assert.ok(screen.getByRole('menu'));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('menu') === null, true);
    fireEvent.click(chip);
    fireEvent.mouseDown(screen.getByRole('menu'));
    assert.ok(screen.getByRole('menu'));
    fireEvent.mouseDown(screen.getByText('page'));
    assert.equal(screen.queryByRole('menu') === null, true);
  });

  it('shows "?" for a user with no display name and no badge without a role label', async () => {
    const { value } = authValue({ user: { ...OPERATOR, displayName: '   ', roleLabel: '' }, role: 'OPERATOR' });
    render(withAuth(value, h(UserMenu)));
    await waitFor(() => assert.ok(screen.getByText('?')));
    assert.equal(document.querySelector('.role-badge') === null, true);
  });
});
