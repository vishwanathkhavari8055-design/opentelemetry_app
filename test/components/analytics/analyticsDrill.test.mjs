/**
 * Guards the Analytics → Logs drill-through.
 *
 * A clicked count promises "these N lines". The drill must carry the row's
 * service, the column's severity and the analytics window mapped onto a Logs
 * preset — or the Logs screen opens on a different number than the one
 * clicked. Where that promise cannot be kept, the cell must NOT be a link:
 *  - `other` is TRACE ∪ unset, which the logs dialect cannot express (no OR);
 *  - a row summed over several services would open as a trace-level
 *    intersection, a smaller number than the cell;
 *  - a row not counted from service_name would degrade to free-text search;
 *  - a zero can only open an empty table.
 * Each refusal has its own tooltip, asserted here.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLogsDrill,
  drillHint,
  serviceNamesFrom,
  windowToLogsRange,
} from '../../../src/components/analytics/analyticsDrill.js';

const ROW = { matchedOn: ['service_name=IoTOpsSvc'], total: 5000, error: 1062, info: 3000, warn: 0, debug: 7, other: 429 };

describe('serviceNamesFrom', () => {
  it('reads service_name identifiers, trimmed and de-duplicated', () => {
    assert.deepEqual(serviceNamesFrom({ matchedOn: [' service_name = a ', 'service_name=b', 'service_name=a'] }), ['a', 'b']);
  });

  it('ignores other columns, blanks and malformed identifiers', () => {
    assert.deepEqual(serviceNamesFrom({ matchedOn: ['k8s_deployment_name=x', 'service_name=', 'no-equals', 42] }), []);
    assert.deepEqual(serviceNamesFrom({ matchedOn: ['service_name=a=b'] }), ['a=b'], 'splits on the first =');
    assert.deepEqual(serviceNamesFrom({}), []);
    assert.deepEqual(serviceNamesFrom(null), []);
  });
});

describe('windowToLogsRange', () => {
  it('maps each analytics window to a preset the Logs picker highlights', () => {
    assert.deepEqual(windowToLogsRange('now-24h'), { mode: 'relative', relative: '1d', from: '', to: '' });
    assert.equal(windowToLogsRange('now-7d').relative, '1w');
    assert.equal(windowToLogsRange('now-15m').relative, '15m');
    assert.equal(windowToLogsRange(' 1h ').relative, '1h');
    assert.equal(windowToLogsRange('now-6h').relative, '6h');
  });

  it('passes through other well-formed windows and falls back to 15m', () => {
    assert.equal(windowToLogsRange('now-3d').relative, '3d');
    assert.equal(windowToLogsRange('now-2M').relative, '2M');
    assert.equal(windowToLogsRange('yesterday').relative, '15m');
    assert.equal(windowToLogsRange('').relative, '15m');
    assert.equal(windowToLogsRange(undefined).relative, '15m');
  });
});

describe('buildLogsDrill', () => {
  it('carries the service, the severity and the window for a severity cell', () => {
    assert.deepEqual(buildLogsDrill({ row: ROW, bucketKey: 'error', window: 'now-24h' }), {
      services: ['IoTOpsSvc'], severity: 'ERROR',
      range: { mode: 'relative', relative: '1d', from: '', to: '' }, count: 1062,
    });
  });

  it('drills Total with no severity clause at all', () => {
    const drill = buildLogsDrill({ row: ROW, bucketKey: 'total', window: 'now-1h' });
    assert.equal(drill.severity, '');
    assert.equal(drill.count, 5000);
  });

  it('refuses `other`, unknown columns and a missing row', () => {
    assert.equal(buildLogsDrill({ row: ROW, bucketKey: 'other', window: 'now-1h' }), null);
    assert.equal(buildLogsDrill({ row: ROW, bucketKey: 'fatal', window: 'now-1h' }), null);
    assert.equal(buildLogsDrill({ row: null, bucketKey: 'error' }), null);
  });

  it('refuses a zero or non-numeric count', () => {
    assert.equal(buildLogsDrill({ row: ROW, bucketKey: 'warn' }), null);
    assert.equal(buildLogsDrill({ row: { ...ROW, error: 'n/a' }, bucketKey: 'error' }), null);
  });

  it('refuses a row with no service_name or with several services', () => {
    assert.equal(buildLogsDrill({ row: { ...ROW, matchedOn: ['db_name=x'] }, bucketKey: 'error' }), null);
    assert.equal(buildLogsDrill({ row: { ...ROW, matchedOn: ['service_name=a', 'service_name=b'] }, bucketKey: 'error' }), null);
  });
});

describe('drillHint', () => {
  it('says what a link opens', () => {
    const drill = buildLogsDrill({ row: ROW, bucketKey: 'error', window: 'now-1h' });
    assert.equal(drillHint({ row: ROW, bucketKey: 'error', drill, exact: '1,062' }), 'Open these 1,062 ERROR logs for IoTOpsSvc in Logs');
    const total = buildLogsDrill({ row: ROW, bucketKey: 'total', window: 'now-1h' });
    assert.equal(drillHint({ row: ROW, bucketKey: 'total', drill: total, exact: '5,000' }), 'Open these 5,000 logs for IoTOpsSvc in Logs');
  });

  it('explains why `other` is not a link', () => {
    assert.match(drillHint({ row: ROW, bucketKey: 'other', drill: null, exact: '429' }), /^429 — trace and logs with no severity set\. .*no OR\.$/);
  });

  it('says a zero has nothing to open', () => {
    assert.equal(drillHint({ row: ROW, bucketKey: 'warn', drill: null, exact: '0' }), '0 — nothing to open');
    assert.equal(drillHint({ row: undefined, bucketKey: 'error', drill: null, exact: '0' }), '0 — nothing to open');
  });

  it('explains a row not counted from service_name', () => {
    const row = { ...ROW, matchedOn: ['k8s_deployment_name=x'] };
    assert.match(drillHint({ row, bucketKey: 'error', drill: null, exact: '1,062' }), /not counted from a service_name/);
  });

  it('explains a multi-service sum, naming how many', () => {
    const row = { ...ROW, matchedOn: ['service_name=a', 'service_name=b', 'service_name=c'] };
    assert.match(drillHint({ row, bucketKey: 'error', drill: null, exact: '2,279' }), /^2,279 — a sum over 3 services\. .*single service/);
  });

  it('falls back to the bare figure for a drillable cell without a drill', () => {
    assert.equal(drillHint({ row: ROW, bucketKey: 'error', drill: null, exact: '1,062' }), '1,062');
  });
});
