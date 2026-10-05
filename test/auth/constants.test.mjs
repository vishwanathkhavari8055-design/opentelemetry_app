/**
 * Guards the invariants of the auth vocabulary that other code assumes.
 *
 * Every role the SSO map can produce must have a label and a permission entry,
 * or a successful sign-in lands on an unlabelled, powerless session. The
 * operator's list must never hold a configuration grant or the wildcard. The
 * footer copyright is derived from the company name, not typed twice.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_PERMISSIONS,
  APP_META,
  PERMISSION_MATRIX,
  PERMISSIONS,
  ROLE_LABELS,
  ROLES,
  SSO_ROLE_MAP,
} from '../../src/auth/constants.js';

describe('auth constants', () => {
  it('maps every SSO role onto a role that has a label and permissions', () => {
    for (const [ssoRole, role] of Object.entries(SSO_ROLE_MAP)) {
      assert.ok(ROLE_LABELS[role], `${ssoRole} → ${role} has a label`);
      assert.ok(PERMISSION_MATRIX[role], `${ssoRole} → ${role} has permissions`);
    }
  });

  it('keeps the operator free of the wildcard and every configure/manage-users grant', () => {
    const operator = PERMISSION_MATRIX[ROLES.OPERATOR];
    assert.equal(operator.includes(ALL_PERMISSIONS), false);
    for (const p of operator) assert.ok(Object.values(PERMISSIONS).includes(p), `${p} is in the vocabulary`);
    assert.equal(operator.some((p) => /:configure$|^users:|^permissions:|^organizations:/.test(p)), false);
    assert.deepEqual(PERMISSION_MATRIX[ROLES.ADMIN], [ALL_PERMISSIONS]);
  });

  it('builds the copyright from the company name', () => {
    assert.equal(APP_META.COPYRIGHT, `© 2026 ${APP_META.COMPANY}. All rights reserved.`);
  });
});
