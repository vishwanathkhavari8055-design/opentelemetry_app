/**
 * Guards the Prometheus `format: "table"` step — the label-to-column transform
 * Grafana does in its own browser plugin, which this application has to do
 * itself because that plugin is not loaded here.
 *
 * Two things are being pinned. The column NAMES, because they are not cosmetic:
 * dashboards name them literally in their `organize` and `seriesToColumns`
 * transformations, so `Value #A` becoming `Value` silently empties a panel. And
 * the narrowness of the trigger, because this runs on every query response in
 * the application — a table transform applied to an Infinity or time-series
 * query would corrupt panels that work today.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyPrometheusTableFormat } from '../src/grafana/promTable.js';

const PROM = { type: 'prometheus', uid: 'ffto7tbvxmeiod' };
const INFINITY = { type: 'yesoreyeram-infinity-datasource', uid: 'dfuu2ag0a8glcd' };

/** One Prometheus series as it arrives: `[Time, Value]` with labels on value. */
const series = (refId, labels, value, time = 1789975391000) => ({
  refId,
  fields: [
    { name: 'Time', type: 'time', config: {}, values: [time] },
    { name: 'Value', type: 'number', config: {}, labels, values: [value] },
  ],
  length: 1,
});

const query = (refId, extra = {}) => ({
  refId, datasource: PROM, expr: 'x', format: 'table', instant: true, ...extra,
});

const sent = (...queries) => new Map(queries.map((q) => [q.refId, q]));

const names = (frame) => frame.fields.map((f) => f.name);
const column = (frame, name) => frame.fields.find((f) => f.name === name)?.values;

describe('applyPrometheusTableFormat', () => {
  it('promotes labels to columns and merges a refId\'s series into one frame', () => {
    const frames = [
      series('A', { assetid: 'ANPR-001', __name__: 'iot_device_status' }, 1),
      series('A', { assetid: 'ANPR-002', __name__: 'iot_device_status' }, 0),
    ];

    const [out, ...rest] = applyPrometheusTableFormat(frames, sent(query('A')), 'prometheus');

    assert.equal(rest.length, 0, 'two series of one refId become one frame');
    // Sole refId in the response -> plain "Value", Grafana's own rule.
    assert.deepEqual(names(out), ['Time', '__name__', 'assetid', 'Value']);
    assert.deepEqual(column(out, 'assetid'), ['ANPR-001', 'ANPR-002']);
    assert.deepEqual(column(out, 'Value'), [1, 0]);
    assert.equal(out.length, 2);
  });

  it('suffixes the value column with the refId when the response carried several', () => {
    // The shape "IoT Devices Inventory & Health Status" joins on: its organize
    // transformation names Value #A and Value #Operational_Status literally.
    const frames = [
      series('A', { assetid: 'ANPR-001' }, 1),
      series('Operational_Status', { assetid: 'ANPR-001' }, 16),
    ];

    const out = applyPrometheusTableFormat(
      frames, sent(query('A'), query('Operational_Status')), 'prometheus',
    );

    assert.deepEqual(out.map((f) => f.refId), ['A', 'Operational_Status']);
    assert.deepEqual(names(out[0]), ['Time', 'assetid', 'Value #A']);
    assert.deepEqual(names(out[1]), ['Time', 'assetid', 'Value #Operational_Status']);
  });

  it('unions labels across series and leaves a missing one blank', () => {
    const frames = [
      series('A', { assetid: 'ANPR-001', zone: 'north' }, 1),
      series('A', { assetid: 'ANPR-002' }, 0),
    ];

    const [out] = applyPrometheusTableFormat(frames, sent(query('A')), 'prometheus');

    // Sorted, so the column order cannot drift between refreshes.
    assert.deepEqual(names(out), ['Time', 'assetid', 'zone', 'Value']);
    // Blank, not a dropped row — an outer join still lines up.
    assert.deepEqual(column(out, 'zone'), ['north', '']);
    assert.deepEqual(column(out, 'Value'), [1, 0]);
  });

  it('types the histogram bucket label as a number', () => {
    const frames = [series('A', { le: '0.5' }, 3), series('A', { le: '10' }, 9)];

    const [out] = applyPrometheusTableFormat(frames, sent(query('A')), 'prometheus');

    const le = out.fields.find((f) => f.name === 'le');
    assert.equal(le.type, 'number');
    // Numbers, so a sort gives 0.5, 10 rather than "0.5", "10".
    assert.deepEqual(le.values, [0.5, 10]);
  });

  it('parses Prometheus\'s special float strings', () => {
    const frames = [series('A', { k: 'a' }, '+Inf'), series('A', { k: 'b' }, 'NaN')];

    const [out] = applyPrometheusTableFormat(frames, sent(query('A')), 'prometheus');

    assert.equal(column(out, 'Value')[0], Number.POSITIVE_INFINITY);
    assert.ok(Number.isNaN(column(out, 'Value')[1]));
  });

  // ─── what must be left alone ──────────────────────────────────────────────

  it('leaves a query that did not ask for table format untouched', () => {
    const frames = [series('A', { assetid: 'ANPR-001' }, 1)];
    const untouched = applyPrometheusTableFormat(
      frames, sent(query('A', { format: 'time_series' })), 'prometheus',
    );
    assert.equal(untouched, frames, 'the original array is handed straight back');
  });

  it('leaves a NON-Prometheus table query untouched', () => {
    // Infinity's own table format is already a table; rewriting it would
    // destroy the columns its dashboards read by name.
    const frames = [series('A', { assetid: 'x' }, 1)];
    const untouched = applyPrometheusTableFormat(
      frames, sent(query('A', { datasource: INFINITY })), 'yesoreyeram-infinity-datasource',
    );
    assert.equal(untouched, frames);
  });

  it('converts only the table refIds of a mixed panel', () => {
    // OSS Engine Overview's KPI panel: refId A is Infinity, B is Prometheus.
    const infinityFrame = { refId: 'A', fields: [{ name: 'svc', type: 'string', values: ['kafka'] }], length: 1 };
    const frames = [infinityFrame, series('B', { pod: 'p1' }, 7)];

    const out = applyPrometheusTableFormat(
      frames,
      sent(query('A', { datasource: INFINITY }), query('B')),
      'prometheus',
    );

    assert.equal(out[0], infinityFrame, 'the Infinity frame is the very same object');
    assert.deepEqual(names(out[1]), ['Time', 'pod', 'Value #B']);
  });

  it('tolerates empty and malformed responses', () => {
    assert.deepEqual(applyPrometheusTableFormat([], sent(query('A')), 'prometheus'), []);
    assert.equal(applyPrometheusTableFormat(null, sent(query('A')), 'prometheus'), null);

    // A frame with no fields — what an empty Prometheus result looks like.
    const empty = [{ refId: 'A', fields: [], length: 0 }];
    const [out] = applyPrometheusTableFormat(empty, sent(query('A')), 'prometheus');
    assert.equal(out.length, 0, 'no rows, and no throw');

    // No record of what was sent: nothing is known to be table format.
    const frames = [series('A', { k: 'v' }, 1)];
    assert.equal(applyPrometheusTableFormat(frames, undefined, 'prometheus'), frames);
  });
});
