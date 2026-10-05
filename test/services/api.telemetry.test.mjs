/**
 * Guards the read side of the telemetry client (src/services/api.js): logs,
 * traces, metrics, summaries, IAM and infrastructure.
 *
 * What is pinned here is the wire contract — the exact URL, query params and org
 * scoping each reader sends, and the normalisation it applies to what comes back.
 * Both matter more than they look: a forgotten `?org=` silently answers about the
 * wrong tenant, an `ALL` sent as a literal filter matches nothing, and a reader
 * that throws on an older backend's bare-array shape blanks a whole screen. The
 * error paths are pinned too, because several readers deliberately resolve to an
 * empty or `supported:false` envelope instead of throwing, and an abort must never
 * be logged as a failure.
 *
 * fetch is stubbed per test (./fetchStub.mjs) and restored afterwards.
 */

import '../support/dom.mjs';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { abortError, json, paramsOf, stubFetch, text } from './fetchStub.mjs';

const api = await import('../../src/services/api.js');

const BASE = 'http://api.test/api';
let fx;

beforeEach(() => {
  api.setApiBase(`${BASE}/`);
  api.setOrg('');
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
});

afterEach(() => {
  fx?.restore();
  fx = undefined;
  mock.restoreAll();
  api.setOrg('');
});

const errorLogged = () => console.error.mock.callCount() > 0;

describe('trace-id sentinel', () => {
  it('hasTraceId accepts a real id and rejects blanks and the NO_TRACE placeholder', () => {
    assert.equal(api.hasTraceId({ traceId: 'abc123' }), true);
    assert.equal(api.hasTraceId({ traceId: api.NO_TRACE }), false);
    assert.equal(api.hasTraceId({ traceId: '   ' }), false);
    assert.equal(api.hasTraceId({ traceId: 42 }), false);
    assert.equal(api.hasTraceId(null), false);
    assert.equal(api.hasTraceId({}), false);
  });
});

describe('API base', () => {
  it('strips one trailing slash and falls back to the default when cleared', () => {
    api.setApiBase('http://elsewhere/x/');
    assert.equal(api.getApiBase(), 'http://elsewhere/x');
    api.setApiBase('');
    assert.equal(api.getApiBase(), '/OpentelemetryService/api');
  });
});

describe('organization scoping', () => {
  it('persists the selected org and removes it when cleared', () => {
    api.setOrg('DLH');
    assert.equal(api.getOrg(), 'DLH');
    assert.equal(localStorage.getItem('observability-ui:org:v1'), 'DLH');
    api.setOrg(null);
    assert.equal(api.getOrg(), '');
    assert.equal(localStorage.getItem('observability-ui:org:v1'), null);
  });

  it('sends no org param when none is selected', async () => {
    fx = stubFetch(() => json({ items: [] }));
    await api.fetchStreams();
    assert.equal(fx.last.url.searchParams.has('org'), false);
  });

  it('appends the org with & when the URL already has a query, ? when it does not', async () => {
    api.setOrg('A B');
    fx = stubFetch(() => json({ items: [] }));
    await api.fetchStreams({ type: 'traces' });
    assert.equal(fx.last.raw, `${BASE}/streams?type=traces&org=A%20B`);
    await api.fetchMetricStreams();
    assert.equal(fx.last.raw, `${BASE}/metrics/streams?org=A%20B`);
  });

  it('lets an explicit org in the URL win over the selected one', async () => {
    api.setOrg('default');
    fx = stubFetch(() => json({ items: [] }));
    await api.fetchIamUsers({ org: 'DLH' });
    assert.deepEqual(fx.last.url.searchParams.getAll('org'), ['DLH']);
  });
});

describe('fetchStreams', () => {
  it('reads /streams for the given type and returns items', async () => {
    fx = stubFetch(() => json({ items: ['a', 'b'] }));
    const out = await api.fetchStreams({ type: 'metrics' });
    assert.equal(fx.last.url.pathname, '/api/streams');
    assert.equal(fx.last.url.searchParams.get('type'), 'metrics');
    assert.deepEqual(out, ['a', 'b']);
  });

  it('defaults to logs and tolerates a missing items array', async () => {
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchStreams(), []);
    assert.equal(fx.last.url.searchParams.get('type'), 'logs');
  });

  it('rejects with the backend message on a non-2xx answer', async () => {
    fx = stubFetch(() => json({ error: 'OpenObserve unreachable' }, 502));
    await assert.rejects(api.fetchStreams(), { message: 'OpenObserve unreachable' });
  });
});

describe('fetchLogs', () => {
  it('sends paging and sort defaults and nothing else when called bare', async () => {
    fx = stubFetch(() => json({ items: [], hasMore: false, total: 0 }));
    await api.fetchLogs();
    assert.equal(fx.last.url.pathname, '/api/logs');
    assert.deepEqual(paramsOf(fx.last), { page: '0', size: '50', sort: 'timestamp,desc' });
  });

  it('sends stream, traceId, filters and window in the documented order', async () => {
    fx = stubFetch(() => json({ items: [] }));
    await api.fetchLogs({
      stream: 'app_logs', traceId: 'T1', serviceName: 'Orders', severity: ' warn ',
      severityMode: 'at_least', startDate: 's', endDate: 'e', page: 2, size: 10, sort: 'x,asc',
    });
    assert.deepEqual([...fx.last.url.searchParams.keys()], [
      'page', 'size', 'sort', 'stream', 'traceId', 'serviceName', 'severity', 'severityMode',
      'startTime', 'endTime',
    ]);
    assert.deepEqual(paramsOf(fx.last), {
      page: '2', size: '10', sort: 'x,asc', stream: 'app_logs', traceId: 'T1',
      serviceName: 'Orders', severity: 'WARN', severityMode: 'AT_LEAST', startTime: 's', endTime: 'e',
    });
  });

  it('repeats serviceNames for an array, dropping blanks and ALL', async () => {
    fx = stubFetch(() => json({ items: [] }));
    await api.fetchLogs({ serviceName: [' A ', '', null, 'all', 'B'] });
    assert.deepEqual(fx.last.url.searchParams.getAll('serviceNames'), ['A', 'B']);
    assert.equal(fx.last.url.searchParams.has('serviceName'), false);
  });

  it('omits ALL service and severity filters and a non-AT_LEAST mode', async () => {
    fx = stubFetch(() => json({ items: [] }));
    await api.fetchLogs({ serviceName: 'All', severity: 'all', severityMode: 'EXACT' });
    const p = paramsOf(fx.last);
    assert.equal('serviceName' in p, false);
    assert.equal('severity' in p, false);
    assert.equal('severityMode' in p, false);
  });

  it('routes a trace: prefix and a bare hex id to traceId, anything else to search', async () => {
    fx = stubFetch(() => json({ items: [] }));
    const hex = '0123456789abcdef0123456789ABCDEF';
    await api.fetchLogs({ search: ` trace:${hex} ` });
    assert.equal(fx.last.url.searchParams.get('traceId'), hex);
    assert.equal(fx.last.url.searchParams.has('search'), false);

    await api.fetchLogs({ search: 'abcdef0123456789' });
    assert.equal(fx.last.url.searchParams.get('traceId'), 'abcdef0123456789');

    await api.fetchLogs({ search: 'Class:  OrderController' });
    assert.equal(fx.last.url.searchParams.get('search'), 'OrderController');
    assert.equal(fx.last.url.searchParams.has('traceId'), false);

    await api.fetchLogs({ search: 'timeout' });
    assert.equal(fx.last.url.searchParams.get('search'), 'timeout');
  });

  it('normalises the lib wire shape and keeps the untouched record as _raw', async () => {
    const dotted = {
      id: 1, '@timestamp': 't1', 'service.name': 'svc', severity_text: ' error ',
      'trace.id': 'tr', message: 'boom',
    };
    const camel = { id: 2, timestamp: 't2', serviceName: 'c', severity: 'debug', traceId: 'x' };
    const snake = { id: 3, service_name: 'snake' };
    const empty = { id: 4 };
    fx = stubFetch(() => json({ items: [dotted, camel, snake, empty], hasMore: 1, total: 99 }));
    const out = await api.fetchLogs();
    assert.equal(out.hasMore, true);
    assert.equal(out.total, 99);
    const [a, b, c, d] = out.items;
    assert.deepEqual(
      { ts: a.timestamp, s: a.serviceName, sev: a.severity, t: a.traceId, m: a.message },
      { ts: 't1', s: 'svc', sev: 'ERROR', t: 'tr', m: 'boom' },
    );
    assert.deepEqual(a._raw, dotted);
    assert.equal(b.timestamp, 't2');
    assert.equal(b.serviceName, 'c');
    assert.equal(b.severity, 'DEBUG');
    assert.equal(b.traceId, 'x');
    assert.equal(c.serviceName, 'snake');
    assert.equal(d.serviceName, 'unknown-service');
    assert.equal(d.severity, 'INFO');
    assert.equal(d.traceId, api.NO_TRACE);
    assert.equal(d.message, 'No message provided');
  });

  it('accepts an older backend\'s bare array, and anything else as empty', async () => {
    fx = stubFetch(() => json([{ id: 1, message: 'm' }]));
    const bare = await api.fetchLogs();
    assert.equal(bare.items.length, 1);
    assert.equal(bare.hasMore, false);
    assert.equal(bare.total, null);

    fx.restore();
    fx = stubFetch(() => json({ nope: true }));
    assert.deepEqual(await api.fetchLogs(), { items: [], hasMore: false, total: null });
  });

  it('rejects with the status on a non-2xx answer and logs it', async () => {
    fx = stubFetch(() => text('bad', 500));
    await assert.rejects(api.fetchLogs(), { message: 'HTTP error! status: 500' });
    assert.ok(errorLogged());
  });

  it('passes the signal through and does not log an abort', async () => {
    const controller = new AbortController();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchLogs({ signal: controller.signal }), { name: 'AbortError' });
    assert.equal(fx.last.options.signal, controller.signal);
    assert.equal(errorLogged(), false);
  });
});

describe('fetchLogGroups', () => {
  it('reads /logs/groups with filters and a prefix-stripped search', async () => {
    fx = stubFetch(() => json({ items: [{ traceId: 't' }], hasMore: true, total: 3 }));
    const out = await api.fetchLogGroups({
      serviceName: 'S', severity: 'error', search: ' msg: failed ', page: 1, size: 5,
    });
    assert.equal(fx.last.url.pathname, '/api/logs/groups');
    assert.deepEqual(paramsOf(fx.last), {
      page: '1', size: '5', serviceName: 'S', severity: 'ERROR', search: 'failed',
    });
    assert.deepEqual(out, { items: [{ traceId: 't' }], hasMore: true, total: 3 });
  });

  it('defaults a shapeless answer to an empty page with an unknown total', async () => {
    fx = stubFetch(() => json(null));
    assert.deepEqual(await api.fetchLogGroups(), { items: [], hasMore: false, total: null });
  });

  it('rejects and logs a failure, but not an abort', async () => {
    fx = stubFetch(() => text('', 503));
    await assert.rejects(api.fetchLogGroups(), /status: 503/);
    assert.ok(errorLogged());
    fx.restore();
    console.error.mock.resetCalls();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchLogGroups(), { name: 'AbortError' });
    assert.equal(errorLogged(), false);
  });
});

describe('fetchLogServices / fetchLogServiceCounts', () => {
  it('sends the relative window when no explicit range is given', async () => {
    fx = stubFetch(() => json({ services: [{ name: 'a', count: 1 }], items: ['a'], supported: true, backend: 'openobserve' }));
    const out = await api.fetchLogServices();
    assert.equal(fx.last.url.pathname, '/api/logs/services');
    assert.deepEqual(paramsOf(fx.last), { window: 'now-24h' });
    assert.deepEqual(out, {
      services: [{ name: 'a', count: 1 }], items: ['a'], supported: true, backend: 'openobserve',
    });
  });

  it('lets an explicit range replace the window', async () => {
    fx = stubFetch(() => json({}));
    const out = await api.fetchLogServices({ startTime: 's', endTime: 'e', window: 'now-1h' });
    assert.deepEqual(paramsOf(fx.last), { startTime: 's', endTime: 'e' });
    assert.deepEqual(out, { services: [], items: [], supported: false, backend: null });
  });

  it('rejects on failure', async () => {
    fx = stubFetch(() => text('', 500));
    await assert.rejects(api.fetchLogServices(), /status: 500/);
    assert.ok(errorLogged());
  });

  it('de-dupes exactly (case preserved), drops placeholders and sorts A-Z', async () => {
    fx = stubFetch(() => json({
      services: [
        { name: 'zeta', count: '4' }, { name: ' IoTOpsApiSvc ', count: 2 },
        { name: 'iotopsapisvc', count: null }, { name: 'zeta', count: 9 },
        { name: 'unknown-service', count: 1 }, { name: '-' }, { name: '' }, null,
      ],
    }));
    const out = await api.fetchLogServiceCounts({ window: 'now-15m' });
    assert.equal(fx.last.url.searchParams.get('window'), 'now-15m');
    assert.deepEqual(out.map((r) => r.name).sort(), ['IoTOpsApiSvc', 'iotopsapisvc', 'zeta'].sort());
    assert.equal(out[out.length - 1].name, 'zeta');
    assert.deepEqual(out.find((r) => r.name === 'zeta'), { name: 'zeta', count: 4 });
    assert.equal(out.find((r) => r.name === 'iotopsapisvc').count, null);
  });

  it('falls back to bare names without counts from an older backend', async () => {
    fx = stubFetch(() => json({ services: [], items: ['b', 'a'] }));
    assert.deepEqual(await api.fetchLogServiceCounts(), [
      { name: 'a', count: null }, { name: 'b', count: null },
    ]);
  });
});

describe('fetchTrace', () => {
  it('reads one trace and normalises both the tree and the flat span shape', async () => {
    fx = stubFetch(() => json([
      {
        rootOperation: 'GET /x',
        spans: [
          { '@timestamp': 1, 'service.name': 's', 'span.name': 'n', 'trace.id': 't', 'span.id': 'p', duration: 5 },
          { timestamp: 2, service_name: 'snake', traceId: 't2', spanId: 'p2' },
          {},
        ],
      },
      { timestamp: 3, serviceName: 'flat', spanName: 'op', actualOperation: 'a', duration: 7 },
      {},
    ]));
    const out = await api.fetchTrace('abc', 1, 10);
    assert.equal(fx.last.url.pathname, '/api/traces');
    assert.deepEqual(paramsOf(fx.last), { traceId: 'abc', page: '1', size: '10' });
    const [tree, flat, blank] = out;
    assert.deepEqual(
      tree.spans.map((s) => [s.timestamp, s.serviceName, s.spanName, s.traceId, s.spanId]),
      [[1, 's', 'n', 't', 'p'], [2, 'snake', 'unnamed-span', 't2', 'p2'],
        [undefined, 'unknown-service', 'unnamed-span', undefined, undefined]],
    );
    assert.equal(tree.rootOperation, 'GET /x');
    assert.equal(flat.serviceName, 'flat');
    assert.equal(flat.spanName, 'op');
    assert.equal(flat.actualOperation, 'a');
    assert.equal(blank.serviceName, 'unknown-service');
    assert.equal(blank.spanName, 'unnamed-span');
  });

  it('uses default paging and returns [] (with a warning) for a non-array', async () => {
    fx = stubFetch(() => json({ items: [] }));
    assert.deepEqual(await api.fetchTrace('t'), []);
    assert.deepEqual(paramsOf(fx.last), { traceId: 't', page: '0', size: '100' });
    assert.equal(console.warn.mock.callCount(), 1);
  });

  it('rejects on failure', async () => {
    fx = stubFetch(() => text('', 404));
    await assert.rejects(api.fetchTrace('t'), /status: 404/);
    assert.ok(errorLogged());
  });
});

describe('fetchTraces', () => {
  it('sends only the meaningful filters, trimmed, with outcome lower-cased', async () => {
    fx = stubFetch(() => json([{ traceId: 'a' }, { traceId: 'b' }]));
    const out = await api.fetchTraces({
      serviceName: 'S', traceId: ' t ', transactionName: ' tx ', outcome: 'ERROR', dbName: ' db ',
      search: ' q ', startTime: 's', endTime: 'e', type: 'db', page: 3, size: 2,
    });
    assert.deepEqual(paramsOf(fx.last), {
      page: '3', size: '2', type: 'db', traceId: 't', serviceName: 'S', transactionName: 'tx',
      outcome: 'error', dbName: 'db', search: 'q', startTime: 's', endTime: 'e',
    });
    assert.equal(out.items.length, 2);
    assert.equal(out.hasMore, true, 'a full page implies there may be more');
  });

  it('omits ALL filters and reports no more on a short page', async () => {
    fx = stubFetch(() => json([{ traceId: 'a' }]));
    const out = await api.fetchTraces({ serviceName: 'ALL', outcome: 'ALL', type: 'ALL' });
    assert.deepEqual(paramsOf(fx.last), { page: '0', size: '20' });
    assert.equal(out.hasMore, false);
  });

  it('treats a non-array as empty and rejects failures', async () => {
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchTraces(), { items: [], hasMore: false });
    fx.restore();
    fx = stubFetch(() => text('', 500));
    await assert.rejects(api.fetchTraces(), /status: 500/);
    assert.ok(errorLogged());
  });

  it('does not log an abort', async () => {
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchTraces(), { name: 'AbortError' });
    assert.equal(errorLogged(), false);
  });
});

describe('traces analytics', () => {
  const cases = [
    ['fetchSpans', 'spans'], ['fetchTraceList', 'list'],
    ['fetchServiceCatalog', 'catalog'], ['fetchTraceHistogram', 'histogram'],
  ];
  for (const [fn, path] of cases) {
    it(`${fn} reads /traces/${path} and returns the body untouched`, async () => {
      const body = { items: [1], total: 1 };
      fx = stubFetch(() => json(body));
      assert.deepEqual(await api[fn](), body);
      assert.equal(fx.last.url.pathname, `/api/traces/${path}`);
      assert.deepEqual(paramsOf(fx.last), { page: '0', size: '25' });
    });
  }

  it('repeats serviceNames, which suppresses the scalar serviceName', async () => {
    fx = stubFetch(() => json({}));
    const signal = new AbortController().signal;
    await api.fetchSpans({
      serviceNames: ['A', ' ', 'ALL', 'B'], serviceName: 'Ignored', traceId: ' t ', spanName: ' s ',
      outcome: 'error', search: ' q ', startTime: 'a', endTime: 'b', page: 2, size: 5, signal,
    });
    assert.deepEqual(paramsOf(fx.last), {
      page: '2', size: '5', serviceNames: ['A', 'B'], traceId: 't', spanName: 's',
      outcome: 'error', search: 'q', startTime: 'a', endTime: 'b',
    });
    assert.equal(fx.last.options.signal, signal);
    assert.equal(fx.last.url.searchParams.has('signal'), false);
  });

  it('uses the scalar serviceName when no list is given, and drops ALL', async () => {
    fx = stubFetch(() => json({}));
    await api.fetchTraceList({ serviceName: 'Solo', serviceNames: null, outcome: 'ALL' });
    assert.deepEqual(paramsOf(fx.last), { page: '0', size: '25', serviceName: 'Solo' });
    await api.fetchTraceList({ serviceName: 'ALL' });
    assert.equal(fx.last.url.searchParams.has('serviceName'), false);
  });

  it('rejects failures and stays quiet on abort', async () => {
    fx = stubFetch(() => text('', 500));
    await assert.rejects(api.fetchServiceCatalog(), /status: 500/);
    assert.ok(errorLogged());
    fx.restore();
    console.error.mock.resetCalls();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchTraceHistogram(), { name: 'AbortError' });
    assert.equal(errorLogged(), false);
  });
});

describe('fetchMetrics / fetchMetricStreams', () => {
  it('sends metric filters and normalises dotted and camelCase points', async () => {
    fx = stubFetch(() => json([
      { 'metric.name': 'cpu', '@timestamp': 1, value: 0.5, 'service.name': 's', 'host.name': 'h' },
      { name: 'mem', timestamp: 2, value: 3, serviceName: 'c', hostName: 'hc' },
      { service_name: 'snake', host_name: 'hs' },
      {},
    ]));
    const out = await api.fetchMetrics({
      metricName: 'cpu', serviceName: 'svc', hostName: 'h', startTime: 's', endTime: 'e',
    });
    assert.equal(fx.last.url.pathname, '/api/metrics');
    assert.deepEqual(paramsOf(fx.last), {
      page: '0', size: '100', metricName: 'cpu', serviceName: 'svc', hostName: 'h', startTime: 's', endTime: 'e',
    });
    assert.deepEqual(out.map((p) => [p.name, p.timestamp, p.value, p.serviceName, p.hostName]), [
      ['cpu', 1, 0.5, 's', 'h'], ['mem', 2, 3, 'c', 'hc'],
      ['unknown-metric', undefined, undefined, 'snake', 'hs'],
      ['unknown-metric', undefined, undefined, 'unknown-service', null],
    ]);
  });

  it('omits an ALL service and returns [] for a non-array', async () => {
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchMetrics({ serviceName: 'all' }), []);
    assert.deepEqual(paramsOf(fx.last), { page: '0', size: '100' });
    assert.equal(console.warn.mock.callCount(), 1);
  });

  it('rejects metric failures', async () => {
    fx = stubFetch(() => text('', 500));
    await assert.rejects(api.fetchMetrics(), /status: 500/);
  });

  it('fetchMetricStreams returns the list, and [] for bad shapes and failures', async () => {
    fx = stubFetch(() => json(['a', 'b']));
    assert.deepEqual(await api.fetchMetricStreams(), ['a', 'b']);
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchMetricStreams(), []);
    fx.restore();
    fx = stubFetch(() => { throw new TypeError('network down'); });
    assert.deepEqual(await api.fetchMetricStreams(), []);
    assert.ok(errorLogged());
  });
});

describe('summary endpoints', () => {
  it('fetchServicesUptime sends only non-empty params and no bare "?"', async () => {
    fx = stubFetch(() => json({ items: [] }));
    await api.fetchServicesUptime();
    assert.equal(fx.last.raw, `${BASE}/services/uptime`);
    await api.fetchServicesUptime({ window: 'now-1h', livenessSec: 60 });
    assert.deepEqual(paramsOf(fx.last), { window: 'now-1h', livenessSec: '60' });
  });

  it('fetchServicesUptime rejects failures but does not log aborts', async () => {
    fx = stubFetch(() => text('', 500));
    await assert.rejects(api.fetchServicesUptime(), /status: 500/);
    assert.ok(errorLogged());
    fx.restore();
    console.error.mock.resetCalls();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchServicesUptime(), { name: 'AbortError' });
    assert.equal(errorLogged(), false);
  });

  const simple = [
    ['fetchLogsSummary', '/api/logs/summary', { window: 'now-1h' }, { window: 'now-1h' }],
    ['fetchTracesSummary', '/api/traces/summary', { window: 'now-6h' }, { window: 'now-6h' }],
    ['fetchMetricsSummary', '/api/metrics/summary',
      { window: 'now-1h', bucketSec: 30, serviceName: 'S' },
      { window: 'now-1h', bucketSec: '30', serviceName: 'S' }],
  ];
  for (const [fn, path, args, expected] of simple) {
    it(`${fn} reads ${path} and passes the body through`, async () => {
      fx = stubFetch(() => json({ supported: true, n: 1 }));
      assert.deepEqual(await api[fn](args), { supported: true, n: 1 });
      assert.equal(fx.last.url.pathname, path);
      assert.deepEqual(paramsOf(fx.last), expected);
      await api[fn]();
      assert.equal(fx.last.url.search, '');
    });

    it(`${fn} rejects failures`, async () => {
      fx = stubFetch(() => text('', 502));
      await assert.rejects(api[fn](), /status: 502/);
      assert.ok(errorLogged());
    });
  }
});

describe('fetchServiceNames', () => {
  const route = (logs, uptime) => (url) => {
    if (url.includes('/logs/services')) return typeof logs === 'function' ? logs() : json(logs);
    return typeof uptime === 'function' ? uptime() : json(uptime);
  };

  it('unions log discovery with the heartbeat inventory, case-insensitively', async () => {
    fx = stubFetch(route(
      { items: ['kafkaconnector', 'Orders', 'unknown-service', '-', ''] },
      { items: [{ 'service.name': 'Kafkaconnector' }, { serviceName: 'billing' }, { service_name: 'auth' }, null] },
    ));
    const out = await api.fetchServiceNames();
    assert.deepEqual(out, ['auth', 'billing', 'kafkaconnector', 'Orders']);
  });

  it('forwards the discovery window to logs only, and uptimeWindow to uptime', async () => {
    fx = stubFetch(route({ items: [] }, { items: [] }));
    await api.fetchServiceNames({ window: 'now-1h' });
    const logsCall = fx.calls.find((c) => c.url.pathname.endsWith('/logs/services'));
    const uptimeCall = fx.calls.find((c) => c.url.pathname.endsWith('/services/uptime'));
    assert.equal(logsCall.url.searchParams.get('window'), 'now-1h');
    assert.equal(uptimeCall.url.searchParams.has('window'), false);

    await api.fetchServiceNames({ uptimeWindow: 'now-5m' });
    assert.equal(fx.last.url.searchParams.get('window'), 'now-5m');
  });

  it('keeps one source\'s names when the other fails', async () => {
    fx = stubFetch(route(() => text('', 500), { items: [{ serviceName: 'only-uptime' }] }));
    assert.deepEqual(await api.fetchServiceNames(), ['only-uptime']);
    fx.restore();
    fx = stubFetch(route({ items: ['only-logs'] }, () => text('', 500)));
    assert.deepEqual(await api.fetchServiceNames(), ['only-logs']);
  });
});

describe('fetchOrgSummary', () => {
  it('reads the nested camelCase shape', async () => {
    fx = stubFetch(() => json({
      supported: true, backend: 'openobserve', org: 'default',
      streams: { count: 632, events: 47800000, ingestedBytes: 1, compressedBytes: 2, indexBytes: 3 },
      functions: { count: 4 },
      alerts: { scheduled: 1, realTime: 2, items: [{ id: 'a' }], health: { healthy: 3, failed: '1', warning: 0 } },
      pipelines: { scheduledCount: 5, real_time_count: 6 },
    }));
    const out = await api.fetchOrgSummary();
    assert.equal(fx.last.url.pathname, '/api/org/summary');
    assert.deepEqual(out, {
      supported: true, backend: 'openobserve', org: 'default',
      streams: { count: 632, events: 47800000, ingestedBytes: 1, compressedBytes: 2, indexBytes: 3 },
      functions: { count: 4 },
      alerts: { scheduled: 1, realTime: 2, items: [{ id: 'a' }], health: { healthy: 3, failed: 1, warning: 0 } },
      pipelines: { scheduled: 5, realTime: 6, items: [], health: null },
    });
  });

  it('accepts OpenObserve snake_case stats and numeric strings', async () => {
    fx = stubFetch(() => json({
      org_id: 'DLH',
      streams: { stream_count: 'x', doc_num: '10', storage_size: '20', compressed_size: 30, index_size: 40 },
      alerts: { scheduled_count: '7', real_time: 8 },
    }));
    const out = await api.fetchOrgSummary();
    assert.equal(out.org, 'DLH');
    assert.deepEqual(out.streams, {
      count: null, events: 10, ingestedBytes: 20, compressedBytes: 30, indexBytes: 40,
    });
    assert.equal(out.alerts.scheduled, 7);
    assert.equal(out.alerts.realTime, 8);
  });

  it('accepts a flat top-level shape and reports unsupported', async () => {
    fx = stubFetch(() => json({
      supported: false, orgId: 'o', streamCount: 3, events: 4, ingestedBytes: 5,
      compressedBytes: 6, indexBytes: 7, functionCount: 8,
      alertsScheduled: 1, alertsRealTime: 2, pipelinesScheduled: 3, pipelinesRealTime: 4,
    }));
    const out = await api.fetchOrgSummary();
    assert.equal(out.supported, false);
    assert.equal(out.backend, null);
    assert.equal(out.org, 'o');
    assert.deepEqual(out.streams, { count: 3, events: 4, ingestedBytes: 5, compressedBytes: 6, indexBytes: 7 });
    assert.equal(out.functions.count, 8);
    assert.deepEqual([out.alerts.scheduled, out.alerts.realTime], [1, 2]);
    assert.deepEqual([out.pipelines.scheduled, out.pipelines.realTime], [3, 4]);
  });

  it('attaches the HTTP status so a missing endpoint is distinguishable', async () => {
    fx = stubFetch(() => text('', 404));
    await assert.rejects(api.fetchOrgSummary(), (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.message, 'GET /org/summary returned HTTP 404');
      return true;
    });
  });

  it('rethrows network errors (logged) and aborts (silent)', async () => {
    fx = stubFetch(() => { throw new TypeError('offline'); });
    await assert.rejects(api.fetchOrgSummary(), { message: 'offline' });
    assert.ok(errorLogged());
    fx.restore();
    console.error.mock.resetCalls();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchOrgSummary(), { name: 'AbortError' });
    assert.equal(errorLogged(), false);
  });
});

describe('fetchServiceVitals', () => {
  it('requires a service name', async () => {
    await assert.rejects(api.fetchServiceVitals(''), /serviceName is required/);
  });

  it('encodes the name into the path and sends window/bucket only when set', async () => {
    fx = stubFetch(() => json({ tiles: {} }));
    assert.deepEqual(await api.fetchServiceVitals('a/b c', { window: 'now-1h', bucketSec: 60 }), { tiles: {} });
    assert.equal(fx.last.url.pathname, '/api/services/a%2Fb%20c/vitals');
    assert.deepEqual(paramsOf(fx.last), { window: 'now-1h', bucketSec: '60' });
    await api.fetchServiceVitals('x');
    assert.equal(fx.last.raw, `${BASE}/services/x/vitals`);
  });

  it('rejects failures', async () => {
    fx = stubFetch(() => text('', 500));
    await assert.rejects(api.fetchServiceVitals('x'), /status: 500/);
  });
});

describe('IAM reads', () => {
  const cases = [
    ['fetchOrganizations', 'organizations'], ['fetchIamUsers', 'users'],
    ['fetchServiceAccounts', 'service-accounts'],
  ];
  for (const [fn, path] of cases) {
    it(`${fn} reads /iam/${path}`, async () => {
      fx = stubFetch(() => json({ items: [path] }));
      assert.deepEqual(await api[fn](), { items: [path] });
      assert.equal(fx.last.raw, `${BASE}/iam/${path}`);
    });
  }

  it('rejects failures and stays quiet on abort', async () => {
    fx = stubFetch(() => text('', 403));
    await assert.rejects(api.fetchOrganizations(), /status: 403/);
    assert.ok(errorLogged());
    fx.restore();
    console.error.mock.resetCalls();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchServiceAccounts(), { name: 'AbortError' });
    assert.equal(errorLogged(), false);
  });
});

describe('PromQL metrics', () => {
  it('fetchMetricCatalog normalises the catalogue', async () => {
    fx = stubFetch(() => json({ items: [{ name: 'up' }], groups: [{ key: 'g' }], total: '1', error: 'partial' }));
    assert.deepEqual(await api.fetchMetricCatalog(), {
      items: [{ name: 'up' }], groups: [{ key: 'g' }], total: 1, supported: true, error: 'partial',
    });
    assert.equal(fx.last.raw, `${BASE}/metrics/catalog`);
  });

  it('fetchMetricCatalog defaults a shapeless body and degrades a failure', async () => {
    fx = stubFetch(() => json({ supported: false }));
    assert.deepEqual(await api.fetchMetricCatalog(), {
      items: [], groups: [], total: 0, supported: false, error: null,
    });
    fx.restore();
    fx = stubFetch(() => text('', 500));
    assert.deepEqual(await api.fetchMetricCatalog(), {
      items: [], groups: [], total: 0, supported: false, error: 'HTTP error! status: 500',
    });
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchMetricCatalog(), { name: 'AbortError' });
  });

  it('fetchMetricProducers coerces every counter and flag', async () => {
    fx = stubFetch(() => json({
      services: [{ name: 's' }], building: true, partial: true, progressDone: '5', progressTotal: 10,
      builtAt: 'b', ageSeconds: 1, buildMillis: 2, windowSeconds: 3, metricsProbed: 4,
      metricsWithNoData: 5, metricsUnscoped: 6, probeFailures: 7,
    }));
    const out = await api.fetchMetricProducers();
    assert.equal(fx.last.url.pathname, '/api/metrics/producers');
    assert.deepEqual(out, {
      services: [{ name: 's' }], building: true, partial: true, progressDone: 5, progressTotal: 10,
      builtAt: 'b', ageSeconds: 1, buildMillis: 2, windowSeconds: 3, metricsProbed: 4,
      metricsWithNoData: 5, metricsUnscoped: 6, probeFailures: 7, supported: true, error: null,
    });
  });

  it('fetchMetricProducers treats "building":"true" as not building and zeros junk', async () => {
    fx = stubFetch(() => json({ building: 'true', progressDone: 'x' }));
    const out = await api.fetchMetricProducers();
    assert.equal(out.building, false);
    assert.equal(out.progressDone, 0);
    assert.deepEqual(out.services, []);
  });

  it('fetchMetricProducers degrades a failure and rethrows an abort', async () => {
    fx = stubFetch(() => text('', 503));
    const out = await api.fetchMetricProducers();
    assert.equal(out.supported, false);
    assert.equal(out.error, 'HTTP error! status: 503');
    assert.deepEqual(out.services, []);
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchMetricProducers(), { name: 'AbortError' });
  });

  it('refreshMetricProducers POSTs and returns the body, or null on failure', async () => {
    fx = stubFetch(() => json({ building: true }));
    assert.deepEqual(await api.refreshMetricProducers(), { building: true });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/metrics/producers/refresh');
    fx.restore();
    fx = stubFetch(() => text('', 500));
    assert.equal(await api.refreshMetricProducers(), null);
  });

  it('fetchMetricLabels scopes to a metric only when given', async () => {
    fx = stubFetch(() => json({ items: ['job'] }));
    assert.deepEqual(await api.fetchMetricLabels(), ['job']);
    assert.equal(fx.last.raw, `${BASE}/metrics/labels`);
    await api.fetchMetricLabels({ metric: 'up' });
    assert.deepEqual(paramsOf(fx.last), { metric: 'up' });
  });

  it('fetchMetricLabels degrades to [] and rethrows an abort', async () => {
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchMetricLabels(), []);
    fx.restore();
    fx = stubFetch(() => text('', 500));
    assert.deepEqual(await api.fetchMetricLabels(), []);
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchMetricLabels(), { name: 'AbortError' });
  });

  it('fetchMetricLabelValues needs a label and sends it with the metric', async () => {
    fx = stubFetch(() => json({ items: ['a', 'b'] }));
    assert.deepEqual(await api.fetchMetricLabelValues({}), []);
    assert.equal(fx.calls.length, 0);
    assert.deepEqual(await api.fetchMetricLabelValues({ label: 'job', metric: 'up' }), ['a', 'b']);
    assert.equal(fx.last.url.pathname, '/api/metrics/label-values');
    assert.deepEqual(paramsOf(fx.last), { label: 'job', metric: 'up' });
  });

  it('fetchMetricLabelValues degrades to [] and rethrows an abort', async () => {
    fx = stubFetch(() => json({ items: 'nope' }));
    assert.deepEqual(await api.fetchMetricLabelValues({ label: 'x' }), []);
    fx.restore();
    fx = stubFetch(() => text('', 500));
    assert.deepEqual(await api.fetchMetricLabelValues({ label: 'x' }), []);
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchMetricLabelValues({ label: 'x' }), { name: 'AbortError' });
  });

  it('fetchMetricRange answers a blank query locally without a request', async () => {
    fx = stubFetch();
    const empty = { resultType: null, series: [], supported: true, error: null };
    assert.deepEqual(await api.fetchMetricRange({ query: '  ' }), empty);
    assert.deepEqual(await api.fetchMetricRange(), empty);
    assert.equal(fx.calls.length, 0);
  });

  it('fetchMetricRange converts points to sorted ms/number pairs, holes as null', async () => {
    fx = stubFetch(() => json({
      resultType: 'matrix',
      series: [
        { labels: { job: 'a' }, values: [[20, '2'], [10, '1.5'], [30, 'NaN'], ['bad', '3'], [40, '+Inf']] },
        { labels: 'junk', values: 'junk' },
        null,
      ],
    }));
    const out = await api.fetchMetricRange({ query: 'up', startTime: 'now-1h', endTime: 'now', step: 15 });
    assert.equal(fx.last.url.pathname, '/api/metrics/query-range');
    assert.deepEqual(paramsOf(fx.last), { query: 'up', startTime: 'now-1h', endTime: 'now', step: '15' });
    assert.deepEqual(out, {
      resultType: 'matrix', supported: true, error: null,
      series: [
        { labels: { job: 'a' }, points: [
          { t: 10000, v: 1.5 }, { t: 20000, v: 2 }, { t: 30000, v: null }, { t: 40000, v: null },
        ] },
        { labels: {}, points: [] },
        { labels: {}, points: [] },
      ],
    });
  });

  it('fetchMetricRange omits a non-positive step and degrades a failure', async () => {
    fx = stubFetch(() => json({ supported: false, error: 'nope' }));
    const out = await api.fetchMetricRange({ query: 'up', step: 0 });
    assert.equal(fx.last.url.searchParams.has('step'), false);
    assert.deepEqual(out, { resultType: null, supported: false, error: 'nope', series: [] });
    fx.restore();
    fx = stubFetch(() => text('', 500));
    assert.deepEqual(await api.fetchMetricRange({ query: 'up' }), {
      resultType: null, series: [], supported: false, error: 'HTTP error! status: 500',
    });
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchMetricRange({ query: 'up' }), { name: 'AbortError' });
  });

  it('fetchMetricInstant queries /metrics/query at a time', async () => {
    fx = stubFetch();
    assert.deepEqual(await api.fetchMetricInstant({ query: '' }),
      { resultType: null, series: [], supported: true, error: null });
    assert.equal(fx.calls.length, 0);
    fx.restore();
    fx = stubFetch(() => json({ resultType: 'vector', series: [{ labels: {}, values: [[1, '7']] }] }));
    const out = await api.fetchMetricInstant({ query: 'up', time: '123' });
    assert.equal(fx.last.url.pathname, '/api/metrics/query');
    assert.deepEqual(paramsOf(fx.last), { query: 'up', time: '123' });
    assert.deepEqual(out.series, [{ labels: {}, points: [{ t: 1000, v: 7 }] }]);
  });

  it('fetchMetricInstant degrades a failure and rethrows an abort', async () => {
    fx = stubFetch(() => text('', 500));
    const out = await api.fetchMetricInstant({ query: 'up' });
    assert.equal(out.supported, false);
    assert.equal(out.error, 'HTTP error! status: 500');
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchMetricInstant({ query: 'up' }), { name: 'AbortError' });
  });
});

describe('fetchInfrastructureUtilization', () => {
  it('sends node and refresh only when set, and normalises the envelope', async () => {
    fx = stubFetch(() => json({
      items: [{ id: 'cpu' }], nodes: ['n1'], org: 'o', capturedAt: 'c', cached: true,
    }));
    const out = await api.fetchInfrastructureUtilization({ node: 'n1', refresh: true });
    assert.equal(fx.last.url.pathname, '/api/infrastructure/utilization');
    assert.deepEqual(paramsOf(fx.last), { node: 'n1', refresh: 'true' });
    assert.deepEqual(out, {
      items: [{ id: 'cpu' }], nodes: ['n1'], org: 'o', capturedAt: 'c', cached: true,
      supported: true, error: null,
    });
  });

  it('sends no query for the defaults and reads supported:false', async () => {
    fx = stubFetch(() => json({ supported: false, cached: 'yes' }));
    const out = await api.fetchInfrastructureUtilization();
    assert.equal(fx.last.raw, `${BASE}/infrastructure/utilization`);
    assert.deepEqual(out, {
      items: [], nodes: [], org: null, capturedAt: null, cached: false, supported: false, error: null,
    });
  });

  it('resolves a failure to an unsupported envelope and rethrows an abort', async () => {
    fx = stubFetch(() => text('', 500));
    const out = await api.fetchInfrastructureUtilization();
    assert.equal(out.supported, false);
    assert.equal(out.error, 'HTTP error! status: 500');
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchInfrastructureUtilization(), { name: 'AbortError' });
  });
});
