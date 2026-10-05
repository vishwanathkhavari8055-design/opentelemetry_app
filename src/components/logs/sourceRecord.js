/** Aliases api.js layers on top of the wire shape. Hidden from the source JSON
 *  so a row doesn't show `service.name` and `serviceName` as two fields. */
const ALIAS_KEYS = new Set([
  '_raw', 'timestamp', 'serviceName', 'severity', 'traceId', 'message', 'id',
]);

/**
 * Record actually shown in the source column: the untouched wire object when
 * api.js preserved one, otherwise the row minus the aliases it added.
 */
export const sourceRecord = (log) => {
  if (log && typeof log._raw === 'object' && log._raw !== null) return log._raw;
  const out = {};
  Object.entries(log || {}).forEach(([k, v]) => {
    if (!ALIAS_KEYS.has(k)) out[k] = v;
  });
  return out;
};
