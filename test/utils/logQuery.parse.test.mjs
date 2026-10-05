/**
 * logQuery turns the Query Editor's text into the only filters /api/logs and
 * /api/traces accept. What is guarded: every clause the backend can honour lands
 * on its parameter, everything it cannot is reported as a warning (a query must
 * never silently return rows it did not ask for), and the rewrite helpers the
 * dropdowns and drill-throughs use REPLACE their clause rather than layering a
 * contradictory one on top. Tested through the exports only, so the scanner
 * internals can change freely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLogQuery, parseTraceQuery, sqlTemplate, toSql, fromSql,
  withoutSeverityClauses, withSeverityClause, withServiceClauses, withTraceClause,
} from '../../src/utils/logQuery.js';

const TRACE = '0123456789abcdef0123456789abcdef';

describe('parseLogQuery — filter mode', () => {
  it('returns empty filters for blank input', () => {
    for (const text of ['', '   ', null, undefined]) {
      const r = parseLogQuery(text);
      assert.deepEqual(r, {
        serviceNames: [], severity: '', traceId: '', operationName: '', outcome: '', search: '',
        warnings: [], error: null,
      });
    }
  });

  it('maps service, severity and trace equality onto their parameters', () => {
    const r = parseLogQuery(`service_name='iot' AND severity_text="error" AND trace_id='${TRACE}'`);
    assert.deepEqual(r.serviceNames, ['iot']);
    assert.equal(r.severity, 'ERROR');
    assert.equal(r.traceId, TRACE);
    assert.deepEqual(r.warnings, []);
  });

  it('accepts the dotted and alias column spellings', () => {
    const r = parseLogQuery(`service.name='a' and ServiceName='b' AND level=warn AND trace.id=${TRACE.slice(0, 16)}`);
    assert.deepEqual(r.serviceNames, ['a', 'b']);
    assert.equal(r.severity, 'WARN');
    assert.equal(r.traceId, TRACE.slice(0, 16));
  });

  it('rejects unknown severities and malformed trace ids with a warning', () => {
    const r = parseLogQuery("severity='loud' AND traceid='xyz'");
    assert.equal(r.severity, '');
    assert.equal(r.traceId, '');
    assert.match(r.warnings[0], /"loud" is not a known severity \(TRACE, DEBUG/);
    assert.match(r.warnings[1], /"xyz" is not a valid trace id/);
  });

  it('warns about an empty value', () => {
    const r = parseLogQuery("service_name=''");
    assert.deepEqual(r.serviceNames, []);
    assert.match(r.warnings[0], /Empty value for "service_name"/);
  });

  it('turns an unknown column into a free-text search with a warning', () => {
    const r = parseLogQuery("host='web-1'");
    assert.equal(r.search, 'web-1');
    assert.match(r.warnings[0], /No dedicated filter for "host" — matching "web-1"/);
  });

  it('treats operation/status as unknown columns in the logs stream', () => {
    const r = parseLogQuery("operation_name='GET'");
    assert.equal(r.operationName, '');
    assert.equal(r.search, 'GET');
  });

  it('reads match_all and its variants as full-text search', () => {
    assert.equal(parseLogQuery("match_all('timeout')").search, 'timeout');
    assert.equal(parseLogQuery("MATCH_ALL_RAW ( 'x y' )").search, 'x y');
    assert.equal(parseLogQuery('match_all_indexed("q")').search, 'q');
    assert.equal(parseLogQuery("match_all('it\\'s')").search, "it's");
  });

  it('reads str_match as search and notes the column is advisory', () => {
    const r = parseLogQuery("str_match(body, 'Pending Notification')");
    assert.equal(r.search, 'Pending Notification');
    assert.match(r.warnings[0], /str_match on "body" is searched across all text columns/);
    const ic = parseLogQuery("str_match_ignore_case( attr.code , 'abc' )");
    assert.equal(ic.search, 'abc');
    assert.match(ic.warnings[0], /"attr\.code"/);
  });

  it('falls back to free text for malformed calls', () => {
    // No column, no comma, no closing paren: none are str_match / match_all.
    assert.equal(parseLogQuery("str_match('x')").search, "str_match('x')");
    assert.equal(parseLogQuery('str_match(body)').search, 'str_match(body)');
    assert.equal(parseLogQuery("match_all('x'").search, "match_all('x'");
    assert.equal(parseLogQuery('match_all x').search, 'match_all x');
  });

  it('reads an empty or whitespace-only match_all argument the way the old regex did', () => {
    // Nothing between the parens: not a call, so the whole clause is the term.
    assert.equal(parseLogQuery('match_all()').search, 'match_all()');
    // Only spaces: the call matches with a blank term.
    const blank = parseLogQuery('match_all(   )');
    assert.equal(blank.search, '');
    assert.deepEqual(blank.warnings, []);
    // Only a line break: not a call either.
    assert.equal(parseLogQuery('match_all(\n)').search, 'match_all(\n)');
  });

  it('names unsupported operators instead of guessing', () => {
    for (const [text, op] of [
      ["service_name != 'a'", '!='], ["a <> 'b'", '<>'], ['NOT x', 'NOT'], ["body LIKE '%a%'", 'LIKE'],
      ["svc IN ('a')", 'IN'], ['a OR b', 'OR'], ['n >= 3', '>='], ['n <= 3', '<='], ['n > 3', '>'], ['n < 3', '<'],
    ]) {
      const r = parseLogQuery(text);
      assert.match(r.warnings[0], new RegExp(`^"${op}" is not supported`), text);
      assert.equal(r.search, '', text);
    }
  });

  it('treats a bare term as search, unquoted', () => {
    assert.equal(parseLogQuery("'connection reset'").search, 'connection reset');
    assert.equal(parseLogQuery('timeout').search, 'timeout');
  });

  it('keeps only the first of several search terms and says so', () => {
    const r = parseLogQuery("match_all('a') AND b");
    assert.equal(r.search, 'a');
    assert.match(r.warnings.at(-1), /Only the first search term \("a"\) is applied/);
  });

  it('splits only on top-level AND, not inside quotes or parentheses', () => {
    assert.equal(parseLogQuery("match_all('salt and pepper')").search, 'salt and pepper');
    assert.equal(parseLogQuery('match_all("rock AND roll")').search, 'rock AND roll');
    const r = parseLogQuery("str_match(body, 'a AND b') AND service_name='s'");
    assert.equal(r.search, 'a AND b');
    assert.deepEqual(r.serviceNames, ['s']);
    // "band" is not the word AND.
    assert.equal(parseLogQuery('band').search, 'band');
    // An escaped quote does not close the string.
    assert.equal(parseLogQuery("match_all('it\\' and x')").search, "it' and x");
    // A stray close paren does not push depth negative.
    assert.deepEqual(parseLogQuery(") AND service_name='z'").serviceNames, ['z']);
  });
});

describe('parseLogQuery — SQL mode', () => {
  it('extracts the WHERE clause of a SELECT', () => {
    const r = parseLogQuery(`SELECT * FROM "default" WHERE service_name='iot' AND severity='INFO';`, true);
    assert.deepEqual(r.serviceNames, ['iot']);
    assert.equal(r.severity, 'INFO');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.error, null);
  });

  it('accepts an unquoted stream and no WHERE', () => {
    const r = parseLogQuery('select * from my-stream.v1', true);
    assert.equal(r.error, null);
    assert.equal(r.search, '');
  });

  it('reports a non-* projection and every ignored tail clause', () => {
    const r = parseLogQuery(
      'SELECT body, count(*) FROM "s" WHERE x GROUP BY body HAVING count(*) > 1 ORDER BY body LIMIT 10',
      true,
    );
    assert.equal(r.search, 'x');
    assert.deepEqual(r.warnings, [
      'Projection "body, count(*)" is ignored — /api/logs always returns whole records.',
      'GROUP BY is ignored — no aggregation endpoint exists.',
      'HAVING is ignored — no aggregation endpoint exists.',
      'ORDER BY is ignored — results are always newest first.',
      'LIMIT is ignored — use the rows-per-page control instead.',
    ]);
  });

  it('errors on text that is not a SELECT … FROM', () => {
    for (const text of ["service_name='a'", 'SELECT *', 'SELECT * FROM', 'SELECT * FROM ""', 'SELECT*FROM x']) {
      const r = parseLogQuery(text, true);
      assert.equal(r.error, 'Expected SELECT … FROM "stream" [WHERE …].', text);
      assert.deepEqual(r.serviceNames, []);
    }
  });

  it('keeps the regex-compatible reading of a projection-less SELECT', () => {
    // No projection before FROM: the grammar lends SELECT's whitespace to it.
    const r = parseLogQuery('SELECT   FROM "s" WHERE a', true);
    assert.equal(r.error, null);
    assert.equal(r.search, 'a');
  });
});

describe('parseTraceQuery', () => {
  it('maps operation and span status, and drops severity', () => {
    const r = parseTraceQuery("span_name='GET /x' AND span_status='error' AND service_name='svc'");
    assert.equal(r.operationName, 'GET /x');
    assert.equal(r.outcome, 'ERROR');
    assert.deepEqual(r.serviceNames, ['svc']);
    assert.equal(r.severity, '');
  });

  it('treats UNSET and OK as success', () => {
    assert.equal(parseTraceQuery('status=unset').outcome, 'SUCCESS');
    assert.equal(parseTraceQuery("status='OK'").outcome, 'SUCCESS');
  });

  it('warns about an unknown span status', () => {
    const r = parseTraceQuery("status='weird'");
    assert.equal(r.outcome, '');
    assert.match(r.warnings[0], /"weird" is not a known span status \(UNSET, OK, ERROR\)/);
  });

  it('treats severity_text as an unknown column for spans', () => {
    const r = parseTraceQuery("severity_text='ERROR'");
    assert.equal(r.search, 'ERROR');
    assert.match(r.warnings[0], /No dedicated filter/);
  });

  it('parses SQL mode the same way', () => {
    const r = parseTraceQuery(`SELECT * FROM "traces" WHERE operation_name='op' AND trace_id='${TRACE}'`, true);
    assert.equal(r.operationName, 'op');
    assert.equal(r.traceId, TRACE);
  });
});

describe('SQL toggle helpers', () => {
  it('builds the starter template', () => {
    assert.equal(sqlTemplate(), 'SELECT * FROM "default"');
    assert.equal(sqlTemplate('traces'), 'SELECT * FROM "traces"');
  });

  it('wraps a filter in a SELECT, or gives the template when empty', () => {
    assert.equal(toSql("a='b'", 's'), `SELECT * FROM "s" WHERE a='b'`);
    assert.equal(toSql('  ', 's'), 'SELECT * FROM "s"');
    assert.equal(toSql(null), 'SELECT * FROM "default"');
  });

  it('pulls the WHERE back out, or empty', () => {
    assert.equal(fromSql(`SELECT * FROM "s" WHERE a='b' LIMIT 5`), "a='b'");
    assert.equal(fromSql('SELECT * FROM "s"'), '');
    assert.equal(fromSql('garbage'), '');
    assert.equal(fromSql(null), '');
  });

  it('round-trips a filter through toSql/fromSql', () => {
    const f = "service_name='a' AND match_all('b')";
    assert.equal(fromSql(toSql(f, 'x')), f);
  });
});

describe('clause rewriters', () => {
  it('withoutSeverityClauses strips every severity spelling and keeps the rest', () => {
    assert.equal(
      withoutSeverityClauses("severity_text='ERROR' AND service_name='a' AND level=warn AND x", false),
      "service_name='a' AND x",
    );
    assert.equal(withoutSeverityClauses("status='ERROR'", false), '');
    assert.equal(withoutSeverityClauses('', false), '');
  });

  it('withoutSeverityClauses rebuilds the SELECT in SQL mode', () => {
    assert.equal(
      withoutSeverityClauses(`SELECT * FROM "s" WHERE severity='INFO' AND a='b'`, true, 's'),
      `SELECT * FROM "s" WHERE a='b'`,
    );
    assert.equal(withoutSeverityClauses(`SELECT * FROM "s" WHERE severity='INFO'`, true, 's'), 'SELECT * FROM "s"');
  });

  it('withSeverityClause replaces rather than layers', () => {
    assert.equal(withSeverityClause("severity='INFO' AND a='b'", false, 'error'), "a='b' AND severity='ERROR'");
    assert.equal(withSeverityClause('', false, 'WARN'), "severity='WARN'");
    assert.equal(withSeverityClause("severity='INFO'", false, '  '), '');
    assert.equal(withSeverityClause("x AND severity='INFO'", false, null), 'x');
    assert.equal(withSeverityClause('', false, "o'k"), "severity='O\\'K'");
  });

  it('withSeverityClause works in SQL mode', () => {
    assert.equal(
      withSeverityClause(`SELECT * FROM "s" WHERE a='b'`, true, 'fatal', 's'),
      `SELECT * FROM "s" WHERE a='b' AND severity='FATAL'`,
    );
    assert.equal(withSeverityClause('SELECT * FROM "s"', true, 'debug', 's'), `SELECT * FROM "s" WHERE severity='DEBUG'`);
    assert.equal(withSeverityClause(`SELECT * FROM "s" WHERE level=INFO`, true, '', 's'), 'SELECT * FROM "s"');
  });

  it('withServiceClauses replaces every service clause with the given set', () => {
    assert.equal(
      withServiceClauses("service_name='old' AND service.name='o2' AND x", false, ['a', "b'c"]),
      "x AND service_name='a' AND service_name='b\\'c'",
    );
    assert.equal(withServiceClauses("servicename='old'", false, []), '');
    assert.equal(withServiceClauses(null, false, null), '');
  });

  it('withServiceClauses works in SQL mode', () => {
    assert.equal(
      withServiceClauses(`SELECT * FROM "s" WHERE service_name='old'`, true, ['n'], 's'),
      `SELECT * FROM "s" WHERE service_name='n'`,
    );
    assert.equal(withServiceClauses(`SELECT * FROM "s" WHERE service_name='old'`, true, [], 's'), 'SELECT * FROM "s"');
  });

  it('withTraceClause pins exactly one trace', () => {
    assert.equal(withTraceClause(`trace_id='aaa' AND traceid='bbb' AND x`, false, ` ${TRACE} `), `x AND trace_id='${TRACE}'`);
    assert.equal(withTraceClause(`trace.id='aaa'`, false, ''), '');
    assert.equal(withTraceClause(undefined, false, "a'b"), "trace_id='a\\'b'");
  });

  it('withTraceClause works in SQL mode', () => {
    assert.equal(
      withTraceClause('SELECT * FROM "t"', true, TRACE, 't'),
      `SELECT * FROM "t" WHERE trace_id='${TRACE}'`,
    );
    assert.equal(withTraceClause(`SELECT * FROM "t" WHERE trace_id='x'`, true, null, 't'), 'SELECT * FROM "t"');
  });

  it('rewriters leave multi-line and non-equality clauses alone', () => {
    // An equality whose value spans a line break is not an equality clause.
    assert.equal(withServiceClauses("service_name='a\nb'", false, []), "service_name='a\nb'");
    assert.equal(withServiceClauses("service_name != 'a'", false, []), "service_name != 'a'");
  });
});
