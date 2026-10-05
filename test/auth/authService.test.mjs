/**
 * Guards the SSO → session exchange as it runs today (mock endpoint on).
 *
 * Two things here are security decisions rather than conveniences:
 *  - an unrecognised role is REFUSED, never defaulted to a readable one, and
 *    the loose fallback checks "admin" before "operator" so nothing downgrades
 *    by accident — or upgrades: "wizard" stays refused;
 *  - a session is rebuilt from a token only when the token is the right TYPE
 *    and not expired, so an access token can never be replayed as a refresh.
 *
 * The display-name rule is also pinned: a reference key must never be
 * title-cased into a fake person's name in the top bar.
 *
 * Time is passed in as nowSeconds; the clock is never read. The live network
 * path is in authServiceLive.test.mjs.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTH_ERRORS,
  loginBySso,
  mapSsoRole,
  refresh,
  userFromAccessToken,
} from '../../src/auth/authService.js';
import { readSsoParams } from '../../src/auth/ssoParams.js';
import { decodeToken, issueToken } from '../../src/auth/jwtService.js';
import { ROLES, SSO_CONFIG, TOKEN_CONFIG } from '../../src/auth/constants.js';

const NOW = 1_790_000_000;
const params = (search) => readSsoParams({ search });

describe('mapSsoRole', () => {
  it('maps the listed roles, ignoring tenant prefix, case and punctuation', () => {
    assert.equal(mapSsoRole('smartDomain/administrator'), ROLES.ADMIN);
    assert.equal(mapSsoRole('SUPER_ADMIN'), ROLES.ADMIN);
    assert.equal(mapSsoRole('Read-Only'), ROLES.OPERATOR);
    assert.equal(mapSsoRole('user'), ROLES.OPERATOR);
  });

  it('falls back loosely, checking admin before operator', () => {
    assert.equal(mapSsoRole('tenant_admin_user'), ROLES.ADMIN);
    assert.equal(mapSsoRole('admin-operator'), ROLES.ADMIN);
    assert.equal(mapSsoRole('read-only-operator'), ROLES.OPERATOR);
    assert.equal(mapSsoRole('dashboard viewer'), ROLES.OPERATOR);
  });

  it('refuses anything unrecognised or empty', () => {
    for (const raw of ['wizard', '', null, undefined, 'tenant/', '---']) {
      assert.equal(mapSsoRole(raw), null, String(raw));
    }
    assert.equal(mapSsoRole(), null);
  });
});

describe('loginBySso (mock endpoint)', () => {
  it('is running against the mock in this environment', () => {
    assert.equal(SSO_CONFIG.MOCK, true);
  });

  it('refuses a link without the SSO parameters, naming what is missing', async () => {
    await assert.rejects(loginBySso({ params: params('?role=admin'), nowSeconds: NOW }), {
      code: AUTH_ERRORS.MISSING_SSO_PARAMS,
      details: { missing: ['tenantCode', 'refKey'] },
    });
    await assert.rejects(loginBySso({ params: undefined, nowSeconds: NOW }), {
      code: AUTH_ERRORS.MISSING_SSO_PARAMS,
      details: { missing: ['role', 'tenantCode', 'refKey'] },
    });
  });

  it('signs an administrator in from the portal\'s sample link', async () => {
    const out = await loginBySso({
      params: params('?role=superadministrator&tenantCode=Primary&lang=en&refKey=qgit6fmspn7ebu'),
      nowSeconds: NOW,
    });
    assert.deepEqual(out.user, {
      id: 'sso_qgit6fmspn7ebu',
      username: 'qgit6fmspn7ebu',
      role: ROLES.ADMIN,
      roleLabel: 'Administrator',
      // A reference key is not a name: the role label stands in.
      displayName: 'Administrator',
      email: '',
      tenantCode: 'Primary',
      lang: 'en',
    });
    assert.equal(out.raw.ssoRoleName, 'Primary/superadministrator');
    assert.equal(out.raw.ssoUserName, null);

    const access = decodeToken(out.accessToken);
    assert.equal(access.type, 'access');
    assert.equal(access.role, ROLES.ADMIN);
    assert.equal(access.tenant, 'Primary');
    assert.equal(access.exp, NOW + TOKEN_CONFIG.ACCESS_TTL_SECONDS);
    const refreshClaims = decodeToken(out.refreshToken);
    assert.equal(refreshClaims.type, 'refresh');
    assert.equal(refreshClaims.exp, NOW + TOKEN_CONFIG.REFRESH_TTL_SECONDS);
  });

  it('humanises a username that is a name', async () => {
    const out = await loginBySso({ params: params('?role=operator&tenantCode=t&ssoUserName=yaseen.shariff'), nowSeconds: NOW });
    assert.equal(out.user.role, ROLES.OPERATOR);
    assert.equal(out.user.displayName, 'Yaseen Shariff');
    assert.equal(out.user.username, 'yaseen.shariff');
    assert.equal(out.user.lang, '');
  });

  it('refuses a role this app does not know', async () => {
    await assert.rejects(loginBySso({ params: params('?role=wizard&tenantCode=t&refKey=k'), nowSeconds: NOW }), (err) => {
      assert.equal(err.code, AUTH_ERRORS.UNKNOWN_ROLE);
      assert.deepEqual(err.details, { rawRole: 'wizard' });
      assert.match(err.message, /wizard/);
      return true;
    });
  });
});

describe('refresh', () => {
  const claims = { sub: 'u1', username: 'jane.doe', role: ROLES.OPERATOR, name: '', email: 'j@x', tenant: 't', lang: 'en' };

  it('mints a fresh pair from a live refresh token, keeping the profile', async () => {
    const token = issueToken({ ...claims, type: 'refresh' }, NOW, 100);
    const later = NOW + 50;
    const out = await refresh({ refreshToken: token, nowSeconds: later });
    assert.equal(out.user.id, 'u1');
    assert.equal(out.user.displayName, 'Jane Doe');
    assert.equal(out.user.email, 'j@x');
    assert.equal(decodeToken(out.accessToken).iat, later);
    assert.equal(decodeToken(out.refreshToken).type, 'refresh');
  });

  it('refuses an expired, malformed or wrong-type token', async () => {
    const expired = issueToken({ ...claims, type: 'refresh' }, NOW, 100);
    const access = issueToken({ ...claims, type: 'access' }, NOW, 100);
    for (const refreshToken of [expired, access, 'garbage', null]) {
      const nowSeconds = refreshToken === expired ? NOW + 100 : NOW;
      await assert.rejects(refresh({ refreshToken, nowSeconds }), { code: AUTH_ERRORS.SESSION_EXPIRED });
    }
  });

  it('refuses a token whose role the app no longer knows', async () => {
    const token = issueToken({ ...claims, role: 'WIZARD', type: 'refresh' }, NOW, 100);
    await assert.rejects(refresh({ refreshToken: token, nowSeconds: NOW }), { code: AUTH_ERRORS.SESSION_EXPIRED });
  });
});

describe('userFromAccessToken', () => {
  it('rebuilds the profile from a live token, preferring its name claim', () => {
    const token = issueToken({ sub: 'u', username: 'x9', role: ROLES.ADMIN, name: 'Real Name' }, NOW, 60);
    const user = userFromAccessToken(token, NOW);
    assert.equal(user.displayName, 'Real Name');
    assert.equal(user.roleLabel, 'Administrator');
    assert.equal(user.tenantCode, '');
  });

  it('returns null for an expired, malformed or role-less token', () => {
    const token = issueToken({ sub: 'u', role: ROLES.ADMIN }, NOW, 60);
    assert.equal(userFromAccessToken(token, NOW + 60), null);
    assert.equal(userFromAccessToken('nope', NOW), null);
    assert.equal(userFromAccessToken(issueToken({ sub: 'u' }, NOW, 60), NOW), null);
  });
});
