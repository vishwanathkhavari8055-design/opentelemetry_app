/**
 * Prometheus `format: "table"` — the label-to-column step Grafana does in the
 * browser, which this application otherwise never performs.
 *
 * ─── The problem this solves ────────────────────────────────────────────────
 *
 * A Prometheus query carries a `format` of `time_series`, `table` or `heatmap`.
 * It looks like a server-side concern and it is not: Grafana's Go backend
 * answers EVERY Prometheus query the same way, as one frame per series with two
 * fields — `Time` and the value — and the series' labels hanging off the value
 * field as `field.labels`. Turning that into a table is done afterwards, in the
 * browser, by the Prometheus datasource PLUGIN (`transformDFToTable` in its
 * result transformer).
 *
 * This application renders with @grafana/scenes through its own proxy
 * datasource, so no Prometheus plugin is loaded and that step simply never
 * happens — exactly the same class of gap as Infinity's browser parser in
 * ./infinity.js. A `format: "table"` query therefore arrives as N skinny
 * time-series frames with no label columns at all, and every downstream
 * transformation that names a label is left joining on a field that does not
 * exist.
 *
 * On "IoT Device Monitoring Dashboard" that is the whole failure of its main
 * panel: three queries return 13 series each, all correct, and its
 * `seriesToColumns` transformation joins them `byField: "assetid"` — a column
 * that only exists once labels have been promoted. The join matches nothing and
 * the panel reports "No data" over three perfectly good 200 responses. Its
 * `organize` transformation names `Value #A`, `assetid 1`, `__name__ 2`,
 * `Time 3` — the exact output shape of the function below, which is what
 * confirms this is the missing step rather than a dashboard that was never
 * right.
 *
 * ─── Matching Grafana rather than inventing ─────────────────────────────────
 *
 * The output is Grafana's, field for field and name for name, because the
 * dashboards being rendered were authored against it: the transformations and
 * field overrides saved in their JSON refer to these column names literally. A
 * "nicer" shape here would be a shape no existing dashboard asks for.
 *
 *   · fields are `[Time, ...labels sorted by name, Value]`
 *   · the value column is `Value #<refId>` when the response carried more than
 *     one refId, and plain `Value` when it carried exactly one
 *   · `le` is a number column (histogram buckets sort numerically); every other
 *     label is a string
 *   · one output frame per refId, with every series' rows concatenated
 */

/**
 * `FieldType`, inlined rather than imported from `@grafana/data`.
 *
 * It is a plain string enum there, so these are the identical values — but
 * importing it would pull the whole package in, and that package needs a
 * browser (`window`) at import time. Staying dependency-free is what lets this
 * module be unit-tested under bare `node --test`, the same reason ./infinity.js
 * imports nothing.
 */
const FieldType = { time: 'time', number: 'number', string: 'string' };

/** Prometheus-compatible datasource plugin ids. */
const PROM_TYPES = new Set(['prometheus', 'grafana-amazonprometheus-datasource']);

/**
 * Grafana's own name for the histogram bucket label.
 *
 * Typed as a number so a table sorted by it orders 1, 2, 10 rather than
 * 1, 10, 2 — the same special case Grafana makes.
 */
const LABEL_NAME_FOR_HISTOGRAM = 'le';

/** Whether a query asked for table format against a Prometheus datasource. */
function wantsTable(query, fallbackType) {
  if (query?.format !== 'table') return false;
  const type = query.datasource?.type || fallbackType;
  return PROM_TYPES.has(type);
}

/** `"NaN"`, `"+Inf"` and friends arrive as strings; everything else is a number. */
function parseSampleValue(value) {
  if (typeof value === 'number') return value;
  switch (value) {
    case '+Inf': return Number.POSITIVE_INFINITY;
    case '-Inf': return Number.NEGATIVE_INFINITY;
    default: return Number.parseFloat(value);
  }
}

/**
 * Promote labels to columns for the table-format queries in one response.
 *
 * @param {Array} frames    every frame the response produced, any refId
 * @param {Map}   sentByRef refId -> the query that was sent, for its `format`
 * @param {string} fallbackType the proxy's plugin type, when a query named none
 * @returns {Array} frames, with table-format refIds replaced by one table each
 */
export function applyPrometheusTableFormat(frames, sentByRef, fallbackType) {
  if (!Array.isArray(frames) || frames.length === 0) return frames;

  // Which refIds are in play at all — this is what decides `Value` vs
  // `Value #<refId>`, and Grafana counts the WHOLE response, not just the
  // table-format part of it.
  const refIdsInResponse = new Set(frames.map((frame) => frame.refId));

  const tableRefIds = new Set(
    [...refIdsInResponse].filter((refId) => wantsTable(sentByRef?.get(refId), fallbackType)),
  );
  if (tableRefIds.size === 0) return frames;

  const out = [];
  const grouped = new Map();
  for (const frame of frames) {
    if (!tableRefIds.has(frame.refId)) {
      // Not a table query — passed through exactly as it arrived.
      out.push(frame);
      continue;
    }
    if (!grouped.has(frame.refId)) grouped.set(frame.refId, []);
    grouped.get(frame.refId).push(frame);
  }

  for (const [refId, group] of grouped) {
    out.push(toTableFrame(refId, group, refIdsInResponse.size > 1));
  }
  return out;
}

/**
 * Every label any series in this group carries, sorted — so the column order
 * is stable across refreshes even when the first series changes shape.
 */
function labelFieldsFor(group) {
  const labelNames = new Set();
  for (const frame of group) {
    const labels = frame.fields?.[1]?.labels;
    if (labels) for (const name of Object.keys(labels)) labelNames.add(name);
  }
  return [...labelNames].sort((a, b) => a.localeCompare(b)).map((name) => ({
    name,
    config: { filterable: true },
    type: name === LABEL_NAME_FOR_HISTOGRAM ? FieldType.number : FieldType.string,
    values: [],
  }));
}

/**
 * A series missing a label gets an empty cell, not a dropped row — Grafana's
 * own behaviour, and what keeps an outer join lining up.
 */
function labelCell(field, raw) {
  if (raw === undefined) return '';
  return field.type === FieldType.number ? Number(raw) : raw;
}

/** One series' samples -> rows appended to the table's columns. */
function appendSeriesRows(frame, timeField, valueField, labelFields) {
  const time = frame.fields?.[0];
  const value = frame.fields?.[1];
  if (!value) return;
  const labels = value.labels ?? {};
  const rows = value.values?.length ?? 0;
  for (let row = 0; row < rows; row += 1) {
    timeField.values.push(time?.values?.[row]);
    valueField.values.push(parseSampleValue(value.values[row]));
    for (const field of labelFields) {
      field.values.push(labelCell(field, labels[field.name]));
    }
  }
}

/** One refId's series -> one table frame. */
function toTableFrame(refId, group, suffixValueName) {
  const timeField = {
    name: 'Time',
    type: FieldType.time,
    config: {},
    values: [],
  };
  const valueField = {
    name: suffixValueName ? `Value #${refId}` : 'Value',
    type: FieldType.number,
    config: {},
    values: [],
  };

  const labelFields = labelFieldsFor(group);

  for (const frame of group) {
    appendSeriesRows(frame, timeField, valueField, labelFields);
  }

  return {
    refId,
    name: group[0]?.name,
    meta: { ...group[0]?.meta, preferredVisualisationType: 'table' },
    fields: [timeField, ...labelFields, valueField],
    length: timeField.values.length,
  };
}
