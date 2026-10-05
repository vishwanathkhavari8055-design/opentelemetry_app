/**
 * usePermissions is how every screen hides or disables an action, so its answer
 * for each role is the RBAC model as the user experiences it:
 *
 *  - the administrator passes every check, including ones defined later;
 *  - the operator is read-only except alert triage (acknowledge/resolve), and
 *    `isReadOnly` is true for anyone who is not an admin — including no role;
 *  - the returned object and its functions keep their identity across renders
 *    while the role is unchanged, since components list them as effect deps.
 *
 * Rendered inside a bare AuthContext provider with a fixed role, so nothing of
 * the SSO exchange runs.
 */
import '../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { renderHook, cleanup } = await import('@testing-library/react');
const { default: AuthContext } = await import('../../src/auth/AuthContext.jsx');
const { usePermissions, useCan } = await import('../../src/auth/usePermissions.js');
const { PERMISSIONS, ROLES } = await import('../../src/auth/constants.js');

const withRole = (initialRole) => {
  const value = { current: { role: initialRole } };
  const wrapper = ({ children }) => React.createElement(AuthContext.Provider, { value: value.current }, children);
  return { wrapper, value };
};

const render = (hook, role) => {
  const { wrapper, value } = withRole(role);
  const utils = renderHook(hook, { wrapper });
  return {
    ...utils,
    setRole: (next) => { value.current = { role: next }; utils.rerender(); },
  };
};

describe('usePermissions', () => {
  afterEach(cleanup);

  it('gives the administrator everything', () => {
    const { result } = render(() => usePermissions(), ROLES.ADMIN);
    const p = result.current;
    assert.equal(p.role, ROLES.ADMIN);
    assert.equal(p.isAdmin, true);
    assert.equal(p.isOperator, false);
    assert.equal(p.isReadOnly, false);
    assert.equal(p.can(PERMISSIONS.CONFIGURE_ALERTS), true);
    assert.equal(p.can('some:future:permission'), true, 'the wildcard covers later additions');
    assert.equal(p.canAll([PERMISSIONS.MANAGE_USERS, PERMISSIONS.VIEW_IAM]), true);
    assert.equal(p.canAny([PERMISSIONS.DELETE_USERS]), true);
  });

  it('keeps the operator read-only apart from alert triage', () => {
    const { result } = render(() => usePermissions(), ROLES.OPERATOR);
    const p = result.current;
    assert.equal(p.isAdmin, false);
    assert.equal(p.isOperator, true);
    assert.equal(p.isReadOnly, true);
    assert.equal(p.can(PERMISSIONS.VIEW_LOGS), true);
    assert.equal(p.can(PERMISSIONS.MANAGE_ALERT_STATE), true);
    assert.equal(p.can(PERMISSIONS.CONFIGURE_ALERTS), false);
    assert.equal(p.can(PERMISSIONS.VIEW_IAM), false);
    assert.equal(p.canAll([PERMISSIONS.VIEW_LOGS, PERMISSIONS.CONFIGURE_ALERTS]), false);
    assert.equal(p.canAll([PERMISSIONS.VIEW_LOGS, PERMISSIONS.VIEW_TRACES]), true);
    assert.equal(p.canAny([PERMISSIONS.CONFIGURE_ALERTS, PERMISSIONS.VIEW_ALERTS]), true);
    assert.equal(p.canAny([PERMISSIONS.CONFIGURE_ALERTS, PERMISSIONS.MANAGE_USERS]), false);
  });

  it('treats a missing or unknown role as read-only with no grants', () => {
    for (const role of [null, 'AUDITOR']) {
      const { result } = render(() => usePermissions(), role);
      assert.equal(result.current.isReadOnly, true);
      assert.equal(result.current.isAdmin, false);
      assert.equal(result.current.isOperator, false);
      assert.equal(result.current.can(PERMISSIONS.VIEW_LOGS), false);
      assert.equal(result.current.canAny([PERMISSIONS.VIEW_LOGS]), false);
      cleanup();
    }
  });

  it('is referentially stable while the role is unchanged, and follows a change', () => {
    const { result, rerender, setRole } = render(() => usePermissions(), ROLES.OPERATOR);
    const first = result.current;
    rerender();
    assert.equal(result.current, first, 'same object across a re-render');
    assert.equal(result.current.can, first.can);

    setRole(ROLES.ADMIN);
    assert.notEqual(result.current, first);
    assert.notEqual(result.current.can, first.can);
    assert.equal(result.current.can(PERMISSIONS.CONFIGURE_ALERTS), true);
  });

  it('useCan answers a single permission', () => {
    const operator = render(() => useCan(PERMISSIONS.CONFIGURE_ALERTS), ROLES.OPERATOR);
    assert.equal(operator.result.current, false);
    operator.setRole(ROLES.ADMIN);
    assert.equal(operator.result.current, true);
  });

  it('fails loudly outside an AuthProvider', () => {
    // React re-throws render errors through jsdom's window, which would print
    // them; cancelling the event keeps the expected failure out of the output.
    const swallow = (event) => event.preventDefault();
    const silence = console.error;
    window.addEventListener('error', swallow);
    console.error = () => {};
    try {
      assert.throws(() => renderHook(() => usePermissions()), /must be used within an <AuthProvider>/);
    } finally {
      console.error = silence;
      window.removeEventListener('error', swallow);
    }
  });
});
