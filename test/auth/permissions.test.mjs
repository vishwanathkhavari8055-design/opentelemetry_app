/**
 * Guards the RBAC helpers every gate in the app calls.
 *
 * The operator is read-only except for alert triage, and that deny side is the
 * one that has to hold: a missing role, an unknown role or an empty permission
 * must answer "no", and nothing that writes configuration may leak to the
 * operator. The administrator's wildcard must pass permissions that do not
 * exist yet, so extending the vocabulary never locks them out.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  isAdmin,
  isOperator,
} from '../../src/auth/permissions.js';
import { PERMISSIONS, ROLES } from '../../src/auth/constants.js';

describe('hasPermission', () => {
  it('passes every check, including unknown permissions, for the administrator', () => {
    for (const p of Object.values(PERMISSIONS)) assert.equal(hasPermission(ROLES.ADMIN, p), true, p);
    assert.equal(hasPermission(ROLES.ADMIN, 'future:permission'), true);
  });

  it('grants the operator viewing and alert triage only', () => {
    assert.equal(hasPermission(ROLES.OPERATOR, PERMISSIONS.VIEW_LOGS), true);
    assert.equal(hasPermission(ROLES.OPERATOR, PERMISSIONS.MANAGE_ALERT_STATE), true);
    assert.equal(hasPermission(ROLES.OPERATOR, PERMISSIONS.EXPORT), true);
  });

  it('denies the operator configuration, IAM and the rules list', () => {
    for (const p of [PERMISSIONS.CONFIGURE_ALERTS, PERMISSIONS.VIEW_IAM, PERMISSIONS.VIEW_ALERT_RULES,
      PERMISSIONS.MANAGE_USERS, PERMISSIONS.ACCESS_SETTINGS, 'future:permission']) {
      assert.equal(hasPermission(ROLES.OPERATOR, p), false, p);
    }
  });

  it('denies a missing or unknown role and a missing permission', () => {
    assert.equal(hasPermission(undefined, PERMISSIONS.VIEW_LOGS), false);
    assert.equal(hasPermission('', PERMISSIONS.VIEW_LOGS), false);
    assert.equal(hasPermission('WIZARD', PERMISSIONS.VIEW_LOGS), false);
    assert.equal(hasPermission(ROLES.ADMIN, ''), false);
    assert.equal(hasPermission(ROLES.ADMIN, null), false);
  });
});

describe('hasAllPermissions / hasAnyPermission', () => {
  const mixed = [PERMISSIONS.VIEW_LOGS, PERMISSIONS.CONFIGURE_ALERTS];

  it('requires every permission for "all" and one for "any"', () => {
    assert.equal(hasAllPermissions(ROLES.OPERATOR, mixed), false);
    assert.equal(hasAnyPermission(ROLES.OPERATOR, mixed), true);
    assert.equal(hasAllPermissions(ROLES.ADMIN, mixed), true);
    assert.equal(hasAnyPermission('WIZARD', mixed), false);
  });

  it('treats an empty list the way every/some do', () => {
    assert.equal(hasAllPermissions(ROLES.OPERATOR), true);
    assert.equal(hasAnyPermission(ROLES.ADMIN), false);
  });
});

describe('isAdmin / isOperator', () => {
  it('matches the exact role name only', () => {
    assert.equal(isAdmin(ROLES.ADMIN), true);
    assert.equal(isAdmin('admin'), false);
    assert.equal(isAdmin(ROLES.OPERATOR), false);
    assert.equal(isOperator(ROLES.OPERATOR), true);
    assert.equal(isOperator(undefined), false);
  });
});
