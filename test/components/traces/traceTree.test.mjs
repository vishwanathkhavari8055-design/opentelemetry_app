/**
 * Guards the span list → waterfall tree conversion.
 *
 * The waterfall trusts this module for three things, and each fails quietly:
 *  - UNITS. start/end are nanoseconds and duration is microseconds; mixing
 *    them scales every bar by 1000 and still looks plausible.
 *  - NO LOST SPANS. A child whose parent was sampled away becomes a root; a
 *    trace whose parent links form a cycle still renders instead of going
 *    blank; a span without an id is the only thing dropped.
 *  - ORDER. Nodes come out depth-first with a parent before its children and
 *    siblings by start time, which is what lets rows map straight to the list.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTraceTree,
  formatSpanClock,
  formatSpanTimestamp,
  parseJsonArray,
  serviceGraph,
  spanGeometry,
  spanKindLetter,
  spanKindName,
} from '../../../src/components/traces/traceTree.js';

/** A span row as GET /api/traces/spans returns it; times in ns, duration in µs. */
const span = (id, parent, startNs, endNs, extra = {}) => ({
  raw: {
    span_id: id,
    reference_parent_span_id: parent,
    operation_name: `op-${id}`,
    service_name: extra.service ?? 'api',
    span_kind: extra.kind ?? '2',
    span_status: extra.status,
    start_time: startNs,
    end_time: endNs,
    duration: (endNs - startNs) / 1000,
    ...extra.raw,
  },
});

describe('spanKindName / spanKindLetter', () => {
  it('maps the numeric OTLP enum, as a number or a string', () => {
    assert.equal(spanKindName('1'), 'Internal');
    assert.equal(spanKindName(3), 'Client');
    assert.equal(spanKindName('5'), 'Consumer');
    assert.equal(spanKindName(0), 'Unspecified');
  });

  it('normalises a spelled-out kind and treats blank as Unspecified', () => {
    assert.equal(spanKindName('SERVER'), 'Server');
    assert.equal(spanKindName('producer'), 'Producer');
    assert.equal(spanKindName(''), 'Unspecified');
    assert.equal(spanKindName(null), 'Unspecified');
    assert.equal(spanKindName('9'), '9', 'an out-of-range number is not invented into a kind');
  });

  it('gives each kind its letter, and a dot for anything else', () => {
    assert.equal(spanKindLetter('2'), 's');
    assert.equal(spanKindLetter('Consumer'), 'r');
    assert.equal(spanKindLetter(undefined), '·');
    assert.equal(spanKindLetter('weird'), '·');
  });
});

describe('buildTraceTree', () => {
  it('orders nodes depth-first, siblings by start, with depths', () => {
    const tree = buildTraceTree([
      span('c2', 'root', 3_000, 4_000),
      span('root', null, 0, 10_000),
      span('c1', 'root', 1_000, 2_000),
      span('g1', 'c1', 1_500, 1_800),
    ]);
    assert.deepEqual(tree.nodes.map((n) => [n.id, n.depth]), [['root', 0], ['c1', 1], ['g1', 2], ['c2', 1]]);
    assert.deepEqual(tree.roots.map((n) => n.id), ['root']);
    assert.equal(tree.maxDepth, 2);
    assert.equal(tree.startNs, 0);
    assert.equal(tree.endNs, 10_000);
    assert.equal(tree.totalUs, 10, 'nanoseconds → microseconds');
  });

  it('breaks a start-time tie by the shorter duration', () => {
    const tree = buildTraceTree([
      span('root', null, 0, 10_000),
      span('long', 'root', 1_000, 9_000),
      span('short', 'root', 1_000, 2_000),
    ]);
    assert.deepEqual(tree.nodes.map((n) => n.id), ['root', 'short', 'long']);
  });

  it('keeps an orphan as a root and drops only spans without an id', () => {
    const tree = buildTraceTree([
      span('a', null, 0, 1_000),
      span('orphan', 'sampled-away', 500, 700),
      { raw: { operation_name: 'no id' } },
    ]);
    assert.deepEqual(tree.roots.map((n) => n.id), ['a', 'orphan']);
    assert.equal(tree.nodes.length, 2);
  });

  it('treats a span that is its own parent as a root', () => {
    const tree = buildTraceTree([span('self', 'self', 0, 100)]);
    assert.deepEqual(tree.nodes.map((n) => n.id), ['self']);
  });

  it('still renders a trace whose parent links form a cycle', () => {
    const tree = buildTraceTree([span('x', 'y', 200, 300), span('y', 'x', 100, 400)]);
    assert.deepEqual(tree.roots.map((n) => n.id), ['y'], 'the earliest span becomes the root');
    assert.deepEqual(tree.nodes.map((n) => n.id), ['y', 'x']);
  });

  it('reads the fallback fields and defaults of a thin row', () => {
    const [node] = buildTraceTree([{ spanId: 's1', operationName: 'GET /', serviceName: 'web', spanStatus: 'error' }]).nodes;
    assert.equal(node.name, 'GET /');
    assert.equal(node.service, 'web');
    assert.equal(node.status, 'ERROR');
    assert.equal(node.kind, 'Unspecified');
    assert.equal(node.httpStatus, null);
    assert.equal(node.startNs, 0);
    const [bare] = buildTraceTree([{ spanId: 's2', raw: { span_id: 's2', start_time: 'junk' } }]).nodes;
    assert.equal(bare.name, '(unnamed)');
    assert.equal(bare.service, '—');
    assert.equal(bare.status, 'UNSET');
    assert.equal(bare.startNs, 0, 'a non-numeric time reads as 0, not NaN');
  });

  it('counts errors and keeps the http status', () => {
    const tree = buildTraceTree([
      span('r', null, 0, 10, { status: 'ERROR', raw: { http_status_code: 500 } }),
      span('c', 'r', 1, 2, { status: 'ok' }),
    ]);
    assert.equal(tree.errorCount, 1);
    assert.equal(tree.nodes[0].httpStatus, 500);
    assert.equal(tree.nodes[1].status, 'OK');
  });

  it('never reports a zero-width trace, and handles no spans', () => {
    assert.equal(buildTraceTree([span('a', null, 5, 5)]).totalUs, 1);
    for (const input of [[], null, undefined]) {
      const empty = buildTraceTree(input);
      assert.deepEqual(empty.nodes, []);
      assert.equal(empty.startNs, 0);
      assert.equal(empty.endNs, 0);
      assert.equal(empty.totalUs, 1);
      assert.equal(empty.maxDepth, 0);
    }
  });
});

describe('spanGeometry', () => {
  it('places a span as percentages of the trace', () => {
    assert.deepEqual(spanGeometry({ startNs: 2_500, endNs: 5_000 }, 0, 10_000), { left: 25, width: 25, offsetUs: 2.5 });
  });

  it('floors a tiny span to a visible width', () => {
    assert.equal(spanGeometry({ startNs: 0, endNs: 1 }, 0, 1_000_000).width, 0.2);
  });

  it('clamps a span that starts before or runs past the window', () => {
    const before = spanGeometry({ startNs: -100, endNs: 50 }, 0, 100);
    assert.equal(before.left, 0);
    assert.equal(before.offsetUs, -0.1);
    const past = spanGeometry({ startNs: 80, endNs: 500 }, 0, 100);
    assert.equal(past.left, 80);
    assert.equal(past.width, 20);
  });

  it('does not divide by zero on a zero-width trace', () => {
    const g = spanGeometry({ startNs: 7, endNs: 7 }, 7, 7);
    assert.equal(g.left, 0);
    assert.equal(g.width, 0.2);
  });
});

describe('serviceGraph', () => {
  it('aggregates per service and counts cross-service calls, dropping self-edges', () => {
    const { nodes } = buildTraceTree([
      span('r', null, 0, 10_000, { service: 'gw' }),
      span('a', 'r', 0, 2_000, { service: 'api', status: 'ERROR' }),
      span('b', 'r', 2_000, 4_000, { service: 'api' }),
      span('c', 'a', 0, 1_000, { service: 'api' }),
      span('d', 'a', 0, 1_000, { service: 'db' }),
      span('e', 'missing', 0, 1_000, { service: 'db' }),
    ]);
    const { services, edges } = serviceGraph(nodes);
    const api = services.find((s) => s.name === 'api');
    assert.deepEqual(api, { name: 'api', spans: 3, errors: 1, totalUs: 5 });
    assert.deepEqual(edges.sort((x, y) => x.to.localeCompare(y.to)), [
      { from: 'gw', to: 'api', calls: 2 },
      { from: 'api', to: 'db', calls: 1 },
    ]);
  });

  it('is empty for no nodes', () => {
    assert.deepEqual(serviceGraph([]), { services: [], edges: [] });
  });
});

describe('parseJsonArray', () => {
  it('passes arrays through and parses JSON text', () => {
    const arr = [{ name: 'e' }];
    assert.equal(parseJsonArray(arr), arr);
    assert.deepEqual(parseJsonArray('[{"name":"exception"}]'), [{ name: 'exception' }]);
  });

  it('returns [] for blank, invalid, non-array or non-string input', () => {
    for (const v of ['', '   ', '{bad', '{"a":1}', 'null', 42, null, undefined, {}]) {
      assert.deepEqual(parseJsonArray(v), [], String(v));
    }
  });
});

describe('formatSpanClock / formatSpanTimestamp', () => {
  // Built from LOCAL date parts, so the expectations hold in any time zone
  // (Jenkins runs in UTC, developers in IST).
  const ms = new Date(2026, 9, 5, 13, 2, 4, 56).getTime();
  const ns = ms * 1e6 + 789_000; // + 789 µs inside that millisecond

  it('shows the request/response wall-clock time to the millisecond', () => {
    assert.equal(formatSpanClock(ns), '13:02:04.056');
    assert.equal(formatSpanClock(String(ns)), '13:02:04.056', 'the stream may send a string');
  });

  it('keeps microseconds in the full stamp, so same-millisecond spans differ', () => {
    assert.equal(formatSpanTimestamp(ns), '2026-10-05 13:02:04.056789');
    assert.equal(formatSpanTimestamp(ns + 1_000), '2026-10-05 13:02:04.056790');
    assert.equal(formatSpanClock(ns + 1_000), formatSpanClock(ns));
  });

  it('reads the waterfall row start/end from buildTraceTree in nanoseconds', () => {
    const { nodes } = buildTraceTree([span('a', null, ns, ns + 250_000_000)]);
    assert.equal(formatSpanClock(nodes[0].startNs), '13:02:04.056');
    assert.equal(formatSpanClock(nodes[0].endNs), '13:02:04.306', '250 ms later, not 250 s');
  });

  it('renders a dash for a missing or in-flight boundary rather than 1970', () => {
    for (const v of [0, null, undefined, '', 'abc', -5, Number.NaN]) {
      assert.equal(formatSpanClock(v), '—', String(v));
      assert.equal(formatSpanTimestamp(v), '—', String(v));
    }
  });
});
