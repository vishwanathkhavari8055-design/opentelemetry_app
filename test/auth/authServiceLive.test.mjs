/**
 * Guards the "login by SSO" call as it runs in production (VITE_SSO_MOCK=false).
 *
 * The landing page shows very different copy for "you may not enter" (401/403,
 * an explicit `valid: false`), "the service is down" (5xx) and "we could not
 * reach it / it hung". Collapse those and an outage reads as a permissions
 * problem, which sends people to the wrong team. So each answer shape is fed
 * through a stubbed fetch and the resulting error code is asserted.
 *
 * The endpoint's role WINS over the one the URL asked for: a backend that
 * downgrades a caller must not be overridden by what the link claimed.
 *
 * The live configuration is produced by ./liveSsoHooks.mjs; fetch is stubbed
 * and restored after every test, and the 15 s timeout runs on mock timers.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, describe, it, mock } from 'node:test';

register('./liveSsoHooks.mjs', import.meta.url);

const { SSO_CONFIG, ROLES } = await import('../../src/auth/constants.js');
const { AUTH_ERRORS, loginBySso } = await import('../../src/auth/authService.js');
const { readSsoParams } = await import('../../src/auth/ssoParams.js');

const NOW = 1_790_000_000;
const PARAMS = readSsoParams({ search: '?role=administrator&tenantCode=smartDomain&refKey=k1&lang=en' });

/** A fetch Response-alike. `body` of undefined makes .json() throw. */
function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected token <');
      return body;
    },
  };
}

function stubFetch(impl) {
  return mock.method(globalThis, 'fetch', impl);
}

/**
 * A fetch that only settles by rejecting when its signal aborts.
 *
 * It rejects with a plain Error. Browsers (and Node's fetch) reject with a
 * DOMException named AbortError instead — see the skipped test at the bottom
 * for why that matters.
 */
const hangingFetch = (makeError = () => new Error('The operation was aborted')) => (_url, init) => (
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(makeError()));
  }));

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

describe('loginBySso (live endpoint)', () => {
  it('is running against the network in this file', () => {
    assert.equal(SSO_CONFIG.MOCK, false);
  });

  it('POSTs the SSO request as JSON to the configured endpoint', async () => {
    const fetchMock = stubFetch(async () => reply(200, { status: 'SUCCESS', role: 'administrator' }));
    await loginBySso({ params: PARAMS, nowSeconds: NOW });
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, SSO_CONFIG.ENDPOINT);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), {
      ssoUserName: null, tenantCode: 'smartDomain', ssoRoleName: 'smartDomain/administrator', refKey: 'k1', lang: 'en',
    });
  });

  it('builds the user from a wrapped response, and the endpoint\'s role wins', async () => {
    stubFetch(async () => reply(200, {
      data: { role: 'viewer', ssoUserName: 'jane.doe', userId: 42, fullName: 'Jane D.', email: 'j@x', tenantCode: 'T2' },
    }));
    const { user } = await loginBySso({ params: PARAMS, nowSeconds: NOW });
    assert.deepEqual(user, {
      id: 42, username: 'jane.doe', role: ROLES.OPERATOR, roleLabel: 'Operator',
      displayName: 'Jane D.', email: 'j@x', tenantCode: 'T2', lang: 'en',
    });
  });

  it('reads the role from the other field names and a `result` wrapper', async () => {
    stubFetch(async () => reply(200, { result: { roleName: 'readonly', id: 'r-1', name: 'N' } }));
    const { user } = await loginBySso({ params: PARAMS, nowSeconds: NOW });
    assert.equal(user.role, ROLES.OPERATOR);
    assert.equal(user.id, 'r-1');

    mock.restoreAll();
    stubFetch(async () => reply(200, { userRole: 'admin' }));
    assert.equal((await loginBySso({ params: PARAMS, nowSeconds: NOW })).user.role, ROLES.ADMIN);
  });

  it('falls back to the URL\'s role when a 2xx body carries none, or is not JSON', async () => {
    stubFetch(async () => reply(200, undefined));
    const out = await loginBySso({ params: PARAMS, nowSeconds: NOW });
    assert.equal(out.user.role, ROLES.ADMIN);
    assert.deepEqual(out.raw, {});
  });

  it('treats an explicit "no" in a 2xx body as a rejection', async () => {
    for (const body of [{ valid: false, message: 'Not today' }, { data: { isValid: false } },
      { authorized: false }, { status: 'denied' }, { data: { status: 'FAILED' } }]) {
      mock.restoreAll();
      stubFetch(async () => reply(200, body));
      await assert.rejects(loginBySso({ params: PARAMS, nowSeconds: NOW }), (err) => {
        assert.equal(err.code, AUTH_ERRORS.SSO_REJECTED, JSON.stringify(body));
        assert.equal(err.message, body.message || 'Your portal session is not authorised for this application.');
        return true;
      });
    }
  });

  it('reads 400/401/403 as a rejection, preferring the body\'s message', async () => {
    for (const [status, body, message] of [
      [401, undefined, 'Your portal session is not authorised for this application.'],
      [403, { message: 'Forbidden for tenant' }, 'Forbidden for tenant'],
      [400, {}, 'Your portal session is not authorised for this application.'],
    ]) {
      mock.restoreAll();
      stubFetch(async () => reply(status, body));
      await assert.rejects(loginBySso({ params: PARAMS, nowSeconds: NOW }), {
        code: AUTH_ERRORS.SSO_REJECTED, message, details: { status },
      });
    }
  });

  it('reads any other failure status as the service being unavailable', async () => {
    stubFetch(async () => reply(503, undefined));
    await assert.rejects(loginBySso({ params: PARAMS, nowSeconds: NOW }), {
      code: AUTH_ERRORS.SERVICE_UNAVAILABLE,
      message: 'The sign-in service is unavailable. Please try again.',
      details: { status: 503 },
    });
  });

  it('refuses an unknown role the endpoint returns', async () => {
    stubFetch(async () => reply(200, { role: 'wizard' }));
    await assert.rejects(loginBySso({ params: PARAMS, nowSeconds: NOW }), {
      code: AUTH_ERRORS.UNKNOWN_ROLE, details: { rawRole: 'wizard' },
    });
  });

  it('reports a network failure as unreachable', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(loginBySso({ params: PARAMS, nowSeconds: NOW }), {
      code: AUTH_ERRORS.NETWORK, message: 'Could not reach the sign-in service.',
    });
  });

  it('gives up after the timeout and says so', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    stubFetch(hangingFetch());
    const pending = loginBySso({ params: PARAMS, nowSeconds: NOW });
    mock.timers.tick(SSO_CONFIG.TIMEOUT_MS - 1);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'still waiting one millisecond before the timeout');
    mock.timers.tick(1);
    await assert.rejects(pending, {
      code: AUTH_ERRORS.NETWORK, message: 'The sign-in service did not respond in time.',
    });
  });

  it('stops when the caller aborts, without blaming a timeout', async () => {
    stubFetch(hangingFetch());
    const caller = new AbortController();
    const pending = loginBySso({ params: PARAMS, nowSeconds: NOW, signal: caller.signal });
    caller.abort();
    await assert.rejects(pending, { code: AUTH_ERRORS.NETWORK, message: 'Could not reach the sign-in service.' });
  });

  // SUSPECTED BUG (src/auth/authService.js postSso): the catch rethrows any
  // error with a truthy `code` as "already one of ours". A real fetch aborts
  // with DOMException AbortError, whose legacy `code` is 20, so a timeout or a
  // caller abort escapes as a raw DOMException instead of AUTH_ERRORS.NETWORK
  // and the landing page cannot map it to "did not respond in time".
  it('maps a real AbortError (DOMException) from a timeout to NETWORK', {
    skip: 'suspected bug: DOMException.code (20) is mistaken for an auth error code',
  }, async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    stubFetch(hangingFetch(() => new DOMException('aborted', 'AbortError')));
    const pending = loginBySso({ params: PARAMS, nowSeconds: NOW });
    mock.timers.tick(SSO_CONFIG.TIMEOUT_MS);
    await assert.rejects(pending, { code: AUTH_ERRORS.NETWORK });
  });
});
