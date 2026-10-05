/**
 * Extracts the most meaningful "actual operation" string from a TraceTreeNode.
 *
 * Type-specific fields are preferred FIRST (`dbStatement`, `endpoint`,
 * `command`, `className.methodName`) because they carry the full payload —
 * the lib's `name`/`operation` fields are often a truncated label suitable
 * for a row title but not for the inspector pane.
 *
 * Earlier this used the generic name fields first; that meant `node.name`
 * (almost always present) shadowed the richer type-specific value, and the
 * pane's payload section was suppressed (since payload === name).
 */
const sqlOperation = (node) => node.dbStatement || node.query || node.statement;

const internalOperation = (node) => {
  if (node.className && node.methodName) {
    return `${node.className}.${node.methodName}()`;
  }
  return node.methodName || node.className;
};

// Type-specific extraction — this is the field with the most useful
// payload (full SQL query, full URL with query string, redis command,
// class.method form for internal spans).
const TYPE_EXTRACTORS = {
  SQL: sqlOperation,
  MSSQL: sqlOperation,
  DATABASE: sqlOperation,
  MONGODB: sqlOperation,
  HTTP: (node) => node.endpoint || node.url || node.target,
  REDIS: (node) => node.command || node.dbStatement,
  INTERNAL: internalOperation,
};

export const extractActualOperation = (node) => {
  if (!node) return null;

  const type = String(node.type || '').toUpperCase();

  const typed = Object.hasOwn(TYPE_EXTRACTORS, type) ? TYPE_EXTRACTORS[type](node) : null;
  if (typed) return typed;

  // Generic fallback — for log nodes, untyped spans, or DB/HTTP spans where
  // the lib didn't populate the type-specific field.
  const priorityValues = [
    node.actualOperation,
    node.operation,
    node.requestLabel,
    node.spanName,
    node.name,
  ];
  for (const val of priorityValues) {
    if (val && String(val).trim()) return val;
  }

  return null;
};

/**
 * Pretty-prints a payload value for display in a `<pre>` block.
 *
 * - JSON-shaped strings get parsed + reformatted with indentation.
 * - Objects are JSON.stringify'd.
 * - Plain strings are returned as-is.
 * - Anything that fails parsing falls back to `String(val)`.
 */
export const renderPayload = (val) => {
  if (!val) return null;
  try {
    if (typeof val === 'string' && (val.trim().startsWith('{') || val.trim().startsWith('[')))
      return JSON.stringify(JSON.parse(val), null, 2);
    if (typeof val === 'object') return JSON.stringify(val, null, 2);
    return String(val);
  } catch { return String(val); }
};
