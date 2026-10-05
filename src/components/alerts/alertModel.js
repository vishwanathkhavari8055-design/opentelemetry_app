/**
 * The alert document, and the rules for reading and writing it.
 *
 * Everything that knows OpenObserve's on-the-wire shape lives here so the
 * components stay about layout. Three ideas are worth understanding before
 * changing any of it.
 *
 * ── 1. Conditions are a recursive tree, not a list ────────────────────────
 *
 * OpenObserve stores `query_condition.conditions` as a single group keyed by its
 * join operator, whose entries are either a leaf condition or another group:
 *
 *   { "and": [
 *       { "column": "service_name", "operator": "=", "value": "checkout" },
 *       { "or": [ {...}, {...} ] }
 *   ]}
 *
 * A bare array is also accepted on write and is normalised by the server to
 * `{"and":[…]}`. Both shapes are read here; only the keyed form is written.
 *
 * ── 2. The document is round-tripped, not rebuilt ─────────────────────────
 *
 * `applyForm` MERGES form values into the document the server sent. It must not
 * be turned into a "build a fresh alert from the form" function: the document
 * carries keys this UI never renders (`anomaly_config`, `search_event_type`,
 * `workflows`, …) and rebuilding it would silently drop them on the first save.
 * That is the single most important property of this module — it is what lets an
 * alert authored in OpenObserve's own UI be edited here without damage.
 *
 * The same rule applies one level down, per field: a key the user has not filled
 * in is left ABSENT rather than written as an empty value, unless the document
 * already carried it — in which case emptying it is the user clearing it and has
 * to be written. See `setOrDrop`, and the `deduplication` branch that mirrors it
 * for a whole sub-object.
 *
 * ── 3. Units ──────────────────────────────────────────────────────────────
 *
 * `period`, `silence` and `frequency` are all MINUTES (frequency is ignored for
 * `frequency_type: "cron"`, where `cron` holds the expression). OpenObserve
 * stores them verbatim, so the editor labels them and passes them through
 * without arithmetic in either direction.
 *
 * Worth stating explicitly because OpenObserve's own OpenAPI document annotates
 * `frequency` as "(seconds)", which is wrong. Verified against this instance by
 * saving an alert with `frequency: 0`: it came back as `1`, clamped to the
 * minimum schedule interval expressed in minutes. Had the field been seconds it
 * would have come back as 60. Do not "fix" this by multiplying by 60 — that
 * would make every alert evaluate an hour apart instead of a minute.
 */

/** Stream types an alert can watch. */
export const STREAM_TYPES = [
  { value: 'logs',    label: 'Logs' },
  { value: 'metrics', label: 'Metrics' },
  { value: 'traces',  label: 'Traces' },
];

/** The two alert types the one-screen editor writes. */
export const ALERT_TYPES = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'realtime',  label: 'Realtime' },
];

/**
 * The three the WIZARD offers.
 *
 * <p>Held apart from {@link ALERT_TYPES} on purpose. The one-screen editor has
 * no way to express a composite — no sub-alert list, no expression box — so
 * offering the option there would let someone convert a working alert into one
 * the very same screen then cannot show or save back. The editor keeps the two
 * it can draw; a composite is created in the wizard.</p>
 */
export const WIZARD_ALERT_TYPES = [
  ...ALERT_TYPES,
  { value: 'composite', label: 'Composite' },
];

/**
 * How a composite treats a child whose state has gone stale.
 *
 * <p>Stale means the child has not re-evaluated inside its own freshness
 * deadline — it was disabled, or its schedule is slower than the composite's,
 * or it is simply broken. The three answers are genuinely different alerting
 * postures and there is no safe default: "treat as false" cannot page you about
 * a monitor that has stopped reporting, and "treat as true" will page you every
 * cooldown until someone fixes it. OpenObserve defaults to the middle course.</p>
 *
 * <p>Values are OpenObserve's own `CompositeStaleChildPolicy` enum. Its schema
 * notes the on-disk mapping is append-only, so these strings are never
 * renamed — a renamed variant decodes existing rows as a different policy.</p>
 */
export const STALE_CHILD_POLICIES = [
  {
    value: 'use_last_state',
    label: 'Use last state',
    hint: 'When freshness expires, keep using the child\u2019s last computed state.',
  },
  {
    value: 'treat_as_false',
    label: 'Treat as not firing',
    hint: 'A stale child counts as false — the composite will not fire on it alone.',
  },
  {
    value: 'treat_as_true',
    label: 'Treat as firing',
    hint: 'A stale child counts as true — a monitor that stops reporting pages you.',
  },
];

/** OpenObserve accepts 2–10 children in one composite expression. */
export const COMPOSITE_MIN_CHILDREN = 2;
export const COMPOSITE_MAX_CHILDREN = 10;

/** Comparison operators, exactly OpenObserve's `Operator` enum. */
export const CONDITION_OPERATORS = [
  { value: '=',            label: '=' },
  { value: '!=',           label: '!=' },
  { value: '>',            label: '>' },
  { value: '>=',           label: '>=' },
  { value: '<',            label: '<' },
  { value: '<=',           label: '<=' },
  { value: 'contains',     label: 'Contains' },
  { value: 'not_contains', label: 'Not Contains' },
];

/** Threshold operators on the trigger condition. Same enum, shown separately. */
export const THRESHOLD_OPERATORS = CONDITION_OPERATORS.filter(
  (o) => !['contains', 'not_contains'].includes(o.value),
);

/**
 * Operators that compare a column against NOTHING.
 *
 * <p>The four presence tests OpenObserve's current alert UI offers. They are held
 * apart from the comparison operators because the value box has to DISAPPEAR for
 * them — a control asking what to compare `is_null` against has no answer, and
 * whatever the user types in it is discarded on save.</p>
 *
 * <p>The wire values are OpenObserve's own, snake_cased where the two
 * text operators are not; both spellings were read off its condition-operator
 * select rather than guessed, because a value it does not recognise is stored
 * and then silently never matches.</p>
 */
export const VALUELESS_OPERATORS = ['is_null', 'is_not_null', 'is_empty', 'is_not_empty'];

/** True when {@link VALUELESS_OPERATORS} holds this operator. */
export const isValuelessOperator = (operator) => VALUELESS_OPERATORS.includes(operator);

/**
 * The full filter-operator list the reference UI offers, presence tests included.
 *
 * <p>Separate from {@link CONDITION_OPERATORS} rather than replacing it. The
 * one-screen editor has shipped with the eight comparison operators and its
 * saved alerts round-trip through them; widening that constant would change what
 * every existing condition row offers as a side effect of building a new screen.
 * A component takes whichever list its screen means to offer.</p>
 */
export const FILTER_OPERATORS = [
  ...CONDITION_OPERATORS,
  { value: 'is_null',       label: 'Is Null' },
  { value: 'is_not_null',   label: 'Is Not Null' },
  { value: 'is_empty',      label: 'Is Empty' },
  { value: 'is_not_empty',  label: 'Is Not Empty' },
];

/** Aggregation functions, OpenObserve's `AggFunction` enum. */
export const AGG_FUNCTIONS = [
  'avg', 'min', 'max', 'sum', 'count', 'median', 'p50', 'p75', 'p90', 'p95', 'p99',
];

/**
 * The sentinel the "Alert if" picker uses for "do not aggregate at all".
 *
 * <p>NOT a value that is ever written: an alert with no aggregation has
 * `query_condition.aggregation: null` and compares the matched ROW COUNT through
 * `trigger_condition.threshold`. The sentinel only exists so one control can
 * offer that choice alongside the eleven real functions, which is how the
 * reference UI puts the question — and it is the right way to put it, because
 * "count the events" and "average a column" are the same decision.</p>
 */
export const TOTAL_EVENTS = '__total_events__';

/**
 * Everything the "Alert if" picker offers, in the reference's order.
 *
 * <p>`count` is BOTH here and in {@link AGG_FUNCTIONS} and is not the same thing
 * as {@link TOTAL_EVENTS}: total events counts matched rows with no GROUP BY,
 * `count` is `count(<column>)` inside an aggregation and can be grouped.</p>
 */
export const ALERT_IF_OPTIONS = [
  { value: TOTAL_EVENTS, label: 'total events' },
  ...AGG_FUNCTIONS.map((f) => ({ value: f, label: f })),
];

/**
 * Which "Alert if" functions need a column to aggregate.
 *
 * <p>`count` does not — `count(*)` grouped by something is a legitimate rule and
 * the reference leaves its column picker optional. Everything else averages,
 * sums or takes a percentile OF something, and has nothing to do without it.</p>
 */
export const AGG_NEEDS_COLUMN = AGG_FUNCTIONS.filter((f) => f !== 'count');

/**
 * How often a scheduled alert re-evaluates, as the wizard asks it.
 *
 * <p>Hours is presentation only: `trigger_condition.frequency` is MINUTES (see
 * the note at the top of this file) and there is no hourly frequency_type, so
 * the unit is multiplied out on the way into the form and never stored. Cron is
 * a real `frequency_type` and brings its own expression and timezone.</p>
 */
export const FREQUENCY_UNITS = [
  { value: 'minutes', label: 'Minutes', minutes: 1 },
  { value: 'hours',   label: 'Hours',   minutes: 60 },
  { value: 'cron',    label: 'Cron',    minutes: 0 },
];

/**
 * Units the "Hold for" tolerance can be written in.
 *
 * <p>`trigger_condition.tolerance_in_secs` is SECONDS on the wire — there is no
 * unit field beside it — so Minutes is presentation only and is multiplied out
 * on the way into the document, exactly the way {@link FREQUENCY_UNITS} handles
 * Hours.</p>
 */
export const HOLD_FOR_UNITS = [
  { value: 'seconds', label: 'Seconds', seconds: 1 },
  { value: 'minutes', label: 'Minutes', seconds: 60 },
];

/** `query_condition.type` — how the alert expresses what to look for. */
export const QUERY_TYPES = [
  { value: 'custom', label: 'Custom' },
  { value: 'sql',    label: 'SQL' },
  { value: 'promql', label: 'PromQL' },
];

/** OpenObserve's root alert folder, which is addressed by this literal id. */
export const DEFAULT_FOLDER_ID = 'default';

/**
 * `priority` — P1 (most urgent) … P5. Sent as a NUMBER, or the key is omitted.
 *
 * Routing metadata only: OpenObserve uses it for filtering, sorting and
 * destination routing and it has no effect on when the alert fires. The select
 * holds strings because that is what a DOM `<select>` gives back; the number
 * conversion happens once, in {@link applyForm}.
 */
export const PRIORITIES = [1, 2, 3, 4, 5].map((n) => ({
  value: String(n), label: `P${n}`,
}));

/**
 * Operators a per-group / per-series alert may use.
 *
 * Such an alert fires on ANY group that breaches, so the comparison has to be
 * ordered — "= 5 groups" cannot be evaluated one group at a time. OpenObserve
 * rejects the equality operators here, so they are excluded rather than sent
 * and bounced.
 */
export const ORDERED_OPERATORS = ['>', '>=', '<', '<='];

/** `row_template_type` — how the per-row template output is assembled. */
export const ROW_TEMPLATE_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'json',   label: 'JSON' },
];

/**
 * Units a comparison-window offset can be written in.
 *
 * These single letters are OpenObserve's own suffixes, and `M` (month) really is
 * capitalised where `m` is minutes — the two are NOT interchangeable, so the
 * values are never lower-cased anywhere in this module.
 */
export const OFFSET_UNITS = [
  { value: 's', label: 'Seconds' },
  { value: 'm', label: 'Minutes' },
  { value: 'h', label: 'Hours' },
  { value: 'd', label: 'Days' },
  { value: 'w', label: 'Weeks' },
  { value: 'M', label: 'Months' },
];

/* ── the VRL function is stored base64url-encoded ───────────────────────── */

/**
 * OpenObserve stores `query_condition.vrl_function` BASE64URL-ENCODED, not as
 * plain text — and its own alphabet at that: `+` → `-`, `/` → `_`, `=` → `.`.
 *
 * This matters in both directions. A VRL body saved as plain text is stored
 * as-is and then fails to decode when the alert evaluates, so the transform
 * silently does nothing; and an alert authored in OpenObserve's UI opens here
 * showing base64 gibberish in the VRL box, which a user would reasonably
 * "correct" by deleting.
 *
 * @returns the encoded string, or null when the input cannot be encoded
 */
const b64UrlEncode = (text) => {
  try {
    const utf8 = encodeURIComponent(text)
      .replaceAll(/%([0-9A-F]{2})/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
    return btoa(utf8).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '.');
  } catch {
    return null;
  }
};

/** Inverse of {@link b64UrlEncode}; null when the input is not valid base64url. */
const b64UrlDecode = (text) => {
  try {
    const b64 = text.replaceAll('-', '+').replaceAll('_', '/').replaceAll('.', '=');
    const bytes = atob(b64);
    return decodeURIComponent(
      Array.prototype.map
        .call(bytes, (c) => `%${c.codePointAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
  } catch {
    return null;
  }
};

/**
 * True when a string is plausibly one of our own encodings.
 *
 * Real VRL contains spaces, dots and `=`, so it fails the alphabet test almost
 * immediately. The `decoded !== value` guard rejects the degenerate case where a
 * string decodes to itself.
 */
const looksEncoded = (value) => {
  if (!value || typeof value !== 'string' || !/^[A-Za-z0-9\-_.]+$/.test(value)) return false;
  const decoded = b64UrlDecode(value);
  return decoded !== null && decoded !== value;
};

/**
 * Decode a stored VRL body for display, tolerating one that was stored plain.
 *
 * Deliberately forgiving, and in the same way OpenObserve's own reader is: this
 * app previously wrote the field as plain text, so both encodings exist in the
 * wild and neither may be shown as raw base64 or destroyed. The double-decode
 * handles a body that was encoded twice by a UI that read a plain value and
 * re-encoded it on save.
 */
export const decodeVrl = (stored) => {
  if (!stored) return '';
  const once = b64UrlDecode(stored);
  if (once === null) return stored;
  if (looksEncoded(once)) {
    const twice = b64UrlDecode(once);
    if (twice !== null) return twice;
  }
  return once;
};

/** Encode a VRL body for the wire. Falls back to the raw text if btoa refuses. */
export const encodeVrl = (text) => {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  return b64UrlEncode(trimmed) ?? trimmed;
};

/* ── comparison windows (`query_condition.multi_time_range`) ─────────────── */

const OFFSET_RE = /^(\d+)([smhdwM])$/;

/** Split `"15m"` into `{ amount: '15', unit: 'm' }`, defaulting on junk. */
export const parseOffset = (offset) => {
  const m = OFFSET_RE.exec((offset ?? '').toString().trim());
  return m ? { amount: m[1], unit: m[2] } : { amount: '15', unit: 'm' };
};

/** "15 Minutes" — the label the comparison row reads back to the user. */
export const formatOffset = (amount, unit) => {
  const n = Number(amount);
  const label = OFFSET_UNITS.find((u) => u.value === unit)?.label || unit;
  if (!Number.isFinite(n)) return `— ${label}`;
  // "1 Minutes" reads as a bug, so the singular is trimmed off the plural label.
  return `${n} ${n === 1 ? label.replace(/s$/, '') : label}`;
};

/**
 * A client id for a comparison window.
 *
 * OpenObserve puts a `uuid` on each entry and keys its own list off it. New
 * windows get a real uuid where the browser offers one so that a window added
 * here is indistinguishable from one added there.
 */
/** Keeps ids unique within the page when there is no crypto at all. */
let windowSeq = 0;
const newWindowUuid = () => {
  if (typeof crypto === 'undefined') {
    windowSeq += 1;
    return `w${Date.now().toString(36)}${windowSeq.toString(36)}`;
  }
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // randomUUID exists only in secure contexts, so a page served over plain http
  // lands here. getRandomValues is available there too.
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
  return `w${Date.now().toString(36)}${suffix}`;
};

/**
 * A fresh comparison window, defaulting to the reference UI's 15 minutes.
 *
 * `key` is React's identity for the row and never reaches the wire; `uuid` is
 * OpenObserve's and does.
 */
export const newComparisonWindow = () => ({
  key: nextKey(), uuid: newWindowUuid(), amount: '15', unit: 'm',
});

/* ── ids for the condition tree ─────────────────────────────────────────── */

let seq = 0;
/**
 * Client-only key for a condition row or group.
 *
 * React needs a stable identity per row, and the condition objects have no id
 * of their own. Using the array index instead would re-key every row below a
 * deletion, which makes the focused input jump to a different condition
 * mid-edit. These keys are stripped by `toWireConditions` before saving.
 */
export const nextKey = () => {
  seq += 1;
  return `c${seq}`;
};

/* ── reading the wire shape ─────────────────────────────────────────────── */

/** True when a node is a v1 group rather than a leaf condition. */
const groupJoin = (node) => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node.and)) return 'and';
  if (Array.isArray(node.or)) return 'or';
  return null;
};

/**
 * Detect OpenObserve's SECOND condition serialisation.
 *
 * There are two live formats and which one you get depends on which UI wrote the
 * alert:
 *
 *   v1 (this app, and OpenObserve's older exports)
 *     {"and":[{"column":"service_name","operator":"=","value":"x","ignore_case":false}]}
 *
 *   v2 (OpenObserve's current web UI)
 *     {"version":2,"conditions":{
 *        "filterType":"group","logicalOperator":"AND","conditions":[
 *          {"filterType":"condition","column":"service_name","operator":"=",
 *           "value":"x","logicalOperator":"AND"}]}}
 *
 * Both must be READ, or an alert authored in OpenObserve opens here showing a
 * single blank condition — and saving it then writes that blank over the real
 * rule. That is silent destruction of a live alert, which is why this is handled
 * rather than left to the v1 path's accidental behaviour.
 */
const isV2Conditions = (raw) => !!raw
  && typeof raw === 'object'
  && !Array.isArray(raw)
  && (raw.version === 2 || (raw.conditions && typeof raw.conditions === 'object'));

const V2_JOIN = (node) => ((node?.logicalOperator || 'AND').toUpperCase() === 'OR' ? 'or' : 'and');

/**
 * Parse `query_condition.conditions` into the editor's tree.
 *
 * Handles both serialisations above, a bare array (accepted on write and
 * produced by some exports), and null/absent for an alert with no conditions.
 *
 * The detected format is recorded on the returned root as `wireVersion` so
 * {@link toWireConditions} can write the SAME format back. Rewriting a v2 alert
 * as v1 would work — OpenObserve accepts both — but it would silently migrate
 * someone else's document on an unrelated edit, and this module's whole contract
 * is that a round-trip changes only what the user changed.
 */
export const parseConditions = (raw) => {
  const emptyGroup = () => ({
    key: nextKey(), kind: 'group', join: 'and', items: [], wireVersion: 1,
  });

  const leaf = (node) => ({
    key: nextKey(),
    kind: 'condition',
    column: node.column ?? '',
    operator: node.operator ?? '=',
    // Values arrive as strings, numbers or booleans; the input is textual, so
    // they are normalised to a string here and re-typed on the way out.
    value: node.value === null || node.value === undefined ? '' : String(node.value),
    ignoreCase: !!node.ignore_case,
  });

  /** v2: nodes are tagged by `filterType`. */
  const parseV2 = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.filterType === 'group' || Array.isArray(node.conditions)) {
      return {
        key: nextKey(),
        kind: 'group',
        join: V2_JOIN(node),
        items: (node.conditions || []).map(parseV2).filter(Boolean),
      };
    }
    return leaf(node);
  };

  /** v1: groups are keyed by their join operator. */
  const parseV1 = (node) => {
    const join = groupJoin(node);
    if (join) {
      return {
        key: nextKey(),
        kind: 'group',
        join,
        items: (node[join] || []).map(parseV1).filter(Boolean),
      };
    }
    if (!node || typeof node !== 'object') return null;
    return leaf(node);
  };

  if (!raw) return emptyGroup();

  if (Array.isArray(raw)) {
    return {
      key: nextKey(), kind: 'group', join: 'and', wireVersion: 1,
      items: raw.map(parseV1).filter(Boolean),
    };
  }

  if (isV2Conditions(raw)) {
    const root = parseV2(raw.conditions ?? raw);
    if (!root) return { ...emptyGroup(), wireVersion: 2 };
    const asGroup = root.kind === 'group'
      ? root
      : { key: nextKey(), kind: 'group', join: 'and', items: [root] };
    return { ...asGroup, wireVersion: 2 };
  }

  const parsed = parseV1(raw);
  // A single leaf at the root is wrapped, so the editor always has a group to
  // add siblings to.
  if (parsed?.kind === 'condition') {
    return {
      key: nextKey(), kind: 'group', join: 'and', items: [parsed], wireVersion: 1,
    };
  }
  return parsed ? { ...parsed, wireVersion: 1 } : emptyGroup();
};

/* ── writing the wire shape ─────────────────────────────────────────────── */

/**
 * Coerce a textual condition value back to a number or boolean where that is
 * unambiguous.
 *
 * OpenObserve compares numerically only when the JSON value is a number, so a
 * threshold typed as "500" must not be sent as the string "500" — `code >= "500"`
 * is a string comparison and quietly matches the wrong rows. Anything that is
 * not exactly a number or a boolean literal stays a string.
 */
const typedValue = (value) => {
  const v = (value ?? '').toString().trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Number() accepts '' and whitespace, so the emptiness check above matters.
  // A leading-zero string like "007" is deliberately kept as a string: it is an
  // identifier, not a quantity.
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^-?0\d/.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
};

/**
 * Convert the editor tree back to OpenObserve's v1 keyed-group shape.
 *
 * Empty groups and conditions with no column are dropped rather than sent: a
 * half-filled row is a row the user has not finished, and forwarding it would
 * either be rejected or, worse, silently match everything.
 *
 * @returns the group object, or null when nothing usable remains
 */
const toWireV1 = (node) => {
  if (!node) return null;
  if (node.kind === 'condition') {
    if (!node.column?.trim()) return null;
    return {
      column: node.column.trim(),
      operator: node.operator || '=',
      value: typedValue(node.value),
      ignore_case: !!node.ignoreCase,
    };
  }
  const items = (node.items || []).map(toWireV1).filter(Boolean);
  if (!items.length) return null;
  return { [node.join === 'or' ? 'or' : 'and']: items };
};

/**
 * Convert the editor tree back to OpenObserve's v2 tagged shape.
 *
 * `logicalOperator` is repeated on every leaf as well as on the group, because
 * that is what OpenObserve's own UI emits and its reader keys off the tag rather
 * than inferring position.
 *
 * Values are stringified: observed v2 documents carry `"value":"1"` where the
 * equivalent v1 document carries `"value":1`. Sending a number into a v2
 * document would be a shape this format is not seen to use.
 */
const toWireV2Node = (node, parentJoin) => {
  if (!node) return null;
  const logicalOperator = (parentJoin === 'or' ? 'OR' : 'AND');
  if (node.kind === 'condition') {
    if (!node.column?.trim()) return null;
    const v = typedValue(node.value);
    return {
      filterType: 'condition',
      column: node.column.trim(),
      operator: node.operator || '=',
      value: v === '' ? '' : String(v),
      logicalOperator,
    };
  }
  const items = (node.items || [])
    .map((child) => toWireV2Node(child, node.join))
    .filter(Boolean);
  if (!items.length) return null;
  return {
    filterType: 'group',
    logicalOperator: node.join === 'or' ? 'OR' : 'AND',
    conditions: items,
  };
};

/**
 * Serialise the condition tree in the format it was read in.
 *
 * @param node    the editor tree
 * @param version 1 or 2; defaults to 1 for a newly created alert
 */
export const toWireConditions = (node, version) => {
  if (!node) return null;
  if (Number(version) === 2) {
    const root = toWireV2Node(node, node.join);
    return root ? { version: 2, conditions: root } : null;
  }
  return toWireV1(node);
};

/** Count the leaf conditions in a tree, for the summary panel. */
export const countConditions = (node) => {
  if (!node) return 0;
  if (node.kind === 'condition') return node.column?.trim() ? 1 : 0;
  return (node.items || []).reduce((sum, n) => sum + countConditions(n), 0);
};

/* ── tree editing ───────────────────────────────────────────────────────── */

/** A fresh leaf condition. */
export const newCondition = () => ({
  key: nextKey(),
  kind: 'condition',
  column: '',
  operator: '=',
  value: '',
  ignoreCase: false,
});

/** A fresh nested group, pre-seeded with one row so it is not an empty box. */
export const newGroup = () => ({
  key: nextKey(),
  kind: 'group',
  join: 'and',
  items: [newCondition()],
});

/**
 * Return a copy of `tree` with the node at `key` replaced by `updater`'s result.
 *
 * Returning a new object at every level on the path (and reusing untouched
 * subtrees) is what lets React see the change without the whole tree being
 * re-created on each keystroke.
 */
export const updateNode = (tree, key, updater) => {
  if (!tree) return tree;
  if (tree.key === key) return updater(tree);
  if (tree.kind !== 'group') return tree;
  let changed = false;
  const items = tree.items.map((child) => {
    const next = updateNode(child, key, updater);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...tree, items } : tree;
};

/** Remove the node with `key`. The root group is never removed. */
export const removeNode = (tree, key) => {
  if (tree?.kind !== 'group') return tree;
  let changed = false;
  const items = [];
  for (const child of tree.items) {
    if (child.key === key) { changed = true; continue; }
    const next = removeNode(child, key);
    if (next !== child) changed = true;
    items.push(next);
  }
  return changed ? { ...tree, items } : tree;
};

/**
 * Swap the entry at `index` of group `groupKey` with the neighbour `delta` away.
 *
 * Reordering is presentational, not semantic: a group is joined by ONE operator,
 * so `a AND b` and `b AND a` evaluate identically. It still earns a control,
 * because the order is what gets stored and what the next reader of the alert
 * sees — a rule that reads "service = checkout AND code >= 500" is worth being
 * able to arrange, and the alternative is delete-and-retype.
 *
 * Out-of-range moves return the group untouched, so the caller does not have to
 * bounds-check the ends of the list.
 */
export const moveNode = (tree, groupKey, index, delta) => updateNode(
  tree, groupKey, (group) => {
    const to = index + delta;
    if (to < 0 || to >= group.items.length) return group;
    const items = [...group.items];
    items[index] = group.items[to];
    items[to] = group.items[index];
    return { ...group, items };
  },
);

/* ── the alert document ─────────────────────────────────────────────────── */

/**
 * A new alert's document, matching the defaults the reference UI opens with:
 * scheduled, 10-minute window, evaluated every minute, 10-minute cooldown.
 */
export const emptyAlertDoc = () => ({
  name: '',
  description: '',
  stream_type: 'logs',
  stream_name: '',
  is_real_time: false,
  enabled: true,
  query_condition: {
    type: 'custom',
    conditions: { and: [] },
    sql: null,
    promql: null,
    aggregation: null,
    vrl_function: null,
    // Only meaningful for a PromQL alert, but present and null here because
    // OpenObserve's own new-alert document carries them — an absent key and a
    // null key are not the same thing to its deserialiser.
    promql_condition: null,
    promql_multi_alert: false,
    multi_time_range: [],
  },
  trigger_condition: {
    period: 10,
    operator: '>=',
    threshold: 3,
    frequency: 1,
    frequency_type: 'minutes',
    cron: '',
    silence: 10,
    timezone: 'UTC',
    // "Hold for": the condition must stay true this long before the alert
    // fires, which is what stops a one-second spike paging anybody. Null, not
    // 0 — that is what OpenObserve's own new-alert document carries, and its
    // deserialiser does not treat an absent key and a null key alike.
    tolerance_in_secs: null,
    align_time: true,
  },
  destinations: [],
  context_attributes: {},
  row_template: '',
  creates_incident: false,
  // Absent rather than null for a non-composite alert — see applyForm. A new
  // document is scheduled, so it carries no composite_condition at all.
});

/**
 * Give an empty condition tree one blank row.
 *
 * The reference UI opens with a single empty condition already on screen, and
 * an empty bordered box whose only content is an "add" link reads as though
 * conditions were optional.
 *
 * Costs nothing on the wire: `toWireConditions` drops a row with no column, and
 * `countConditions` does not count one either — so "Add at least one condition"
 * still fires until a column is actually chosen.
 */
const seedConditions = (root) => {
  if (root?.kind !== 'group' || root?.items?.length) return root;
  return { ...root, items: [newCondition()] };
};

/**
 * Render a stored number into a text input's value.
 *
 * `0` is a legitimate threshold, so this cannot be written as `value || ''` —
 * that turns a real zero into an empty box and then into the fallback on the
 * way back out.
 */
const numText = (value, fallback) => (
  value === undefined || value === null || value === '' ? fallback : String(value)
);

/* ── composite expressions ──────────────────────────────────────
 *
 * A composite's expression is stored over ALERT IDS in braces:
 *
 *   {3J7xjrR4FBY25cvd1QbaK5ff2kl} && ({3J7x1GEsDd0…} || {3J7vbAb6J6l…})
 *
 * and is edited over LETTERS:
 *
 *   A && (B || C)
 *
 * Both forms are needed and neither can be dropped. The id form is what
 * OpenObserve evaluates and the only form that survives an alert being renamed;
 * the letter form is the only one a person can read, because a 27-character
 * ULID repeated three times in one line is not an expression anyone can check.
 * The mapping between them is POSITIONAL — the nth distinct id is the nth
 * letter — and the id order is stored on the form so it stays fixed while the
 * expression is edited.
 */

/** A-Z for the first 26 children; OpenObserve caps a composite at 10 anyway. */
export const childLabel = (index) => String.fromCodePoint(65 + index);

/** Distinct alert ids in `{id}` placeholders, in first-appearance order. */
export const compositeChildIds = (expression) => {
  const ids = [];
  const seen = new Set();
  for (const m of (expression || '').matchAll(/\{([^{}]+)\}/g)) {
    const id = m[1].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
};

/**
 * Rewrite a stored `{id}` expression into the letter form, for display.
 *
 * An id with no seat in `childIds` is left as its own placeholder rather than
 * being dropped or given a letter: it means the expression references a child
 * the list no longer holds, and showing it is how the user finds out.
 */
export const expressionToLabels = (expression, childIds) => (expression || '')
  .replaceAll(/\{([^{}]+)\}/g, (whole, id) => {
    const at = (childIds || []).indexOf(id.trim());
    return at >= 0 ? childLabel(at) : whole;
  });

/**
 * Rewrite the letter form back to `{id}` for the wire.
 *
 * Only whole-word letters are substituted, so an operator or a child id that
 * happens to contain the letter is untouched. A letter with no child behind it
 * is left as-is and then fails validation, which is the correct outcome —
 * quietly deleting it would change the rule into one that is valid and wrong.
 */
export const expressionToIds = (labelled, childIds) => (labelled || '')
  .replaceAll(/\b([A-Z])\b/g, (whole, letter) => {
    const at = letter.codePointAt(0) - 65;
    const id = (childIds || [])[at];
    return id ? `{${id}}` : whole;
  });

/**
 * Is this labelled expression well-formed, and does it use every child once?
 *
 * Checked here as well as on the server because the server check is a round
 * trip per keystroke and most mistakes are local: unbalanced brackets, a
 * dangling operator, a child added to the list and never used. Anything needing
 * knowledge this UI does not have — whether a referenced alert exists, whether
 * the caller may read it, whether the reference graph stays acyclic — is left
 * to the server, which is the only place that can answer it.
 *
 * @returns an error string, or '' when the expression is locally sound
 */
export const validateCompositeExpression = (labelled, childCount) => {
  const text = (labelled || '').trim();
  if (!text) return 'Write an expression that combines the sub-alerts.';
  return compositeCountError(childCount)
    || (/[^A-Z\s()&|!]/.test(text) ? 'Use only the sub-alert letters, AND, OR, NOT and brackets.' : '')
    || bracketError(text)
    || letterUsageError(text, childCount)
    || shapeError(text);
};

/** Too few or too many children for a composite, or '' when the count is fine. */
const compositeCountError = (childCount) => {
  if (childCount < COMPOSITE_MIN_CHILDREN) {
    return `Add at least ${COMPOSITE_MIN_CHILDREN} sub-alerts — a composite of one is just that alert.`;
  }
  if (childCount > COMPOSITE_MAX_CHILDREN) {
    return `A composite takes at most ${COMPOSITE_MAX_CHILDREN} sub-alerts.`;
  }
  return '';
};

/** Unbalanced brackets, or '' when every bracket pairs up. */
const bracketError = (text) => {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) return 'A closing bracket has nothing to close.';
  }
  return depth === 0 ? '' : 'A bracket is left open.';
};

/** A child left out, a letter with no child, or a letter used twice. */
const letterUsageError = (text, childCount) => {
  const used = new Set(text.match(/\b[A-Z]\b/g) || []);
  for (let i = 0; i < childCount; i += 1) {
    if (!used.has(childLabel(i))) {
      return `${childLabel(i)} is not used in the expression — every sub-alert must appear exactly once.`;
    }
  }
  for (const letter of used) {
    const at = letter.codePointAt(0) - 65;
    if (at >= childCount) return `${letter} has no sub-alert behind it.`;
    const occurrences = (text.match(new RegExp(String.raw`\b${letter}\b`, 'g')) || []).length;
    if (occurrences > 1) return `${letter} appears ${occurrences} times — use each sub-alert exactly once.`;
  }
  return '';
};

/* Shape check, cheaply: collapsing every operand to `x` and every operator
   run to a single token must leave something that reads as an expression.
   This catches "A &&", "A B" and "(A && B" without writing a parser. */
const shapeError = (text) => {
  const shape = text
    .replaceAll(/\b[A-Z]\b/g, 'x')
    .replaceAll(/&&|\|\||AND|OR/g, '#')
    .replaceAll(/!|NOT/g, '~')
    .replaceAll(/\s+/g, '');
  if (/#$|^#|##|x~|xx|\(\)/.test(shape) || /#\)/.test(shape) || /\(#/.test(shape)) {
    return 'The expression is incomplete — check the operators and brackets.';
  }
  return '';
};

/** True when a document is a composite alert. */
const compositeType = (doc) => (doc?.alert_type === 'composite')
  || (!!doc?.composite_condition && typeof doc.composite_condition === 'object');

/**
 * Project an alert document onto the editor's form state.
 *
 * Every value is given a defined fallback so the controls are never
 * uncontrolled — React warns once and then silently stops tracking the input,
 * which shows up as a field that cannot be typed into.
 */
export const docToForm = (doc) => {
  const d = doc || {};
  const q = d.query_condition || {};

  return {
    name: d.name ?? '',
    description: d.description ?? '',
    streamType: d.stream_type ?? 'logs',
    streamName: d.stream_name ?? '',
    // `is_real_time` is the source of truth for the realtime/scheduled split,
    // not the list's `alert_type` string — the latter is a derived label and is
    // absent on a fresh document. Composite is the exception and HAS to be read
    // from `alert_type`: a composite has no stream and no query, so
    // `is_real_time: false` would otherwise make it indistinguishable from a
    // scheduled alert and the editor would show it as one with everything blank.
    alertType: formAlertType(d),

    ...compositeFormFields(d.composite_condition || {}),
    enabled: d.enabled !== false,
    ...queryFormFields(q, q.aggregation || null),
    ...triggerFormFields(d.trigger_condition || {}),
    ...notifyFormFields(d),
  };
};

/** realtime / scheduled / composite, as the editor's type switch reads it. */
const formAlertType = (d) => {
  if (compositeType(d)) return 'composite';
  return d.is_real_time ? 'realtime' : 'scheduled';
};

/** docToForm's composite fields, from `composite_condition`. */
const compositeFormFields = (c) => ({
  /* ── composite ───────────────────────────────────────────────
   *
   * The expression is stored over alert IDs and edited over LETTERS — see
   * compositeChildIds. The id order is kept beside it so the letters stay
   * stable across a round trip: re-deriving them from the expression text
   * would renumber every child the moment one is removed from the middle,
   * silently rewriting a rule the user never touched. */
  compositeExpression: c.expression ?? '',
  compositeChildren: compositeChildIds(c.expression ?? ''),
  staleChildPolicy: STALE_CHILD_POLICIES.some((p) => p.value === c.stale_child_policy)
    ? c.stale_child_policy : 'use_last_state',
  // Defaults to TRUE, which is OpenObserve's own default and the less
  // surprising one: a composite built out of warning-level children that
  // never fires is the kind of bug nobody finds until the incident review.
  warningCountsAsFiring: c.warning_counts_as_firing !== false,
});

/** docToForm's query fields, from `query_condition` and its aggregation. */
const queryFormFields = (q, agg) => ({
  queryType: q.type ?? 'custom',
  sql: q.sql ?? '',
  promql: q.promql ?? '',
  // Stored base64url — see decodeVrl. Shown decoded and re-encoded on save.
  vrlFunction: decodeVrl(q.vrl_function),
  conditions: seedConditions(parseConditions(q.conditions)),

  // A PromQL alert compares the expression's RESULT, so its threshold lives
  // in query_condition, not in trigger_condition where every other alert
  // type keeps it. Without this the editor could write a PromQL alert with
  // no comparison at all, which OpenObserve stores and then never fires.
  promqlOperator: q.promql_condition?.operator ?? '>=',
  promqlValue: numText(q.promql_condition?.value, '1'),
  promqlMultiAlert: !!q.promql_multi_alert,
  promqlWarningValue: numText(q.promql_warning_value, ''),

  aggregationEnabled: !!agg,
  aggFunction: agg?.function ?? 'count',
  // The column the function is computed OVER — `avg` of WHAT. Read back out of
  // `having.column`, which is where OpenObserve keeps it.
  //
  // Blank when that field just repeats the function name: this app's
  // one-screen editor has no column picker and wrote `having.column` = the
  // function, so an alert it authored would otherwise open here claiming to
  // average a column called "avg". `applyForm` puts the function name back
  // when this is blank, so such an alert still round-trips byte-identically.
  aggColumn: agg?.having?.column && agg.having.column !== agg?.function
    ? agg.having.column : '',
  aggGroupBy: Array.isArray(agg?.group_by) ? agg.group_by.join(', ') : '',
  aggHavingOperator: agg?.having?.operator ?? '>=',
  aggHavingValue: numText(agg?.having?.value, ''),
  aggWarningValue: numText(agg?.warning_value, ''),
  multiAlert: !!agg?.multi_alert,

  // Comparison windows. Given client keys because the rows are reorderable by
  // deletion and React would otherwise re-key every row below the one removed.
  multiWindows: (Array.isArray(q.multi_time_range) ? q.multi_time_range : []).map((w) => ({
    key: nextKey(),
    uuid: w?.uuid || '',
    ...parseOffset(w?.offSet),
  })),

});

/** docToForm's trigger fields, from `trigger_condition`. */
const triggerFormFields = (t) => ({
  period: t.period ?? 10,
  thresholdOperator: t.operator ?? '>=',
  threshold: t.threshold ?? 3,
  frequency: t.frequency ?? 1,
  frequencyType: t.frequency_type ?? 'minutes',
  cron: t.cron ?? '',
  silence: t.silence ?? 10,
  timezone: t.timezone ?? 'UTC',

  /* "Hold for", stored as SECONDS and edited in whichever unit reads better.
   *
   * The unit is chosen rather than defaulted: a tolerance of 300 shown as
   * "300 Seconds" is the same rule as "5 Minutes" but is markedly harder to
   * check at a glance, and the unit is not on the wire to be read back. Whole
   * minutes therefore come back as minutes and everything else as seconds. */
  toleranceSecs: numText(t.tolerance_in_secs, '0'),
  toleranceUnit: Number(t.tolerance_in_secs) >= 60
    && Number(t.tolerance_in_secs) % 60 === 0 ? 'minutes' : 'seconds',

  alignTime: t.align_time !== false,
  // The second, lower tier. Which document field it maps to depends on the
  // query type — see warningField.
  warningThreshold: numText(t.warning_threshold, ''),

});

/** docToForm's notification, dedup and variable fields, from the document root. */
const notifyFormFields = (d) => ({
  destinations: Array.isArray(d.destinations) ? d.destinations : [],
  createsIncident: !!d.creates_incident,
  rowTemplate: d.row_template ?? '',
  rowTemplateType: d.row_template_type === 'json' ? 'json' : 'string',
  template: d.template ?? '',
  priority: d.priority === undefined || d.priority === null ? '' : String(d.priority),
  tags: Array.isArray(d.tags) ? d.tags : [],

  dedupFields: Array.isArray(d.deduplication?.fingerprint_fields)
    ? d.deduplication.fingerprint_fields : [],
  dedupWindow: numText(d.deduplication?.time_window_minutes, ''),

  // context_attributes is an OBJECT on the wire and a list of rows in the
  // form: a map cannot represent a half-typed row (an entry whose key is
  // still empty) without either losing it or colliding on "".
  variables: Object.entries(
    d.context_attributes && typeof d.context_attributes === 'object'
      ? d.context_attributes : {},
  ).map(([key, value]) => ({ key: nextKey(), name: key, value: String(value ?? '') })),
});

/** Coerce a form number field, falling back when the box is empty or junk. */
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Coerce an OPTIONAL number field: an empty box means "not set", not zero.
 *
 * @returns the number, or null when the box is empty or unparseable
 */
const optNum = (value) => {
  const v = (value ?? '').toString().trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Which document field the warning tier writes to, for a given form.
 *
 * OpenObserve keeps ONE warning threshold but stores it in three different
 * places depending on how the alert expresses its condition, and it deletes the
 * two that do not apply on every save. Getting this wrong does not error — the
 * value simply lands in a field nothing reads.
 *
 *   - `promql`      → `query_condition.promql_warning_value`
 *   - `aggregation` → `query_condition.aggregation.warning_value`
 *   - `trigger`     → `trigger_condition.warning_threshold`  (custom w/o
 *                      aggregation, and SQL)
 *
 * A realtime alert has no threshold of any kind, so it has no warning tier.
 *
 * @returns 'promql' | 'aggregation' | 'trigger' | null
 */
export const warningField = (form) => {
  if (form.alertType === 'realtime') return null;
  if (form.queryType === 'promql') return 'promql';
  if (form.queryType === 'custom' && form.aggregationEnabled) return 'aggregation';
  return 'trigger';
};

/**
 * Normalise a tag list the way OpenObserve does: lower-cased, trimmed, unique.
 *
 * Done here rather than left to the server so the chips the user sees are the
 * chips that get stored — a tag that silently changes case on save looks like
 * the save went somewhere else.
 */
export const normaliseTags = (tags) => {
  const seen = new Set();
  const out = [];
  for (const raw of tags || []) {
    const tag = (raw ?? '').toString().trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
};

/**
 * Set `key` on the document, or remove it when the value is empty.
 *
 * A key the user has not filled in is left ABSENT rather than written as `""`,
 * except where the document already carried it — in which case the empty value
 * is the user clearing it and has to be written, or the save would appear to do
 * nothing. This is the merge contract at field granularity.
 */
const setOrDrop = (doc, base, key, value) => {
  const empty = value === '' || value === null || value === undefined;
  if (!empty) { doc[key] = value; return; }
  if (base && Object.hasOwn(base, key)) { doc[key] = value ?? ''; return; }
  delete doc[key];
};

/** Variable rows collapsed back into the `context_attributes` map. */
const variablesToMap = (variables) => (variables || []).reduce((acc, row) => {
  const name = (row.name || '').trim();
  const value = (row.value || '').trim();
  if (name && value) acc[name] = value;
  return acc;
}, {});

/** applyForm's deduplication section. */
const applyDedup = (doc, base, form) => {
  const dedupFields = (form.dedupFields || []).map((f) => f.trim()).filter(Boolean);
  const dedupWindow = optNum(form.dedupWindow);
  if (dedupFields.length || dedupWindow !== null) {
    doc.deduplication = {
      ...base?.deduplication,
      enabled: dedupFields.length > 0,
      fingerprint_fields: dedupFields,
      time_window_minutes: dedupWindow,
    };
  } else if (base?.deduplication) {
    doc.deduplication = {
      ...base.deduplication, enabled: false, fingerprint_fields: [], time_window_minutes: null,
    };
  } else {
    delete doc.deduplication;
  }
};

/** An empty condition tree in the given wire serialisation. */
const emptyWireConditions = (version) => (version === 2
  ? { version: 2, conditions: { filterType: 'group', logicalOperator: 'AND', conditions: [] } }
  : { and: [] });

/** The `promql_condition` block of a PromQL alert. */
const wirePromqlCondition = (base, form) => ({
  ...base?.query_condition?.promql_condition,
  column: 'value',
  operator: form.promqlOperator || '>=',
  value: num(form.promqlValue, 1),
});

/** Comparison window rows as `multi_time_range` entries; blank or non-positive
 *  offsets are dropped. */
const wireWindows = (windows) => (windows || [])
  .map((w) => {
    const amount = Number(w.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const entry = { offSet: `${amount}${w.unit || 'm'}` };
    if (w.uuid) entry.uuid = w.uuid;
    return entry;
  })
  .filter(Boolean);

/** The custom-mode aggregation block. */
const wireAggregation = (base, form) => ({
  ...base?.query_condition?.aggregation,
  function: form.aggFunction,
  group_by: (form.aggGroupBy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  having: {
    // The aggregated column when one was chosen. Falling back to the
    // function name is not a default so much as a compatibility rule: it is
    // what this app wrote before the column could be picked, and rewriting
    // those alerts on an unrelated save is exactly the silent migration the
    // merge contract at the top of this file forbids.
    column: (form.aggColumn || '').trim() || form.aggFunction,
    operator: form.aggHavingOperator,
    value: num(form.aggHavingValue, 0),
  },
  // One alert per group instead of one for the whole query.
  multi_alert: !!form.multiAlert,
});

/** applyForm's `query_condition`, merged over the one the document carried. */
const buildQueryCondition = (base, form) => {
  // Written in whichever serialisation it was read in — see toWireConditions.
  const version = form.conditions?.wireVersion || 1;
  const wire = toWireConditions(form.conditions, version);
  const promql = form.queryType === 'promql';
  // Aggregation is a CUSTOM-mode idea: the group-by and having clauses are
  // compiled into the query OpenObserve builds from the conditions, and there
  // is nothing to compile them into once the user writes their own SQL. Sent
  // with a SQL alert it is stored and ignored, which reads as a threshold that
  // does not work, so it is dropped here exactly as the reference UI drops it.
  const aggregating = form.aggregationEnabled && form.queryType === 'custom';

  const qc = {
    ...base?.query_condition,
    type: form.queryType,
    // Always an object, never null: OpenObserve accepts an empty group but
    // rejects a missing `conditions` on a custom-type alert.
    conditions: wire || emptyWireConditions(version),
    // Only the field belonging to the selected query type is populated. Leaving
    // a stale `sql` behind while type is "custom" makes the alert's behaviour
    // depend on which order the user touched the controls in.
    sql: form.queryType === 'sql' ? (form.sql || '') : null,
    promql: promql ? (form.promql || '') : null,
    vrl_function: encodeVrl(form.vrlFunction),

    // A PromQL alert's threshold. `column: 'value'` is what the reference UI
    // writes and is not derived from anything the user picked.
    promql_condition: promql ? wirePromqlCondition(base, form) : null,
    // Evaluate each returned series separately rather than collapsing them.
    promql_multi_alert: promql ? !!form.promqlMultiAlert : false,

    // Comparison windows are a SQL-mode feature — OpenObserve compares the same
    // SQL run over an offset window, and there is no query to re-run in the
    // other two modes. Cleared rather than carried so switching mode cannot
    // leave an invisible comparison attached.
    multi_time_range: form.queryType === 'sql' ? wireWindows(form.multiWindows) : [],

    aggregation: aggregating ? wireAggregation(base, form) : null,
  };

  applyQueryWarning(qc, form);
  return qc;
};

/* The warning tier lands in exactly one of three fields — see warningField —
 * and the other two must be ABSENT, not null: OpenObserve deletes them on
 * every save, and a null left in `promql_warning_value` on a custom alert is
 * read as "a warning threshold of nothing". The trigger-side field is handled
 * in buildTriggerCondition. */
const applyQueryWarning = (qc, form) => {
  const warnAt = warningField(form);
  const aggWarn = optNum(form.aggWarningValue);
  const promqlWarn = optNum(form.promqlWarningValue);

  if (warnAt === 'promql' && promqlWarn !== null) qc.promql_warning_value = promqlWarn;
  else delete qc.promql_warning_value;

  if (qc.aggregation) {
    if (warnAt === 'aggregation' && aggWarn !== null) qc.aggregation.warning_value = aggWarn;
    else delete qc.aggregation.warning_value;
  }
};

/** applyForm's `trigger_condition`, merged over the one the document carried. */
const buildTriggerCondition = (base, form, realtime) => {
  const trigger = {
    ...base?.trigger_condition,
    period: num(form.period, 10),
    operator: form.thresholdOperator,
    threshold: num(form.threshold, 1),
    frequency: num(form.frequency, 1),
    frequency_type: form.frequencyType,
    cron: form.frequencyType === 'cron' ? (form.cron || '') : '',
    silence: num(form.silence, 10),
    timezone: form.timezone || 'UTC',
    align_time: !!form.alignTime,
  };

  /* "Hold for" — null rather than 0 when it is not set.
   *
   * OpenObserve treats both as "fire immediately", but it WRITES null, and a
   * document that differs from the one its own editor would have written for
   * the same rule is the kind of difference that shows up later as a spurious
   * diff in an export. A realtime alert has no window to hold a condition true
   * across, so it never carries one. */
  const tolerance = optNum(form.toleranceSecs);
  trigger.tolerance_in_secs = realtime || tolerance === null || tolerance <= 0
    ? null
    : Math.round(tolerance);

  const warnValue = optNum(form.warningThreshold);
  if (warningField(form) === 'trigger' && warnValue !== null) {
    trigger.warning_threshold = warnValue;
  } else {
    delete trigger.warning_threshold;
  }
  // A dead field in OpenObserve's own schema: its editor deletes it on every
  // save regardless of state. Removed here too so an alert that still carries
  // one from an older version is cleaned up rather than propagated.
  delete trigger.notify_on_warning;
  return trigger;
};

/* ── composite ──────────────────────────────────────────────────
 *
 * A composite is discriminated by `alert_type`, which is the ONLY key that
 * says so: it carries `is_real_time: false` like a scheduled alert, and the
 * stream, query and trigger fields written above are meaningless to it. They
 * are left in place rather than stripped because OpenObserve stores and
 * ignores them, and deleting keys the server sent is exactly what the merge
 * contract at the top of this file forbids.
 *
 * `composite_condition` is REMOVED, not nulled, when the alert is not a
 * composite: an alert converted away from composite must not keep an
 * expression that would resurface if it were converted back. */
const applyComposite = (doc, base, form) => {
  if (form.alertType === 'composite') {
    doc.alert_type = 'composite';
    doc.composite_condition = {
      ...base?.composite_condition,
      expression: (form.compositeExpression || '').trim(),
      stale_child_policy: form.staleChildPolicy || 'use_last_state',
      warning_counts_as_firing: form.warningCountsAsFiring !== false,
    };
  } else {
    delete doc.composite_condition;
    if (doc.alert_type === 'composite') delete doc.alert_type;
  }
};

/**
 * Merge form state back into the alert document.
 *
 * MERGE, not rebuild — see the note at the top of this file. `base` is the
 * document the server sent (or `emptyAlertDoc()` for a new alert) and every key
 * it holds that the form does not cover survives untouched.
 */
export const applyForm = (base, form) => {
  const doc = { ...base };
  const realtime = form.alertType === 'realtime';

  doc.name = (form.name || '').trim();
  doc.description = form.description || '';
  doc.stream_type = form.streamType;
  doc.stream_name = form.streamName;
  doc.is_real_time = realtime;
  doc.enabled = !!form.enabled;
  doc.creates_incident = !!form.createsIncident;
  doc.destinations = [...(form.destinations || [])];
  doc.row_template = form.rowTemplate || '';

  // Rows collapse back into the map. A row with a blank name or blank value is
  // dropped rather than written as `"": ""` — the same rule OpenObserve applies.
  doc.context_attributes = variablesToMap(form.variables);

  // Notification template override, and how the per-row template is assembled.
  setOrDrop(doc, base, 'template', (form.template || '').trim());
  if (form.rowTemplateType === 'json' || base?.row_template_type) {
    doc.row_template_type = form.rowTemplateType === 'json' ? 'json' : 'string';
  }

  // Priority is a number or the key is absent — never an empty string, which
  // OpenObserve rejects. Unsetting it here means the key is omitted from the
  // PUT, and since a PUT replaces the document that clears it.
  const priority = optNum(form.priority);
  if (priority === null) delete doc.priority; else doc.priority = priority;

  const tags = normaliseTags(form.tags);
  if (tags.length) doc.tags = tags; else delete doc.tags;

  /* Deduplication — suppresses a repeat of the SAME alert.
   *
   * `enabled` is not a control the user sees: OpenObserve derives it from
   * whether any fingerprint field is set, and its own form keeps the two in
   * lockstep. Mirrored here so an alert round-trips identically.
   *
   * The whole object is omitted when nothing is configured AND the document
   * never had one, so a user who does not touch this tab does not start sending
   * a new key. */
  applyDedup(doc, base, form);

  doc.query_condition = buildQueryCondition(base, form);

  doc.trigger_condition = buildTriggerCondition(base, form, realtime);

  applyComposite(doc, base, form);

  return doc;
};

const DESTINATIONS_REQUIRED = 'Choose at least one destination — an alert with none notifies nobody.';

/** Alert name: required, and restricted to what OpenObserve accepts. */
const validateName = (form, errors) => {
  const name = (form.name || '').trim();
  if (!name) {
    errors.name = 'Alert name is required.';
  } else if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    // OpenObserve rejects spaces and punctuation in alert names, and its error
    // for it is generic. Saying so up front beats a failed save.
    errors.name = 'Use letters, numbers, hyphen and underscore only — no spaces.';
  }
};

const validateSilence = (form, errors) => {
  if (num(form.silence, -1) < 0) errors.silence = 'Cooldown period cannot be negative.';
};

const validateDestinations = (form, errors) => {
  if (!form.destinations || form.destinations.length === 0) {
    errors.destinations = DESTINATIONS_REQUIRED;
  }
};

/* A composite validates almost nothing the other two do.
 *
 * It has no stream, no query and no window — it reads the CURRENT STATES of
 * other alerts — so every check the other types need would be asking about
 * fields the composite screen never shows and can never fill in. Cooldown and
 * destinations still apply: it notifies like any other alert. */
const validateComposite = (form, errors) => {
  const rows = form.compositeChildren || [];
  const unfilled = rows.some((id) => !id);

  // A child slot with no alert chosen yet. Reported INSTEAD of the expression
  // error rather than alongside it: an unfilled row makes the expression look
  // short of children too, and "add at least 2 sub-alerts" printed under a
  // list that already shows two rows reads as a screen that cannot count.
  // One complaint, on the control that can fix it.
  if (unfilled) {
    errors.compositeChildren = 'Every sub-alert row needs an alert selected.';
  } else {
    const expressionError = validateCompositeExpression(
      form.compositeExpressionLabelled ?? expressionToLabels(
        form.compositeExpression, form.compositeChildren,
      ),
      rows.length,
    );
    if (expressionError) errors.compositeExpression = expressionError;
  }

  validateSilence(form, errors);
  validateDestinations(form, errors);
  return errors;
};

/** Stream, and the query text for the selected query type. */
const validateSource = (form, errors) => {
  if (!form.streamType) errors.streamType = 'Stream type is required.';
  if (!form.streamName) errors.streamName = 'Stream name is required.';

  if (form.queryType === 'sql' && !(form.sql || '').trim()) {
    errors.sql = 'SQL query is required for a SQL alert.';
  }
  if (form.queryType === 'promql' && !(form.promql || '').trim()) {
    errors.promql = 'PromQL query is required for a PromQL alert.';
  }
};

// A realtime alert is evaluated per ingested row, so it has no window or
// cadence to validate — only its conditions matter.
const validateSchedule = (form, errors) => {
  if (form.alertType !== 'scheduled') return;
  if (num(form.period, 0) <= 0) errors.period = 'Look back window must be at least 1 minute.';
  if (form.frequencyType === 'cron') {
    if (!(form.cron || '').trim()) errors.cron = 'A cron expression is required.';
  } else if (num(form.frequency, 0) <= 0) {
    errors.frequency = 'Frequency must be at least 1 minute.';
  }
};

/* "Hold for" — only the checks a screen with the control can act on.
 *
 * The one-screen editor has no Hold for control, so anything reported here is
 * a complaint it cannot offer a way to fix. These two can only be provoked by
 * typing in the box, which means the only screen that can see them is the one
 * that has it. The rule about it outlasting the look-back window lives in the
 * wizard for exactly that reason — see AlertWizard's `errors`. */
const validateTolerance = (form, errors) => {
  const tolerance = optNum(form.toleranceSecs);
  if ((form.toleranceSecs ?? '').toString().trim() !== '' && tolerance === null) {
    errors.toleranceSecs = 'Hold for must be a number of seconds.';
  } else if (tolerance !== null && tolerance < 0) {
    errors.toleranceSecs = 'Hold for cannot be negative.';
  }
};

const validateConditions = (form, errors) => {
  if (form.queryType === 'custom' && countConditions(form.conditions) === 0) {
    errors.conditions = 'Add at least one condition.';
  }
  if (form.aggregationEnabled && (form.aggHavingValue === '' || form.aggHavingValue === null)) {
    errors.aggHavingValue = 'Threshold for the aggregation is required.';
  }
};

/** The form field that holds the warning tier, per warningField result. */
const WARNING_FORM_FIELD = {
  trigger: 'warningThreshold',
  aggregation: 'aggWarningValue',
  promql: 'promqlWarningValue',
};

/** The operator and critical value the warning tier is compared against. */
const warningCritical = (form, warnAt) => {
  if (warnAt === 'promql') {
    return { operator: form.promqlOperator, critical: optNum(form.promqlValue) };
  }
  return {
    operator: form.thresholdOperator,
    critical: optNum(warnAt === 'aggregation' ? form.aggHavingValue : form.threshold),
  };
};

/** Why a numeric warning cannot sit beside this critical, or '' when it can. */
const warningDirectionError = (warn, operator, critical) => {
  if (!ORDERED_OPERATORS.includes(operator)) {
    return `A warning threshold is not allowed with the ${operator} operator.`;
  }
  if (critical === null) return '';
  const wantsLower = operator === '>' || operator === '>=';
  if (wantsLower && warn >= critical) {
    return `Warning (${warn}) must be lower than critical (${critical}) for ${operator}.`;
  }
  if (!wantsLower && warn <= critical) {
    return `Warning (${warn}) must be higher than critical (${critical}) for ${operator}.`;
  }
  return '';
};

/* ── the warning tier ────────────────────────────────────────────────────
 *
 * A warning threshold is a SECOND, less-severe level on the same comparison,
 * so it shares the critical threshold's operator and only makes sense on an
 * ordered one — "= 5, warning = 3" describes nothing. The direction check
 * catches the common inversion, where a warning set above a `>=` critical
 * would only ever fire after the critical had already fired. */
const validateWarningTier = (form, errors) => {
  const warnAt = warningField(form);
  if (!warnAt) return;
  const field = WARNING_FORM_FIELD[warnAt];
  const raw = form[field];
  const warn = optNum(raw);
  const hasText = (raw ?? '').toString().trim() !== '';

  if (hasText && warn === null) {
    errors[field] = 'Warning threshold must be a number.';
    return;
  }
  if (warn === null) return;
  const { operator, critical } = warningCritical(form, warnAt);
  const message = warningDirectionError(warn, operator, critical);
  if (message) errors[field] = message;
};

/* ── PromQL threshold ──────────────────────────────────────────────────── */
const validatePromqlThreshold = (form, errors) => {
  if (form.queryType === 'promql' && form.alertType === 'scheduled'
    && optNum(form.promqlValue) === null) {
    errors.promqlValue = 'A value to compare the expression against is required.';
  }
};

const validatePerGroup = (form, errors) => {
  const groupBy = (form.aggGroupBy || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!groupBy.length) {
    errors.aggGroupBy = 'Add at least one Group By column to alert per group.';
  }
  if ((form.multiWindows || []).length && form.queryType === 'sql') {
    errors.multiAlert = 'Per-group alerting cannot be combined with multi-window comparison.';
  }
  if (form.createsIncident) {
    errors.multiAlert = 'Per-group alerting cannot yet be combined with incident creation.';
  }
};

const validateGroupGate = (form, errors) => {
  if (!ORDERED_OPERATORS.includes(form.thresholdOperator)) {
    errors.thresholdOperator = 'Per-group alerting needs an ordered comparison (>, >=, <, <=).';
  } else if (num(form.threshold, 0) !== 1 || form.thresholdOperator !== '>=') {
    // It fires on ANY breaching group, so the gate that counts how many
    // groups breached can only be "at least 1".
    errors.threshold = 'Per-group alerting fires on any breaching group, so the group '
      + 'count threshold must be “at least 1”.';
  }
};

/* ── per-group / per-series alerting ──────────────────────────────────────
 *
 * These are OpenObserve's own constraints, checked here because it reports
 * them as one opaque rejection of the whole save. */
const validateMultiAlert = (form, errors) => {
  const perGroup = form.aggregationEnabled && form.queryType === 'custom' && form.multiAlert;
  const perSeries = form.queryType === 'promql' && form.promqlMultiAlert;
  if (perGroup) validatePerGroup(form, errors);
  if (perGroup || perSeries) validateGroupGate(form, errors);
};

/* ── comparison windows ───────────────────────────────────────────────── */
const validateWindows = (form, errors) => {
  if ((form.multiWindows || []).length && form.queryType !== 'sql') {
    errors.multiWindows = 'Comparison windows are only supported in SQL mode.';
  }
  (form.multiWindows || []).forEach((w) => {
    if (!Number.isFinite(Number(w.amount)) || Number(w.amount) <= 0) {
      errors.multiWindows = 'Every comparison window needs a positive offset.';
    }
  });
};

/* ── deduplication, tags and additional variables ─────────────────────── */
const validateExtras = (form, errors) => {
  if ((form.dedupWindow ?? '').toString().trim() !== '') {
    const window = optNum(form.dedupWindow);
    if (window === null || window < 0) {
      errors.dedupWindow = 'Deduplication window must be a non-negative number of minutes.';
    }
  }

  const badTag = normaliseTags(form.tags).find((t) => !/^[a-z][a-z0-9_.:/-]*$/.test(t));
  if (badTag) {
    errors.tags = `“${badTag}” is not a valid tag — a tag must start with a letter.`;
  }

  const halfRow = (form.variables || []).some(
    (row) => !!(row.name || '').trim() !== !!(row.value || '').trim(),
  );
  if (halfRow) {
    errors.variables = 'Every variable needs both a name and a value — '
      + 'a half-filled row is dropped on save.';
  }
};

/**
 * Validate the form, returning a map of field → message.
 *
 * Checked here rather than only server-side so the user is told which control is
 * wrong instead of getting one opaque rejection for the whole save.
 *
 * Each section writes into the same map, so the order messages appear in is
 * the order the sections are called in.
 */
export const validateForm = (form) => {
  const errors = {};
  validateName(form, errors);

  // Returning early is what keeps a composite from being permanently invalid
  // on the strength of a missing stream name — see validateComposite.
  if (form.alertType === 'composite') return validateComposite(form, errors);

  validateSource(form, errors);
  validateSchedule(form, errors);
  validateSilence(form, errors);
  validateTolerance(form, errors);
  validateDestinations(form, errors);
  validateConditions(form, errors);
  validateWarningTier(form, errors);
  validatePromqlThreshold(form, errors);
  validateMultiAlert(form, errors);
  validateWindows(form, errors);
  validateExtras(form, errors);
  return errors;
};

/* ── display helpers, shared by the list and the summary ────────────────── */

/** "10 mins" / "1 min" / "—". */
export const formatMinutes = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n} ${n === 1 ? 'min' : 'mins'}`;
};

/**
 * The "Check every" column: a cron alert shows its expression, everything else
 * shows its interval.
 */
export const formatFrequency = (row) => {
  if (!row) return '—';
  if (row.frequencyType === 'cron') return row.cron ? `cron: ${row.cron}` : 'cron';
  return formatMinutes(row.frequency);
};

/** Local timestamp, or an em dash for "never". */
export const formatTimestamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

/** Human label for an alert type, tolerating the anomaly type we do not author. */
export const alertTypeLabel = (type) => {
  if (type === 'realtime') return 'Realtime';
  if (type === 'scheduled') return 'Scheduled';
  if (type === 'anomaly_detection') return 'Anomaly';
  return type || '—';
};

/**
 * What a scheduled alert actually compares, split into its three parts.
 *
 * <p>The measure is not one field: "alert if" is asked once and stored in two
 * different places depending on the answer (see the note on ALERT_IF_OPTIONS),
 * so reading the threshold back means knowing which of the two the form is
 * currently using. That knowledge is here, once, because both the wizard footer
 * and its review step restate the rule and a second copy of this rule is a
 * second thing to keep in step.</p>
 *
 * <p>Meaningless for a realtime alert, which has no threshold at all, and for a
 * composite, which compares the states of other alerts rather than a number.</p>
 *
 * @returns {{measure: string, operator: string, value: string}}
 */
export const thresholdParts = (form) => {
  if (form.queryType === 'promql') {
    return {
      measure: 'value',
      operator: form.promqlOperator,
      value: `${form.promqlValue ?? ''}` || '—',
    };
  }
  const aggregating = form.aggregationEnabled && form.queryType === 'custom';
  if (aggregating) {
    return {
      measure: `${form.aggFunction}(${form.aggColumn || '*'})`,
      operator: form.aggHavingOperator,
      value: `${form.aggHavingValue ?? ''}` || '—',
    };
  }
  return {
    measure: form.queryType === 'sql' ? 'query result' : 'events',
    operator: form.thresholdOperator,
    value: `${form.threshold ?? ''}` || '—',
  };
};
