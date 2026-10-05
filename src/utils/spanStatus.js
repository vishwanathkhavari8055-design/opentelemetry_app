/**
 * Resolves the status to display for a span row.
 *
 * The lib's `node.status` field carries the OTel **span status** — OK,
 * ERROR, or (most commonly) UNSET. By OTel convention, agents leave span
 * status UNSET on successful operations; the lib derives that to "UNKNOWN".
 *
 * For HTTP spans this is misleading because the actual outcome is in
 * `node.httpStatus` (the HTTP response code). When that's populated we
 * derive a meaningful status from it; otherwise we fall back to the
 * lib-provided span status.
 *
 *   2xx -> SUCCESS
 *   3xx -> INFO
 *   4xx -> WARN
 *   5xx -> ERROR
 */
export const effectiveSpanStatus = (node) => {
  if (!node) return null;
  const hs = Number(node.httpStatus);
  if (!Number.isNaN(hs) && hs > 0) {
    if (hs >= 500) return 'ERROR';
    if (hs >= 400) return 'WARN';
    if (hs >= 300) return 'INFO';
    return 'SUCCESS';
  }
  return node.status || node.severity || null;
};
