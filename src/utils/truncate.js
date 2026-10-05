/**
 * Content-aware truncation.
 *
 * `text-overflow: ellipsis` always clips the END, which hides the suffix —
 * but for HTTP paths and Java loggers the suffix is the part you actually
 * care about. This util picks the right strategy based on what kind of
 * string we're looking at.
 *
 * Strategies:
 *   - `http`      → keep the verb + last path segment:
 *                   `POST /IoTOpsCIMService/contextual/fetchContextualInformation`
 *                   becomes `POST …/fetchContextualInformation`
 *   - `logger`    → keep the suffix (Java logger names = FQCN; the class is
 *                   the suffix): `…serviceimpl.CimDataServiceImpl`
 *   - `classname` → middle-truncate: `com.trinity…CimDataServiceImpl`
 *   - `sql`       → start-anchor (the verb / table is at the front)
 *   - `plain`     → start-anchor (today's `text-overflow` behaviour)
 *
 * Always pass the FULL untruncated text via `title=` for the hover tooltip
 * — these strategies are display-only.
 */

export const detectTruncateKind = (text, type) => {
  if (!text) return 'plain';
  const t = String(type || '').toUpperCase();
  if (t === 'HTTP') return 'http';
  if (t === 'SQL' || t === 'MSSQL') return 'sql';

  // Logger heuristic: type=LOG and the body looks like a Java FQCN (no spaces,
  // dotted, mostly lowercase before the final segment).
  if (t === 'LOG' && text.includes('.') && !text.includes(' ')) {
    return 'logger';
  }

  // Generic FQCN: lowercase.lowercase…ClassName
  if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.[A-Z]/.test(text)) {
    return 'classname';
  }

  return 'plain';
};

export const smartTruncate = (text, kind, maxChars = 60) => {
  if (!text || text.length <= maxChars) return text;
  switch (kind) {
    case 'http':       return endAnchorHttp(text, maxChars);
    case 'logger':     return endAnchorPlain(text, maxChars);
    case 'classname':  return middleTruncate(text, maxChars);
    case 'sql':
    case 'plain':
    default:           return startAnchor(text, maxChars);
  }
};

// "POST /a/b/c/d/longEndpointName" → "POST …/longEndpointName"
// If the verb-and-tail composition still overflows, falls back to a plain
// start-anchor on the composed string.
function endAnchorHttp(text, max) {
  const spaceIdx = text.indexOf(' ');
  if (spaceIdx < 0) return endAnchorPlain(text, max);
  const verb = text.slice(0, spaceIdx);
  const rest = text.slice(spaceIdx + 1);
  const lastSeg = Math.max(rest.lastIndexOf('/'), rest.lastIndexOf('.'));
  if (lastSeg < 0) return startAnchor(text, max);
  const tail = rest.slice(lastSeg);
  const composed = `${verb} …${tail}`;
  if (composed.length <= max) return composed;
  // tail itself is huge — keep verb + ellipsis + start of tail
  return startAnchor(composed, max);
}

// "…the.last.relevant.suffix" — no leading verb.
function endAnchorPlain(text, max) {
  return '…' + text.slice(-(max - 1));
}

// "abc.def…xyz.qwe" — head + ellipsis + tail.
function middleTruncate(text, max) {
  const head = Math.ceil((max - 1) * 0.45);
  const tail = (max - 1) - head;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function startAnchor(text, max) {
  return text.slice(0, max - 1) + '…';
}
