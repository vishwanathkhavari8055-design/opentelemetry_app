/**
 * Guards the proxy datasource every dashboard panel and template variable queries
 * through (src/grafana/ProxyDataSource.js): panel -> this -> /api/dashboards/query
 * -> Grafana. No Grafana credential is in the browser, so this is the only road.
 *
 * Pinned, against a stubbed fetch:
 *  - the /api/ds/query payload: stringified range, refIds defaulted A, B, …, the
 *    proxy's own datasource filled in when a target has none, and an Infinity
 *    query rewritten to the backend parser (else the panel says "No data" over a
 *    perfectly good response);
 *  - the Observable contract Scenes relies on: Loading, then Done with DataFrames
 *    carrying their refId; a per-query or HTTP error reported as panel ERROR
 *    state, never thrown; a frame with rows nothing parsed reported on the panel
 *    while the frames that did parse are kept; and unsubscribing ABORTS the HTTP
 *    request and suppresses the late answer;
 *  - metricFindQuery for each Prometheus variable function, Infinity's legacy
 *    helpers, and the generic "run it as a query" path — all of which resolve to
 *    [] rather than throwing, because one broken dropdown must not blank a
 *    dashboard.
 *
 * `.css` is stubbed for require() because @grafana/ui loads a stylesheet from CJS,
 * which the ESM hooks in test/support cannot intercept.
 */

import Module from 'node:module';

import '../support/dom.mjs';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { abortError, json, stubFetch } from '../services/fetchStub.mjs';

Module._extensions['.css'] = (module) => { module.exports = {}; };

const { LoadingState } = await import('@grafana/data');
const S = await import('@grafana/scenes');
const { setApiBase, setOrg } = await import('../../src/services/api.js');
const { ProxyDataSource } = await import('../../src/grafana/ProxyDataSource.js');

const INFINITY = 'yesoreyeram-infinity-datasource';
const RANGE = { from: new Date(1000), to: new Date(5000) };
let fx;

beforeEach(() => {
  setApiBase('http://api.test/api');
  setOrg('');
  mock.method(console, 'warn', () => {});
});

afterEach(() => {
  fx?.restore();
  fx = undefined;
  mock.restoreAll();
});

const timeFrame = (values = [[1000, 2000], [1, 2]]) => ({
  schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number' }] },
  data: { values },
});

/** Subscribe and collect every emission until completion. */
const collect = (observable) => new Promise((resolve, reject) => {
  const seen = [];
  observable.subscribe({ next: (v) => seen.push(v), complete: () => resolve(seen), error: reject });
});

const request = (targets, extra = {}) => ({
  range: RANGE, targets, intervalMs: 15000, maxDataPoints: 500, requestId: 'r1', ...extra,
});

describe('construction', () => {
  it('records uid and plugin type, and flags mixed only when asked', () => {
    const plain = new ProxyDataSource('prometheus', 'p1');
    assert.equal(plain.uid, 'p1');
    assert.equal(plain.pluginType, 'prometheus');
    assert.notEqual(plain.meta?.mixed, true);
    const mixed = new ProxyDataSource('mixed', 'm1', { mixed: true });
    assert.equal(mixed.meta.mixed, true);
  });

  it('testDatasource always reports success', async () => {
    assert.deepEqual(await new ProxyDataSource('prometheus', 'p').testDatasource(),
      { status: 'success', message: 'Proxy datasource ready' });
  });
});

describe('query', () => {
  it('builds the ds/query payload and emits Loading then Done with frames', async () => {
    fx = stubFetch(() => json({ results: { A: { frames: [timeFrame()] }, B: {} } }));
    const ds = new ProxyDataSource('prometheus', 'p1');
    const emitted = await collect(ds.query(request([
      { expr: 'up' },
      { refId: 'Q', expr: 'down', datasource: { type: 'prometheus', uid: 'other' } },
    ])));

    assert.equal(fx.last.url.pathname, '/api/dashboards/query');
    assert.equal(fx.last.method, 'POST');
    assert.deepEqual(fx.last.body, {
      from: '1000', to: '5000',
      queries: [
        { refId: 'A', expr: 'up', datasource: { type: 'prometheus', uid: 'p1' }, intervalMs: 15000, maxDataPoints: 500 },
        { refId: 'Q', expr: 'down', datasource: { type: 'prometheus', uid: 'other' }, intervalMs: 15000, maxDataPoints: 500 },
      ],
    });
    assert.ok(fx.last.options.signal instanceof AbortSignal);

    assert.equal(emitted.length, 2);
    assert.deepEqual(emitted[0], { data: [], state: LoadingState.Loading, key: 'r1' });
    assert.equal(emitted[1].state, LoadingState.Done);
    assert.equal(emitted[1].key, 'r1');
    assert.equal(emitted[1].data.length, 1);
    const [frame] = emitted[1].data;
    assert.equal(frame.refId, 'A');
    assert.deepEqual(frame.fields.map((f) => f.name), ['Time', 'Value']);
    assert.deepEqual(frame.fields[1].values, [1, 2]);
  });

  it('keeps a frame\'s own refId and defaults later refIds by position', async () => {
    fx = stubFetch(() => json({ results: { A: { frames: [{ ...timeFrame(), schema: { ...timeFrame().schema, refId: 'Z' } }] } } }));
    const ds = new ProxyDataSource('prometheus', 'p1');
    const emitted = await collect(ds.query(request([{ refId: 'A' }, {}])));
    assert.deepEqual(fx.last.body.queries.map((q) => q.refId), ['A', 'B']);
    assert.equal(emitted[1].data[0].refId, 'Z');
  });

  it('asks Grafana to parse an Infinity query on the backend', async () => {
    fx = stubFetch(() => json({ results: {} }));
    const ds = new ProxyDataSource(INFINITY, 'inf');
    const emitted = await collect(ds.query(request([{ refId: 'A', parser: 'simple', url: 'x' }])));
    assert.equal(fx.last.body.queries[0].parser, 'backend');
    assert.deepEqual(emitted[1], { data: [], state: LoadingState.Done, key: 'r1' });
  });

  it('reports a per-query error as panel error state', async () => {
    fx = stubFetch(() => json({ results: { A: { error: 'parse error at 3' } } }));
    const emitted = await collect(new ProxyDataSource('prometheus', 'p').query(request([{ expr: 'up(' }])));
    assert.equal(emitted[1].state, LoadingState.Error);
    assert.deepEqual(emitted[1].errors, [{ message: 'A: parse error at 3' }]);
    assert.deepEqual(emitted[1].error, { message: 'A: parse error at 3' });
    assert.deepEqual(emitted[1].data, []);
  });

  it('reports an HTTP failure with the backend\'s message, or a generic one', async () => {
    fx = stubFetch(() => json({ error: 'Grafana unreachable' }, 502));
    let emitted = await collect(new ProxyDataSource('prometheus', 'p').query(request([{}])));
    assert.equal(emitted[1].state, LoadingState.Error);
    assert.equal(emitted[1].error.message, 'Grafana unreachable');
    fx.restore();
    fx = stubFetch(() => { throw new Error(''); });
    emitted = await collect(new ProxyDataSource('prometheus', 'p').query(request([{}])));
    assert.equal(emitted[1].error.message, 'Query failed');
  });

  it('flags rows nothing parsed, once, while keeping the frames that did parse', async () => {
    const unparsed = { schema: { fields: [], meta: { custom: { data: [{ a: 1 }, { a: 2 }] } } }, data: { values: [] } };
    fx = stubFetch(() => json({ results: { A: { frames: [unparsed, unparsed] }, B: { frames: [timeFrame()] } } }));
    const ds = new ProxyDataSource(INFINITY, 'inf');
    const emitted = await collect(ds.query(request([{ refId: 'A', parser: 'backend' }, { refId: 'B', parser: 'backend' }])));
    const last = emitted[1];
    assert.equal(last.state, LoadingState.Error);
    assert.equal(last.errors.length, 1);
    assert.match(last.errors[0].message, /returned 2 row\(s\) that nothing parsed into fields/);
    assert.equal(last.data.length, 3, 'every frame is still handed to the panel');
    assert.ok(last.data.some((f) => f.refId === 'B' && f.fields.length === 2));
    assert.equal(console.warn.mock.callCount(), 1);
  });

  it('stays silent about an empty frame that genuinely matched nothing', async () => {
    const empty = { schema: { fields: [], meta: { custom: { data: { hits: [] } } } }, data: { values: [] } };
    fx = stubFetch(() => json({ results: { A: { frames: [empty] } } }));
    const emitted = await collect(new ProxyDataSource(INFINITY, 'inf').query(request([{ refId: 'A', root_selector: 'hits' }])));
    assert.equal(emitted[1].state, LoadingState.Done);
  });

  it('aborts the HTTP request on unsubscribe and drops the late answer', async () => {
    let seenSignal;
    let answer;
    fx = stubFetch((url, options) => {
      seenSignal = options.signal;
      return new Promise((resolve) => { answer = resolve; });
    });
    const emitted = [];
    const sub = new ProxyDataSource('prometheus', 'p').query(request([{}]))
      .subscribe({ next: (v) => emitted.push(v) });
    await new Promise((r) => setImmediate(r));
    sub.unsubscribe();
    assert.equal(seenSignal.aborted, true);
    answer(json({ results: { A: { frames: [timeFrame()] } } }));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(emitted.map((e) => e.state), [LoadingState.Loading]);
  });

  it('does not report an abort as a panel error', async () => {
    fx = stubFetch(() => { throw abortError(); });
    const emitted = [];
    new ProxyDataSource('prometheus', 'p').query(request([{}])).subscribe({ next: (v) => emitted.push(v) });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(emitted.map((e) => e.state), [LoadingState.Loading]);
  });
});

describe('metricFindQuery — Prometheus', () => {
  const ds = () => new ProxyDataSource('prometheus', 'prom 1');

  it('label_values reads the label values endpoint over the range', async () => {
    fx = stubFetch(() => json({ values: ['api', 'db'] }));
    const out = await ds().metricFindQuery('label_values(up, job)', { range: RANGE });
    assert.equal(fx.last.url.pathname, '/api/dashboards/datasources/prom%201/label-values');
    assert.deepEqual(Object.fromEntries(fx.last.url.searchParams), { label: 'job', metric: 'up', from: '1000', to: '5000' });
    assert.deepEqual(out, [{ text: 'api', value: 'api' }, { text: 'db', value: 'db' }]);
  });

  it('metrics() lists __name__ values filtered by the regex, with no range', async () => {
    fx = stubFetch(() => json({ values: ['node_cpu', 'node_mem', 'up'] }));
    const out = await ds().metricFindQuery({ query: 'metrics(node_.*)' });
    assert.deepEqual(Object.fromEntries(fx.last.url.searchParams), { label: '__name__' });
    assert.deepEqual(out.map((o) => o.value), ['node_cpu', 'node_mem']);
  });

  it('query_result() runs an instant query and renders Grafana\'s row text', async () => {
    const frame = {
      schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels: { __name__: 'up', job: 'a' } }] },
      data: { values: [[3000], [1]] },
    };
    fx = stubFetch(() => json({ results: { A: { frames: [frame] } } }));
    const out = await ds().metricFindQuery({ expr: 'query_result(up)' }, { range: RANGE });
    assert.deepEqual(fx.last.body, {
      from: '1000', to: '5000',
      queries: [{ refId: 'A', datasource: { type: 'prometheus', uid: 'prom 1' }, expr: 'up', instant: true, range: false }],
    });
    assert.deepEqual(out, [{ text: 'up{job="a"} 1 3000', value: 'up{job="a"} 1 3000' }]);
  });

  it('a bare selector returns series names, defaulting to the last hour', async () => {
    const frame = {
      schema: { fields: [{ name: 'Value', type: 'number', labels: { __name__: 'up', job: 'a' } }] },
      data: { values: [[1]] },
    };
    fx = stubFetch(() => json({ results: { A: { frames: [frame] } } }));
    const before = Date.now();
    const out = await ds().metricFindQuery('up{job="a"}');
    const { from, to } = fx.last.body;
    assert.equal(Number(to) - Number(from), 3600000);
    assert.ok(Number(to) >= before);
    assert.deepEqual(out, [{ text: 'up{job="a"}', value: 'up{job="a"}' }]);
  });

  it('answers [] for an empty query and for an unsupported function', async () => {
    fx = stubFetch(() => json({}));
    assert.deepEqual(await ds().metricFindQuery(''), []);
    assert.deepEqual(await ds().metricFindQuery('label_names()'), []);
    assert.equal(fx.calls.length, 0);
    assert.match(console.warn.mock.calls[0].arguments[0], /"label_names" is not supported/);
  });

  it('answers [] with a warning when the lookup fails, silently on abort', async () => {
    fx = stubFetch(() => json({ error: 'boom' }, 500));
    assert.deepEqual(await ds().metricFindQuery('label_values(job)'), []);
    assert.equal(console.warn.mock.callCount(), 1);
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    assert.deepEqual(await ds().metricFindQuery('label_values(job)'), []);
    assert.equal(console.warn.mock.callCount(), 1);
  });

  it('interpolates chained variables against the live scene first', async () => {
    const constant = new S.ConstantVariable({ name: 'ns', value: 'prod' });
    const scene = new S.EmbeddedScene({
      $variables: new S.SceneVariableSet({ variables: [constant] }),
      body: new S.SceneFlexLayout({ children: [] }),
    });
    fx = stubFetch(() => json({ values: ['pod-1'] }));
    await ds().metricFindQuery('label_values(kube_pod_info{namespace="$ns"}, pod)', {
      scopedVars: { __sceneObject: { value: scene, valueOf: () => scene } },
    });
    assert.equal(fx.last.url.searchParams.get('metric'), 'kube_pod_info{namespace="prod"}');
  });

  it('falls back to the raw query when interpolation throws', async () => {
    // Not a scene object: resolving $job against it throws inside Scenes.
    const notAScene = { valueOf: () => ({}) };
    fx = stubFetch(() => json({ values: ['v'] }));
    const out = await ds().metricFindQuery('label_values(up{job="$job"}, instance)', {
      scopedVars: { __sceneObject: notAScene },
    });
    assert.match(console.warn.mock.calls[0].arguments[0], /variable interpolation failed/);
    assert.equal(fx.last.url.searchParams.get('metric'), 'up{job="$job"}', 'raw query sent');
    assert.deepEqual(out, [{ text: 'v', value: 'v' }]);
  });
});

describe('metricFindQuery — other datasources', () => {
  it('answers Infinity\'s legacy Collection() helper locally', async () => {
    fx = stubFetch();
    const out = await new ProxyDataSource(INFINITY, 'inf').metricFindQuery('Collection(A,a,B,b)');
    assert.deepEqual(out, [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }]);
    assert.equal(fx.calls.length, 0);
  });

  it('runs any other variable query as a panel query and reads options from frames', async () => {
    const frame = { schema: { fields: [{ name: 'name', type: 'string' }] }, data: { values: [['x', 'y']] } };
    fx = stubFetch(() => json({ results: { 'variable-site': { frames: [frame] } } }));
    const out = await new ProxyDataSource('mssql', 'sql').metricFindQuery('SELECT name FROM sites', {
      range: RANGE, variable: { name: 'site' },
    });
    assert.deepEqual(fx.last.body, {
      from: '1000', to: '5000',
      queries: [{
        refId: 'variable-site', datasource: { type: 'mssql', uid: 'sql' },
        query: 'SELECT name FROM sites', rawSql: 'SELECT name FROM sites', format: 'table',
      }],
    });
    assert.deepEqual(out, [{ text: 'x', value: 'x' }, { text: 'y', value: 'y' }]);
  });

  it('sends a non-legacy Infinity query with the backend parser over the last six hours', async () => {
    fx = stubFetch(() => json({ results: {} }));
    const out = await new ProxyDataSource(INFINITY, 'inf').metricFindQuery({ queryType: 'json', parser: 'simple', url: 'u' });
    const sent = fx.last.body;
    assert.equal(Number(sent.to) - Number(sent.from), 6 * 3600000);
    assert.equal(sent.queries[0].parser, 'backend');
    assert.equal(sent.queries[0].refId, 'variable-query');
    assert.deepEqual(out, []);
  });

  it('falls through when Infinity legacy text is not a helper', async () => {
    fx = stubFetch(() => json({ results: {} }));
    await new ProxyDataSource(INFINITY, 'inf').metricFindQuery({ queryType: 'legacy', query: 'something else' });
    assert.equal(fx.calls.length, 1);
  });

  it('answers [] without a request for a blank query', async () => {
    fx = stubFetch();
    assert.deepEqual(await new ProxyDataSource('mssql', 'sql').metricFindQuery('   '), []);
    assert.equal(fx.calls.length, 0);
  });

  it('answers [] with a warning when the query reports an error', async () => {
    fx = stubFetch(() => json({ results: { 'variable-query': { error: 'syntax error' } } }));
    assert.deepEqual(await new ProxyDataSource('mssql', 'sql').metricFindQuery('SELEC'), []);
    assert.equal(console.warn.mock.callCount(), 1);
    assert.match(String(console.warn.mock.calls[0].arguments[1]?.message), /variable-query: syntax error/);
  });
});
