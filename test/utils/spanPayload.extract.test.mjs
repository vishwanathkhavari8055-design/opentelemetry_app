/**
 * spanPayload decides what the trace inspector shows as a span's "actual
 * operation" and how its payload is printed. The type-specific field must win
 * over the generic `name` — when `name` won, the full SQL / URL payload was
 * hidden behind a truncated label — and bad JSON must never throw into render.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractActualOperation, renderPayload } from '../../src/utils/spanPayload.js';

describe('extractActualOperation', () => {
  it('returns null for a missing node', () => {
    assert.equal(extractActualOperation(null), null);
    assert.equal(extractActualOperation(undefined), null);
  });

  it('prefers the SQL statement over the name for every database type', () => {
    for (const type of ['SQL', 'mssql', 'Database', 'MONGODB']) {
      assert.equal(extractActualOperation({ type, name: 'SELECT', dbStatement: 'SELECT * FROM t' }), 'SELECT * FROM t');
    }
    assert.equal(extractActualOperation({ type: 'SQL', name: 'q', query: 'SELECT 1' }), 'SELECT 1');
    assert.equal(extractActualOperation({ type: 'SQL', name: 'q', statement: 'UPDATE x' }), 'UPDATE x');
  });

  it('uses endpoint, then url, then target for HTTP spans', () => {
    assert.equal(extractActualOperation({ type: 'http', name: 'GET', endpoint: '/a?b=1', url: 'u' }), '/a?b=1');
    assert.equal(extractActualOperation({ type: 'HTTP', name: 'GET', url: 'http://x/y' }), 'http://x/y');
    assert.equal(extractActualOperation({ type: 'HTTP', name: 'GET', target: '/t' }), '/t');
  });

  it('uses the command, then the statement, for redis spans', () => {
    assert.equal(extractActualOperation({ type: 'REDIS', command: 'GET k', dbStatement: 'x' }), 'GET k');
    assert.equal(extractActualOperation({ type: 'REDIS', dbStatement: 'SET k v' }), 'SET k v');
  });

  it('formats internal spans as Class.method()', () => {
    assert.equal(extractActualOperation({ type: 'INTERNAL', className: 'Svc', methodName: 'run' }), 'Svc.run()');
    assert.equal(extractActualOperation({ type: 'INTERNAL', methodName: 'run' }), 'run');
    assert.equal(extractActualOperation({ type: 'INTERNAL', className: 'Svc' }), 'Svc');
  });

  it('falls back through the generic fields when the typed one is absent', () => {
    assert.equal(extractActualOperation({ type: 'SQL', name: 'fallback' }), 'fallback');
    assert.equal(extractActualOperation({ actualOperation: 'a', operation: 'b', name: 'n' }), 'a');
    assert.equal(extractActualOperation({ operation: '  ', requestLabel: 'label', name: 'n' }), 'label');
    assert.equal(extractActualOperation({ spanName: 'span', name: 'n' }), 'span');
    assert.equal(extractActualOperation({ type: 'LOG', name: 'n' }), 'n');
  });

  it('does not treat inherited object keys as span types', () => {
    assert.equal(extractActualOperation({ type: 'constructor', name: 'n' }), 'n');
  });

  it('returns null when nothing is populated', () => {
    assert.equal(extractActualOperation({ type: 'HTTP', name: '   ' }), null);
  });
});

describe('renderPayload', () => {
  it('returns null for empty values', () => {
    assert.equal(renderPayload(''), null);
    assert.equal(renderPayload(null), null);
  });

  it('pretty-prints JSON strings and objects', () => {
    assert.equal(renderPayload('{"a":1}'), '{\n  "a": 1\n}');
    assert.equal(renderPayload(' [1,2]'), '[\n  1,\n  2\n]');
    assert.equal(renderPayload({ b: 'x' }), '{\n  "b": "x"\n}');
  });

  it('returns plain strings and numbers as text', () => {
    assert.equal(renderPayload('SELECT 1'), 'SELECT 1');
    assert.equal(renderPayload(42), '42');
  });

  it('falls back to the raw string when JSON-looking text does not parse', () => {
    assert.equal(renderPayload('{not json'), '{not json');
  });

  it('falls back to String() for objects that cannot be stringified', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.equal(renderPayload(cyclic), '[object Object]');
  });
});
