/**
 * Guards the number formatting on the traces screens.
 *
 * The traces stream stores durations in MICROSECONDS even though OpenObserve's
 * tooltip calls them "ns". Reading them in the wrong unit is off by 1000× and
 * still looks plausible, so each rung of the unit ladder is pinned at its
 * boundary. Missing and non-numeric values render as an em dash, never "NaN".
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatCount, formatDurationUs, formatExact, formatPercent } from '../../src/utils/format.js';

const MISSING = [null, undefined, 'abc', NaN, Infinity];

describe('formatDurationUs', () => {
  it('walks the us → ms → s → m ladder at each boundary', () => {
    assert.equal(formatDurationUs(0), '0.00ns');
    assert.equal(formatDurationUs(26), '26.00us');
    assert.equal(formatDurationUs(999), '999.00us');
    assert.equal(formatDurationUs(1000), '1.00ms');
    assert.equal(formatDurationUs(1410), '1.41ms');
    assert.equal(formatDurationUs(999_999), '1000.00ms');
    assert.equal(formatDurationUs(1_000_000), '1.00s');
    assert.equal(formatDurationUs(5_261_305), '5.26s');
    assert.equal(formatDurationUs(60_000_000), '1.00m');
    assert.equal(formatDurationUs('68400000'), '1.14m');
  });

  it('renders a missing or non-numeric duration as a dash', () => {
    for (const v of MISSING) assert.equal(formatDurationUs(v), '—', String(v));
  });
});

describe('formatCount', () => {
  it('shows exact values below a thousand and compacts above', () => {
    assert.equal(formatCount(966), '966');
    assert.equal(formatCount(1000), '1.0K');
    assert.equal(formatCount(15_000), '15.0K');
    assert.equal(formatCount(1_400_000), '1.4M');
    assert.equal(formatCount(-2500), '-2.5K');
    assert.equal(formatCount('0'), '0');
  });

  it('renders missing values as a dash', () => {
    for (const v of MISSING) assert.equal(formatCount(v), '—', String(v));
  });
});

describe('formatPercent', () => {
  it('formats a fraction as a two-decimal percentage', () => {
    assert.equal(formatPercent(0.1946), '19.46%');
    assert.equal(formatPercent(0), '0.00%');
    assert.equal(formatPercent(1), '100.00%');
    for (const v of MISSING) assert.equal(formatPercent(v), '—', String(v));
  });
});

describe('formatExact', () => {
  it('formats with the locale\'s separators', () => {
    assert.equal(formatExact(1234567), (1234567).toLocaleString());
    assert.equal(formatExact('42'), '42');
    for (const v of MISSING) assert.equal(formatExact(v), '—', String(v));
  });
});
