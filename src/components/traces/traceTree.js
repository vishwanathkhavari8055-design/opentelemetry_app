/**
 * Turning a flat list of spans into the tree the waterfall draws.
 *
 * Pure functions, no React — the geometry is the part worth being able to
 * reason about (and test) on its own.
 *
 * ─── Units, measured against the live stream ───────────────────────────────
 *
 *   start_time / end_time   NANOSECONDS  (end - start = duration × 1000)
 *   duration                MICROSECONDS
 *
 * Mixing these up silently scales the whole waterfall by 1000, which looks
 * plausible until you compare a bar against its own label. Everything below
 * works in nanoseconds internally and converts to µs only at the edges, where
 * formatDurationUs expects it.
 */

/** OTLP SpanKind. The stream carries the numeric enum as a string ("1"), but
 *  some services emit the word ("Internal"), so both are handled. */
const KIND_BY_NUMBER = {
  0: 'Unspecified', 1: 'Internal', 2: 'Server', 3: 'Client',
  4: 'Producer', 5: 'Consumer',
};

/** Single letter shown against each waterfall row, as in the reference UI. */
const KIND_LETTER = {
  Internal: 'i', Server: 's', Client: 'c', Producer: 'p', Consumer: 'r',
  Unspecified: '·',
};

export const spanKindName = (raw) => {
  if (raw == null || raw === '') return 'Unspecified';
  const n = Number(raw);
  if (Number.isFinite(n) && KIND_BY_NUMBER[n]) return KIND_BY_NUMBER[n];
  const s = String(raw);
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
};

export const spanKindLetter = (raw) => KIND_LETTER[spanKindName(raw)] || '·';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Build the span tree.
 *
 * @param {Array} spans rows from GET /api/traces/spans (each with `raw`)
 * @returns {{nodes: Array, roots: Array, startNs: number, endNs: number,
 *            totalUs: number, maxDepth: number, errorCount: number}}
 *
 * `nodes` is in RENDER ORDER — a depth-first walk — so the waterfall can map
 * it straight to rows without re-walking, and so a parent always precedes its
 * children.
 */
export const buildTraceTree = (spans) => {
  const rows = (spans || []).map((s) => {
    const r = s.raw || s;
    return {
      span: s,
      raw: r,
      id: r.span_id || s.spanId,
      parentId: r.reference_parent_span_id || null,
      name: r.operation_name || s.operationName || '(unnamed)',
      service: r.service_name || s.serviceName || '—',
      kind: spanKindName(r.span_kind),
      status: (r.span_status || s.spanStatus || 'UNSET').toUpperCase(),
      httpStatus: r.http_status_code ?? null,
      startNs: num(r.start_time),
      endNs: num(r.end_time),
      durationUs: num(r.duration),
      children: [],
    };
  }).filter((r) => r.id);

  const byId = new Map(rows.map((r) => [r.id, r]));

  // A parent outside this trace (sampled away, or still in flight) makes its
  // child a root rather than dropping it — losing spans from the waterfall is
  // far worse than showing an extra top-level row.
  const roots = [];
  rows.forEach((r) => {
    const parent = r.parentId ? byId.get(r.parentId) : null;
    if (parent && parent !== r) parent.children.push(r);
    else roots.push(r);
  });

  const sortByStart = (a, b) => a.startNs - b.startNs || a.durationUs - b.durationUs;

  // If the parent links form a cycle, every span is somebody's child and the
  // walk below starts from an empty stack — rendering NOTHING for a trace that
  // does have spans. Fall back to the earliest span as a root so a malformed
  // trace still displays; the cycle guard in the walk stops the loop.
  if (roots.length === 0 && rows.length > 0) {
    const earliest = rows.reduce((a, b) => (b.startNs < a.startNs ? b : a), rows[0]);
    roots.push(earliest);
  }

  roots.sort(sortByStart);
  rows.forEach((r) => {
    r.children.sort(sortByStart);
  });

  // Depth-first flatten, tracking depth. Iterative rather than recursive: a
  // pathological trace can nest deeply enough to blow the call stack, and a
  // blank screen would be a poor way to find that out.
  const nodes = [];
  const stack = [...roots].reverse().map((r) => ({ row: r, depth: 0 }));
  const guard = new Set();
  while (stack.length) {
    const { row, depth } = stack.pop();
    if (guard.has(row.id)) continue; // cycle guard — malformed parent links
    guard.add(row.id);
    row.depth = depth;
    nodes.push(row);
    for (let i = row.children.length - 1; i >= 0; i -= 1) {
      stack.push({ row: row.children[i], depth: depth + 1 });
    }
  }

  const startNs = nodes.length ? Math.min(...nodes.map((n) => n.startNs)) : 0;
  const endNs = nodes.length ? Math.max(...nodes.map((n) => n.endNs)) : 0;

  return {
    nodes,
    roots,
    startNs,
    endNs,
    // Guard against a zero-width trace (every span in the same nanosecond):
    // the waterfall divides by this.
    totalUs: Math.max(1, (endNs - startNs) / 1000),
    maxDepth: nodes.reduce((m, n) => Math.max(m, n.depth), 0),
    errorCount: nodes.filter((n) => n.status === 'ERROR').length,
  };
};

/** Position of one span within the trace, as percentages of the total width. */
export const spanGeometry = (node, startNs, endNs) => {
  const total = Math.max(1, endNs - startNs);
  const left = ((node.startNs - startNs) / total) * 100;
  const width = ((node.endNs - node.startNs) / total) * 100;
  return {
    left: Math.max(0, Math.min(100, left)),
    // Floor the width so a microsecond span is still visible rather than
    // collapsing to nothing on a multi-second trace.
    width: Math.max(0.2, Math.min(100 - left, width)),
    offsetUs: (node.startNs - startNs) / 1000,
  };
};

/**
 * Service-to-service edges, for the Trace Graph tab.
 * Self-edges are dropped: a service calling itself adds a loop to every node
 * and tells you nothing about the topology.
 */
export const serviceGraph = (nodes) => {
  const services = new Map();
  const edges = new Map();

  nodes.forEach((n) => {
    const s = services.get(n.service) || { name: n.service, spans: 0, errors: 0, totalUs: 0 };
    s.spans += 1;
    s.totalUs += n.durationUs;
    if (n.status === 'ERROR') s.errors += 1;
    services.set(n.service, s);
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  nodes.forEach((n) => {
    const parent = n.parentId ? byId.get(n.parentId) : null;
    if (!parent || parent.service === n.service) return;
    const key = `${parent.service} ${n.service}`;
    const e = edges.get(key) || { from: parent.service, to: n.service, calls: 0 };
    e.calls += 1;
    edges.set(key, e);
  });

  return { services: Array.from(services.values()), edges: Array.from(edges.values()) };
};

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** A span's start/end as a local Date, or null when the stream has no value
 *  (an in-flight span can arrive with end_time 0). */
const instantOf = (ns) => {
  const v = Number(ns);
  if (!Number.isFinite(v) || v <= 0) return null;
  return new Date(Math.floor(v / 1e6));
};

/**
 * Wall-clock time of a span boundary, "HH:mm:ss.SSS" in local time — the
 * Request (start_time) and Response (end_time) columns of the waterfall.
 * Takes NANOSECONDS, like everything else in this module.
 */
export const formatSpanClock = (ns) => {
  const d = instantOf(ns);
  if (!d) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${
    pad(d.getMilliseconds(), 3)}`;
};

/**
 * Full "YYYY-MM-DD HH:mm:ss.SSSSSS" stamp of a span boundary, for tooltips and
 * the span panel. Microseconds are kept because sibling spans routinely start
 * inside the same millisecond, where the short clock reads identically.
 */
export const formatSpanTimestamp = (ns) => {
  const d = instantOf(ns);
  if (!d) return '—';
  const micros = Math.floor(Number(ns) / 1e3) % 1e6;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${
    pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(micros, 6)}`;
};

/** OpenObserve stores `events` and `links` as JSON TEXT, not arrays. */
export const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
