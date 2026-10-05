/**
 * Alert → telemetry drill-through.
 *
 * ─── What "the telemetry this alert came from" can honestly mean ────────────
 *
 * A firing carries no pointer to a log record, a span or a metric series. What it
 * carries is an IDENTITY (a service, a pod, a container, a namespace — whatever the
 * notification template chose to send) and a TIME. So a drill is those two things
 * applied to the target screen, and nothing more is invented on the way.
 *
 * That is also the whole bug this module fixes. The Telemetry buttons used to
 * switch tab and, for Logs only, append a service clause to whatever query was
 * already in the editor — leaving the target screen on its own remembered time
 * range. An alert that fired at 04:10 opened a Logs screen showing the last fifteen
 * minutes of everything, which reads as "the link is broken" and is very nearly
 * true: the window is the half of the answer that was missing.
 *
 * ─── The window is built around the LATEST firing, not the incident ─────────
 *
 * `windowStart` is filled from the payload's `alert_start_time`, and in this
 * deployment that is when the INCIDENT opened — routinely days before the row you
 * clicked (a pod alert first seen on 12 Aug is still firing now). Opening
 * [windowStart, now] would be a four-day scan, which OpenObserve answers with an
 * empty result rather than an error (it caps the scan, see the 24h note below).
 *
 * So the window is anchored on `lastFiredAt` — the firing on screen — and spans the
 * rule's own evaluation period when the payload states one. Both `windowStart` and
 * `windowEnd` are honoured when BOTH arrive and the span between them is sane,
 * because that pair really is the evaluated window; a lone `windowStart` is not.
 *
 * ─── Only filters the target screen can actually apply ─────────────────────
 *
 * Every clause emitted here is one the receiving screen expresses exactly:
 * `service_name` and `trace_id` for Logs and Traces (see utils/logQuery.js — the
 * dialect has no others; anything else silently degrades to a full-text search that
 * matches nothing), and for Metrics only labels VERIFIED to carry the alert's value
 * — see resolveMetricIdentity. A drill that lands on an empty screen is worse than
 * no drill, because the operator reads the emptiness as an answer.
 */

/**
 * Values a notification template writes when it has no value for a dimension.
 *
 * Not a guess: `"namespace": "-"`, `"node": "-"`, `"pod": "-"` all arrive that way
 * from this deployment's own templates. Filtering on one would pin the query to a
 * literal dash and return nothing.
 */
const PLACEHOLDER_VALUES = new Set(['', '-', '--', 'n/a', 'na', 'none', 'null', 'unknown', 'undefined']);

const isRealValue = (v) => {
  const t = (v === null || v === undefined) ? '' : String(v).trim();
  return t !== '' && !PLACEHOLDER_VALUES.has(t.toLowerCase());
};

/** Minutes of telemetry to show before the firing when the rule states no period.
 *  The same span the Logs screen opens on by default, so the drill lands on a
 *  window an operator already reads as "just now". */
const DEFAULT_LEAD_MINUTES = 15;

/** Minutes kept AFTER the firing, so the row that tripped the rule is not sitting
 *  on the very edge of the window and the recovery (if any) is visible too. */
const TRAIL_MINUTES = 5;

/**
 * Widest window a drill will ever open.
 *
 * OpenObserve answers a scan that exceeds its window limit with HTTP 200 and zero
 * hits — indistinguishable from "nothing happened" — so a window wide enough to
 * trip it turns a working drill into a confident lie. Kept under a day for that
 * reason, not for tidiness.
 */
const MAX_SPAN_MINUTES = 12 * 60;

const MINUTE_MS = 60_000;

const parseInstant = (iso) => {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** ms → the `datetime-local` spelling TimeRangePicker holds (local wall time). */
const toLocalInput = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * The time range a drill from this alert should open on.
 *
 * Returns the same `{ mode, relative, from, to }` object every screen's
 * TimeRangePicker already speaks, so no caller has to convert anything.
 *
 * @param {object} alert an alert row
 * @param {number} [now] injectable clock, for the tests
 */
export function alertDrillWindow(alert, now = Date.now()) {
  const start = parseInstant(alert?.windowStart);
  const end = parseInstant(alert?.windowEnd);

  // The evaluated window, but only when the payload sent BOTH edges and they
  // describe a window rather than an incident that has been open for a week.
  if (start !== null && end !== null && end > start
      && (end - start) <= MAX_SPAN_MINUTES * MINUTE_MS) {
    return {
      mode: 'absolute',
      relative: `${DEFAULT_LEAD_MINUTES}m`,
      from: toLocalInput(start),
      to: toLocalInput(end + MINUTE_MS),
    };
  }

  // Otherwise: anchored on the firing that is on screen. `lastFiredAt` is set on
  // every stored row; `triggeredAt` covers a live-stream row that never reached
  // PostgreSQL, and `now` covers a malformed payload with neither.
  const anchor = parseInstant(alert?.lastFiredAt) ?? parseInstant(alert?.triggeredAt) ?? now;

  const period = Number(alert?.periodMinutes);
  const lead = Number.isFinite(period) && period > 0
    ? Math.min(period, MAX_SPAN_MINUTES)
    : DEFAULT_LEAD_MINUTES;

  return {
    mode: 'absolute',
    relative: `${DEFAULT_LEAD_MINUTES}m`,
    from: toLocalInput(anchor - lead * MINUTE_MS),
    to: toLocalInput(Math.min(anchor + TRAIL_MINUTES * MINUTE_MS, now + MINUTE_MS)),
  };
}

/** A trace id the query dialects will accept as an exact filter, or ''. */
const traceIdOf = (alert) => {
  const raw = String(alert?.traceId || '').trim();
  // Same shape utils/logQuery.js validates against before promoting a term to the
  // traceId parameter. A value that fails here would be sent as free text instead,
  // which matches nothing.
  return /^[a-f0-9]{16,32}$/i.test(raw) ? raw : '';
};

/** The service the alert names, or '' — `-` and friends are not a service. */
const serviceOf = (alert) => (isRealValue(alert?.serviceName) ? String(alert.serviceName).trim() : '');

/**
 * The Logs drill.
 *
 * Deliberately the same `{ services, severity, range }` shape the Analytics
 * dashboard already sends, plus `traceId` — so LogsView keeps ONE prefill path
 * rather than growing a second one that would drift from it.
 *
 * `severity` is always blank. An alert's severity is the RULE's grading
 * (critical/warning/disaster); a log line's is its own level, and the two are not
 * the same scale. Mapping one onto the other would hide the very lines that explain
 * the firing whenever a rule grades an INFO-level symptom as critical.
 */
export function buildLogsDrill(alert, now = Date.now()) {
  const service = serviceOf(alert);
  const traceId = traceIdOf(alert);
  return {
    services: service ? [service] : [],
    severity: '',
    traceId,
    range: alertDrillWindow(alert, now),
  };
}

/**
 * The Traces drill.
 *
 * `openTrace` is the one case where a drill can be exact: a trace id identifies a
 * single trace, so the screen opens that trace's waterfall directly instead of a
 * filtered list of one row.
 */
export function buildTracesDrill(alert, now = Date.now()) {
  const service = serviceOf(alert);
  const traceId = traceIdOf(alert);
  return {
    services: service ? [service] : [],
    traceId,
    openTrace: !!traceId,
    range: alertDrillWindow(alert, now),
  };
}

/**
 * Identifiers that look like a metric name.
 *
 * The underscore requirement is what separates a metric name from the prose around
 * it: `jvm_cpu_recent_utilization realtime - warn >= 50%` yields one candidate, not
 * four. A single-word metric (`up`) is missed by this and that is the right trade —
 * every prose word in a description would otherwise become a candidate, and the
 * first one that happened to collide with a catalogue entry would be plotted as
 * though the alert had named it.
 */
const METRIC_NAME_RE = /\b[a-zA-Z_:][a-zA-Z0-9:]*(?:_[a-zA-Z0-9:]+)+\b/g;

const metricNamesIn = (text) => String(text || '').match(METRIC_NAME_RE) || [];

/**
 * The Metrics drill.
 *
 * ─── Named, never guessed ──────────────────────────────────────────────────
 *
 * `candidates` holds only names the alert (or its rule) actually WROTE, most
 * authoritative first, and the caller keeps whichever exists in the metric
 * catalogue. Nothing is derived from the alert's display name: "K8s Pod High Memory
 * Usage" would resolve by word-matching to `k8s_pod_memory_usage`, while the rule
 * that fired reads `k8s_pod_memory_limit_utilization` — a chart whose numbers
 * disagree with the alert that led you to it. When no candidate survives, the
 * caller opens the service's metric inventory instead and says so, which is a
 * shorter answer but a true one.
 *
 * @param {object} alert an alert row
 * @param {object} [rule] the locally-stored rule, when this application owns one
 */
export function buildMetricsDrill(alert, rule, now = Date.now()) {
  const candidates = [];
  const push = (name) => {
    const t = String(name || '').trim();
    if (t && !candidates.includes(t)) candidates.push(t);
  };

  // 1. A metrics alert's stream IS the metric it evaluates.
  if (String(alert?.streamType || '').toLowerCase() === 'metrics') push(alert?.streamName);

  // 2. The description is generated from the rule and leads with the metric it
  //    tests — `jvm_gc_duration_bucket p95 - warn >= 50 ms`.
  metricNamesIn(alert?.description).forEach(push);
  metricNamesIn(alert?.summary).forEach(push);

  // Everything to this point is the alert NAMING a metric, which is the only
  // evidence strong enough to promise a chart before the catalogue has been asked.
  const named = candidates[0] || '';

  // 3. Whatever else the template labelled the measurement with, and the payload's
  //    own value keys. Both are long shots — `current_usage` and `value` ride along
  //    on nearly every firing and are not metric names — so they go last and are
  //    never advertised. They cost nothing: a name absent from the catalogue is
  //    dropped rather than plotted.
  push(alert?.labels?.metric);
  Object.keys(alert?.currentValues || {}).forEach(push);

  return {
    // The metric the alert actually NAMED, if it named one. Deliberately not the
    // same as `candidates[0]`, which may be a payload key that only might turn out
    // to be a metric — see step 3. This is the one the UI may promise.
    named,
    // A PromQL rule already states the exact expression that fired. Nothing this
    // module can build improves on it, so it is used verbatim.
    promql: String(rule?.queryCondition?.promql || '').trim(),
    candidates,
    identityValues: identityValuesOf(alert),
    serviceName: serviceOf(alert),
    range: alertDrillWindow(alert, now),
  };
}

/**
 * Label names that identify WHICH thing a series is about, most specific first.
 *
 * A schema convention, in the same spirit as LOG_COLUMN_TARGETS in
 * utils/logQuery.js: OTel and kube-state write the same dimension under several
 * spellings, and a deployment using none of them simply gets fewer filters —
 * never a wrong one, because every pair is verified against the metric's real
 * label values before it is used.
 */
const IDENTITY_LABELS = [
  'k8s_pod_name', 'pod',
  'k8s_container_name', 'container',
  'host_name', 'instance', 'k8s_node_name', 'node',
  'service_instance_id',
  'k8s_namespace_name', 'namespace',
  'service_name', 'service',
  'k8s_cluster', 'cluster', 'env', 'environment',
];

/**
 * At most two filters go into a selector.
 *
 * Each is verified to match on its own, but two labels verified separately can
 * still intersect to nothing if they belong to different series. Two is enough to
 * pin a pod within a service — the case this exists for — while keeping that risk
 * small and the expression readable.
 */
const MAX_IDENTITY_FILTERS = 2;

/**
 * Everything this alert says about WHICH entity it is about, deduplicated.
 *
 * The modelled fields first (the backend chose those as the alert's identity),
 * then the conventional identity labels from the payload. Placeholders are
 * dropped — see PLACEHOLDER_VALUES.
 */
export function identityValuesOf(alert) {
  const out = [];
  const add = (v) => {
    if (!isRealValue(v)) return;
    const t = String(v).trim();
    if (!out.includes(t)) out.push(t);
  };

  // Host before service: a pod name identifies one replica, a service name a set.
  add(alert?.hostName);
  add(alert?.serviceName);
  add(alert?.namespace);
  add(alert?.environment);
  IDENTITY_LABELS.forEach((label) => add(alert?.labels?.[label]));
  return out;
}

/**
 * Which `label="value"` clauses can be attached to `metric` for this alert.
 *
 * ─── Verified against the real label values, one call per label ─────────────
 *
 * Not optional rigour. `kube_pod_container_status_restarts_total` carries a
 * `service_name`, but it is written by kube-state-metrics — its values are
 * scrape targets like `argocd-metrics`, never the alerting service. Attaching
 * `service_name="tiotdlhsvc"` there produces a valid PromQL query, a 200 response
 * and an empty chart, on the exact screen an operator opened to see the spike. The
 * same alert's `container` label DOES carry that value, and this is what finds it.
 *
 * Both fetchers are injected so this is testable without a backend and so the
 * caller keeps ownership of aborting.
 *
 * @returns {Promise<Array<[string, string]>>} verified clauses, most specific first
 */
export async function resolveMetricIdentity({
  metric, identityValues, fetchLabels, fetchLabelValues, signal,
}) {
  if (!metric || !identityValues?.length) return [];

  let labelNames = [];
  try {
    labelNames = await fetchLabels({ metric, signal });
  } catch {
    // A metric whose labels cannot be read is still worth plotting unfiltered —
    // losing the chart because the narrowing failed is the wrong trade.
    return [];
  }

  const present = IDENTITY_LABELS.filter((l) => labelNames.includes(l));
  if (!present.length) return [];

  const wanted = new Set(identityValues.map((v) => v.toLowerCase()));
  const settled = await Promise.all(present.map(async (label) => {
    try {
      const values = await fetchLabelValues({ label, metric, signal });
      const hit = (values || []).find((v) => wanted.has(String(v).trim().toLowerCase()));
      return hit ? [label, String(hit).trim()] : null;
    } catch {
      return null;
    }
  }));

  const chosen = [];
  const usedValues = new Set();
  for (const pair of settled) {
    if (!pair) continue;
    // Two spellings of one dimension (`pod` and `k8s_pod_name`) narrow to the same
    // series twice. The more specific spelling is already first.
    if (usedValues.has(pair[1])) continue;
    usedValues.add(pair[1]);
    chosen.push(pair);
    if (chosen.length >= MAX_IDENTITY_FILTERS) break;
  }
  return chosen;
}

/**
 * What a Telemetry button will actually do, in one sentence.
 *
 * Rendered next to the buttons rather than kept as a tooltip: the three signals
 * scope differently for the same alert, and an operator who is told "logs for
 * StreamMonitorService around 06:30" before clicking does not have to reverse
 * engineer the query they land on.
 */
export function drillHint(target, alert, rule) {
  const service = serviceOf(alert);
  const traceId = traceIdOf(alert);
  const scope = service ? `service ${service}` : 'every service';

  if (target === 'logs') {
    if (traceId) return `Logs of trace ${traceId.slice(0, 12)}… in the firing window.`;
    return `Logs for ${scope} in the firing window. This alert carries no trace id, `
      + 'and the logs query filters by service, severity and trace only — so the '
      + 'window and the service are the whole of what can be applied exactly.';
  }

  if (target === 'traces') {
    if (traceId) return `Opens trace ${traceId.slice(0, 12)}… directly.`;
    return `Spans for ${scope} in the firing window. No trace id on this alert, `
      + 'so the list is scoped rather than pinned to one trace.';
  }

  if (target === 'metrics') {
    const drill = buildMetricsDrill(alert, rule);
    if (drill.promql) return 'Plots the rule\'s own PromQL over the firing window.';
    if (drill.named) {
      return `Plots ${drill.named} over the firing window, narrowed to this `
        + 'alert\'s pod or service where the metric carries that label.';
    }
    return service
      ? `This alert names no metric, so Metrics opens ${service}'s inventory for you `
        + 'to pick from rather than plotting a guess.'
      : 'This alert names neither a metric nor a service, so there is nothing to plot.';
  }
  return '';
}

/** Whether a Telemetry button can do anything at all for this alert. */
export function canDrill(target, alert) {
  if (!alert) return false;
  if (target === 'metrics') return true; // always at least the inventory or the catalogue
  return !!serviceOf(alert) || !!traceIdOf(alert);
}

export const __testing = {
  DEFAULT_LEAD_MINUTES, TRAIL_MINUTES, MAX_SPAN_MINUTES, IDENTITY_LABELS,
  MAX_IDENTITY_FILTERS, isRealValue, metricNamesIn, toLocalInput,
};
