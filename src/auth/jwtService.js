/**
 * MOCK JWT service — DEVELOPMENT ONLY.
 *
 * Produces structurally-valid, three-part (header.payload.signature) tokens so
 * the frontend can exercise a real JWT lifecycle (decode, expiry, refresh)
 * without a backend. The signature here is NOT cryptographically secure — it is
 * a deterministic stand-in. In production, tokens are minted and verified by
 * the identity provider; this file is swapped out entirely.
 *
 * Nothing sensitive (passwords) is ever placed in a token payload.
 */
import { TOKEN_CONFIG } from './constants';

/** URL-safe base64 of a UTF-8 string (handles non-ASCII safely). */
function base64UrlEncode(input) {
  const utf8 = new TextEncoder().encode(input);
  let binary = '';
  utf8.forEach((byte) => {
    binary += String.fromCodePoint(byte);
  });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); // `=` only ever appears as trailing padding
}

/** Inverse of base64UrlEncode → original string. */
function base64UrlDecode(input) {
  const padded = input.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
  const bytes = Uint8Array.from(binary, (ch) => ch.codePointAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Deterministic non-crypto "signature". Purely to give the token a third
 * segment and let us detect casual tampering in dev. Do not rely on this for
 * security — a real HMAC/RS256 signature replaces it in production.
 */
function fakeSign(headerB64, payloadB64) {
  const data = `${headerB64}.${payloadB64}.${TOKEN_CONFIG.ISSUER}`;
  let hash = 0;
  for (let i = 0; i < data.length; i += 1) {
    hash = (hash << 5) - hash + data.codePointAt(i);
    hash = Math.trunc(hash); // force 32-bit integer
  }
  return base64UrlEncode(`sig_${Math.abs(hash).toString(36)}`);
}

/**
 * Issue a mock JWT.
 * @param {object} payload  claims to embed (sub, username, role, type, ...)
 * @param {number} nowSeconds  current epoch seconds (passed in — no Date here)
 * @param {number} ttlSeconds  lifetime
 */
export function issueToken(payload, nowSeconds, ttlSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const fullPayload = {
    ...payload,
    iss: TOKEN_CONFIG.ISSUER,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = fakeSign(headerB64, payloadB64);
  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Decode a token's payload without verifying the signature.
 * @returns {object | null} claims, or null if the token is malformed.
 */
export function decodeToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

/**
 * Verify structural integrity + signature match (dev-grade).
 * @returns {boolean}
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signature] = parts;
  return fakeSign(headerB64, payloadB64) === signature;
}

/**
 * Is the token expired relative to `nowSeconds`?
 * A malformed/undecodable token counts as expired (fail closed).
 */
export function isTokenExpired(token, nowSeconds) {
  const claims = decodeToken(token);
  if (!claims || typeof claims.exp !== 'number') return true;
  return nowSeconds >= claims.exp;
}

/** Seconds until expiry (0 if already expired / invalid). */
export function secondsUntilExpiry(token, nowSeconds) {
  const claims = decodeToken(token);
  if (!claims || typeof claims.exp !== 'number') return 0;
  return Math.max(0, claims.exp - nowSeconds);
}
