/**
 * Guards the two rules that decide whether a registered dashboard shows data.
 *
 * Both are easy to "tidy" into something broken, and neither fails loudly when
 * you do: widen the rewrite and a working dashboard starts erroring; widen the
 * detector and every panel whose query matched nothing grows an error banner.
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { unparsedFrameReason, withInfinityBackendParser } from '../src/grafana/infinity.js';

const INFINITY = { type: 'yesoreyeram-infinity-datasource', uid: 'dfuu2ag0a8glcd' };

/** A realistic Infinity target: the shape every panel on these dashboards uses. */
const target = (extra = {}) => ({
  refId: 'A',
  datasource: INFINITY,
  type: 'json',
  source: 'url',
  format: 'table',
  root_selector: 'hits',
  columns: [],
  url: 'http://openobserve/api/default/_search?type=metrics',
  url_options: { method: 'POST', data: '{"query":{"sql":"SELECT 1"}}' },
  ...extra,
});

/** A frame in Grafana's wire format, as /api/ds/query returns it. */
const frame = ({ fields = [], data, query } = {}) => ({
  schema: {
    refId: 'A',
    fields,
    meta: data === undefined ? {} : { custom: { data, ...(query ? { query } : {}) } },
  },
});

describe('withInfinityBackendParser', () => {
  it('rewrites a missing parser — the case that renders an empty dashboard', () => {
    assert.equal(withInfinityBackendParser(target()).parser, 'backend');
  });

  it('rewrites an explicit frontend parser', () => {
    assert.equal(withInfinityBackendParser(target({ parser: 'simple' })).parser, 'backend');
    assert.equal(withInfinityBackendParser(target({ parser: '' })).parser, 'backend');
  });

  it('leaves every parser that already runs server-side exactly as authored', () => {
    // Every working dashboard in the catalog is on `backend`. Touching these is
    // how a fix for one dashboard becomes an outage for the other seven.
    for (const parser of ['backend', 'uql', 'groq', 'sqlite']) {
      const original = target({ parser });
      assert.equal(withInfinityBackendParser(original), original, parser);
    }
  });

  it('leaves query types the Go backend cannot run', () => {
    for (const type of ['series', 'global-q']) {
      const original = target({ type });
      assert.equal(withInfinityBackendParser(original), original, type);
    }
  });

  it('ignores every other datasource', () => {
    const prom = { refId: 'A', datasource: { type: 'prometheus', uid: 'x' }, expr: 'up' };
    assert.equal(withInfinityBackendParser(prom), prom);
    const sql = { refId: 'A', datasource: { type: 'mssql', uid: 'y' }, rawSql: 'SELECT 1' };
    assert.equal(withInfinityBackendParser(sql), sql);
  });

  it('falls back to the proxy plugin type when the target names no datasource', () => {
    const bare = { refId: 'A', type: 'json', root_selector: 'hits' };
    assert.equal(
      withInfinityBackendParser(bare, 'yesoreyeram-infinity-datasource').parser, 'backend',
    );
    assert.equal(withInfinityBackendParser(bare, 'prometheus'), bare);
  });

  it('changes `parser` and nothing else', () => {
    const original = target();
    const out = withInfinityBackendParser(original);
    assert.deepEqual({ ...out, parser: undefined }, { ...original, parser: undefined });
    assert.notEqual(out, original, 'must not mutate the caller\'s target');
    assert.equal(original.parser, undefined);
  });

  it('survives rubbish without throwing', () => {
    for (const value of [null, undefined, 'a string', 42]) {
      assert.equal(withInfinityBackendParser(value), value);
    }
  });
});

describe('unparsedFrameReason', () => {
  it('says nothing when the frame parsed', () => {
    assert.equal(
      unparsedFrameReason(frame({ fields: [{ name: 'CPU' }], data: { hits: [{ CPU: 9 }] } })),
      null,
    );
  });

  it('says nothing when there is no raw response attached', () => {
    assert.equal(unparsedFrameReason(frame()), null);
    assert.equal(unparsedFrameReason(frame({ data: null })), null);
  });

  it('SAYS NOTHING when the query simply matched no rows', () => {
    // The false positive that matters. OpenObserve answers an empty search with a
    // full envelope — `hits: []` beside a dozen populated statistics fields — so
    // "raw data is attached" proves nothing. Get this wrong and every panel with
    // a currently-empty query wears an error banner.
    const empty = { cached_ratio: 100, scan_records: 530992, took: 166, hits: [] };
    assert.equal(unparsedFrameReason(frame({ data: empty }), target()), null);
  });

  it('reports a response that carried rows nothing turned into fields', () => {
    const rows = { hits: [{ 'CPU Usage %': 9.11 }] };
    const why = unparsedFrameReason(frame({ data: rows }), target());
    assert.match(why, /1 row\(s\)/);
    assert.match(why, /Backend/);
  });

  it('reads root_selector off the echoed query when the target is unknown', () => {
    const f = frame({ data: { hits: [{ a: 1 }, { a: 2 }] }, query: { root_selector: 'hits' } });
    assert.match(unparsedFrameReason(f, undefined), /2 row\(s\)/);
  });

  it('follows a nested path, and stops at one that does not resolve', () => {
    const data = { outer: { inner: [{ a: 1 }] } };
    assert.match(
      unparsedFrameReason(frame({ data }), target({ root_selector: 'outer.inner' })), /1 row/,
    );
    assert.equal(unparsedFrameReason(frame({ data }), target({ root_selector: 'outer.gone' })), null);
  });

  it('stays quiet when the selector is an expression it cannot follow', () => {
    // Infinity accepts JSONata here. Guessing at what it selects is how this
    // starts crying wolf, so an expression means silence.
    for (const root_selector of ['hits[0]', '$.hits', 'items.*.value', 'foo(bar)']) {
      assert.equal(
        unparsedFrameReason(frame({ data: { hits: [{ a: 1 }] } }), target({ root_selector })),
        null,
        root_selector,
      );
    }
  });

  it('treats a bare array response as the rows', () => {
    assert.match(
      unparsedFrameReason(frame({ data: [{ a: 1 }] }), target({ root_selector: '' })), /1 row/,
    );
    assert.equal(unparsedFrameReason(frame({ data: [] }), target({ root_selector: '' })), null);
  });

  it('does not treat the response envelope itself as rows', () => {
    // No selector, and the payload is an object rather than an array: that is as
    // likely to be an envelope as data, so it is not evidence of anything.
    const envelope = { total: 0, took: 12, hits: [] };
    assert.equal(unparsedFrameReason(frame({ data: envelope }), target({ root_selector: '' })), null);
  });
});
