/**
 * Guards the formatting shared by the two Analytics faces.
 *
 * The Drill Table and the Category Board show the same numbers so they can be
 * compared; the thresholds of the compact count are pinned so both faces agree.
 * The severity mix is measured against `total`, NOT against the sum of the
 * buckets — renormalising would make a row that is mostly unspecified look
 * like a clean info/error split. A sub-1% share says "<1%", never "0%" next to
 * a non-zero count.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  exactCount,
  formatCount,
  formatShare,
  SEVERITY_BUCKETS,
  severityMix,
} from '../../../src/components/analytics/analyticsFormat.js';

describe('SEVERITY_BUCKETS', () => {
  it('lists the buckets in display order, keyed as the backend row fields', () => {
    assert.deepEqual(SEVERITY_BUCKETS.map((b) => b.key), ['info', 'warn', 'error', 'debug', 'other']);
  });
});

describe('formatCount', () => {
  it('keeps zero, shows small values exactly and compacts large ones', () => {
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(undefined), '0');
    assert.equal(formatCount(429), '429');
    assert.equal(formatCount(1_062), '1.1K');
    assert.equal(formatCount(9_949), '9.9K');
    assert.equal(formatCount(10_000), '10K');
    assert.equal(formatCount(999_000), '999K');
    assert.equal(formatCount(1_380_000), '1.4M');
    assert.equal(formatCount(12_000_000), '12M');
  });
});

describe('exactCount', () => {
  it('formats with separators and reads junk as zero', () => {
    assert.equal(exactCount(1062), (1062).toLocaleString());
    assert.equal(exactCount('abc'), '0');
    assert.equal(exactCount(null), '0');
  });
});

describe('severityMix', () => {
  it('measures each bucket against total and drops empty ones', () => {
    const mix = severityMix({ total: 1000, info: 500, warn: 0, error: 50, debug: '0', other: 400 });
    assert.deepEqual(mix.map((s) => [s.key, s.count, s.pct]), [['info', 500, 50], ['error', 50, 5], ['other', 400, 40]]);
    assert.equal(mix[0].label, 'Info');
  });

  it('does not renormalise when the buckets do not reach total', () => {
    const mix = severityMix({ total: 1000, info: 50 });
    assert.equal(mix.length, 1);
    assert.equal(mix[0].pct, 5);
  });

  it('returns no segments for a silent or missing row', () => {
    assert.deepEqual(severityMix({ total: 0, info: 5 }), []);
    assert.deepEqual(severityMix(null), []);
  });
});

describe('formatShare', () => {
  it('rounds to a whole percent', () => {
    assert.equal(formatShare(1, 3), '33%');
    assert.equal(formatShare(50, 100), '50%');
    assert.equal(formatShare(1, 100), '1%');
  });

  it('says "<1%" rather than 0% for a non-zero part', () => {
    assert.equal(formatShare(4_000, 1_000_000), '<1%');
  });

  it('is 0% for a zero part or an empty whole', () => {
    assert.equal(formatShare(0, 100), '0%');
    assert.equal(formatShare(5, 0), '0%');
    assert.equal(formatShare('x', 'y'), '0%');
  });
});
