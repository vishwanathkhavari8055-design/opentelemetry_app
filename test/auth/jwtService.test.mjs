/**
 * Guards the development token service.
 *
 * Every session decision in the app — restore on reload, silent refresh, the
 * redirect to the landing page — reads a token through these four functions.
 * The failure that matters is fail-OPEN: a malformed or tampered token that
 * decodes as valid, or one with no `exp` that never expires. So the malformed
 * shapes are asserted to read as expired/invalid, and the expiry boundary is
 * asserted at the exact second.
 *
 * Time is always passed in (nowSeconds), so nothing here reads the clock.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeToken,
  isTokenExpired,
  issueToken,
  secondsUntilExpiry,
  verifyToken,
} from '../../src/auth/jwtService.js';
import { TOKEN_CONFIG } from '../../src/auth/constants.js';

const NOW = 1_790_000_000;

describe('issueToken / decodeToken', () => {
  it('round-trips the claims and stamps iss, iat and exp', () => {
    const token = issueToken({ sub: 'u1', role: 'ADMIN', type: 'access' }, NOW, 900);
    assert.equal(token.split('.').length, 3);
    assert.deepEqual(decodeToken(token), {
      sub: 'u1', role: 'ADMIN', type: 'access', iss: TOKEN_CONFIG.ISSUER, iat: NOW, exp: NOW + 900,
    });
  });

  it('is URL-safe and survives non-ASCII claims', () => {
    const token = issueToken({ name: 'Zoë Ångström — 東京', pad: '?>?>' }, NOW, 60);
    assert.doesNotMatch(token, /[+/=]/);
    assert.equal(decodeToken(token).name, 'Zoë Ångström — 東京');
  });

  it('lets the payload not override the issuer or timestamps', () => {
    const claims = decodeToken(issueToken({ iss: 'evil', exp: 1 }, NOW, 60));
    assert.equal(claims.iss, TOKEN_CONFIG.ISSUER);
    assert.equal(claims.exp, NOW + 60);
  });

  it('returns null for anything that is not a three-part decodable token', () => {
    for (const bad of [null, undefined, '', 42, {}, 'a.b', 'a.b.c.d', 'x.!!!notbase64.y', 'x.bm90LWpzb24.y']) {
      assert.equal(decodeToken(bad), null, String(bad));
    }
  });
});

describe('verifyToken', () => {
  it('accepts a token as issued', () => {
    assert.equal(verifyToken(issueToken({ sub: 'a' }, NOW, 60)), true);
  });

  it('rejects a token whose payload was swapped', () => {
    const a = issueToken({ role: 'OPERATOR' }, NOW, 60).split('.');
    const b = issueToken({ role: 'ADMIN' }, NOW, 60).split('.');
    assert.equal(verifyToken(`${a[0]}.${b[1]}.${a[2]}`), false);
  });

  it('rejects non-strings and the wrong number of segments', () => {
    assert.equal(verifyToken(null), false);
    assert.equal(verifyToken(123), false);
    assert.equal(verifyToken('a.b'), false);
  });
});

describe('isTokenExpired / secondsUntilExpiry', () => {
  const token = issueToken({ sub: 'a' }, NOW, 100);

  it('is live one second before exp and expired at exp exactly', () => {
    assert.equal(isTokenExpired(token, NOW + 99), false);
    assert.equal(isTokenExpired(token, NOW + 100), true);
    assert.equal(isTokenExpired(token, NOW + 101), true);
  });

  it('counts down to zero and never goes negative', () => {
    assert.equal(secondsUntilExpiry(token, NOW), 100);
    assert.equal(secondsUntilExpiry(token, NOW + 40), 60);
    assert.equal(secondsUntilExpiry(token, NOW + 500), 0);
  });

  it('fails closed on a malformed token or one without a numeric exp', () => {
    const header = 'eyJhbGciOiJIUzI1NiJ9';
    const noExp = `${header}.${Buffer.from(JSON.stringify({ exp: 'never' })).toString('base64url')}.sig`;
    for (const bad of ['garbage', null, noExp]) {
      assert.equal(isTokenExpired(bad, NOW), true);
      assert.equal(secondsUntilExpiry(bad, NOW), 0);
    }
  });
});
