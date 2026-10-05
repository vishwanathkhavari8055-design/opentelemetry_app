/**
 * Guards the step-size floor that decides how expensive every Prometheus panel
 * on a dashboard is to answer.
 *
 * Both directions of getting this wrong are quiet. Too coarse on a short range
 * and a fifteen-minute zoom — how an incident actually gets looked at — loses
 * the resolution it is being opened for, while still drawing a plausible line.
 * Too fine on a long one and a wide panel asks for ~1440 evaluation steps to
 * draw ~1900 pixels, which is what made a 22-panel dashboard take 14s to load.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROM_DEFAULT_MIN_INTERVAL,
  PROM_MIN_INTERVAL_TIERS,
  pickMinInterval,
} from '../src/grafana/minInterval.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('pickMinInterval', () => {
  it('leaves a short zoomed-in window on Grafana\'s own 15s', () => {
    // The case the tiering exists to NOT touch.
    for (const range of [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR]) {
      assert.equal(pickMinInterval(range), PROM_DEFAULT_MIN_INTERVAL);
    }
  });

  it('widens past an hour, and again past six', () => {
    assert.equal(pickMinInterval(HOUR + 1000), '60s');
    assert.equal(pickMinInterval(6 * HOUR), '60s');
    assert.equal(pickMinInterval(6 * HOUR + 1000), '300s');
    assert.equal(pickMinInterval(24 * HOUR), '300s');
    assert.equal(pickMinInterval(30 * 24 * HOUR), '300s');
  });

  it('treats each boundary as belonging to the FINER tier', () => {
    // Exactly one hour is a range a user picks from the toolbar, and it must
    // get the resolution the "Last 1 hour" option has always given it.
    assert.equal(pickMinInterval(1 * HOUR), '15s');
    assert.equal(pickMinInterval(6 * HOUR), '60s');
  });

  it('keeps a toolbar range on the tier it looks like', () => {
    // Grafana resolves now-1h -> now INCLUSIVELY: the range that reaches a query
    // is 3600001ms, not 3600000. Measured in the browser, not assumed — an exact
    // comparison put every "Last 1 hour" view on a 60s step, four times coarser
    // than it renders today, while still drawing a plausible line.
    assert.equal(pickMinInterval(1 * HOUR + 1), '15s');
    assert.equal(pickMinInterval(6 * HOUR + 1), '60s');
    assert.equal(pickMinInterval(15 * MINUTE + 1), '15s');
  });

  it('still widens for a range genuinely past the boundary', () => {
    // A second over is a different window; a millisecond over is the same one.
    assert.equal(pickMinInterval(1 * HOUR + 1000), '60s');
    assert.equal(pickMinInterval(6 * HOUR + 1000), '300s');
  });

  it('falls back to the widest tier for a range it cannot read', () => {
    // A 15s step over a nonsense range is the one combination that can hang the
    // datasource, so an unreadable range must never land on the finest tier.
    for (const bad of [undefined, null, NaN, Infinity, -1, 'now-6h']) {
      assert.equal(pickMinInterval(bad), '300s');
    }
  });

  it('only ever coarsens as the window grows', () => {
    const asMs = (s) => Number(s.replace('s', '')) * 1000;
    let previous = 0;
    for (const range of [MINUTE, HOUR, 2 * HOUR, 6 * HOUR, 12 * HOUR, 7 * 24 * HOUR]) {
      const current = asMs(pickMinInterval(range));
      assert.ok(current >= previous, `${range}ms refined the step to ${current}ms`);
      previous = current;
    }
  });

  it('ends in a catch-all, so no range can fall off the table', () => {
    assert.equal(PROM_MIN_INTERVAL_TIERS.at(-1).maxRangeMs, Infinity);
  });
});
