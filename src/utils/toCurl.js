/**
 * Builds a `curl` command-line equivalent of an HTTP span so the user can
 * paste it into a terminal to reproduce the request.
 *
 * Inputs come from the lib's TraceTreeNode HTTP fields:
 *   node.httpMethod       e.g. "POST"
 *   node.endpoint         full URL (preferred) — falls back to node.url
 *   node.httpRequestBody  raw payload string (often JSON)
 *
 * Headers are not captured by default OTel HTTP instrumentation, so we add
 * `Content-Type: application/json` only as a best-effort hint when the body
 * looks like JSON. If you need exact headers, configure the agent with
 * `-Dotel.instrumentation.http.client.capture-request-headers=...`.
 *
 * Output format: single-line curl (works in bash, zsh, PowerShell, cmd).
 * Single-quoted shell strings; embedded single quotes are escaped via the
 * bash `'\''` idiom (PowerShell users will need to adjust if they paste
 * into non-bash shells with bodies containing apostrophes — uncommon).
 *
 * Returns null when the node doesn't have enough info to build a curl.
 */
export const toCurl = (node) => {
  if (!node) return null;
  const method = String(node.httpMethod || '').toUpperCase();
  const url = node.endpoint || node.url;
  if (!method || !url) return null;

  const parts = [`curl -X ${method}`, shellQuote(url)];

  const body = node.httpRequestBody;
  if (body != null && String(body).length > 0) {
    if (looksLikeJson(body)) {
      parts.push(`-H ${shellQuote('Content-Type: application/json')}`);
    }
    parts.push(`--data-raw ${shellQuote(String(body))}`);
  }

  return parts.join(' ');
};

const looksLikeJson = (s) => {
  const t = String(s).trim();
  return t.startsWith('{') || t.startsWith('[');
};

// Wrap value in POSIX single quotes and escape embedded single quotes via
// the standard '\'' idiom so the entire string can be pasted verbatim.
const shellQuote = (value) => {
  const s = String(value);
  if (s === '') return "''";
  return "'" + s.replaceAll("'", String.raw`'\''`) + "'";
};
