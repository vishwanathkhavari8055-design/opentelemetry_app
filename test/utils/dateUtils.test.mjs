/**
 * Guards the timestamp formatters used by the logs, traces and alerts lists.
 *
 * All three render LOCAL time, so the process time zone is pinned to
 * Asia/Kolkata (UTC+05:30, no daylight saving) before the module loads: a
 * half-hour offset catches any code that formats UTC fields by mistake, which
 * a UTC-pinned run would hide. The formatters' Intl instances are built at
 * import, which is why the zone is set first.
 *
 * The failure modes guarded are the quiet ones: an invalid value must come
 * back as itself (never "Invalid Date", never a throw that blanks a row), and
 * OpenObserve's microsecond epochs must not be read as milliseconds — that
 * puts a 2026 event in the year 57,000.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const originalTz = process.env.TZ;
process.env.TZ = 'Asia/Kolkata';
after(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const { formatFullTimestamp, formatIsoDateTime, formatTimeOnly } = await import('../../src/utils/dateUtils.js');

/** 2026-04-06T07:42:14.456Z — 13:12:14.456 in Kolkata. */
const ISO = '2026-04-06T07:42:14.456Z';
const MS = Date.parse(ISO);

describe('formatFullTimestamp', () => {
  it('formats local date and 24-hour time with milliseconds, without the comma', () => {
    assert.equal(formatFullTimestamp(ISO), '06 Apr 2026 13:12:14.456');
  });

  it('rolls over the date when the offset crosses midnight', () => {
    assert.equal(formatFullTimestamp('2026-12-31T20:00:00.000Z'), '01 Jan 2027 01:30:00.000');
  });

  it('shows "--" for an empty value and returns an invalid one unchanged', () => {
    assert.equal(formatFullTimestamp(''), '--');
    assert.equal(formatFullTimestamp(null), '--');
    assert.equal(formatFullTimestamp('not a date'), 'not a date');
  });
});

describe('formatIsoDateTime', () => {
  it('formats YYYY-MM-DD HH:mm:ss.SSS in local time, zero-padded', () => {
    assert.equal(formatIsoDateTime(ISO), '2026-04-06 13:12:14.456');
    assert.equal(formatIsoDateTime('2026-01-01T00:00:00.007Z'), '2026-01-01 05:30:00.007');
  });

  it('accepts epoch milliseconds as a number', () => {
    assert.equal(formatIsoDateTime(MS), '2026-04-06 13:12:14.456');
  });

  it('rescales a numeric-string microsecond epoch', () => {
    assert.equal(formatIsoDateTime(String(MS * 1000)), '2026-04-06 13:12:14.456');
  });

  it('reads a numeric-string millisecond epoch as-is', () => {
    assert.equal(formatIsoDateTime(String(MS)), '2026-04-06 13:12:14.456');
  });

  it('shows "--" for empty and the raw text for anything unparseable', () => {
    assert.equal(formatIsoDateTime(undefined), '--');
    assert.equal(formatIsoDateTime('yesterday'), 'yesterday');
    assert.equal(formatIsoDateTime('1e400'), '1e400', 'numeric but beyond any date');
  });
});

describe('formatTimeOnly', () => {
  it('formats local 24-hour time with milliseconds', () => {
    assert.equal(formatTimeOnly(ISO), '13:12:14.456');
  });

  it('parses a numeric-string epoch in milliseconds', () => {
    assert.equal(formatTimeOnly(String(MS)), '13:12:14.456');
  });

  it('shows "--" for empty and the raw value when nothing parses', () => {
    assert.equal(formatTimeOnly(0), '--');
    assert.equal(formatTimeOnly('garbage'), 'garbage');
    assert.equal(formatTimeOnly('1e400'), '1e400');
  });
});
