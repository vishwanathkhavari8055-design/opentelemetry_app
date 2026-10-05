/**
 * Guards the small span/log helpers the trace and log views lean on:
 * toCurl, parseTimestampMs, effectiveSpanStatus, getTypeColor and sourceRecord.
 *
 * - toCurl output is pasted into a shell. An unescaped apostrophe in a body
 *   ends the quoted string and the rest of the payload runs as shell words.
 * - parseTimestampMs must read OpenObserve's microsecond `_timestamp` as µs,
 *   or sibling spans sort into the far future.
 * - effectiveSpanStatus must prefer the HTTP code: OTel leaves successful spans
 *   UNSET, which otherwise shows every 200 as "UNKNOWN".
 * - sourceRecord must show the untouched wire record, not api.js's aliases.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toCurl } from '../../src/utils/toCurl.js';
import { parseTimestampMs } from '../../src/utils/parseTimestamp.js';
import { effectiveSpanStatus } from '../../src/utils/spanStatus.js';
import { getTypeColor, TYPE_COLORS } from '../../src/utils/typeColors.js';
import { sourceRecord } from '../../src/components/logs/sourceRecord.js';

describe('toCurl', () => {
  it('builds a GET with the upper-cased method and quoted URL', () => {
    assert.equal(toCurl({ httpMethod: 'get', endpoint: 'http://h/a?x=1&y=2' }), "curl -X GET 'http://h/a?x=1&y=2'");
  });

  it('adds a JSON content type only when the body looks like JSON', () => {
    assert.equal(
      toCurl({ httpMethod: 'POST', url: 'http://h/p', httpRequestBody: '  {"a":1}' }),
      "curl -X POST 'http://h/p' -H 'Content-Type: application/json' --data-raw '  {\"a\":1}'",
    );
    assert.equal(
      toCurl({ httpMethod: 'PUT', url: 'http://h/p', httpRequestBody: '[1]' }),
      "curl -X PUT 'http://h/p' -H 'Content-Type: application/json' --data-raw '[1]'",
    );
    assert.equal(
      toCurl({ httpMethod: 'POST', url: 'http://h/p', httpRequestBody: 'a=1' }),
      "curl -X POST 'http://h/p' --data-raw 'a=1'",
    );
  });

  it('escapes embedded single quotes the POSIX way', () => {
    assert.equal(
      toCurl({ httpMethod: 'POST', endpoint: "http://h/it's", httpRequestBody: "{\"n\":\"O'Brien\"}" }),
      "curl -X POST 'http://h/it'\\''s' -H 'Content-Type: application/json' --data-raw '{\"n\":\"O'\\''Brien\"}'",
    );
  });

  it('prefers endpoint over url and omits an empty or missing body', () => {
    assert.equal(toCurl({ httpMethod: 'GET', endpoint: 'http://e', url: 'http://u', httpRequestBody: '' }), "curl -X GET 'http://e'");
    assert.equal(toCurl({ httpMethod: 'GET', url: 'http://u', httpRequestBody: null }), "curl -X GET 'http://u'");
  });

  it('stringifies a non-string body', () => {
    assert.equal(toCurl({ httpMethod: 'POST', url: 'http://u', httpRequestBody: 0 }), "curl -X POST 'http://u' --data-raw '0'");
  });

  it('returns null without a node, a method or a URL', () => {
    assert.equal(toCurl(null), null);
    assert.equal(toCurl({ endpoint: 'http://u' }), null);
    assert.equal(toCurl({ httpMethod: 'GET' }), null);
  });
});

describe('parseTimestampMs', () => {
  it('parses ISO strings, including microsecond fractions', () => {
    assert.equal(parseTimestampMs('2026-05-07T09:06:30.495Z'), Date.UTC(2026, 4, 7, 9, 6, 30, 495));
    assert.equal(parseTimestampMs('2026-05-07T09:06:30.495821Z'), Date.UTC(2026, 4, 7, 9, 6, 30, 495));
  });

  it('reads milliseconds as-is and rescales microseconds', () => {
    assert.equal(parseTimestampMs(1746611400000), 1746611400000);
    assert.equal(parseTimestampMs('1746611400000'), 1746611400000);
    assert.equal(parseTimestampMs(1746611400000123), 1746611400000.123);
    assert.equal(parseTimestampMs(1e14), 1e14, 'the threshold itself is milliseconds');
  });

  it('returns null for nullish and unparseable input', () => {
    assert.equal(parseTimestampMs(null), null);
    assert.equal(parseTimestampMs(undefined), null);
    assert.equal(parseTimestampMs('Tuesday'), null);
    assert.equal(parseTimestampMs('abc'), null);
  });
});

describe('effectiveSpanStatus', () => {
  it('derives the status from the HTTP code at each class boundary', () => {
    assert.equal(effectiveSpanStatus({ httpStatus: 200, status: 'UNKNOWN' }), 'SUCCESS');
    assert.equal(effectiveSpanStatus({ httpStatus: '299' }), 'SUCCESS');
    assert.equal(effectiveSpanStatus({ httpStatus: 300 }), 'INFO');
    assert.equal(effectiveSpanStatus({ httpStatus: 404 }), 'WARN');
    assert.equal(effectiveSpanStatus({ httpStatus: 499 }), 'WARN');
    assert.equal(effectiveSpanStatus({ httpStatus: 500, status: 'OK' }), 'ERROR');
  });

  it('falls back to span status, then severity, when there is no HTTP code', () => {
    assert.equal(effectiveSpanStatus({ httpStatus: 0, status: 'ERROR' }), 'ERROR');
    assert.equal(effectiveSpanStatus({ httpStatus: 'n/a', severity: 'WARN' }), 'WARN');
    assert.equal(effectiveSpanStatus({}), null);
    assert.equal(effectiveSpanStatus(null), null);
  });
});

describe('getTypeColor', () => {
  it('looks up a type case-insensitively', () => {
    assert.equal(getTypeColor('http'), TYPE_COLORS.HTTP);
    assert.equal(getTypeColor('Redis'), TYPE_COLORS.REDIS);
  });

  it('keeps SQL and Redis visually distinct', () => {
    assert.notEqual(TYPE_COLORS.SQL, TYPE_COLORS.REDIS);
  });

  it('falls back to grey for unknown or missing types', () => {
    assert.equal(getTypeColor('KAFKA'), '#6e7681');
    assert.equal(getTypeColor(undefined), '#6e7681');
  });
});

describe('sourceRecord', () => {
  it('returns the preserved wire object untouched', () => {
    const raw = { 'service.name': 'svc', body: 'hi' };
    assert.equal(sourceRecord({ _raw: raw, serviceName: 'svc' }), raw);
  });

  it('otherwise strips the aliases api.js added', () => {
    assert.deepEqual(
      sourceRecord({ _raw: null, timestamp: 1, serviceName: 's', severity: 'INFO', traceId: 't', message: 'm', id: 'x', body: 'b', 'k8s.pod': 'p' }),
      { body: 'b', 'k8s.pod': 'p' },
    );
    assert.deepEqual(sourceRecord({ _raw: 'not-an-object', a: 1 }), { a: 1 });
  });

  it('returns an empty record for no row', () => {
    assert.deepEqual(sourceRecord(null), {});
    assert.deepEqual(sourceRecord(undefined), {});
  });
});
