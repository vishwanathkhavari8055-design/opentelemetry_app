/**
 * Template-variable queries, for ANY datasource.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * In Grafana, each datasource's BROWSER plugin knows how to answer a variable
 * query. None of those plugins is loaded here, so this application answered only
 * the one form it had been taught — Prometheus `label_values(...)` — and every
 * other variable silently resolved to nothing. A Neo4j variable saved as
 * `{ cypherQuery: "MATCH … RETURN DISTINCT n.tenantCode" }` reached the proxy as
 * an empty string, its picker stayed empty, and every panel filtering on it went
 * quietly blank while the same dashboard worked in Grafana.
 *
 * The fix is the same one the panels already use: a variable query IS a query.
 * Grafana's own /api/ds/query executes it for every backend datasource — Neo4j,
 * SQL, Druid, Infinity, Elasticsearch — and hands back ordinary data frames. So
 * the datasource-specific part shrinks to the two things only a browser plugin
 * would otherwise do:
 *
 *   · Prometheus' variable FUNCTIONS (`label_values`, `metrics`, `query_result`),
 *     which are not PromQL and which Grafana's Go side does not understand;
 *   · Infinity's legacy `Collection(...)` helpers, which never leave the browser.
 *
 * Everything else — including any datasource installed in Grafana next year —
 * goes through {@link variableTarget} and {@link framesToVariableValues}
 * untouched, with nothing to configure here.
 *
 * Pure, and free of @grafana imports, so `npm test` can pin it down directly.
 */

// ─── Prometheus variable functions ─────────────────────────────────────────

// Each function is `name(args)`, with whitespace allowed anywhere around the
// name, the parentheses and the arguments. These are index scans rather than
// regexes: the regexes they replace (`\s*(.*?)\s*\)` and friends) had adjacent
// quantifiers over overlapping characters, which backtrack super-linearly on
// hostile input. Each returns exactly what its regex captured.

/** JS `\s`, for one character. */
const isSpace = (ch) => ch !== undefined && /\s/.test(ch);

/** A label name character — `\w`. */
const isLabelChar = (ch) => ch !== undefined && /\w/.test(ch);

/** Index of the first character in `[i, end)` that is not whitespace, else `end`. */
const skipSpace = (s, i, end) => {
  let j = i;
  while (j < end && isSpace(s[j])) j += 1;
  return j;
};

/** Index just past the last character in `(from, to]` that is not whitespace, else `from`. */
const trimEnd = (s, from, to) => {
  let j = to;
  while (j > from && isSpace(s[j - 1])) j -= 1;
  return j;
};

/**
 * `name(` … `)` spanning all of `s`, whitespace aside. Returns `[open, close]`,
 * the index just past `(` and the index of the closing `)`, or null.
 */
const callBody = (s, name) => {
  const at = skipSpace(s, 0, s.length);
  if (!s.startsWith(name, at)) return null;
  const paren = skipSpace(s, at + name.length, s.length);
  if (s[paren] !== '(') return null;
  const close = trimEnd(s, 0, s.length) - 1;
  return close > paren && s[close] === ')' ? [paren + 1, close] : null;
};

/** `name(x)` → `x` with surrounding whitespace dropped (possibly ''), or null. */
const optionalArgument = (s, name) => {
  const body = callBody(s, name);
  if (!body) return null;
  const from = skipSpace(s, body[0], body[1]);
  return s.slice(from, trimEnd(s, from, body[1]));
};

/**
 * `query_result(expr)` → `expr`: leading whitespace dropped, trailing kept, as
 * the greedy regex had it. A body of only whitespace gives its last character.
 */
const queryResultArgument = (s) => {
  const body = callBody(s, 'query_result');
  if (!body) return null;
  const [open, close] = body;
  const from = skipSpace(s, open, close);
  if (from < close) return s.slice(from, close);
  return close > open ? s.slice(close - 1, close) : null;
};

/**
 * The metric part of `label_values(metric, label)`, given the index of the
 * comma: everything from the first non-space character up to the whitespace
 * before the comma. When the comma is the first thing in the body, the regex
 * took the one whitespace character before it, if there was any.
 */
const labelValuesMetric = (s, open, from, comma) => {
  if (comma === from) return from > open ? s.slice(from - 1, from) : null;
  return s.slice(from, Math.max(from + 1, trimEnd(s, from, comma)));
};

/**
 * `label_values(label)` → `[undefined, label]`; `label_values(metric, label)`
 * → `[metric, label]`; anything else → null. The label is a Prometheus label
 * name; the metric is any text, commas and parentheses included.
 */
const labelValuesArguments = (s) => {
  const body = callBody(s, 'label_values');
  if (!body) return null;
  const [open, close] = body;
  const from = skipSpace(s, open, close);
  const end = trimEnd(s, from, close);
  let start = end;
  while (start > from && isLabelChar(s[start - 1])) start -= 1;
  if (start === end || /\d/.test(s[start])) return null;
  const label = s.slice(start, end);
  if (start === from) return [undefined, label];
  const comma = trimEnd(s, from, start) - 1;
  if (s[comma] !== ',') return null;
  const metric = labelValuesMetric(s, open, from, comma);
  return metric === null ? null : [metric, label];
};

/**
 * The text of a Prometheus variable query, whichever shape Grafana saved it in.
 *
 * Old dashboards save a bare string; the current variable editor saves
 * `{ qryType, query: "label_values(...)", refId }` and still generates `query`.
 */
export function prometheusVariableText(query) {
  if (typeof query === 'string') return query;
  if (query && typeof query === 'object') {
    if (typeof query.query === 'string') return query.query;
    if (typeof query.expr === 'string') return query.expr;
  }
  return '';
}

/**
 * Which Prometheus variable function a query calls.
 *
 * Anything that is not one of Grafana's functions is a plain series selector,
 * which Grafana answers with one `metric{labels}` row per matching series —
 * rather than returning nothing, which is how an unrecognised variable used to
 * look exactly like an empty one.
 *
 * @returns {{ kind: string, metric?: string, label?: string, regex?: string, expr?: string } | null}
 */
export function parsePrometheusVariableQuery(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return null;

  const labelValues = labelValuesArguments(raw);
  if (labelValues) return { kind: 'label_values', metric: labelValues[0] || undefined, label: labelValues[1] };

  const regex = optionalArgument(raw, 'metrics');
  if (regex !== null) return { kind: 'metrics', regex: regex || '' };

  const expr = queryResultArgument(raw);
  if (expr !== null) return { kind: 'query_result', expr };

  const metric = optionalArgument(raw, 'label_names');
  if (metric !== null) return { kind: 'label_names', metric: metric || undefined };

  return { kind: 'series', expr: raw };
}

/**
 * Metric names matching a `metrics(regex)` call.
 *
 * Grafana matches the regex unanchored, so `metrics(node_)` offers every metric
 * that CONTAINS `node_`. An invalid regex offers nothing and says so, rather
 * than throwing the whole variable.
 */
export function filterMetricNames(names, regex) {
  if (!regex) return names;
  let pattern;
  try {
    pattern = new RegExp(regex);
  } catch {
    console.warn(`[dashboards] metrics(${regex}) is not a valid regular expression`);
    return [];
  }
  return names.filter((name) => pattern.test(name));
}

/**
 * `query_result(expr)` rows, spelled exactly the way Grafana spells them —
 * `metric{label="value", …} value timestampMs` — because dashboards pair this
 * function with a variable REGEX written against that exact text. A different
 * spacing or quoting here and the regex matches nothing.
 *
 * `{ seriesOnly: true }` gives the bare-selector form instead,
 * `metric{label="value",…}` — no spaces, no value — which is what Grafana
 * answers for a plain selector.
 */
export function promInstantToVariableValues(frames, { seriesOnly = false } = {}) {
  const values = [];
  for (const frame of frames || []) {
    const fields = frame?.schema?.fields || [];
    const columns = frame?.data?.values || [];
    const timeIndex = fields.findIndex((field) => field?.type === 'time');
    fields.forEach((field, index) => {
      if (index === timeIndex || field?.type !== 'number') return;
      const series = columns[index] || [];
      if (!series.length) return;
      const labels = field.labels || {};
      const name = labels.__name__ ?? '';
      const pairs = Object.entries(labels)
        .filter(([key]) => key !== '__name__')
        .map(([key, value]) => `${key}="${value}"`);
      if (seriesOnly) {
        const text = `${name}{${pairs.join(',')}}`;
        values.push({ text, value: text });
        return;
      }
      const time = timeIndex >= 0 ? (columns[timeIndex] || [])[series.length - 1] : undefined;
      let text = pairs.length ? `${name}{${pairs.join(', ')}}` : name;
      text += ` ${series[series.length - 1]}`;
      if (time != null) text += ` ${time}`;
      values.push({ text, value: text });
    });
  }
  return values;
}

// ─── Infinity legacy helpers ───────────────────────────────────────────────

/** Split `a, b, c` into trimmed arguments. Infinity's helpers do not nest. */
function splitArgs(inner) {
  return inner.split(',').map((part) => part.trim());
}

/**
 * Answer Infinity's browser-only variable helpers, or null when the text is
 * not one of them.
 *
 *   · `Collection(A,a,B,b)`          -> options A=a, B=b
 *   · `CollectionLookup(A,a,B,b,key)` -> the single value whose name is `key`
 *
 * Only these two: they are the ones Infinity documents as its legacy variable
 * syntax, and they never reach Grafana's backend, so nothing else can answer
 * them. `key` arrives already interpolated — a lookup keyed on another variable
 * is the entire reason CollectionLookup exists.
 */
export function infinityLegacyValues(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  const match = /^(Collection|CollectionLookup)\s*\((.*)\)$/is.exec(raw);
  if (!match) return null;

  const args = splitArgs(match[2]);
  if (match[1].toLowerCase() === 'collectionlookup') {
    const key = args.pop();
    for (let i = 0; i + 1 < args.length; i += 2) {
      if (args[i] === key) return [{ text: args[i + 1], value: args[i + 1] }];
    }
    return [];
  }

  const values = [];
  for (let i = 0; i + 1 < args.length; i += 2) {
    values.push({ text: args[i], value: args[i + 1] });
  }
  return values;
}

/**
 * The text of an Infinity legacy variable, or null when the variable is a
 * normal Infinity query.
 *
 * Saved as a bare string on old dashboards, and as
 * `{ queryType: 'legacy', query: '…' }` on current ones.
 */
export function infinityLegacyText(query) {
  if (typeof query === 'string') return query;
  if (query && typeof query === 'object' && query.queryType === 'legacy') {
    return typeof query.query === 'string' ? query.query : '';
  }
  return null;
}

// ─── Every other datasource ────────────────────────────────────────────────

/**
 * The /api/ds/query target a variable query becomes.
 *
 * An object query is sent as saved, since it already IS the datasource's own
 * query model. Infinity is the one wrapper to take off: its variable editor
 * stores the real query under `infinityQuery`. A string query (older SQL, Loki
 * and Elasticsearch dashboards) is offered under the keys those datasources read
 * it from; a datasource ignores keys it does not know.
 *
 * @returns {object|null} null when there is nothing to send
 */
export function variableTarget(query, { name, datasource }) {
  const refId = `variable-${name || 'query'}`;
  if (typeof query === 'string') {
    if (!query.trim()) return null;
    return { refId, datasource, query, rawSql: query, format: 'table' };
  }
  if (!query || typeof query !== 'object') return null;

  const model = query.infinityQuery && typeof query.infinityQuery === 'object'
    ? query.infinityQuery
    : query;
  return { ...model, refId: model.refId || refId, datasource };
}

/** A field's name as Grafana would display it, lower-cased for matching. */
function fieldName(field) {
  return String(field?.config?.displayNameFromDS || field?.name || '').toLowerCase();
}

/**
 * Data frames (Grafana's wire format) -> variable options.
 *
 * Grafana's own rule (toMetricFindValues): a column named `text` and/or
 * `value` (or `__text` / `__value`) says which is which; otherwise the first
 * string column is both. One deliberate difference: where Grafana gives up on a
 * result with no string column at all, this takes the first non-time column —
 * a Neo4j or SQL query returning integer ids is a perfectly good list of
 * options, and an empty picker is not a better answer.
 */
export function framesToVariableValues(frames) {
  const values = [];
  for (const frame of frames || []) {
    const fields = frame?.schema?.fields || [];
    if (!fields.length) continue;
    appendFrameOptions(values, fields, frame?.data?.values || []);
  }
  return values;
}

/** First index that isn't -1, else the fallback. */
function firstFound(index, other, fallback) {
  if (index >= 0) return index;
  return other >= 0 ? other : fallback;
}

/** Column index to use when neither `text` nor `value` is named. */
function fallbackColumnIndex(fields) {
  const stringIndex = fields.findIndex((field) => field?.type === 'string');
  if (stringIndex >= 0) return stringIndex;
  const nonTimeIndex = fields.findIndex((field) => field?.type !== 'time');
  return Math.max(nonTimeIndex, 0);
}

/** One frame's rows -> options pushed onto `values`. */
function appendFrameOptions(values, fields, columns) {
  const find = (predicate) => fields.findIndex(predicate);
  const textIndex = find((field) => ['text', '__text'].includes(fieldName(field)));
  const valueIndex = find((field) => ['value', '__value'].includes(fieldName(field)));
  const fallback = fallbackColumnIndex(fields);

  const textColumn = columns[firstFound(textIndex, valueIndex, fallback)] || [];
  const valueColumn = columns[firstFound(valueIndex, textIndex, fallback)] || [];
  const length = Math.max(textColumn.length, valueColumn.length);
  for (let row = 0; row < length; row++) {
    const value = valueColumn[row];
    const text = textColumn[row];
    if (value == null && text == null) continue;
    values.push({
      text: String(text ?? value),
      value: String(value ?? text),
    });
  }
}
