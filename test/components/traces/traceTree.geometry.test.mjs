/**
 * traceTree.js turns the flat span list into the tree TraceDetail draws. The
 * edges guarded here are the ones that would make a real trace render wrong
 * or render nothing: spans whose parent is missing, cyclic parent links, a
 * zero-width trace, the word-form span kinds some services emit, and the
 * JSON-TEXT `events`/`links` columns OpenObserve stores.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  buildTraceTree, spanGeometry, serviceGraph, spanKindName, spanKindLetter, parseJsonArray,
} = await import('../../../src/components/traces/traceTree.js');

const raw = (id, parent, start, end, extra = {}) => ({
  raw: { span_id: id, reference_parent_span_id: parent, start_time: start, end_time: end, duration: (end - start) / 1000, ...extra },
});

describe('traceTree', () => {
  it('names numeric and word span kinds alike', () => {
    assert.equal(spanKindName('3'), 'Client');
    assert.equal(spanKindName('SERVER'), 'Server');
    assert.equal(spanKindName(''), 'Unspecified');
    assert.equal(spanKindName(null), 'Unspecified');
    assert.equal(spanKindLetter('producer'), 'p');
    assert.equal(spanKindLetter('weird'), '·');
  });

  it('keeps a span whose parent is outside the trace as a root', () => {
    const t = buildTraceTree([raw('a', null, 0, 10), raw('b', 'missing', 5, 8), { raw: { operation_name: 'no id' } }]);
    assert.deepEqual(t.roots.map((r) => r.id), ['a', 'b']);
    assert.equal(t.nodes.length, 2);
    assert.equal(t.nodes[0].name, '(unnamed)');
    assert.equal(t.nodes[0].service, '—');
    assert.equal(t.nodes[0].status, 'UNSET');
  });

  it('still renders a trace whose parent links form a cycle', () => {
    const t = buildTraceTree([raw('a', 'b', 5, 10), raw('b', 'a', 0, 10)]);
    assert.deepEqual(t.nodes.map((n) => [n.id, n.depth]), [['b', 0], ['a', 1]]);
  });

  it('falls back to camelCase fields and handles no spans at all', () => {
    const t = buildTraceTree([{ spanId: 's1', operationName: 'op', serviceName: 'svc', spanStatus: 'error' }]);
    assert.equal(t.nodes[0].name, 'op');
    assert.equal(t.errorCount, 1);
    assert.equal(t.totalUs, 1); // zero-width trace is floored, not divided by zero
    const empty = buildTraceTree(null);
    assert.deepEqual([empty.nodes.length, empty.startNs, empty.endNs, empty.maxDepth], [0, 0, 0, 0]);
  });

  it('clamps geometry and floors a tiny span to a visible width', () => {
    const g = spanGeometry({ startNs: 500, endNs: 500 }, 0, 1000);
    assert.equal(g.left, 50);
    assert.equal(g.width, 0.2);
    assert.equal(g.offsetUs, 0.5);
  });

  it('drops self-edges from the service graph', () => {
    const nodes = [
      { id: 'a', parentId: null, service: 'x', durationUs: 1, status: 'OK' },
      { id: 'b', parentId: 'a', service: 'x', durationUs: 1, status: 'OK' },
    ];
    assert.deepEqual(serviceGraph(nodes).edges, []);
  });

  it('reads events/links as JSON text, arrays, or nothing', () => {
    assert.deepEqual(parseJsonArray('[{"a":1}]'), [{ a: 1 }]);
    assert.deepEqual(parseJsonArray([1]), [1]);
    assert.deepEqual(parseJsonArray('{"a":1}'), []);
    assert.deepEqual(parseJsonArray('not json'), []);
    assert.deepEqual(parseJsonArray('  '), []);
    assert.deepEqual(parseJsonArray(42), []);
  });
});
