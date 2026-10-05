/**
 * Guards content-aware truncation of span and log labels.
 *
 * `text-overflow: ellipsis` clips the END, which for an HTTP path or a Java
 * logger is the part that identifies it. The strategies below keep the useful
 * end instead; the guard is that each kind keeps the RIGHT end, and that the
 * result never exceeds the budget (a label that grows past it pushes the
 * duration column off the row).
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectTruncateKind, smartTruncate } from '../../src/utils/truncate.js';

const HTTP = 'POST /IoTOpsCIMService/contextual/fetchContextualInformation';
const FQCN = 'com.trinity.iot.serviceimpl.CimDataServiceImpl';

describe('detectTruncateKind', () => {
  it('routes by span type first, case-insensitively', () => {
    assert.equal(detectTruncateKind(HTTP, 'http'), 'http');
    assert.equal(detectTruncateKind('SELECT * FROM t', 'SQL'), 'sql');
    assert.equal(detectTruncateKind('SELECT 1', 'mssql'), 'sql');
  });

  it('reads a dotted, space-free LOG body as a logger name', () => {
    assert.equal(detectTruncateKind('com.acme.Thing', 'LOG'), 'logger');
    assert.equal(detectTruncateKind('a sentence. with spaces', 'LOG'), 'plain');
  });

  it('recognises a fully-qualified class name without a type', () => {
    assert.equal(detectTruncateKind(FQCN), 'classname');
    assert.equal(detectTruncateKind('Com.Acme.Thing'), 'plain');
    assert.equal(detectTruncateKind('com.acme.thing'), 'plain');
  });

  it('is plain for empty text', () => {
    assert.equal(detectTruncateKind('', 'HTTP'), 'plain');
    assert.equal(detectTruncateKind(null), 'plain');
  });
});

describe('smartTruncate', () => {
  it('leaves text within the budget, and empty text, untouched', () => {
    assert.equal(smartTruncate('short', 'http'), 'short');
    assert.equal(smartTruncate('x'.repeat(60), 'plain'), 'x'.repeat(60));
    assert.equal(smartTruncate('', 'plain'), '');
    assert.equal(smartTruncate(null, 'plain'), null);
  });

  it('keeps the verb and the last path segment of an HTTP label', () => {
    assert.equal(smartTruncate(HTTP, 'http', 40), 'POST …/fetchContextualInformation');
  });

  it('start-anchors the composed HTTP label when the tail alone overflows', () => {
    const out = smartTruncate(`GET /${'x'.repeat(80)}`, 'http', 30);
    assert.equal(out, `GET …/${'x'.repeat(23)}…`);
    assert.equal(out.length, 30);
  });

  it('end-anchors an HTTP label with no verb, and start-anchors one with no path', () => {
    assert.equal(smartTruncate(`/api${'a'.repeat(40)}`, 'http', 20), `…${'a'.repeat(19)}`);
    assert.equal(smartTruncate(`GET ${'a'.repeat(40)}`, 'http', 20), `GET ${'a'.repeat(15)}…`);
  });

  it('keeps the class end of a logger name', () => {
    const out = smartTruncate(FQCN, 'logger', 30);
    assert.equal(out, '…erviceimpl.CimDataServiceImpl');
    assert.equal(out.length, 30);
  });

  it('keeps both ends of a class name', () => {
    const out = smartTruncate(FQCN, 'classname', 30);
    assert.equal(out, 'com.trinity.io…DataServiceImpl');
    assert.equal(out.length, 30);
  });

  it('start-anchors SQL, plain and unknown kinds', () => {
    const sql = `SELECT ${'c, '.repeat(30)} FROM t`;
    assert.equal(smartTruncate(sql, 'sql', 10), 'SELECT c,…');
    assert.equal(smartTruncate(sql, 'plain', 10), 'SELECT c,…');
    assert.equal(smartTruncate(sql, 'nonsense', 10), 'SELECT c,…');
  });

  it('defaults to a 60-character budget', () => {
    assert.equal(smartTruncate('y'.repeat(61), 'plain').length, 60);
  });
});
