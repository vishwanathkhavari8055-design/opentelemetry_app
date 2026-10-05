/**
 * Translates what the user types in the Query Editor into the parameters
 * GET /api/logs actually accepts.
 *
 * This is NOT a SQL engine and does not pretend to be one. The backend exposes
 * a fixed set of filters (serviceNames, severity, traceId, search, time range)
 * — there is no query passthrough — so the editor's job is to be a familiar
 * front end for those filters rather than a general query language. Anything a
 * clause can't be mapped onto is reported in `warnings` and shown under the
 * editor, so a query never silently returns results it didn't ask for.
 *
 * Two dialects, matching the SQL toggle in the toolbar:
 *
 *   filter mode   a bare WHERE-style expression, which is what OpenObserve's
 *                 non-SQL editor takes:
 *                     severity_text='ERROR' AND service_name='iotopsservice'
 *                     match_all('timeout')
 *                     str_match(body, 'Pending Notification')
 *                 A line with no recognised operator is treated as free text.
 *
 *   sql mode      SELECT * FROM "stream" WHERE <the same expression>
 *                 The projection, GROUP BY, ORDER BY and LIMIT are parsed only
 *                 so they can be reported as unsupported — the WHERE clause is
 *                 the part that maps onto real parameters.
 */

/**
 * Column aliases → the backend parameter that filters on them.
 *
 * OpenObserve writes OTel's dotted attribute names with underscores because a
 * dot isn't valid in a bare SQL identifier, so both spellings arrive in
 * practice (the UI's own field sidebar lists the dotted ones, since that's what
 * the JSON carries). Both are accepted.
 *
 * There is one map per stream, because the same concept has different column
 * names in each: a log's severity is `severity_text`, a span's is
 * `span_status`, and a span's operation has no log equivalent at all. The
 * parser below is shared; only this table differs.
 */
const LOG_COLUMN_TARGETS = {
  'service_name': 'service',
  'service.name': 'service',
  'servicename': 'service',

  'severity_text': 'severity',
  'severity': 'severity',
  'level': 'severity',

  'trace_id': 'trace',
  'trace.id': 'trace',
  'traceid': 'trace',
};

/** The traces stream's equivalents. `operation` and `status` have no log twin. */
const TRACE_COLUMN_TARGETS = {
  'service_name': 'service',
  'service.name': 'service',
  'servicename': 'service',

  'operation_name': 'operation',
  'operationname': 'operation',
  'span_name': 'operation',
  'spanname': 'operation',

  'span_status': 'status',
  'status': 'status',

  'trace_id': 'trace',
  'trace.id': 'trace',
  'traceid': 'trace',
};

/** Severity values the backend recognises, used to validate before sending. */
const SEVERITIES = new Set(['TRACE', 'DEBUG', 'INFO', 'WARN', 'WARNING', 'ERROR', 'FATAL']);

/**
 * Span-status values. `UNSET` is what a healthy span carries — `OK` is
 * accepted as a synonym because people type it, and both mean "not ERROR"
 * which is the only distinction the backend's `outcome` param can express.
 */
const SPAN_STATUSES = new Set(['UNSET', 'OK', 'ERROR']);

const TRACE_ID_RE = /^[a-f0-9]{16,32}$/i;

/** Strips a matching pair of single or double quotes, if present. */
const unquote = (s) => {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === "'" && t.at(-1) === "'") || (t[0] === '"' && t.at(-1) === '"'))) {
    return t.slice(1, -1).replace(/\\(['"])/g, '$1');
  }
  return t;
};

// ─── Linear scanners ───────────────────────────────────────────────────────
//
// The clause and SELECT grammars below used to be single regexes. Several had
// adjacent quantifiers over overlapping characters (`\s*(.+?)\s*`), which
// backtrack super-linearly on hostile input. These scans return exactly what
// those regexes captured, in one pass.

/** JS `\s`, for one character. */
const isSpace = (ch) => ch !== undefined && /\s/.test(ch);

/** A column name character — `[\w.]`. */
const isColumnChar = (ch) => ch !== undefined && /[\w.]/.test(ch);

/** A stream name character — `[\w.-]`. */
const isStreamChar = (ch) => ch !== undefined && /[\w.-]/.test(ch);

/** The characters `.` does not match. */
const isLineBreak = (ch) => ch === '\n' || ch === '\r' || ch === ' ' || ch === ' ';

/** Index of the first character at or after `i` (and before `end`) that is not whitespace. */
const skipSpace = (s, i, end = s.length) => {
  let j = i;
  while (j < end && isSpace(s[j])) j += 1;
  return j;
};

/** Index of the first character at or after `i` that fails `test`. */
const skipWhile = (s, i, test) => {
  let j = i;
  while (j < s.length && test(s[j])) j += 1;
  return j;
};

/**
 * Whether lower-case ASCII `word` appears at `s[i]`, ignoring ASCII case only —
 * as a non-unicode `/i` regex does. (`toLowerCase` would also fold the Kelvin
 * sign into `k`, which the regex never did.)
 */
const hasWordAt = (s, i, word) => {
  for (let k = 0; k < word.length; k += 1) {
    const c = s.charCodeAt(i + k);
    const lower = c >= 65 && c <= 90 ? c + 32 : c;
    if (lower !== word.charCodeAt(k)) return false;
  }
  return true;
};

/** Whether `s[from, to)` contains a line break. */
const hasLineBreak = (s, from, to) => {
  for (let i = from; i < to; i += 1) if (isLineBreak(s[i])) return true;
  return false;
};

/**
 * `name` (plus at most one of `suffixes`), optional whitespace and `(` at the
 * start of `s`. Returns the index just past the `(`, or -1.
 */
const callOpen = (s, name, suffixes) => {
  if (!hasWordAt(s, 0, name)) return -1;
  const suffix = suffixes.find((x) => hasWordAt(s, name.length, x));
  const at = skipSpace(s, name.length + (suffix ? suffix.length : 0));
  return s[at] === '(' ? at + 1 : -1;
};

/**
 * The last argument of a call: `\s*(.+?)\s*\)$` from `start`. The whitespace
 * around it is trimmed, and it may not span a line break. When the argument is
 * nothing but whitespace, the regex settled on its last character that is not
 * a line break, and so does this.
 */
const callArgument = (s, start) => {
  const end = s.length - 1;
  if (end < start || s[end] !== ')') return null;
  const from = skipSpace(s, start, end);
  if (from === end) {
    let last = end - 1;
    while (last >= start && isLineBreak(s[last])) last -= 1;
    return last >= start ? s[last] : null;
  }
  let to = end;
  while (to > from && isSpace(s[to - 1])) to -= 1;
  return hasLineBreak(s, from, to) ? null : s.slice(from, to);
};

/** `match_all('term')` / `match_all_raw` / `match_all_indexed` → the raw argument, or null. */
const matchAllArgument = (clause) => {
  const start = callOpen(clause, 'match_all', ['_raw', '_indexed']);
  return start < 0 ? null : callArgument(clause, start);
};

/** `str_match(column, 'term')` / `str_match_ignore_case` → `[column, term]`, or null. */
const strMatchArguments = (clause) => {
  const start = callOpen(clause, 'str_match', ['_ignore_case']);
  if (start < 0) return null;
  const columnStart = skipSpace(clause, start);
  const columnEnd = skipWhile(clause, columnStart, isColumnChar);
  if (columnEnd === columnStart) return null;
  const comma = skipSpace(clause, columnEnd);
  if (clause[comma] !== ',') return null;
  const term = callArgument(clause, comma + 1);
  return term === null ? null : [clause.slice(columnStart, columnEnd), term];
};

/**
 * `column = value` → `[column, value]`, or null. The value is everything after
 * the `=` and its whitespace, and may not span a line break; a value that is
 * only whitespace keeps its last character, as the regex this replaced did.
 */
const splitEquality = (s) => {
  const columnEnd = skipWhile(s, 0, isColumnChar);
  if (columnEnd === 0) return null;
  const eqAt = skipSpace(s, columnEnd);
  if (s[eqAt] !== '=') return null;
  const valueStart = eqAt + 1;
  let lastBreak = s.length - 1;
  while (lastBreak >= valueStart && !isLineBreak(s[lastBreak])) lastBreak -= 1;
  const start = Math.min(skipSpace(s, valueStart), s.length - 1);
  if (start < valueStart || start <= lastBreak) return null;
  return [s.slice(0, columnEnd), s.slice(start)];
};

/** `FROM\s+"?stream"?\s*` at `s[at]` → everything after it, or null. */
const fromTail = (s, at) => {
  if (!hasWordAt(s, at, 'from')) return null;
  const nameAt = skipSpace(s, at + 4);
  if (nameAt === at + 4) return null;
  const first = s[nameAt] === '"' ? nameAt + 1 : nameAt;
  const last = skipWhile(s, first, isStreamChar);
  if (last === first) return null;
  return s.slice(skipSpace(s, s[last] === '"' ? last + 1 : last));
};

/**
 * `SELECT <projection> FROM "stream" <tail>` → `{ projection, tail }`, or null.
 * The projection is the shortest run followed by whitespace and a FROM clause —
 * the first `FROM` that can close it, even one that is the projection's own text.
 */
const selectParts = (s) => {
  if (!hasWordAt(s, 0, 'select') || !isSpace(s[6])) return null;
  const from = skipSpace(s, 6);
  for (let i = from + 1; i < s.length; i += 1) {
    if (isSpace(s[i])) {
      const keyword = skipSpace(s, i);
      const tail = fromTail(s, keyword);
      if (tail !== null) return { projection: s.slice(from, i), tail };
      i = keyword;
    }
  }
  // Nothing after the projection's first character closes it. The regex then
  // gave some of the whitespace after SELECT to the projection instead: with
  // FROM straight after that whitespace, the projection is the one whitespace
  // character two before it — provided SELECT keeps at least one of its own.
  const tail = fromTail(s, from);
  return tail !== null && from - 2 >= 7 ? { projection: s.slice(from - 2, from - 1), tail } : null;
};

/**
 * Advances the quote/paren state past `expr[i]`. Returns the index of the last
 * character consumed, or -1 when `expr[i]` sits outside quotes at depth zero
 * and may therefore start a top-level `AND`.
 */
const stepNesting = (expr, i, state) => {
  const c = expr[i];

  if (state.quote) {
    if (c === '\\') return i + 1;
    if (c === state.quote) state.quote = null;
    return i;
  }
  if (c === "'" || c === '"') { state.quote = c; return i; }
  if (c === '(') { state.depth += 1; return i; }
  if (c === ')') { state.depth = Math.max(0, state.depth - 1); return i; }
  return state.depth > 0 ? i : -1;
};

/** `AND` as a whole word starting at `i`, preceded by whitespace or the start. */
const isAndAt = (expr, i) => {
  const c = expr[i];
  return (c === 'a' || c === 'A') && /^and\b/i.test(expr.slice(i)) && (i === 0 || /\s/.test(expr[i - 1]));
};

/**
 * Splits on top-level `AND` only — an AND inside quotes or parentheses belongs
 * to the clause, not between clauses. A hand-rolled scan rather than a regex
 * because a regex can't track quote/paren depth.
 */
const splitTopLevelAnd = (expr) => {
  const parts = [];
  const state = { depth: 0, quote: null };
  let start = 0;

  for (let i = 0; i < expr.length; i += 1) {
    const consumed = stepNesting(expr, i, state);
    if (consumed >= 0) { i = consumed; continue; }

    // `AND` as a whole word, at nesting depth zero.
    if (isAndAt(expr, i)) {
      parts.push(expr.slice(start, i));
      i += 2;
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
};

/**
 * Folds a `column = value` clause into `acc`, routed by the stream's column
 * map. Returns a warning string, as `applyClause` does.
 */
const applyEquality = (rawColumn, rawValue, acc, targets) => {
  const column = rawColumn.toLowerCase();
  const value = unquote(rawValue);
  if (!value) return `Empty value for "${rawColumn}" — clause ignored.`;

  switch (targets[column]) {
    case 'service':
      acc.serviceNames.push(value);
      return null;
    case 'severity': {
      const upper = value.toUpperCase();
      if (!SEVERITIES.has(upper)) {
        return `"${value}" is not a known severity (${[...SEVERITIES].join(', ')}) — clause ignored.`;
      }
      acc.severity = upper;
      return null;
    }
    case 'operation':
      acc.operationName = value;
      return null;
    case 'status': {
      const upper = value.toUpperCase();
      if (!SPAN_STATUSES.has(upper)) {
        return `"${value}" is not a known span status (${[...SPAN_STATUSES].join(', ')}) — clause ignored.`;
      }
      // The backend's `outcome` param is a two-way switch, so UNSET and OK
      // both mean "everything that isn't an error".
      acc.outcome = upper === 'ERROR' ? 'ERROR' : 'SUCCESS';
      return null;
    }
    case 'trace':
      if (!TRACE_ID_RE.test(value)) return `"${value}" is not a valid trace id — clause ignored.`;
      acc.traceId = value;
      return null;
    default:
      // Any other column: the value still narrows the result via free-text
      // search, which is the closest honest approximation available.
      acc.searchTerms.push(value);
      return `No dedicated filter for "${rawColumn}" — matching "${value}" as free text across all columns instead.`;
  }
};

/**
 * Parses one clause and folds it into `acc`. Returns a warning string when the
 * clause was understood but can't be expressed against this backend.
 */
const applyClause = (clause, acc, targets) => {
  // match_all('term') / match_all_raw('term') — OpenObserve's full-text search.
  const matchAll = matchAllArgument(clause);
  if (matchAll !== null) {
    acc.searchTerms.push(unquote(matchAll));
    return null;
  }

  // str_match(field, 'term') / str_match_ignore_case(...) — substring on one
  // column. The backend's `search` ORs across body, service, trace id,
  // severity, scope and the code attributes, so the column is advisory: we
  // keep the term and note that the column narrowing isn't applied.
  const strMatch = strMatchArguments(clause);
  if (strMatch) {
    const [column, term] = strMatch;
    acc.searchTerms.push(unquote(term));
    return `str_match on "${column}" is searched across all text columns — the backend has no per-column substring filter.`;
  }

  // field = 'value'
  const eq = splitEquality(clause);
  if (eq) return applyEquality(eq[0], eq[1], acc, targets);

  // Operators the backend has no equivalent for. Named explicitly so the
  // warning says which one rather than "unparseable".
  const unsupportedOp = /(!=|<>|\bNOT\b|\bLIKE\b|\bIN\b|\bOR\b|>=|<=|>|<)/i.exec(clause);
  if (unsupportedOp) {
    return `"${unsupportedOp[1].toUpperCase()}" is not supported — the backend only offers equality filters and full-text search. Clause ignored.`;
  }

  // Anything left is a bare term: search for it.
  acc.searchTerms.push(unquote(clause));
  return null;
};

/**
 * Pulls the WHERE clause out of a SELECT statement, reporting the parts of the
 * statement that this backend can't honour.
 *
 * Returns `{ where, warnings, error }`.
 */
const parseSelect = (sql) => {
  const warnings = [];
  const text = sql.replace(/;\s*$/, '').trim();

  const head = selectParts(text);
  if (!head) {
    return { where: '', warnings, error: 'Expected SELECT … FROM "stream" [WHERE …].' };
  }

  const { projection, tail } = head;
  if (projection.trim() !== '*') {
    warnings.push(`Projection "${projection.trim()}" is ignored — /api/logs always returns whole records.`);
  }

  // Everything after FROM, split at the first clause keyword we recognise.
  const whereMatch = /\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(tail);
  const where = whereMatch ? whereMatch[1].trim() : '';

  if (/\bGROUP\s+BY\b/i.test(tail)) warnings.push('GROUP BY is ignored — no aggregation endpoint exists.');
  if (/\bHAVING\b/i.test(tail)) warnings.push('HAVING is ignored — no aggregation endpoint exists.');
  if (/\bORDER\s+BY\b/i.test(tail)) warnings.push('ORDER BY is ignored — results are always newest first.');
  if (/\bLIMIT\b/i.test(tail)) warnings.push('LIMIT is ignored — use the rows-per-page control instead.');

  return { where, warnings, error: null };
};

/**
 * Parse the editor's contents.
 *
 * @param {string} text     what the user typed
 * @param {boolean} sqlMode whether the SQL toggle is on
 * @returns {{
 *   serviceNames: string[], severity: string, traceId: string, search: string,
 *   warnings: string[], error: string|null,
 * }}
 */
export const parseLogQuery = (text, sqlMode = false) =>
  parseQuery(text, sqlMode, LOG_COLUMN_TARGETS);

/**
 * Same grammar against the traces stream. Adds `operationName` and `outcome`
 * to the result and drops `severity`, which spans don't have.
 */
export const parseTraceQuery = (text, sqlMode = false) =>
  parseQuery(text, sqlMode, TRACE_COLUMN_TARGETS);

const EMPTY = {
  serviceNames: [], severity: '', traceId: '', operationName: '', outcome: '', search: '',
};

const parseQuery = (text, sqlMode, targets) => {
  const acc = {
    serviceNames: [], severity: '', traceId: '', operationName: '', outcome: '', searchTerms: [],
  };
  const warnings = [];

  const raw = (text || '').trim();
  if (!raw) {
    return { ...EMPTY, warnings, error: null };
  }

  let expression = raw;
  if (sqlMode) {
    const parsed = parseSelect(raw);
    if (parsed.error) {
      return { ...EMPTY, warnings: parsed.warnings, error: parsed.error };
    }
    warnings.push(...parsed.warnings);
    expression = parsed.where;
  }

  splitTopLevelAnd(expression).forEach((clause) => {
    const w = applyClause(clause, acc, targets);
    if (w) warnings.push(w);
  });

  // Multiple free-text terms would need an AND the `search` param can't
  // express, so the extras are reported rather than quietly dropped.
  if (acc.searchTerms.length > 1) {
    warnings.push(
      `Only the first search term ("${acc.searchTerms[0]}") is applied — the backend takes one free-text term per query.`,
    );
  }

  return {
    serviceNames: acc.serviceNames,
    severity: acc.severity,
    traceId: acc.traceId,
    operationName: acc.operationName,
    outcome: acc.outcome,
    search: acc.searchTerms[0] || '',
    warnings,
    error: null,
  };
};

/** The starter query shown when SQL mode is switched on with an empty editor. */
export const sqlTemplate = (stream = 'default') => `SELECT * FROM "${stream}"`;

/**
 * Best-effort conversion of a filter expression into the equivalent SELECT, so
 * flipping the SQL toggle keeps whatever the user had typed instead of
 * discarding it.
 */
export const toSql = (filterText, stream = 'default') => {
  const where = (filterText || '').trim();
  return where ? `SELECT * FROM "${stream}" WHERE ${where}` : sqlTemplate(stream);
};

/** The inverse: pull the WHERE clause back out when SQL mode is switched off. */
export const fromSql = (sqlText) => {
  const { where } = parseSelect(sqlText || '');
  return where || '';
};

/** Column spellings that mean "the severity" / span status. */
const SEVERITY_ALIASES = new Set([
  'severity_text', 'severity', 'level', 'span_status', 'status',
]);

/**
 * Strip every severity clause from a query, leaving the rest intact.
 *
 * Used by the chart legend's toggle-off: clicking the highlighted severity
 * should clear that filter WITHOUT disturbing the service or free-text clauses
 * the user also has in play.
 */
export const withoutSeverityClauses = (text, sqlMode, stream = 'default') => {
  const raw = (text || '').trim();
  const where = sqlMode ? fromSql(raw) : raw;

  const kept = splitTopLevelAnd(where).filter((clause) => {
    const eq = splitEquality(clause.trim());
    return !(eq && SEVERITY_ALIASES.has(eq[0].toLowerCase()));
  });

  const next = kept.join(' AND ');
  if (!sqlMode) return next;
  return next ? toSql(next, stream) : sqlTemplate(stream);
};

/**
 * Rewrite a query so its severity filter is exactly `severity`.
 *
 * The counterpart to {@link withoutSeverityClauses}: that one clears the filter,
 * this one sets it. Every existing severity clause is dropped first, so this
 * REPLACES rather than layers — two severity clauses ANDed together match
 * nothing, and a drill-through that silently produced an empty table would look
 * like "no such logs" instead of "the query contradicts itself".
 *
 * A blank `severity` is the same as clearing it, so callers can pass the value
 * straight through without branching.
 *
 * The value is validated by the caller's own parse pass, not here — an unknown
 * severity reaches `applyClause`, which already reports it as a warning naming
 * the accepted set. Rejecting it silently here would lose that message.
 *
 * @param {string} text     current editor contents
 * @param {boolean} sqlMode whether the editor is in SQL mode
 * @param {string} severity e.g. 'ERROR'; blank clears the filter
 * @param {string} stream   stream name, used to rebuild the SELECT
 * @returns {string} the new editor contents
 */
export const withSeverityClause = (text, sqlMode, severity, stream = 'default') => {
  const cleared = withoutSeverityClauses(text, sqlMode, stream);
  const level = String(severity || '').trim().toUpperCase();
  if (!level) return cleared;

  const where = sqlMode ? fromSql(cleared) : cleared;
  const clause = `severity='${level.replace(/'/g, "\\'")}'`;
  const next = where ? `${where} AND ${clause}` : clause;
  return sqlMode ? toSql(next, stream) : next;
};

/** Column spellings that mean "the service", in either stream. */
const SERVICE_ALIASES = new Set(['service_name', 'service.name', 'servicename']);

/**
 * Rewrite a query so its service filter is exactly `services`.
 *
 * This is what lets the service checkbox dropdown and the query editor be the
 * SAME state rather than two filters that can disagree. Every existing
 * service clause is dropped and replaced, so unticking a box genuinely removes
 * it from the query instead of layering another clause on top.
 *
 * Works in both dialects: in SQL mode the WHERE clause is extracted, rewritten
 * and folded back into the SELECT.
 *
 * @param {string} text     current editor contents
 * @param {boolean} sqlMode whether the editor is in SQL mode
 * @param {string[]} services raw backend service names; empty clears the filter
 * @param {string} stream   stream name, used to rebuild the SELECT
 * @returns {string} the new editor contents
 */
export const withServiceClauses = (text, sqlMode, services, stream = 'default') => {
  const raw = (text || '').trim();
  const where = sqlMode ? fromSql(raw) : raw;

  const kept = splitTopLevelAnd(where).filter((clause) => {
    const eq = splitEquality(clause.trim());
    return !(eq && SERVICE_ALIASES.has(eq[0].toLowerCase()));
  });

  (services || []).forEach((s) => {
    const value = String(s).replace(/'/g, "\\'");
    kept.push(`service_name='${value}'`);
  });

  const next = kept.join(' AND ');
  if (!sqlMode) return next;
  return next ? toSql(next, stream) : sqlTemplate(stream);
};

/** Column spellings that mean "the trace id", in either stream. */
const TRACE_ALIASES = new Set(['trace_id', 'trace.id', 'traceid']);

/**
 * Rewrite a query so its trace filter is exactly `traceId`.
 *
 * The same replace-don't-layer contract as {@link withServiceClauses}, and for a
 * sharper reason: two different trace ids ANDed together match nothing at all, so
 * a drill-through that layered one onto a query already scoped to another trace
 * would land on an empty table and read as "this trace has no logs".
 *
 * Both parsers map these spellings to the backend's exact `traceId` parameter, so
 * the result is a pinned lookup rather than a text search. A blank id clears the
 * filter, letting callers pass a possibly-absent value straight through.
 *
 * @param {string} text      current editor contents
 * @param {boolean} sqlMode  whether the editor is in SQL mode
 * @param {string} traceId   the trace to pin to; blank clears the filter
 * @param {string} stream    stream name, used to rebuild the SELECT
 * @returns {string} the new editor contents
 */
export const withTraceClause = (text, sqlMode, traceId, stream = 'default') => {
  const raw = (text || '').trim();
  const where = sqlMode ? fromSql(raw) : raw;

  const kept = splitTopLevelAnd(where).filter((clause) => {
    const eq = splitEquality(clause.trim());
    return !(eq && TRACE_ALIASES.has(eq[0].toLowerCase()));
  });

  const value = String(traceId || '').trim();
  if (value) kept.push(`trace_id='${value.replace(/'/g, "\\'")}'`);

  const next = kept.join(' AND ');
  if (!sqlMode) return next;
  return next ? toSql(next, stream) : sqlTemplate(stream);
};
