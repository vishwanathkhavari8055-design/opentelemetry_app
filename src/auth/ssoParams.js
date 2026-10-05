/**
 * SSO parameter extraction — the URL is the entry ticket.
 *
 * The portal opens this app with the identity context on the query string:
 *
 *   https://host/OpentelemetryApp/?role=superadministrator&tenantCode=Primary
 *                                 &lang=en&refKey=qgit6fmspn7ebu
 *
 * This module is PURE: it reads a URL and produces the request the "login by
 * SSO" endpoint expects. It decides nothing about access — that is the
 * endpoint's job — it only reports whether there is enough on the URL to ask
 * the question at all.
 *
 * Deliberately tolerant on the way in, strict on the way out:
 *   • parameter names are matched case-insensitively, with the aliases the
 *     portal has used at various times (`tenant`, `tenantcode`, `refkey`, …)
 *   • the query is read from `?…` AND from a `#…?…` fragment, so the app still
 *     receives its context if it is ever mounted behind a hash route
 *   • values are trimmed; blank means absent
 */

/**
 * Canonical field → the parameter spellings that map onto it.
 * Compared lowercased, so only distinct SHAPES need listing here.
 */
const PARAM_ALIASES = Object.freeze({
  role: ['role', 'ssorolename', 'rolename', 'ssorole'],
  tenantCode: ['tenantcode', 'tenant', 'tenantid', 'domain'],
  refKey: ['refkey', 'ref', 'reference', 'refid'],
  lang: ['lang', 'language', 'locale'],
  // The portal's sample URL does not carry the user — the backend resolves it
  // from refKey. Honoured when present so a URL that DOES name the user works
  // without a round trip through the reference store.
  ssoUserName: ['ssousername', 'username', 'user', 'ssouser', 'uid'],
});

/** Lowercased key → first non-blank value, from one or more query strings. */
function collect(...queryStrings) {
  const out = new Map();
  queryStrings.filter(Boolean).forEach((qs) => {
    let params;
    try {
      params = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
    } catch {
      return;
    }
    params.forEach((value, key) => {
      const k = key.trim().toLowerCase();
      const v = (value || '').trim();
      if (v && !out.has(k)) out.set(k, v);
    });
  });
  return out;
}

/** First alias that is actually present, else ''. */
function pick(bag, field) {
  const aliases = PARAM_ALIASES[field] || [];
  for (const alias of aliases) {
    const value = bag.get(alias);
    if (value) return value;
  }
  return '';
}

/**
 * The query part of a hash fragment: `#/somewhere?role=x` → `role=x`.
 * Returns '' when the fragment carries no query.
 */
function hashQuery(hash = '') {
  const idx = hash.indexOf('?');
  return idx === -1 ? '' : hash.slice(idx + 1);
}

/**
 * Read the SSO context off a URL.
 *
 * @param {{search?: string, hash?: string}} [source] defaults to the live location
 * @returns {{
 *   role: string, tenantCode: string, refKey: string, lang: string,
 *   ssoUserName: string, ssoRoleName: string,
 *   present: boolean, valid: boolean, missing: string[],
 * }}
 */
export function readSsoParams(source = undefined) {
  const loc = source || (typeof window !== 'undefined' ? window.location : { search: '', hash: '' });
  const bag = collect(loc.search || '', hashQuery(loc.hash || ''));

  const role = pick(bag, 'role');
  const tenantCode = pick(bag, 'tenantCode');
  const refKey = pick(bag, 'refKey');
  const lang = pick(bag, 'lang');
  const ssoUserName = pick(bag, 'ssoUserName');

  const missing = [];
  if (!role) missing.push('role');
  if (!tenantCode) missing.push('tenantCode');
  // Either identifies the user: refKey is resolved server-side, ssoUserName is
  // already the answer. Without one of them there is nobody to validate.
  if (!refKey && !ssoUserName) missing.push('refKey');

  return {
    role,
    tenantCode,
    refKey,
    lang,
    ssoUserName,
    ssoRoleName: qualifyRole(role, tenantCode),
    /** Did the URL carry ANY SSO parameter? Distinguishes "opened cold" from
     *  "opened with a half-filled link", which get different landing copy. */
    present: Boolean(role || tenantCode || refKey || ssoUserName),
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Qualify a bare role with its tenant, matching the endpoint's contract:
 * `smartDomain/administrator`. A role that already carries a prefix is left
 * alone, so a portal that sends the qualified form is not double-prefixed.
 */
export function qualifyRole(role = '', tenantCode = '') {
  const trimmed = (role || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('/')) return trimmed;
  const tenant = (tenantCode || '').trim();
  return tenant ? `${tenant}/${trimmed}` : trimmed;
}

/**
 * The exact body the "login by SSO" endpoint is called with.
 *
 * <p>`refKey` rides along beside the three documented fields: the sample
 * payload names `ssoUserName`, but the portal's URL identifies the user by
 * reference key instead, and it is the backend that resolves one to the other.
 * Sending the refKey AS the username would be a lie the backend cannot detect;
 * sending it in its own field lets the backend fill in what it knows.</p>
 */
export function toSsoRequest(params) {
  const body = {
    ssoUserName: params.ssoUserName || null,
    tenantCode: params.tenantCode,
    ssoRoleName: params.ssoRoleName,
  };
  if (params.refKey) body.refKey = params.refKey;
  if (params.lang) body.lang = params.lang;
  return body;
}

export default readSsoParams;
