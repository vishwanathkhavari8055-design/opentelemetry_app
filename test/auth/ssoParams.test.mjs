/**
 * Guards reading the portal's SSO hand-off off the URL.
 *
 * The URL is the only way into this app. Read too little and a valid portal
 * link lands on "open this from the portal"; read too much (a blank value, a
 * second copy of a parameter) and the request carries something the portal did
 * not send. The aliases, the fragment fallback and the first-value-wins rule
 * are what real portal links rely on, so each is asserted here.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import readSsoParamsDefault, { qualifyRole, readSsoParams, toSsoRequest } from '../../src/auth/ssoParams.js';

describe('readSsoParams', () => {
  it('reads the portal\'s sample link', () => {
    const p = readSsoParams({ search: '?role=superadministrator&tenantCode=Primary&lang=en&refKey=qgit6fmspn7ebu' });
    assert.deepEqual(p, {
      role: 'superadministrator',
      tenantCode: 'Primary',
      refKey: 'qgit6fmspn7ebu',
      lang: 'en',
      ssoUserName: '',
      ssoRoleName: 'Primary/superadministrator',
      present: true,
      valid: true,
      missing: [],
    });
  });

  it('matches names case-insensitively and through aliases', () => {
    const p = readSsoParams({ search: 'ROLENAME=operator&Tenant=acme&REF=k1&Locale=fr&UserName=jane.doe' });
    assert.equal(p.role, 'operator');
    assert.equal(p.tenantCode, 'acme');
    assert.equal(p.refKey, 'k1');
    assert.equal(p.lang, 'fr');
    assert.equal(p.ssoUserName, 'jane.doe');
  });

  it('reads the query out of a hash route, with the real query winning', () => {
    const p = readSsoParams({ search: '?role=admin', hash: '#/home?role=operator&tenantCode=t&refKey=r' });
    assert.equal(p.role, 'admin');
    assert.equal(p.tenantCode, 't');
    assert.equal(p.valid, true);
  });

  it('ignores a fragment with no query', () => {
    const p = readSsoParams({ search: '', hash: '#/traces' });
    assert.equal(p.present, false);
  });

  it('trims values and treats blanks as absent, so a later non-blank copy wins', () => {
    const p = readSsoParams({ search: '?role=%20%20&role=%20viewer%20&tenantCode=&tenant=x' });
    assert.equal(p.role, 'viewer');
    assert.equal(p.tenantCode, 'x');
  });

  it('accepts ssoUserName in place of refKey', () => {
    const p = readSsoParams({ search: '?role=admin&tenantCode=t&ssoUserName=bob' });
    assert.equal(p.valid, true);
    assert.deepEqual(p.missing, []);
  });

  it('reports a half-filled link as present but invalid, naming what is missing', () => {
    const p = readSsoParams({ search: '?lang=en&tenantCode=t' });
    assert.equal(p.present, true);
    assert.equal(p.valid, false);
    assert.deepEqual(p.missing, ['role', 'refKey']);
  });

  it('reports a cold open as not present', () => {
    const p = readSsoParams({ search: '?lang=en' });
    assert.equal(p.present, false);
    assert.deepEqual(p.missing, ['role', 'tenantCode', 'refKey']);
  });

  it('falls back to an empty location when there is no window', () => {
    assert.equal(typeof globalThis.window, 'undefined');
    const p = readSsoParams();
    assert.equal(p.valid, false);
    assert.equal(p.present, false);
  });

  it('is also the default export', () => {
    assert.equal(readSsoParamsDefault, readSsoParams);
  });
});

describe('qualifyRole', () => {
  it('prefixes a bare role with its tenant', () => {
    assert.equal(qualifyRole('administrator', 'smartDomain'), 'smartDomain/administrator');
  });

  it('leaves an already-qualified role alone', () => {
    assert.equal(qualifyRole('other/administrator', 'smartDomain'), 'other/administrator');
  });

  it('returns the bare role without a tenant and "" without a role', () => {
    assert.equal(qualifyRole(' admin ', '  '), 'admin');
    assert.equal(qualifyRole('', 't'), '');
    assert.equal(qualifyRole(null, null), '');
    assert.equal(qualifyRole(), '');
  });
});

describe('toSsoRequest', () => {
  it('sends the documented fields, with a null username when none was given', () => {
    assert.deepEqual(toSsoRequest({ tenantCode: 't', ssoRoleName: 't/admin' }), {
      ssoUserName: null, tenantCode: 't', ssoRoleName: 't/admin',
    });
  });

  it('carries refKey and lang in their own fields rather than as the username', () => {
    assert.deepEqual(
      toSsoRequest({ ssoUserName: 'bob', tenantCode: 't', ssoRoleName: 't/admin', refKey: 'k', lang: 'en' }),
      { ssoUserName: 'bob', tenantCode: 't', ssoRoleName: 't/admin', refKey: 'k', lang: 'en' },
    );
  });
});
