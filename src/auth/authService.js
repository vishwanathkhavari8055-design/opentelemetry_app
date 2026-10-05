/**
 * Authentication service — the SINGLE seam between the UI and "the backend".
 *
 * There is no login form and no password anywhere in this app. The portal hands
 * the app an identity context on the URL (see ssoParams.js) and this module
 * exchanges it for a session by calling the "login by SSO" endpoint:
 *
 *   POST {SSO_CONFIG.ENDPOINT}
 *   { "ssoUserName": "yaseen.shariff",
 *     "tenantCode":  "smartDomain",
 *     "ssoRoleName": "smartDomain/administrator" }
 *
 * That endpoint fronts tiotSSO's `/sso-role-validation/validateRole`. It lives
 * on OUR backend rather than being called from the browser because the upstream
 * call carries a bearer token that must not ship in a JS bundle.
 *
 * ─── While the backend is being built ─────────────────────────────────────
 * `SSO_CONFIG.MOCK` (default ON) answers the call from `mockSsoResponse` below
 * instead of the network, so the landing → validate → role → app flow is fully
 * exercisable today. Set `VITE_SSO_MOCK=false` to go live; nothing else in the
 * app changes, because everything above this file only ever sees the normalised
 * `{ user, accessToken, refreshToken }` result.
 *
 * Security notes honoured here:
 *   • No credentials, tokens or bearer secrets are logged.
 *   • An unrecognised role is REFUSED, never defaulted to a readable one.
 */
import { ROLES, ROLE_LABELS, TOKEN_CONFIG, SSO_CONFIG, SSO_ROLE_MAP } from './constants';
import { issueToken, decodeToken, isTokenExpired } from './jwtService';
import { toSsoRequest } from './ssoParams';

/** Standard error codes so the UI can map to friendly copy without parsing text. */
export const AUTH_ERRORS = Object.freeze({
  /** The URL did not carry enough to ask the question. */
  MISSING_SSO_PARAMS: 'MISSING_SSO_PARAMS',
  /** The endpoint answered, and the answer was "no". */
  SSO_REJECTED: 'SSO_REJECTED',
  /** Validated fine, but the role it returned means nothing to this app. */
  UNKNOWN_ROLE: 'UNKNOWN_ROLE',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  NETWORK: 'NETWORK',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
});

/** Throwable shaped the way AuthContext expects. */
function authError(code, message, details = null) {
  return { code, message, details };
}

// ─────────────────────────────────────────────────────────────────────────────
// Role mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `smartDomain/administrator`, `Administrator`, `SUPER_ADMIN` → a role this app
 * knows, or null.
 *
 * <p>Null is a REFUSAL, not a default. An SSO deployment that invents a new
 * role name should land its users on "role not recognised" rather than quietly
 * granting them whichever role happened to be first in the list.</p>
 */
export function mapSsoRole(rawRole = '') {
  const tail = String(rawRole || '').split('/').pop() || '';
  const key = tail.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return null;
  if (SSO_ROLE_MAP[key]) return SSO_ROLE_MAP[key];
  // Loose fallback for spellings the map has not seen (`tenant_admin_user`,
  // `read-only-operator`). Admin is checked first so "adminoperator" cannot be
  // downgraded, and anything matching neither stays refused.
  if (key.includes('admin')) return ROLES.ADMIN;
  if (key.includes('operator') || key.includes('viewer') || key.includes('read')) {
    return ROLES.OPERATOR;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this identifier a person's name, or an opaque key?
 *
 * <p>`yaseen.shariff` is a name; `qgit6fmspn7ebu` is a reference key that only
 * the backend can resolve. Both arrive in the same field, and title-casing the
 * second one produces "Qgit6fmspn7ebu" in the top bar — a fake name, which is
 * worse than admitting the name is not known yet.</p>
 *
 * <p>The tell is digits: SSO usernames here are alphabetic words, optionally
 * separated by a dot, underscore or hyphen. Reference keys are random.</p>
 */
function looksLikeName(identifier = '') {
  return /^[a-z]+([._\-\s][a-z]+)*$/i.test(String(identifier).trim());
}

/** A display name from an SSO username: `yaseen.shariff` → `Yaseen Shariff`. */
function humanize(ssoUserName = '') {
  const parts = String(ssoUserName).split(/[._\-\s]+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

/** Build the public user profile carried through the app. */
function toPublicUser({ userId, username, role, displayName, email, tenantCode, lang }) {
  return {
    id: userId,
    username,
    role,
    roleLabel: ROLE_LABELS[role],
    // Endpoint's answer → the username when it IS a name → the role. Never a
    // title-cased reference key: until the backend resolves refKey to a real
    // user, "Administrator" is the truthful label. The raw identifier is still
    // on the account popover as @username, so nothing is hidden.
    displayName: displayName
      || (looksLikeName(username) ? humanize(username) : '')
      || ROLE_LABELS[role],
    email: email || '',
    /** Which tenant the portal signed this session in for. */
    tenantCode: tenantCode || '',
    /** Portal UI language, carried for future localisation. */
    lang: lang || '',
  };
}

/** Mint an access + refresh token pair. Claims are self-contained, so a session
 *  can be rebuilt from a token alone — there is no user table to look up. */
function mintTokens(user, nowSeconds) {
  const base = {
    sub: user.id,
    username: user.username,
    role: user.role,
    name: user.displayName,
    email: user.email,
    tenant: user.tenantCode,
    lang: user.lang,
  };
  return {
    accessToken: issueToken({ ...base, type: 'access' }, nowSeconds, TOKEN_CONFIG.ACCESS_TTL_SECONDS),
    refreshToken: issueToken({ ...base, type: 'refresh' }, nowSeconds, TOKEN_CONFIG.REFRESH_TTL_SECONDS),
  };
}

/** Rebuild the profile a token was minted from. */
function userFromClaims(claims) {
  if (!claims?.role || !ROLE_LABELS[claims.role]) return null;
  return toPublicUser({
    userId: claims.sub,
    username: claims.username,
    role: claims.role,
    displayName: claims.name,
    email: claims.email,
    tenantCode: claims.tenant,
    lang: claims.lang,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The "login by SSO" call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ─── HARDCODED RESPONSE (development only) ────────────────────────────────
 *
 * Stands in for the endpoint until it exists. It echoes the role the URL asked
 * for, which is exactly what makes the two paths testable from the browser:
 *
 *   ?role=superadministrator&tenantCode=Primary&refKey=…  → Administrator UI
 *   ?role=operator&tenantCode=Primary&refKey=…            → Operator UI
 *   ?role=wizard&tenantCode=Primary&refKey=…              → refused
 *
 * Delete this function and flip VITE_SSO_MOCK=false once the backend is up.
 */
function mockSsoResponse(request) {
  return {
    status: 'SUCCESS',
    valid: true,
    // Echoed, never invented. The URL identifies the user by refKey and only
    // the backend can resolve it to a username, so the mock leaves it null
    // rather than filling in a name that would then look real on screen.
    ssoUserName: request.ssoUserName || null,
    tenantCode: request.tenantCode,
    ssoRoleName: request.ssoRoleName,
    // Present so the shape matches what a real response is expected to carry;
    // the app maps whichever role field it finds.
    role: String(request.ssoRoleName || '').split('/').pop(),
    userId: null,
    displayName: null,
    email: null,
  };
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** POST the request, with a timeout and no credential of its own. */
async function postSso(request, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSO_CONFIG.TIMEOUT_MS);
  // Caller-supplied abort (component unmount) also stops the request.
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(SSO_CONFIG.ENDPOINT, {
      method: 'POST',
      headers: { accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body — handled below */ }

    if (!res.ok) {
      // 401/403 is a decision ("you may not enter"); 5xx is an outage. They read
      // very differently on the landing page, so they are not collapsed.
      const rejected = res.status === 401 || res.status === 403 || res.status === 400;
      throw authError(
        rejected ? AUTH_ERRORS.SSO_REJECTED : AUTH_ERRORS.SERVICE_UNAVAILABLE,
        body?.message
          || (rejected
            ? 'Your portal session is not authorised for this application.'
            : 'The sign-in service is unavailable. Please try again.'),
        { status: res.status },
      );
    }
    return body || {};
  } catch (err) {
    if (err?.code) throw err; // already one of ours
    throw authError(
      AUTH_ERRORS.NETWORK,
      controller.signal.aborted && !signal?.aborted
        ? 'The sign-in service did not respond in time.'
        : 'Could not reach the sign-in service.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Read the role out of whatever shape the endpoint answers with.
 * Checked in order of specificity; `data` / `result` wrappers are unwrapped.
 */
function readResponseRole(body) {
  const d = body?.data || body?.result || body;
  return d?.role || d?.ssoRoleName || d?.roleName || d?.userRole || '';
}

/** Did the endpoint say yes? Absent flags count as yes on a 2xx. */
function isAffirmative(body) {
  const d = body?.data || body?.result || body;
  if (d?.valid === false || d?.isValid === false || d?.authorized === false) return false;
  const status = String(d?.status || body?.status || '').toUpperCase();
  return !['FAIL', 'FAILED', 'FAILURE', 'ERROR', 'DENIED', 'INVALID'].includes(status);
}

/**
 * Exchange the URL's SSO context for a session.
 *
 * @param {{params: object, nowSeconds: number, signal?: AbortSignal}} args
 *        `params` is the object from readSsoParams()
 * @returns {Promise<{user, accessToken, refreshToken, raw}>}
 * @throws {{code, message, details}}
 */
export async function loginBySso({ params, nowSeconds, signal }) {
  if (!params?.valid) {
    throw authError(
      AUTH_ERRORS.MISSING_SSO_PARAMS,
      'This application must be opened from the portal.',
      { missing: params?.missing || ['role', 'tenantCode', 'refKey'] },
    );
  }

  const request = toSsoRequest(params);

  let body;
  if (SSO_CONFIG.MOCK) {
    await delay(SSO_CONFIG.MOCK_DELAY_MS);
    body = mockSsoResponse(request);
  } else {
    body = await postSso(request, signal);
  }

  if (!isAffirmative(body)) {
    throw authError(
      AUTH_ERRORS.SSO_REJECTED,
      body?.message || 'Your portal session is not authorised for this application.',
    );
  }

  // The endpoint's role wins; the URL's role is only the request. A backend that
  // downgrades a caller must not be overridden by what the link claimed.
  const resolved = body?.data || body?.result || body;
  const rawRole = readResponseRole(body) || params.ssoRoleName;
  const role = mapSsoRole(rawRole);
  if (!role) {
    throw authError(
      AUTH_ERRORS.UNKNOWN_ROLE,
      `Role “${rawRole}” is not recognised by this application.`,
      { rawRole },
    );
  }

  const username = resolved?.ssoUserName || params.ssoUserName || params.refKey;
  const user = toPublicUser({
    userId: resolved?.userId || resolved?.id || `sso_${username}`,
    username,
    role,
    displayName: resolved?.displayName || resolved?.fullName || resolved?.name,
    email: resolved?.email,
    tenantCode: resolved?.tenantCode || params.tenantCode,
    lang: params.lang,
  });

  return { user, ...mintTokens(user, nowSeconds), raw: body };
}

/**
 * Renew the session from a still-valid refresh token.
 *
 * <p>Self-contained: the claims carry the whole profile, so this needs no user
 * store and no second SSO round trip. When the backend grows a real refresh
 * endpoint, this function is where it goes.</p>
 *
 * @returns {Promise<{accessToken, refreshToken, user}>}
 * @throws {{code, message}}
 */
export async function refresh({ refreshToken, nowSeconds }) {
  const claims = decodeToken(refreshToken);
  if (!claims || claims.type !== 'refresh' || isTokenExpired(refreshToken, nowSeconds)) {
    throw authError(AUTH_ERRORS.SESSION_EXPIRED, 'Your session has expired.');
  }
  const user = userFromClaims(claims);
  if (!user) throw authError(AUTH_ERRORS.SESSION_EXPIRED, 'Your session has expired.');
  return { ...mintTokens(user, nowSeconds), user };
}

/**
 * Reconstruct a user profile from a still-valid access token (cold-start
 * restore, before any network call).
 * @returns {object | null}
 */
export function userFromAccessToken(accessToken, nowSeconds) {
  const claims = decodeToken(accessToken);
  if (!claims || isTokenExpired(accessToken, nowSeconds)) return null;
  return userFromClaims(claims);
}
