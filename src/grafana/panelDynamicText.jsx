// ---------------------------------------------------------------------------
// marcusolsson-dynamictext-panel — the community "Dynamic Text" / "Business
// Text" panel.
//
// It is a template panel: `options.content` is a Handlebars template rendered
// against the query result, and `options.afterRender` is JavaScript the panel
// author runs against the rendered DOM. Real dashboards use it for exactly what
// the Microservice Monitoring dashboard uses it for — a hand-built table with
// controls (search box, column chooser) that no core panel offers.
//
// Two halves, and both are needed for such a panel to render at all:
//
//   1. the template — Handlebars, the same library the plugin itself uses, so a
//      template written against the plugin behaves the same here;
//   2. the author's script — run inside a SANDBOXED IFRAME.
//
// ─── Why the iframe ────────────────────────────────────────────────────────
//
// `options.afterRender` is arbitrary JavaScript stored in a Grafana dashboard.
// Running it in this application's own document would hand anyone with
// dashboard-edit rights in Grafana the user's session, this app's localStorage
// and its backend — the escalation ./panelText.js sanitises the text panel to
// avoid. Grafana's own plugin runs it in-page because there it is already the
// same origin as the thing it could reach; here it is not.
//
// So the rendered content and the script go into an `<iframe sandbox="allow-
// scripts">` — no `allow-same-origin`, which gives it an opaque origin: the
// script can build its table, handle its own clicks and read the data embedded
// in the document it was given, and can touch nothing of this application.
//
// ─── What the sandbox is given back, and why each one ──────────────────────
//
// An opaque origin removes rather more than the escalation: it also removes
// things these panels legitimately need, and every one of them shows up as a
// panel that renders its chrome and none of its content. Five are BRIDGED back
// over postMessage — the frame asks, this module answers, and the frame still
// cannot read the app's document, its session or its store:
//
//   · localStorage    panels keep the user's column/filter choices there, and
//                     losing them on every dashboard refresh would be a visible
//                     regression rather than a hardening. Reads are answered
//                     from a snapshot taken at build time; writes land in the
//                     app's real store under STORAGE_PREFIX.
//   · /api/ds/query   a real dashboard's script fetches MORE data than the
//                     panel's own targets carry — the topology panel on OSS
//                     Engine Overview issues ~40 extra queries from
//                     `afterRender` and writes the answers into the DOM it has
//                     just rendered. In Grafana that is a same-origin call to
//                     Grafana's own API; here it reaches nothing, and the panel
//                     draws a complete topology with every number showing "--".
//                     Bridged to this application's own /dashboards/query.
//                     NOT a new capability: the panel's declared targets
//                     already travel that exact path, so this is the same door,
//                     reached from the script instead of from the panel JSON.
//   · locationService drill-down. `locationService.push('/d/<uid>')` is how a
//                     panel says "open that dashboard" — see
//                     ./dashboardNavigation.js. Stubbed, it turns every node of
//                     a clickable topology into a dead control.
//   · `__` globals    panels on one dashboard talk to each other through
//                     `window.__name`, because in Grafana they share a window.
//                     Here each panel is its own frame, so `__`-prefixed
//                     globals are mirrored between the frames of the dashboard
//                     currently on screen, and discarded when it closes.
//   · other panels'   the same reason as the globals, one layer down: in
//     DOM             Grafana every panel is in ONE document, so a panel's
//                     script reaches its neighbours with a bare
//                     `document.querySelector('#their-id')`. That is not an
//                     exotic trick — it is how the OSS Engine Overview
//                     topology panel, which is the one that computes severity,
//                     fills in the KPI row's alert count and colours and
//                     writes the whole Alerts list into the panel beside it.
//                     Per-frame, those seven selectors match nothing: the
//                     dashboard renders, every panel shows its OWN numbers,
//                     and everything one panel was supposed to tell another is
//                     silently dropped. So each frame is given an inert MIRROR
//                     of its neighbours' rendered HTML (in a closed-off
//                     `display:none` shadow root, so their CSS cannot leak
//                     into it), `document.querySelector` falls through to it,
//                     and writes made against the mirror are replayed on the
//                     real element in the frame that owns it. See
//                     "Cross-panel DOM" below.
//
// `eventBus` stays stubbed: it carries Grafana's own internal event stream,
// which has no meaning outside Grafana and no shape this application could
// honour.
//
// ─── What is not supported ─────────────────────────────────────────────────
//
// `options.helpers` (JavaScript that registers custom Handlebars helpers) is
// not run. Unlike `afterRender`, helpers execute where the TEMPLATE is compiled
// — in this document — so there is no sandbox to put them in. A panel that uses
// them still renders; the helper calls resolve to nothing and a warning names
// the panel. Everything else the plugin's options carry — content, partials,
// defaultContent, renderMode, styles, externalStyles — is honoured.
//
// Its propTypes are loose for the same reason as ./panelsExtra.jsx: these props
// are Grafana's PanelProps contract, not an interface this application defines.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef } from 'react';
import { PanelPlugin, getFieldDisplayName } from '@grafana/data';
import { useTheme2 } from '@grafana/ui';
import Handlebars from 'handlebars';

import { runDashboardQuery } from '../services/dashboardsApi';
import { DASHBOARD_PATH_PATTERN, requestDashboardNavigation } from './dashboardNavigation';
import { Centered, hasError, errorMessage } from './panelsExtra.jsx';
import { AWAITS_QUERY_OPTION, isAnswer } from './panelAnswer.js';
import { panelPropTypes } from './panelPropTypes.js';

/** Grafana's plugin id for this panel. */
export const DYNAMIC_TEXT_PLUGIN_ID = 'marcusolsson-dynamictext-panel';

// ─── Handlebars ─────────────────────────────────────────────────────────────

/**
 * A private Handlebars environment.
 *
 * `Handlebars.create()` rather than the default export: helpers registered on
 * the shared instance would be global state this module does not own, and a
 * template that shadows one of our helper names would then affect every other
 * consumer of the library in the bundle.
 */
const hb = Handlebars.create();

/**
 * JSON safe to sit inside a `<script>` element.
 *
 * `{{{json @root}}}` inside a `<script type="application/json">` block is how
 * these panels hand their data to their own script, so the encoder has to be
 * immune to a data value that contains a closing script tag. Escaping `<` as
 * `<` is legal JSON that `JSON.parse` turns straight back into `<`, so the
 * panel's script sees its data unchanged and the document cannot be broken out
 * of.
 */
function jsonForScript(value) {
  let text;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch {
    text = 'null';
  }
  return String(text ?? 'null').replaceAll('<', String.raw`\u003c`);
}

/**
 * Helpers a template may call.
 *
 * The plugin's set, minus the ones that need Grafana's runtime. `json` is the
 * one that matters most — it is what a template uses to hand the whole result
 * to its own script.
 *
 * Handlebars appends its own options object to every helper call, so a helper
 * with an optional argument has to type-check it rather than trust arity.
 */
const HELPERS = {
  json: (value) => new hb.SafeString(jsonForScript(value)),

  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  and: (...args) => args.slice(0, -1).every(Boolean),
  or: (...args) => args.slice(0, -1).some(Boolean),
  not: (value) => !value,

  add: (a, b) => Number(a) + Number(b),
  sub: (a, b) => Number(a) - Number(b),
  mul: (a, b) => Number(a) * Number(b),
  div: (a, b) => (Number(b) === 0 ? '' : Number(a) / Number(b)),
  abs: (a) => Math.abs(Number(a)),
  round: (a) => Math.round(Number(a)),
  toFixed: (value, digits) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    return num.toFixed(Number.isFinite(Number(digits)) ? Number(digits) : 0);
  },

  upper: (value) => String(value ?? '').toUpperCase(),
  lower: (value) => String(value ?? '').toLowerCase(),
  join: (value, separator) => {
    if (!Array.isArray(value)) return '';
    const sepStr = typeof separator === 'string' ? separator : ', ';
    return value.join(sepStr);
  },
  split: (value, separator) => String(value ?? '')
    .split(typeof separator === 'string' ? separator : ','),
  contains: (haystack, needle) => (Array.isArray(haystack)
    ? haystack.includes(needle)
    : String(haystack ?? '').includes(String(needle ?? ''))),
  replace: (value, find, replacement) => {
    if (typeof find !== 'string') return String(value ?? '');
    const replStr = typeof replacement === 'string' ? replacement : '';
    return String(value ?? '').split(find).join(replStr);
  },
  default: (value, fallback) => (
    value === undefined || value === null || value === '' ? fallback : value
  ),
  len: (value) => {
    if (Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') return Object.keys(value).length;
    return String(value ?? '').length;
  },
};

Object.entries(HELPERS).forEach(([name, fn]) => hb.registerHelper(name, fn));

/** Panels whose `options.helpers` we skipped — warned about once each. */
const warnedHelpers = new Set();

function warnUnsupportedHelpers(panelTitle) {
  const key = String(panelTitle || 'untitled');
  if (warnedHelpers.has(key)) return;
  warnedHelpers.add(key);
  console.warn(
    `[panels] dynamic text panel "${key}" registers custom Handlebars helpers in `
    + 'its options — those are JavaScript that would have to run outside the panel '
    + 'sandbox, so they are not executed. The panel still renders; helper calls in '
    + 'its template produce nothing. See grafana/panelDynamicText.jsx.',
  );
}

// ─── Query result -> template data ──────────────────────────────────────────

/** Values have to survive JSON: no bigint, no NaN, no Infinity. */
function normalizeValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (value instanceof Date) return value.valueOf();
  return value;
}

function readValue(field, index) {
  const values = field?.values;
  if (!values) return undefined;
  // @grafana/data returned a Vector with .get() before v10 and a plain array
  // after. Dashboards here are read from a live Grafana of either vintage.
  return typeof values.get === 'function' ? values.get(index) : values[index];
}

function readLength(fields) {
  const values = fields[0]?.values;
  if (!values) return 0;
  return typeof values.length === 'number' ? values.length : 0;
}

function readValues(field, length) {
  const out = [];
  for (let index = 0; index < length; index += 1) {
    out.push(normalizeValue(readValue(field, index)));
  }
  return out;
}

/**
 * The query result, in the two shapes the plugin's contract exposes.
 *
 * ─── Why both, and why per FRAME ────────────────────────────────────────────
 *
 * A template addresses columns by name (`{{Service}}`), so it needs rows. A
 * panel's SCRIPT is given Grafana's own `PanelData` instead, and the scripts on
 * these dashboards use the part of it that rows cannot express: they look a
 * query up by its refId.
 *
 *     var F = context.panelData.series;
 *     function fr(id) { return F.find(function (f) { return f.refId === id; }); }
 *     var st = fr('A').fields.find(function (x) { return x.name === 'status'; });
 *     var pods = sc('B');   // the count from the SECOND query
 *
 * Flattening every frame into one wide row set — which is what this used to
 * hand over — loses exactly that. `series` held a single frame with no refId, so
 * `fr('A')` found nothing, and the KPI row on OSS Engine Overview rendered a
 * complete set of tiles reading "--" while all five of its queries were
 * returning data perfectly well. Its own script had bailed on line six.
 *
 * ─── Two names per field, deliberately ─────────────────────────────────────
 *
 * `display` is `getFieldDisplayName` — what the dashboard SHOWS ("Service", not
 * "field_1"), config overrides and all, and disambiguated across frames. That is
 * what a template is written against, so it is what keys a row.
 *
 * `name` is the field's RAW name. That is what a script matches on
 * (`x.name === 'status'`), and it must not be the disambiguated one: with five
 * queries in a panel the display name of A's status column can come back as
 * "A status", and a script looking for "status" would never find it.
 *
 * The values are serialised ONCE, on the frames. Rows are rebuilt from them
 * inside the sandbox, so carrying both shapes costs no extra bytes — which
 * matters on a panel sixty columns wide.
 */
function framesToPayload(frames) {
  const series = [];
  const columns = [];
  const seen = new Set();

  (frames ?? []).forEach((frame) => {
    const fields = frame?.fields ?? [];
    if (!fields.length) return;
    const length = frame.length ?? readLength(fields);

    series.push({
      refId: frame.refId ?? undefined,
      name: frame.name ?? undefined,
      length,
      fields: fields.map((field) => ({
        name: field.name,
        display: getFieldDisplayName(field, frame, frames),
        type: field.type ?? 'string',
        // Present because a DataFrame's fields have one and a script may read
        // it; the real config carries functions and cannot cross postMessage.
        config: {},
        values: readValues(field, length),
      })),
    });

    for (const field of series.at(-1).fields) {
      if (seen.has(field.display)) continue;
      seen.add(field.display);
      columns.push({ name: field.display, type: field.type });
    }
  });

  return { series, columns };
}

/**
 * The frames as the row objects a template addresses by column name.
 *
 * Keyed by each frame's OWN display names rather than by the deduplicated
 * column list, so a frame whose column name another frame already claimed still
 * puts its value on its own rows — four queries each carrying a "Time" column
 * is the ordinary case, not an edge one.
 */
function payloadRows(series) {
  const rows = [];
  for (const frame of series) {
    for (let index = 0; index < frame.length; index += 1) {
      const row = {};
      for (const field of frame.fields) {
        row[field.display] = field.values[index];
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Render `content` the way `renderMode` asks.
 *
 * - `everyRow` — once per row, the row's columns at the top level;
 * - `allRows` / `data` / anything else — once, with the rows as `data`.
 */
function renderContent({ content, rows, renderMode, partials }) {
  // Partials are passed as a RUNTIME option rather than registered on `hb`:
  // registering would make one panel's partial visible to every other panel in
  // the app for the rest of the session, and two dashboards are free to name
  // theirs the same thing.
  const template = hb.compile(content);
  const render = (context) => template(context, { partials });

  if (renderMode === 'everyRow') {
    return rows.map((row) => render({ ...row, data: rows })).join('');
  }
  return render({ data: rows });
}

// ─── The sandbox document ───────────────────────────────────────────────────

/**
 * The name every message between a panel frame and this module carries.
 *
 * A frame is on an opaque origin, so `event.origin` is the useless string
 * "null" and cannot be checked. What CAN be checked is the sender: the handler
 * below compares `event.source` against its own iframe's contentWindow, so a
 * message from any other frame on the page is dropped before this name is even
 * read. The name is the second gate, not the first.
 */
const PANEL_CHANNEL = 'dynamic-text-panel';

/**
 * localStorage bridge.
 *
 * The panel's script gets an object that behaves like localStorage and is
 * seeded, at document build time, with what the app stored for it last time.
 * Writes are posted here and land in the app's real localStorage under
 * STORAGE_PREFIX, so a key the panel calls `rh-cc-hidden-v1` can never collide
 * with an app key of the same name.
 *
 * Reads are answered from the seed, not from the parent: a synchronous
 * getItem() cannot wait for a message, and the panel's script reads its
 * preferences during its first pass.
 */
const STORAGE_PREFIX = 'grafana-dt-panel/';

function readStorageSnapshot() {
  const snapshot = {};
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) {
        snapshot[key.slice(STORAGE_PREFIX.length)] = window.localStorage.getItem(key);
      }
    }
  } catch {
    // Storage disabled (private mode, or a policy). The panel starts from its
    // defaults every time, which is what it does in Grafana in that case too.
  }
  return snapshot;
}

function applyStorageOp(message) {
  try {
    if (message.op === 'set' && typeof message.key === 'string') {
      window.localStorage.setItem(STORAGE_PREFIX + message.key, String(message.value ?? ''));
    } else if (message.op === 'remove' && typeof message.key === 'string') {
      window.localStorage.removeItem(STORAGE_PREFIX + message.key);
    } else if (message.op === 'clear') {
      Object.keys(readStorageSnapshot()).forEach(
        (key) => window.localStorage.removeItem(STORAGE_PREFIX + key),
      );
    }
  } catch {
    // A full or disabled store loses the preference, nothing else.
  }
}

// ─── Cross-panel globals ────────────────────────────────────────────────────
//
// In Grafana every panel's script runs in the one window, and panels on the same
// dashboard use that: one writes `window.__afHtml`, another polls for it. Here
// each panel is its own frame with its own window, so that conversation simply
// never happens and the reading panel waits forever — which renders as a panel
// permanently showing its "loading" placeholder next to a panel that is fine.
//
// So `__`-prefixed globals are mirrored between the frames on screen. The
// prefix is the panels' own convention and doubles as the filter: it keeps a
// frame's ordinary variables out of the channel without this module having to
// know any panel's names.
//
// Scope is the dashboard on screen, and it is enforced by lifetime rather than
// by an id: frames register on mount and deregister on unmount, and the last
// one out clears the map. Opening another dashboard therefore starts empty
// instead of inheriting a stale `__afHtml` from the previous one.

/**
 * Every dynamic text panel currently mounted: `id -> { frame, bodyHtml }`.
 *
 * One registry rather than a bare frame set, because the cross-panel DOM bridge
 * below needs two more things about each panel — a stable id to address it by,
 * and the HTML it is currently rendering, which is what its neighbours mirror.
 */
const livePanels = new Map();

/** Ids are per session and mean nothing outside it; they only have to be unique. */
let panelSeq = 0;
const nextPanelId = () => { panelSeq += 1; return `dtp-${panelSeq}`; };

/** One per document built — see `message.doc` in SANDBOX_PRELUDE. */
let docSeq = 0;
const nextDocId = () => { docSeq += 1; return `dtd-${docSeq}`; };

/** The `__` globals those frames have published, as JSON text. */
const sharedGlobals = new Map();

/** Every mounted panel's rendered HTML except one — what that one gets to mirror. */
function foreignHtmlFor(panelId) {
  const foreign = {};
  for (const [id, entry] of livePanels) {
    if (id !== panelId) foreign[id] = entry.bodyHtml ?? '';
  }
  return foreign;
}

function postToFrame(frame, message) {
  try {
    // Optional-chained: an iframe whose srcDoc has just changed is mid-reload
    // and briefly has no contentWindow. Its next `ready` will collect whatever
    // it missed.
    // '*' is the only target that can reach it: the frame is sandboxed without
    // allow-same-origin, so its origin is opaque and matches no named origin.
    // Receivers check `source === PANEL_CHANNEL` and the sending frame instead.
    frame?.contentWindow?.postMessage({ ...message, source: PANEL_CHANNEL }, '*'); // NOSONAR
  } catch {
    // A frame removed between the check and the call. Nothing to do.
  }
}

function broadcastGlobals(values, except) {
  for (const entry of livePanels.values()) {
    if (entry.frame === except) continue;
    postToFrame(entry.frame, { op: 'globals', values });
  }
}

// ─── Cross-panel DOM ────────────────────────────────────────────────────────
//
// The frames never touch each other. A write travels
//
//   writer's mirror -> MutationObserver -> here -> owner's frame -> its element
//
// and the address it carries is an INDEX into a document-order walk of the
// panel's elements. Both sides walk the same HTML string — the owner walks the
// content it rendered, the writer walks its copy of it — so index N is the same
// element in both, and no selector has to survive the trip. When a panel's data
// refreshes its HTML changes, and `pushForeignHtml` re-seeds the mirrors so the
// addresses keep meaning what they say.
//
// The ops are deliberately narrow — set an attribute, or replace one element's
// innerHTML. Notably NOT "replace this subtree wholesale", which is what makes
// a remote write land alongside whatever the owning panel's own script did
// rather than on top of it.
//
// The direction is one-way, writer to owner. A neighbour's mirror is therefore
// a faithful copy of what that panel RENDERED, plus whatever this panel has
// since written into it — not of what its own script has done since. Reads
// against it (`classList.contains`, a `querySelectorAll(...).length`) are what
// these panels use it for and are correct; a panel polling a neighbour for a
// value that neighbour's own script computes would not be, and none does.
// Two-way mirroring is what that would need, and it is not free: these panels
// animate their numbers, so every frame would broadcast a mutation per frame of
// a 700ms count-up to every other frame on the dashboard.

/** Hand one panel's freshly rendered HTML to every other panel's mirror. */
function pushForeignHtml(panelId, bodyHtml) {
  for (const [id, entry] of livePanels) {
    if (id === panelId) continue;
    postToFrame(entry.frame, { op: 'foreign', panel: panelId, html: bodyHtml });
  }
}

/**
 * Replay DOM writes a panel's script made against its mirror of `target`.
 *
 * The values are HTML and attribute values built by dashboard-authored script
 * in a sandboxed frame, being handed to dashboard-authored content in another
 * sandboxed frame of the same dashboard — the two are the same trust level, and
 * in Grafana they are the same document. So this forwards rather than
 * sanitises. What it does NOT do is let either of them reach THIS document: the
 * parent only ever reads `ops` as data and posts it on.
 */
function forwardDomOps(target, ops) {
  const entry = livePanels.get(target);
  if (!entry || !Array.isArray(ops) || !ops.length) return;
  postToFrame(entry.frame, { op: 'dom-apply', ops });
}

// ─── The query bridge ───────────────────────────────────────────────────────

/**
 * The largest request body a panel's script may send.
 *
 * These are query payloads — the topology panel's is ~60KB of SQL — so the cap
 * is generous and exists to bound what one dashboard can push through
 * postMessage, not to police the queries themselves.
 */
const MAX_BRIDGED_BODY = 1_000_000;

/**
 * Run one `/api/ds/query` a panel's script asked for, and answer it.
 *
 * Always answers — with `ok: false` and an empty `results` when it fails rather
 * than by leaving the promise hanging. That is what Grafana's own failure looks
 * like to these scripts, and it matters: the panel here reads its values with
 * `.then(...)` and NO `.catch`, so a rejected promise would abandon the whole
 * render half-done instead of leaving the dashes it draws for a missing number.
 */
async function runBridgedQuery(frame, message, { signal, isCurrent = () => true } = {}) {
  // No reply at all once the document that asked has been replaced. Query ids
  // restart at q1 in every document, so an answer delivered late would resolve
  // the NEW document's q1 with the old document's data.
  const reply = (payload) => {
    if (signal?.aborted || !isCurrent()) return;
    postToFrame(frame, { op: 'query-result', id: message.id, ...payload });
  };

  let payload;
  try {
    if (typeof message.body !== 'string') {
      throw new TypeError('the query request carried no JSON body');
    }
    if (message.body.length > MAX_BRIDGED_BODY) {
      throw new Error('the query request body is too large');
    }
    payload = JSON.parse(message.body);
  } catch (err) {
    console.warn('[panels] a dynamic text panel sent a query this bridge refused', err);
    reply({ ok: false, status: 400, body: { results: {}, message: err?.message } });
    return;
  }

  try {
    // The same client the panel's DECLARED targets go through. One query path,
    // one place the org parameter and the backend's base URL are decided.
    reply({ ok: true, status: 200, body: await runDashboardQuery(payload, { signal }) });
  } catch (err) {
    // Cancelled because its document went away — nobody is waiting for it.
    if (signal?.aborted) return;
    console.warn('[panels] a dynamic text panel query failed', err);
    reply({ ok: false, status: err?.status ?? 502, body: { results: {}, message: err?.message } });
  }
}

/**
 * A closing `script` or `style` tag cannot appear inside the elements we build,
 * whatever the dashboard put in its options.
 *
 * In JavaScript the escaped form is the standard fix — the sequence is only ever
 * legal inside a string or a comment, which is the only place a script can
 * contain it for real. A stylesheet has no such escape and no legitimate reason
 * to contain it, so there the sequence is dropped.
 */
const escapeScript = (code) => String(code ?? '').replace(/<\/(script)/gi, String.raw`<\/$1`);
const escapeStyle = (css) => String(css ?? '').replace(/<\/(style|script)/gi, '');
const escapeAttr = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Runs before the panel's own script. Builds the `context` argument the plugin
 * passes, the storage shim, and stubs for what a sandbox cannot provide.
 *
 * `dataFrame` / `panelData` are rebuilt here from the rows instead of being
 * serialised alongside them: the same values in two shapes would double the
 * size of every document, and this dashboard's panel is sixty columns wide.
 */
const SANDBOX_PRELUDE = `
(function () {
  var blob = {};
  try { blob = JSON.parse(document.getElementById('dt-blob').textContent) || {}; } catch (e) {}
  var series = Array.isArray(blob.series) ? blob.series : [];
  var columns = Array.isArray(blob.columns) ? blob.columns : [];

  // Rows, rebuilt from the frames rather than shipped alongside them. See
  // framesToPayload / payloadRows — this is the same walk, on this side of the
  // wire, so the values cross it once.
  var rows = (function () {
    var out = [];
    for (var f = 0; f < series.length; f++) {
      var frame = series[f];
      var fields = frame.fields || [];
      for (var i = 0; i < (frame.length || 0); i++) {
        var row = {};
        for (var k = 0; k < fields.length; k++) {
          row[fields[k].display] = fields[k].values[i];
        }
        out.push(row);
      }
    }
    return out;
  })();

  function post(message) {
    try {
      message.source = blob.channel;
      // Which build of this panel's document is talking. The iframe element —
      // and so its contentWindow — survives a srcDoc change, so without this the
      // host cannot tell a query from the document on screen from one the
      // previous document sent just before it was replaced.
      message.doc = blob.doc;
      parent.postMessage(message, '*');
    } catch (e) {}
  }

  // localStorage, bridged to the application's own store. Defined as an own
  // property of window so it shadows the real accessor, which throws in an
  // opaque origin.
  var seed = (blob.storage && typeof blob.storage === 'object') ? blob.storage : {};
  var shim = {
    getItem: function (key) {
      key = String(key);
      return Object.prototype.hasOwnProperty.call(seed, key) ? seed[key] : null;
    },
    setItem: function (key, value) {
      key = String(key); value = String(value);
      seed[key] = value;
      post({ op: 'set', key: key, value: value });
    },
    removeItem: function (key) {
      key = String(key);
      delete seed[key];
      post({ op: 'remove', key: key });
    },
    clear: function () {
      Object.keys(seed).forEach(function (key) { delete seed[key]; });
      post({ op: 'clear' });
    },
    key: function (index) {
      var keys = Object.keys(seed);
      return index >= 0 && index < keys.length ? keys[index] : null;
    },
  };
  Object.defineProperty(shim, 'length', { get: function () { return Object.keys(seed).length; } });
  try {
    Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: shim, configurable: true });
  } catch (e) {}

  function unsupported(api) {
    return function () {
      console.warn('[panels] ' + api + ' is not available to a dynamic text panel here.');
    };
  }

  // ── Drill-down ───────────────────────────────────────────────────────────
  //
  // A panel says "open that dashboard" in three different ways depending on who
  // wrote it, and a topology panel commonly tries two of them in turn. All three
  // arrive here and leave as the same message.
  var DASHBOARD_PATH = /${DASHBOARD_PATH_PATTERN.source}/;

  function navigate(url) {
    var text = String(url == null ? '' : url);
    if (!DASHBOARD_PATH.test(text)) {
      // Not refused so much as not understood: this sandbox can only ask the
      // application to open a dashboard, and anything else has nowhere to go.
      console.warn('[panels] a dynamic text panel asked to open "' + text
        + '", which is not a dashboard link — ignored.');
      return false;
    }
    post({ op: 'navigate', url: text });
    return true;
  }

  var locationService = {
    partial: unsupported('locationService.partial'),
    push: navigate,
    replace: navigate,
    getSearch: function () { return new URLSearchParams(); },
    getSearchObject: function () { return {}; },
  };

  // The usual fallback when locationService is absent — and in a sandbox with
  // no allow-top-navigation and no allow-popups it is a no-op, so a panel that
  // took this branch had a dead control. Routed to the same place instead.
  var realOpen = (typeof window.open === 'function') ? window.open.bind(window) : null;
  window.open = function (url, target, features) {
    if (navigate(url)) return null;
    return realOpen ? realOpen(url, target, features) : null;
  };

  // A data link, or any anchor the template wrote. Capture phase, so a panel
  // that also handles the click still gets it; only dashboard links are taken,
  // because anything else is not this bridge's to swallow.
  document.addEventListener('click', function (event) {
    var anchor = (event.target && event.target.closest)
      ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    var href = anchor.getAttribute('href');
    if (!href || !DASHBOARD_PATH.test(href)) return;
    event.preventDefault();
    post({ op: 'navigate', url: href });
  }, true);

  // ── /api/ds/query, bridged to the application's backend ──────────────────
  //
  // Only this one endpoint. Every other fetch is left to the browser, which
  // is what it did before this bridge existed.
  var QUERY_ENDPOINT = /\\/api\\/ds\\/query(?:[?]|$)/;
  var pendingQueries = {};
  var querySeq = 0;
  var realFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;

  /** Enough of a Response for what these scripts actually call on one. */
  function fakeResponse(payload) {
    var body = (payload && payload.body !== undefined) ? payload.body : {};
    var text;
    try { text = JSON.stringify(body); } catch (e) { text = '{}'; }
    return {
      ok: !!(payload && payload.ok),
      status: (payload && payload.status) || 500,
      statusText: (payload && payload.ok) ? 'OK' : 'Error',
      redirected: false,
      type: 'basic',
      url: (payload && payload.url) || '',
      headers: {
        get: function (name) {
          return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
        },
      },
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(text); },
      clone: function () { return fakeResponse(payload); },
    };
  }

  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input
      : (input && typeof input.url === 'string') ? input.url : '';
    if (!QUERY_ENDPOINT.test(url)) {
      return realFetch ? realFetch(input, init)
        : Promise.reject(new Error('fetch is not available in this panel'));
    }
    var body = (init && init.body) || null;
    return new Promise(function (resolve) {
      var id = 'q' + (++querySeq);
      pendingQueries[id] = resolve;
      post({ op: 'query', id: id, body: (typeof body === 'string') ? body : null });
    }).then(fakeResponse);
  };

  // ── Globals shared with the dashboard's other panels ─────────────────────
  //
  // Mirrored, not shared: each frame keeps its own copy and the two are kept in
  // step. \`mirrored\` records the JSON last sent OR received for a key, which is
  // what stops a value arriving from another frame being immediately published
  // back as this frame's own change.
  var GLOBAL_TICK_MS = 300;
  var MAX_GLOBAL_BYTES = 262144;
  var RESERVED_GLOBALS = { __dt: 1 };
  var mirrored = {};

  function isSharedName(key) {
    return key.length > 2 && key.charCodeAt(0) === 95 && key.charCodeAt(1) === 95;
  }

  /** The value as JSON, or null when it is not the kind of thing to mirror. */
  function serializeGlobal(value) {
    var kind = typeof value;
    if (kind === 'function' || kind === 'symbol' || kind === 'undefined') return null;
    if (kind === 'object' && value !== null) {
      // Plain data only. A DOM node or a class instance would not survive the
      // trip, and JSON.stringify would either throw on it or quietly produce
      // something that is not the same object.
      var proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return null;
    }
    var text;
    try { text = JSON.stringify(value); } catch (e) { return null; }
    if (typeof text !== 'string' || text.length > MAX_GLOBAL_BYTES) return null;
    return text;
  }

  function applyGlobals(values) {
    if (!values || typeof values !== 'object') return;
    Object.keys(values).forEach(function (key) {
      var text = values[key];
      if (!isSharedName(key) || RESERVED_GLOBALS[key] || mirrored[key] === text) return;
      mirrored[key] = text;
      try { window[key] = JSON.parse(text); } catch (e) {}
    });
  }

  function publishGlobals() {
    var changed = null;
    var keys = Object.keys(window);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!isSharedName(key) || RESERVED_GLOBALS[key]) continue;
      var text = serializeGlobal(window[key]);
      if (text === null || mirrored[key] === text) continue;
      mirrored[key] = text;
      if (!changed) changed = {};
      changed[key] = text;
    }
    if (changed) post({ op: 'globals', values: changed });
  }

  window.addEventListener('message', function (event) {
    // Only the parent talks to this frame, and only in this vocabulary.
    if (event.source !== parent) return;
    var message = event.data;
    if (!message || message.source !== blob.channel) return;
    if (message.op === 'query-result') {
      var resolve = pendingQueries[message.id];
      if (resolve) { delete pendingQueries[message.id]; resolve(message); }
    } else if (message.op === 'globals') {
      applyGlobals(message.values);
    } else if (message.op === 'init') {
      applyGlobals(message.values);
      var foreign = message.foreign || {};
      Object.keys(foreign).forEach(function (panelId) {
        installMirror(panelId, foreign[panelId]);
      });
      startPanelScript();
    } else if (message.op === 'foreign') {
      installMirror(message.panel, message.html);
    } else if (message.op === 'dom-apply') {
      applyDomOps(message.ops);
    }
  });

  // Polled rather than trapped: a script assigns \`window.__afHtml\` directly and
  // there is no hook for that. 300ms is well inside the 3s these panels poll
  // each other on, and the scan only ever looks at own \`__\` keys.
  setInterval(publishGlobals, GLOBAL_TICK_MS);

  // ── The dashboard's other panels, mirrored ───────────────────────────────
  //
  // \`ownNodes\` is indexed HERE, before the panel's own script has run, so an
  // address from a neighbour still resolves after that script has rewritten
  // half the panel: these are element REFERENCES, not paths to re-resolve.

  function indexNodes(rootEl) {
    return rootEl ? Array.prototype.slice.call(rootEl.querySelectorAll('*')) : [];
  }

  var ownNodes = indexNodes(document.getElementById('dt-content'));

  /** panelId -> the mirror of that panel: its root, its node index, its observer. */
  var mirrors = {};

  /** Pending writes, keyed so repeated writes to one element coalesce. */
  var pendingOps = {};
  var flushScheduled = false;

  function flushOps() {
    flushScheduled = false;
    Object.keys(pendingOps).forEach(function (panelId) {
      var mirror = mirrors[panelId];
      var bucket = pendingOps[panelId];
      delete pendingOps[panelId];
      if (!mirror) return;
      var ops = [];
      Object.keys(bucket).forEach(function (key) {
        var entry = bucket[key];
        var el = mirror.nodes[entry.addr];
        if (!el) return;
        // The element's id travels alongside its index when it has one, and the
        // owner prefers it. An index is only correct while the mirror and the
        // original are the same render; an id survives the owning panel
        // re-rendering underneath us, which is the one moment an index can send
        // a write to a real but wrong element.
        var id = el.getAttribute('id') || null;
        // Read the CURRENT value rather than the one at mutation time, so a
        // burst of writes to one element sends its end state once.
        if (entry.name) {
          ops.push({ addr: entry.addr, id: id, kind: 'attr', name: entry.name,
            value: el.getAttribute(entry.name) });
        } else {
          ops.push({ addr: entry.addr, id: id, kind: 'html', value: el.innerHTML });
        }
      });
      if (ops.length) post({ op: 'dom', target: panelId, ops: ops });
    });
  }

  function recordMutations(panelId, mirror, records) {
    var bucket = pendingOps[panelId] || (pendingOps[panelId] = {});
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      // A text change reports the TEXT NODE; its element is what carries the
      // address, and replacing that element's innerHTML carries the change.
      var el = record.target.nodeType === 1
        ? record.target : record.target.parentElement;
      if (!el) continue;
      var addr = mirror.nodes.indexOf(el);
      // Not indexed means the writer's own script created it. Nothing is lost:
      // it is inside an ancestor whose innerHTML op will carry it.
      if (addr < 0) continue;
      if (record.type === 'attributes') {
        bucket['a|' + addr + '|' + record.attributeName] = {
          addr: addr, name: record.attributeName,
        };
      } else {
        bucket['h|' + addr] = { addr: addr, name: null };
      }
    }
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flushOps, 0);
    }
  }

  /**
   * (Re)seed one neighbour's mirror.
   *
   * A shadow root, so the neighbour's own \`<style>\` blocks — these panels each
   * ship one — style the mirror and nothing else. \`innerHTML\` does not run
   * \`<script>\`, and the host is display:none, so nothing here renders or
   * executes; it exists to be queried and written to.
   */
  function installMirror(panelId, html) {
    var mirror = mirrors[panelId];
    if (!mirror) {
      var host = document.createElement('div');
      host.setAttribute('data-dt-mirror', panelId);
      host.style.display = 'none';
      document.body.appendChild(host);
      var shadow = null;
      try { shadow = host.attachShadow({ mode: 'open' }); } catch (e) {}
      mirror = mirrors[panelId] = { shadow: shadow || host, root: null,
        nodes: [], observer: null };
    }
    if (mirror.observer) mirror.observer.disconnect();
    var mount = document.createElement('div');
    mount.innerHTML = String(html == null ? '' : html);
    try { mirror.shadow.textContent = ''; } catch (e) {}
    mirror.shadow.appendChild(mount);
    mirror.root = mount;
    mirror.nodes = indexNodes(mount);
    delete pendingOps[panelId];
    if (typeof MutationObserver === 'function') {
      mirror.observer = new MutationObserver(function (records) {
        recordMutations(panelId, mirror, records);
      });
      mirror.observer.observe(mount, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
    }
  }

  function applyDomOps(ops) {
    if (!ops || !ops.length) return;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      // By id where there is one — resolved against the LIVE document, so a
      // write lands on the element that is on screen now rather than on a node
      // this panel's own script has since detached. Index is the fallback for
      // the elements these templates leave unnamed.
      var el = (op.id ? realById(op.id) : null) || ownNodes[op.addr];
      if (!el) continue;
      try {
        if (op.kind === 'attr') {
          if (op.value === null || op.value === undefined) el.removeAttribute(op.name);
          else el.setAttribute(op.name, String(op.value));
        } else if (op.kind === 'html') {
          el.innerHTML = String(op.value == null ? '' : op.value);
        }
      } catch (e) {
        // One unappliable write must not cost the rest of the batch.
      }
    }
  }

  // ── document.querySelector, extended to the mirrors ──────────────────────
  //
  // This panel's OWN content is searched first and always wins, so a selector
  // that resolves inside the panel behaves exactly as it did before any of this
  // existed. Only a selector that finds nothing here — which is precisely the
  // "reaching for another panel" case — falls through.

  var realQuery = document.querySelector.bind(document);
  var realQueryAll = document.querySelectorAll.bind(document);
  var realById = document.getElementById.bind(document);

  function mirrorRoots() {
    var roots = [];
    Object.keys(mirrors).forEach(function (key) {
      if (mirrors[key].root) roots.push(mirrors[key].root);
    });
    return roots;
  }

  document.querySelector = function (selector) {
    var hit;
    try { hit = realQuery(selector); } catch (e) { return null; }
    if (hit) return hit;
    var roots = mirrorRoots();
    for (var i = 0; i < roots.length; i++) {
      try {
        var found = roots[i].querySelector(selector);
        if (found) return found;
      } catch (e) {}
    }
    return null;
  };

  // An Array, not a NodeList — indexable and .length, which is all these
  // scripts use, plus the forEach some of them expect on it anyway.
  document.querySelectorAll = function (selector) {
    var own;
    try { own = realQueryAll(selector); } catch (e) { return []; }
    if (own.length) return Array.prototype.slice.call(own);
    var roots = mirrorRoots();
    for (var i = 0; i < roots.length; i++) {
      try {
        var found = roots[i].querySelectorAll(selector);
        if (found.length) return Array.prototype.slice.call(found);
      } catch (e) {}
    }
    return [];
  };

  document.getElementById = function (id) {
    var hit = realById(id);
    if (hit) return hit;
    var roots = mirrorRoots();
    for (var i = 0; i < roots.length; i++) {
      try {
        // An id selector, escaped: these come from dashboard content, and an id
        // with a '.' in it would otherwise be read as a class.
        var found = roots[i].querySelector('[id="' + String(id).replace(/"/g, '\\\\"') + '"]');
        if (found) return found;
      } catch (e) {}
    }
    return null;
  };

  var eventBus = {
    publish: unsupported('eventBus.publish'),
    subscribe: function () { return { unsubscribe: function () {} }; },
    getStream: function () {
      return { subscribe: function () { return { unsubscribe: function () {} }; } };
    },
  };

  // ── The time range ───────────────────────────────────────────────────────
  //
  // In Grafana \`timeRange.from\` / \`.to\` are Moment objects, and scripts lean on
  // that: the topology panel computes its query window as
  // \`context.grafana.timeRange.to.valueOf()\`. The range crosses postMessage as
  // epoch milliseconds and is rebuilt here as the part of Moment these scripts
  // use. Handed over as bare strings, \`valueOf()\` returned the DATE TEXT, which
  // went into the SQL as \`start_time\`; OpenObserve answered 400, and the whole
  // severity pass that hangs off that query — the CRIT/WARN badges, the Alerts
  // list, the KPI row's alert count — never ran.
  function momentLike(ms) {
    var date = new Date(ms);
    return {
      valueOf: function () { return ms; },
      toDate: function () { return new Date(ms); },
      toISOString: function () { return date.toISOString(); },
      toJSON: function () { return date.toISOString(); },
      toString: function () { return date.toString(); },
      unix: function () { return Math.floor(ms / 1000); },
      isValid: function () { return isFinite(ms); },
    };
  }

  var timeRange = (function (raw) {
    // typeof, not isFinite alone: a NaN crosses JSON as null, and isFinite(null)
    // is true.
    if (!raw || typeof raw.from !== 'number' || typeof raw.to !== 'number') return undefined;
    return {
      from: momentLike(Number(raw.from)),
      to: momentLike(Number(raw.to)),
      raw: raw.raw || { from: String(raw.from), to: String(raw.to) },
    };
  })(blob.timeRange);

  // Grafana's PanelData, one frame per query and each carrying its refId — see
  // framesToPayload for why a script cannot work without them.
  var panelData = {
    state: blob.state || 'Done',
    series: series,
    timeRange: timeRange,
  };
  // The plugin's "current" frame is the first one, as in Grafana.
  var dataFrame = series[0] || { name: 'A', length: 0, fields: [] };

  // The dashboard's other variables were already substituted into the content
  // before it got here; what a SCRIPT still asks for is the time range, which
  // is the one thing a script's own query cannot do without.
  var replaceVariables = function (value) {
    if (typeof value !== 'string' || !timeRange) return value;
    var from = String(timeRange.from.valueOf());
    var to = String(timeRange.to.valueOf());
    return value
      .replace(/\\$\\{__from\\}|\\$__from\\b/g, from)
      .replace(/\\$\\{__to\\}|\\$__to\\b/g, to);
  };
  var element = document.getElementById('dt-content');

  window.__dt = {
    data: rows,
    dataFrame: dataFrame,
    panelData: panelData,
    options: blob.options || {},
    theme: blob.theme || {},
    replaceVariables: replaceVariables,
    locationService: locationService,
    eventBus: eventBus,
    notify: unsupported('notifySuccess / notifyError'),
    refresh: unsupported('refresh'),
    utils: {},
    context: {
      data: panelData,
      // \`panelData\` as well as \`data\`, because that is the name these panels
      // reach for — \`(context.panelData && context.panelData.series) || []\`,
      // with no fallback that could find it under any other name. The two are
      // the same object, so nothing has to decide which is authoritative.
      panelData: panelData,
      dataFrame: dataFrame,
      // The panel's own container. A script's first line is usually
      // \`context.element || document\`, and giving it the real element is what
      // scopes its selectors to its own content the way Grafana does. Reaching
      // a NEIGHBOUR is a separate act, spelled \`document.querySelector\` —
      // which is bridged; see "Cross-panel DOM".
      element: element,
      panel: { data: rows, options: blob.options || {} },
      grafana: {
        timeRange: timeRange,
        timeZone: blob.timeZone,
        theme: blob.theme || {},
        replaceVariables: replaceVariables,
        locationService: locationService,
        eventBus: eventBus,
        notifySuccess: unsupported('notifySuccess'),
        notifyError: unsupported('notifyError'),
        refresh: unsupported('refresh'),
      },
    },
  };

  // ── Starting the panel's own script ──────────────────────────────────────
  //
  // Deferred by exactly one message round-trip, until the parent has answered
  // \`ready\` with the neighbours' HTML. That is what makes the mirrors above
  // present SYNCHRONOUSLY for the panel's script — which matters, because
  // \`document.querySelector('#their-id')\` has to return the element on the
  // first call; there is nothing in the plugin's API for a script to wait on.
  //
  // The timer is the fallback for a host that never answers. A panel then runs
  // with no mirrors, which is exactly what it did before this existed — late is
  // the failure mode to have here, never "does not run".
  var panelStarted = false;

  function startPanelScript() {
    if (panelStarted) return;
    panelStarted = true;
    clearTimeout(startFallback);
    try {
      if (typeof window.__dtRun === 'function') window.__dtRun();
    } catch (err) {
      console.error('[panels] dynamic text panel script failed', err);
    }
  }

  var startFallback = setTimeout(startPanelScript, 1500);

  // Last, and only once everything above is listening: ask for whatever the
  // dashboard's other panels have already published, and for what they render.
  // A frame that reloads on a data refresh gets the current values back rather
  // than waiting for the panel that owns them to change them again.
  post({ op: 'ready' });
})();
`;

/**
 * The panel's script, given the plugin's own parameter names.
 *
 * Not strict mode, and not a module: the plugin evaluates this code as a plain
 * function body, and a script written for it may well assign an implicit global.
 *
 * Declared as `__dtRun` rather than run where it sits, because the prelude calls
 * it one message round-trip later — once the neighbouring panels' DOM mirrors
 * are in place. See "Starting the panel's own script" in SANDBOX_PRELUDE, which
 * is also where the throw is caught: a broken script leaves the rendered content
 * standing, where in Grafana the same throw blanks the panel.
 */
function wrapPanelCode(code) {
  if (!code || !String(code).trim()) return '';
  return `window.__dtRun = function () {
  (function (context, element, data, dataFrame, panelData, options, theme, replaceVariables,
             locationService, eventBus, notifySuccess, notifyError, refresh, utils) {
${escapeScript(code)}
  })(__dt.context, document.getElementById('dt-content'), __dt.data, __dt.dataFrame,
     __dt.panelData, __dt.options, __dt.theme, __dt.replaceVariables, __dt.locationService,
     __dt.eventBus, __dt.notify, __dt.notify, __dt.refresh, __dt.utils);
};`;
}

/**
 * The document the iframe loads: the rendered content, then the bridge, then the
 * panel's own script — in that order, because the script expects to find the
 * content already in the DOM (Grafana runs it after render, hence its name).
 */
function buildSandboxDocument({
  bodyHtml, code, styles, externalStyles, series, columns, state, options, theme,
  timeRange, timeZone, docId,
}) {
  const links = (externalStyles ?? [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
    .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
    .map((url) => `<link rel="stylesheet" href="${escapeAttr(url)}">`)
    .join('');

  const baseCss = `
html { box-sizing: border-box; color-scheme: ${theme.isDark ? 'dark' : 'light'}; }
*, *::before, *::after { box-sizing: inherit; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  background: transparent;
  color: ${theme.text};
  font-family: ${theme.fontFamily};
  font-size: ${theme.fontSize};
  overflow: auto;
}
a { color: ${theme.link}; }
`;

  const blob = jsonForScript({
    series,
    columns,
    state,
    options,
    theme,
    timeRange,
    timeZone,
    storage: readStorageSnapshot(),
    channel: PANEL_CHANNEL,
    doc: docId,
  });

  return `<!doctype html><html><head><meta charset="utf-8">${links}`
    + `<style>${baseCss}${escapeStyle(styles)}</style></head><body>`
    + `<div id="dt-content">${bodyHtml}</div>`
    + `<script type="application/json" id="dt-blob">${blob}</script>`
    + `<script>${SANDBOX_PRELUDE}</script>`
    + `<script>${wrapPanelCode(code)}</script>`
    + '</body></html>';
}

// ─── The panel ──────────────────────────────────────────────────────────────

function DynamicTextPanel({
  data, width, height, options, title, replaceVariables, timeZone,
}) {
  const grafanaTheme = useTheme2();
  const frameRef = useRef(null);
  // This panel's address for the lifetime of the component. Its own, rather than
  // the Grafana panel id, because the registry only has to be unique within the
  // dashboard on screen and a panel id is not guaranteed to be there at all.
  const panelIdRef = useRef(null);
  if (panelIdRef.current === null) panelIdRef.current = nextPanelId();
  const panelId = panelIdRef.current;

  // The id of the document currently in the frame, and the bridged queries in
  // flight with the document that asked for each. A query whose document has
  // been replaced is cancelled rather than left holding one of the browser's
  // six connections while the new document's queries wait behind it.
  const docIdRef = useRef(null);
  const inflightRef = useRef(new Map());

  // Everything the frame asks for. Bound to THIS iframe's window: a message
  // from anywhere else — another panel, another frame on the page, another
  // origin entirely — is not this panel's and is dropped before it is read.
  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin && event.origin !== 'null' && event.origin !== window.location.origin && !event.origin.startsWith('blob:')) return;
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (message?.source !== PANEL_CHANNEL) return;

      switch (message.op) {
        case 'set':
        case 'remove':
        case 'clear':
          applyStorageOp(message);
          break;

        // Drill-down. Whether it actually opens is not this panel's decision:
        // the dashboard may not be registered in this application's catalog,
        // and the screen that owns the navigation is the one that knows.
        case 'navigate':
          requestDashboardNavigation(message.url);
          break;

        case 'query': {
          // From a document already replaced: nobody will read the answer.
          if (message.doc !== docIdRef.current) break;
          const controller = new AbortController();
          const inflight = inflightRef.current;
          inflight.set(controller, message.doc);
          runBridgedQuery(frame, message, {
            signal: controller.signal,
            isCurrent: () => message.doc === docIdRef.current,
          }).finally(() => inflight.delete(controller));
          break;
        }

        case 'globals':
          if (message.values && typeof message.values === 'object') {
            Object.entries(message.values).forEach(([key, value]) => {
              sharedGlobals.set(key, value);
            });
            broadcastGlobals(message.values, frame);
          }
          break;

        // A DOM write this panel's script made against its mirror of another
        // panel. Routed, not interpreted — see forwardDomOps.
        case 'dom':
          forwardDomOps(message.target, message.ops);
          break;

        // Answered ALWAYS, and synchronously, because the frame is holding its
        // own script until this arrives. An empty reply is a complete one: a
        // dashboard with a single dynamic text panel has no neighbours and no
        // shared globals, and its script must still start.
        case 'ready':
          postToFrame(frame, {
            op: 'init',
            values: sharedGlobals.size ? Object.fromEntries(sharedGlobals) : {},
            foreign: foreignHtmlFor(panelId),
          });
          break;

        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    const inflight = inflightRef.current;
    return () => {
      window.removeEventListener('message', onMessage);
      // The panel is gone — closing the dashboard should not leave its ~40
      // topology queries running against Grafana.
      inflight.forEach((_, controller) => controller.abort());
      inflight.clear();
    };
  }, [panelId]);

  const theme = useMemo(() => ({
    name: grafanaTheme.name,
    isDark: grafanaTheme.isDark,
    text: grafanaTheme.colors.text.primary,
    textSecondary: grafanaTheme.colors.text.secondary,
    background: grafanaTheme.colors.background.primary,
    border: grafanaTheme.colors.border.weak,
    link: grafanaTheme.colors.primary.text,
    fontFamily: grafanaTheme.typography.fontFamily,
    fontSize: `${grafanaTheme.typography.fontSize}px`,
  }), [grafanaTheme]);

  // The answer the panel is showing — see ./panelAnswer.js. Held
  // in a ref so a Loading state keeps the previous answer on screen instead of
  // rebuilding the document around it. `null` until the first answer, and
  // then the panel shows its defaultContent with no script.
  const awaitsQuery = options?.[AWAITS_QUERY_OPTION] === true;
  const answerRef = useRef(null);
  if (isAnswer(data, awaitsQuery)) answerRef.current = { data };
  const answered = answerRef.current !== null;
  const shown = answerRef.current?.data;

  const { series, columns } = useMemo(() => framesToPayload(shown?.series), [shown?.series]);

  // Rows for the TEMPLATE, which is compiled here. The sandbox rebuilds the same
  // rows from `series` on its side, so the values are serialised once.
  const rows = useMemo(() => payloadRows(series), [series]);

  // The rendered content, on its own rather than folded into the document
  // below, because it is what the dashboard's OTHER panels mirror — see
  // "Cross-panel DOM". Both sides of an address are then derived from this one
  // string, which is what makes an index mean the same element in both.
  const bodyHtml = useMemo(() => {
    if (options?.helpers && String(options.helpers).trim()) {
      warnUnsupportedHelpers(title);
    }

    const partials = {};
    (Array.isArray(options?.contentPartials) ? options.contentPartials : []).forEach((partial) => {
      if (partial?.name && typeof partial.content === 'string') {
        partials[partial.name] = partial.content;
      }
    });

    // Grafana variables are substituted before the template is compiled, the
    // same order the plugin uses — a `$service` inside the template is meant to
    // be the dashboard's value of it, not a Handlebars path.
    const interpolate = (source) => {
      try {
        return replaceVariables ? replaceVariables(source) : source;
      } catch {
        return source;
      }
    };

    const source = rows.length ? (options?.content ?? '') : (options?.defaultContent ?? '');

    try {
      return renderContent({
        content: interpolate(String(source)),
        rows,
        renderMode: options?.renderMode,
        partials,
      });
    } catch (err) {
      // A malformed template costs the panel its content, not the dashboard —
      // and the message is worth showing, because it names what to fix.
      console.error(`[panels] dynamic text panel "${title || ''}" template failed`, err);
      return `<div style="padding:12px;color:${escapeAttr(theme.textSecondary)}">`
        + `Template error: ${escapeAttr(err?.message ?? 'unknown')}</div>`;
    }
  }, [rows, options, title, replaceVariables, theme.textSecondary]);

  // Membership of the dashboard's panel registry, for the cross-panel globals
  // and DOM above, carrying the content this panel currently renders.
  //
  // Mount/unmount rather than anything the panel says, so the registry can
  // never outlive the panels in it — which is what scopes both to the dashboard
  // on screen. Re-running on `bodyHtml` keeps what the neighbours mirror in step
  // with what is actually rendered here, because an address is an index into
  // this string: a mirror holding the PREVIOUS render resolves index N to the
  // wrong element, which is worse than resolving it to none.
  //
  // Panels mount together, so on a first render the push below mostly finds no
  // neighbours yet. It does not need to: a frame asks for the whole set itself
  // once it is listening (`ready` -> `init`), and by then every sibling has
  // registered. The push is what keeps a panel already on screen current when
  // this one re-renders on its own refresh.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    livePanels.set(panelId, { frame, bodyHtml });
    pushForeignHtml(panelId, bodyHtml);
    return () => {
      livePanels.delete(panelId);
      // The last panel of this dashboard has gone. Whatever they were saying to
      // each other is not the next dashboard's business.
      if (!livePanels.size) sharedGlobals.clear();
    };
  }, [panelId, bodyHtml]);

  const sandbox = useMemo(() => {
    const docId = nextDocId();
    const html = buildSandboxDocument({
      bodyHtml,
      // No script until there is an answer to run it against. It would only be
      // replaced — queries and all — the moment the answer arrived.
      code: answered ? (options?.afterRender ?? options?.code ?? '') : '',
      styles: options?.styles ?? '',
      externalStyles: options?.externalStyles ?? [],
      series,
      columns,
      state: shown?.state,
      options: { renderMode: options?.renderMode, wrap: options?.wrap },
      theme,
      // Epoch ms, rebuilt as Moment-like objects inside the frame — see "The
      // time range" in SANDBOX_PRELUDE.
      timeRange: shown?.timeRange
        ? {
          from: Number(shown.timeRange.from?.valueOf()),
          to: Number(shown.timeRange.to?.valueOf()),
          raw: {
            from: String(shown.timeRange.raw?.from ?? shown.timeRange.from),
            to: String(shown.timeRange.raw?.to ?? shown.timeRange.to),
          },
        }
        : undefined,
      timeZone,
      docId,
    });
    return { html, docId };
  }, [bodyHtml, answered, columns, series, shown?.state, options, theme, timeZone,
    shown?.timeRange]);

  // Assigned during render, not in an effect, so a message the replaced
  // document sends in the gap before the effect runs is already recognised as
  // stale.
  docIdRef.current = sandbox.docId;

  // A new document is on its way into the frame: whatever the previous one was
  // still waiting on is cancelled.
  useEffect(() => {
    inflightRef.current.forEach((doc, controller) => {
      if (doc !== sandbox.docId) controller.abort();
    });
  }, [sandbox.docId]);

  // An error is the one state where the panel's own content cannot be trusted to
  // say anything useful: its template would render against no rows and its
  // script would build an empty table, which reads as "everything is fine".
  if (hasError(data)) {
    return (
      <Centered width={width} height={height} tone="error">
        {errorMessage(data)}
      </Centered>
    );
  }

  return (
    <iframe
      ref={frameRef}
      className="viz-dynamic-text"
      title={title ? `${title} content` : 'Dynamic text panel content'}
      // No allow-same-origin, deliberately — see the note at the top of this
      // file. Adding it would give the dashboard's script this application.
      sandbox="allow-scripts"
      srcDoc={sandbox.html}
      style={{ width, height }}
    />
  );
}
DynamicTextPanel.propTypes = panelPropTypes;

export const dynamicTextPanelPlugin = new PanelPlugin(DynamicTextPanel).useFieldConfig();
