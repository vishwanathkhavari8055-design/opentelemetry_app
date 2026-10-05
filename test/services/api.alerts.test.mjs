/**
 * Guards the writing side of src/services/api.js — alert rules, folders,
 * destinations, fired-alert notifications, the enterprise alerts table, the
 * Product Catalog — plus the Analytics and RUM readers that share its error
 * convention.
 *
 * Two conventions are pinned because a regression in either is invisible until
 * someone needs it:
 *  - A failed write REJECTS with the backend's own sentence ("Alert with this
 *    name already exists"), and a bodyless 403 names the CORS/PATCH cause that
 *    once cost a day to find. A generic "HTTP 400" would tell the user nothing.
 *  - Empty and non-JSON 2xx bodies (DELETE, 204s from a proxy) are success, not a
 *    parse failure.
 * Beyond that: the exact method, path, headers and JSON body each call sends,
 * repeated multi-select params, and the defaults applied to absent fields.
 *
 * fetch is stubbed per test (./fetchStub.mjs) and restored afterwards.
 */

import '../support/dom.mjs';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { abortError, json, paramsOf, stubFetch, text } from './fetchStub.mjs';

const api = await import('../../src/services/api.js');

const BASE = 'http://api.test/api';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
let fx;

beforeEach(() => {
  api.setApiBase(BASE);
  api.setOrg('');
});

afterEach(() => {
  fx?.restore();
  fx = undefined;
});

describe('backend error messages (alertsError)', () => {
  it('uses the body\'s error, then its message', async () => {
    fx = stubFetch(() => json({ error: 'Alert with this name already exists' }, 409));
    await assert.rejects(api.fetchAlerts(), { message: 'Alert with this name already exists' });
    fx.restore();
    fx = stubFetch(() => json({ message: 'bad cron' }, 400));
    await assert.rejects(api.createAlert({ alert: {} }), { message: 'bad cron' });
  });

  it('explains a bodyless 403 as the CORS method filter', async () => {
    fx = stubFetch(() => text('Invalid CORS request', 403));
    await assert.rejects(api.setAlertEnabled('a', true), (err) => {
      assert.match(err.message, /HTTP 403/);
      assert.match(err.message, /allowedMethods in CorsConfig includes PATCH/);
      return true;
    });
  });

  it('falls back to the status for a non-JSON or message-less body', async () => {
    fx = stubFetch(() => text('<html>gateway</html>', 502));
    await assert.rejects(api.fetchAlertFolders(), { message: 'Request failed (HTTP 502)' });
    fx.restore();
    fx = stubFetch(() => json({ other: 1 }, 500));
    await assert.rejects(api.deleteAlert('x'), { message: 'Request failed (HTTP 500)' });
  });
});

describe('OpenObserve incidents', () => {
  it('lists incidents, tolerating a non-array', async () => {
    fx = stubFetch(() => json([{ id: 1 }]));
    assert.deepEqual(await api.fetchOpenObserveIncidents(), [{ id: 1 }]);
    assert.equal(fx.last.raw, `${BASE}/oo-incidents`);
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchOpenObserveIncidents(), []);
  });

  it('reads one incident by encoded id and rejects failures', async () => {
    fx = stubFetch(() => json({ id: 'a/b' }));
    assert.deepEqual(await api.fetchOpenObserveIncident('a/b'), { id: 'a/b' });
    assert.equal(fx.last.url.pathname, '/api/oo-incidents/a%2Fb');
    fx.restore();
    fx = stubFetch(() => json({ error: 'gone' }, 404));
    await assert.rejects(api.fetchOpenObserveIncident('x'), { message: 'gone' });
    fx.restore();
    fx = stubFetch(() => json({}, 500));
    await assert.rejects(api.fetchOpenObserveIncidents(), /HTTP 500/);
  });
});

describe('alert rules', () => {
  it('fetchAlerts sends only meaningful filters and a bare URL by default', async () => {
    fx = stubFetch(() => json({ items: [{ id: 1 }], org: 'o', total: 1 }));
    const out = await api.fetchAlerts();
    assert.equal(fx.last.raw, `${BASE}/alerts`);
    assert.deepEqual(out, { items: [{ id: 1 }], org: 'o', supported: true, total: 1 });
  });

  it('fetchAlerts sends enabled=false explicitly and pageIdx only with a page size', async () => {
    fx = stubFetch(() => json({}));
    await api.fetchAlerts({
      folder: 'f', alertType: 'scheduled', search: 'cpu', streamType: 'logs', streamName: 's',
      owner: 'me', enabled: false, pageSize: 20, pageIdx: 2,
    });
    assert.deepEqual(paramsOf(fx.last), {
      folder: 'f', alertType: 'scheduled', search: 'cpu', streamType: 'logs', streamName: 's',
      owner: 'me', enabled: 'false', pageSize: '20', pageIdx: '2',
    });
    await api.fetchAlerts({ enabled: true, pageIdx: 3 });
    assert.deepEqual(paramsOf(fx.last), { enabled: 'true' });
    await api.fetchAlerts({ pageSize: 10, pageIdx: 0 });
    assert.deepEqual(paramsOf(fx.last), { pageSize: '10' });
  });

  it('fetchAlerts defaults a shapeless body', async () => {
    fx = stubFetch(() => json({ supported: false }));
    assert.deepEqual(await api.fetchAlerts(), { items: [], org: null, supported: false, total: null });
  });

  it('fetchAlert keeps OpenObserve\'s document and falls back to the requested id', async () => {
    fx = stubFetch(() => json({ alert: { name: 'n', extra: 1 }, folderId: 'f' }));
    const signal = new AbortController().signal;
    const out = await api.fetchAlert('id 1', { signal });
    assert.equal(fx.last.url.pathname, '/api/alerts/id%201');
    assert.equal(fx.last.options.signal, signal);
    assert.deepEqual(out, { alert: { name: 'n', extra: 1 }, alertId: 'id 1', folderId: 'f', supported: true });
    fx.restore();
    fx = stubFetch(() => json({ alertId: 'real' }));
    assert.deepEqual(await api.fetchAlert('x'), { alert: null, alertId: 'real', folderId: null, supported: true });
  });

  const writes = [
    ['createAlert', () => api.createAlert({ alert: { name: 'a' } }),
      'POST', '/api/alerts', { alert: { name: 'a' }, folderId: 'default' }],
    ['updateAlert', () => api.updateAlert('a/1', { alert: { name: 'b' }, folderId: 'f' }),
      'PUT', '/api/alerts/a%2F1', { alert: { name: 'b' }, folderId: 'f' }],
    ['deleteAlert', () => api.deleteAlert('a1'), 'DELETE', '/api/alerts/a1', undefined],
    ['triggerAlert', () => api.triggerAlert('a1'), 'PATCH', '/api/alerts/a1/trigger', undefined],
    ['cloneAlert', () => api.cloneAlert('a1', { name: 'copy' }),
      'POST', '/api/alerts/a1/clone', { name: 'copy', folderId: '' }],
    ['cloneAlert defaults', () => api.cloneAlert('a1'),
      'POST', '/api/alerts/a1/clone', { name: '', folderId: '' }],
    ['moveAlerts', () => api.moveAlerts({ alertIds: ['a', 'b'], targetFolderId: 't' }),
      'PATCH', '/api/alerts/move', { alertIds: ['a', 'b'], targetFolderId: 't' }],
    ['importAlerts', () => api.importAlerts({ alerts: [{ name: 'x' }] }),
      'POST', '/api/alerts/import', { alerts: [{ name: 'x' }], folderId: 'default' }],
    ['createAlertFolder', () => api.createAlertFolder({ name: 'F' }),
      'POST', '/api/alerts/folders', { name: 'F', description: '' }],
    ['updateAlertFolder', () => api.updateAlertFolder('f 1', { name: 'G', description: 'd' }),
      'PUT', '/api/alerts/folders/f%201', { name: 'G', description: 'd' }],
    ['deleteAlertFolder', () => api.deleteAlertFolder('f1'), 'DELETE', '/api/alerts/folders/f1', undefined],
    ['createAlertDestination', () => api.createAlertDestination({ name: 'd', template: 't' }),
      'POST', '/api/alerts/destinations', { name: 'd', template: 't' }],
  ];
  for (const [name, call, method, path, body] of writes) {
    it(`${name} sends ${method} ${path}`, async () => {
      fx = stubFetch(() => json({ ok: 'yes' }));
      assert.deepEqual(await call(), { ok: 'yes' });
      assert.equal(fx.last.method, method);
      assert.equal(fx.last.url.pathname, path);
      assert.deepEqual(fx.last.body, body);
      assert.deepEqual(fx.last.options.headers, body === undefined ? undefined : JSON_HEADERS);
    });
  }

  it('setAlertEnabled sends the state as ?value=, with no body', async () => {
    fx = stubFetch(() => json({}));
    await api.setAlertEnabled('a1', 1);
    assert.equal(fx.last.method, 'PATCH');
    assert.equal(fx.last.url.pathname, '/api/alerts/a1/enable');
    assert.deepEqual(paramsOf(fx.last), { value: 'true' });
    assert.equal(fx.last.options.body, undefined);
    await api.setAlertEnabled('a1', 0);
    assert.deepEqual(paramsOf(fx.last), { value: 'false' });
  });

  it('treats an empty or non-JSON 2xx write body as success', async () => {
    fx = stubFetch(() => new Response(null, { status: 204 }));
    assert.deepEqual(await api.deleteAlert('a'), { ok: true });
    fx.restore();
    fx = stubFetch(() => text('deleted'));
    assert.deepEqual(await api.deleteAlertFolder('f'), { ok: true });
  });

  it('keeps the org param on writes', async () => {
    api.setOrg('DLH');
    fx = stubFetch(() => json({}));
    await api.setAlertEnabled('a', true);
    assert.deepEqual(paramsOf(fx.last), { value: 'true', org: 'DLH' });
  });
});

describe('folders, destinations, templates', () => {
  for (const [fn, path] of [
    ['fetchAlertFolders', '/api/alerts/folders'],
    ['fetchAlertDestinations', '/api/alerts/destinations'],
    ['fetchAlertTemplates', '/api/alerts/templates'],
  ]) {
    it(`${fn} reads ${path} and defaults absent fields`, async () => {
      fx = stubFetch(() => json({ items: [{ id: 1 }] }));
      assert.deepEqual(await api[fn](), { items: [{ id: 1 }], supported: true });
      assert.equal(fx.last.url.pathname, path);
      fx.restore();
      fx = stubFetch(() => json({ supported: false }));
      assert.deepEqual(await api[fn](), { items: [], supported: false });
    });
  }
});

describe('alert streams and schema', () => {
  it('fetchAlertStreams omits absent scope params', async () => {
    fx = stubFetch(() => json({ items: ['s1'] }));
    assert.deepEqual(await api.fetchAlertStreams(), ['s1']);
    assert.deepEqual(paramsOf(fx.last), { type: 'logs' });
    await api.fetchAlertStreams({ type: 'metrics', scopeType: 'service', scopeKey: 'S' });
    assert.deepEqual(paramsOf(fx.last), { type: 'metrics', scopeType: 'service', scopeKey: 'S' });
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchAlertStreams(), []);
  });

  it('fetchScopedAlertStreams reports whether the list was narrowed and asked for', async () => {
    fx = stubFetch(() => json({ items: ['a'], scoped: true }));
    assert.deepEqual(await api.fetchScopedAlertStreams({ scopeType: 'resource', scopeKey: '7' }), {
      items: ['a'], scoped: true, requested: true, notice: '',
    });
    fx.restore();
    fx = stubFetch(() => json({ items: ['a', 'b'], scoped: 'true', notice: 'could not narrow' }));
    assert.deepEqual(await api.fetchScopedAlertStreams({ scopeType: 'service' }), {
      items: ['a', 'b'], scoped: false, requested: false, notice: 'could not narrow',
    });
    fx.restore();
    fx = stubFetch(() => json(null));
    assert.deepEqual(await api.fetchScopedAlertStreams(), {
      items: [], scoped: false, requested: false, notice: '',
    });
  });

  it('fetchAlertStreamFields needs a stream name and encodes it', async () => {
    fx = stubFetch(() => json({ items: ['f1'] }));
    assert.deepEqual(await api.fetchAlertStreamFields({}), []);
    assert.equal(fx.calls.length, 0);
    assert.deepEqual(await api.fetchAlertStreamFields({ streamName: 'a b', type: 'traces' }), ['f1']);
    assert.equal(fx.last.url.pathname, '/api/alerts/streams/a%20b/fields');
    assert.deepEqual(paramsOf(fx.last), { type: 'traces' });
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchAlertStreamFields({ streamName: 's' }), []);
  });

  it('fetchAlertStreamSchema returns typed columns', async () => {
    fx = stubFetch(() => json({ items: [{ name: 'took', type: 'Int64', numeric: true }] }));
    assert.deepEqual(await api.fetchAlertStreamSchema({}), []);
    assert.equal(fx.calls.length, 0);
    const out = await api.fetchAlertStreamSchema({ streamName: 's' });
    assert.equal(fx.last.url.pathname, '/api/alerts/streams/s/schema');
    assert.deepEqual(out, [{ name: 'took', type: 'Int64', numeric: true }]);
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchAlertStreamSchema({ streamName: 's' }), []);
  });

  it('fetchAlertStreamSchema falls back to /fields names, all numeric, on an older backend', async () => {
    fx = stubFetch((url) => (url.includes('/schema') ? json({}, 404) : json({ items: ['a', 'b'] })));
    const out = await api.fetchAlertStreamSchema({ streamName: 's', type: 'logs' });
    assert.deepEqual(fx.calls.map((c) => c.url.pathname), [
      '/api/alerts/streams/s/schema', '/api/alerts/streams/s/fields',
    ]);
    assert.deepEqual(out, [
      { name: 'a', type: null, numeric: true }, { name: 'b', type: null, numeric: true },
    ]);
  });

  it('fetchAlertStreamSchema does not fall back on an abort', async () => {
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.fetchAlertStreamSchema({ streamName: 's' }), { name: 'AbortError' });
    assert.equal(fx.calls.length, 1);
  });
});

describe('previewAlert', () => {
  it('POSTs the draft rule, dropping blank scope, and normalises the ladder', async () => {
    fx = stubFetch(() => json({
      mode: 'custom', periodMinutes: 5, sql: 'SELECT', steps: [{ n: 0 }],
      evaluation: { evaluated: true, fires: false }, durationMs: 12,
    }));
    const out = await api.previewAlert({
      streamType: 'logs', streamName: 'app', queryCondition: { c: 1 }, triggerCondition: { t: 1 },
      periodMinutes: 5, scopeType: '', scopeKey: '',
    });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/alert-builder/preview');
    assert.deepEqual(fx.last.options.headers, JSON_HEADERS);
    assert.deepEqual(fx.last.body, {
      streamType: 'logs', streamName: 'app', queryCondition: { c: 1 }, triggerCondition: { t: 1 },
      periodMinutes: 5, sampleSize: 0,
    });
    assert.deepEqual(out, {
      supported: true, streamType: 'logs', streamName: 'app', mode: 'custom', periodMinutes: 5,
      windowStart: null, windowEnd: null, sql: 'SELECT', scopeLabel: null, steps: [{ n: 0 }],
      evaluation: { evaluated: true, fires: false }, durationMs: 12, notice: '', error: '',
    });
  });

  it('sends scope when set and prefers the backend\'s stream identity', async () => {
    fx = stubFetch(() => json({ streamType: 'metrics', streamName: 'resolved' }));
    const out = await api.previewAlert({ streamType: 'logs', streamName: 'x', scopeType: 'service', scopeKey: 'S', sampleSize: 3 });
    assert.equal(fx.last.body.scopeType, 'service');
    assert.equal(fx.last.body.scopeKey, 'S');
    assert.equal(fx.last.body.sampleSize, 3);
    assert.equal(out.streamType, 'metrics');
    assert.equal(out.streamName, 'resolved');
    assert.deepEqual(out.evaluation, { evaluated: false });
    assert.deepEqual(out.steps, []);
  });

  it('resolves a failure as unsupported with the reason, and rethrows an abort', async () => {
    fx = stubFetch(() => json({ error: 'no such stream' }, 400));
    assert.deepEqual(await api.previewAlert({}), {
      supported: false, steps: [], evaluation: { evaluated: false }, error: 'no such stream',
    });
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.previewAlert({}), { name: 'AbortError' });
  });

  it('uses a generic message when the failure has none', async () => {
    fx = stubFetch(() => { throw Object.assign(new Error(''), { name: 'TypeError' }); });
    assert.equal((await api.previewAlert()).error, 'The preview could not be run.');
  });
});

describe('validateCompositeExpression', () => {
  it('POSTs the expression in OpenObserve\'s snake_case condition shape', async () => {
    fx = stubFetch(() => json({
      valid: true, canonicalExpression: 'A AND B', result: false, resultLevel: 'ok',
      children: [{ id: 'A' }], warnings: ['w'],
    }));
    const out = await api.validateCompositeExpression({ expression: 'A and B', compositeId: 'c1' });
    assert.equal(fx.last.url.pathname, '/api/alerts/composites/validate');
    assert.equal(fx.last.method, 'POST');
    assert.deepEqual(fx.last.body, {
      compositeCondition: {
        expression: 'A and B', stale_child_policy: 'use_last_state', warning_counts_as_firing: true,
      },
      compositeId: 'c1',
    });
    assert.deepEqual(out, {
      valid: true, supported: true, canonicalExpression: 'A AND B', result: false, resultLevel: 'ok',
      code: null, message: '', children: [{ id: 'A' }], warnings: ['w'],
    });
  });

  it('resolves a rejected expression as invalid, not as a failure', async () => {
    fx = stubFetch(() => json({ valid: false, code: 'CYCLE', message: 'cycle', result: 'x' }));
    const out = await api.validateCompositeExpression({ expression: 'A', staleChildPolicy: 'fail', warningCountsAsFiring: false });
    assert.equal(fx.last.body.compositeCondition.stale_child_policy, 'fail');
    assert.equal(fx.last.body.compositeCondition.warning_counts_as_firing, false);
    assert.equal(fx.last.body.compositeId, null);
    assert.equal(out.valid, false);
    assert.equal(out.supported, true);
    assert.equal(out.code, 'CYCLE');
    assert.equal(out.result, null, 'a non-boolean result is not passed through');
  });

  it('softens a transport failure to unsupported, and rethrows an abort', async () => {
    fx = stubFetch(() => json({}, 404));
    const out = await api.validateCompositeExpression({ expression: 'A' });
    assert.equal(out.valid, false);
    assert.equal(out.supported, false);
    assert.equal(out.message, 'Request failed (HTTP 404)');
    fx.restore();
    fx = stubFetch(() => { throw new Error(''); });
    assert.equal((await api.validateCompositeExpression()).message, 'Could not reach the validator.');
    fx.restore();
    fx = stubFetch(() => { throw abortError(); });
    await assert.rejects(api.validateCompositeExpression(), { name: 'AbortError' });
  });
});

describe('fired-alert notifications', () => {
  it('fetchAlertNotifications sends the default limit and normalises', async () => {
    fx = stubFetch(() => json({ items: [{ f: 1 }], org: 'o', total: 1, backend: 'pg' }));
    const out = await api.fetchAlertNotifications({ state: 'firing', severity: 'critical', search: 'x', streamName: 's' });
    assert.equal(fx.last.url.pathname, '/api/alerts/notifications');
    assert.deepEqual(paramsOf(fx.last), {
      state: 'firing', severity: 'critical', search: 'x', streamName: 's', limit: '200',
    });
    assert.deepEqual(out, { items: [{ f: 1 }], org: 'o', supported: true, total: 1, backend: 'pg' });
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchAlertNotifications(), {
      items: [], org: null, supported: true, total: null, backend: null,
    });
  });

  it('fetchAlertNotificationsSummary prefers needsAttention, else sums firing + acknowledged', async () => {
    fx = stubFetch(() => json({ firing: 2, acknowledged: 3, resolved: 1, needsAttention: 9, bySeverity: { critical: 1 } }));
    assert.deepEqual(await api.fetchAlertNotificationsSummary(), {
      org: null, supported: true, firing: 2, acknowledged: 3, resolved: 1, needsAttention: 9,
      bySeverity: { critical: 1 },
    });
    assert.equal(fx.last.url.pathname, '/api/alerts/notifications/summary');
    fx.restore();
    fx = stubFetch(() => json({ firing: 2, acknowledged: 3 }));
    assert.equal((await api.fetchAlertNotificationsSummary()).needsAttention, 5);
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchAlertNotificationsSummary(), {
      org: null, supported: true, firing: 0, acknowledged: 0, resolved: 0, needsAttention: 0, bySeverity: {},
    });
  });

  it('fetchAlertNotificationHistory needs a fingerprint and defaults to 7 days', async () => {
    fx = stubFetch(() => json({ items: [{ e: 1 }], total: 1 }));
    assert.deepEqual(await api.fetchAlertNotificationHistory({}), { items: [], total: 0 });
    assert.equal(fx.calls.length, 0);
    assert.deepEqual(await api.fetchAlertNotificationHistory({ fingerprint: 'fp' }), { items: [{ e: 1 }], total: 1 });
    assert.equal(fx.last.url.pathname, '/api/alerts/notifications/history');
    assert.deepEqual(paramsOf(fx.last), { fingerprint: 'fp', hours: '168' });
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchAlertNotificationHistory({ fingerprint: 'fp', hours: 1 }), { items: [], total: 0 });
  });

  for (const fn of ['acknowledgeAlertNotification', 'resolveAlertNotification']) {
    const action = fn.startsWith('ack') ? 'acknowledge' : 'resolve';
    it(`${fn} POSTs actor and note to /${action}`, async () => {
      fx = stubFetch(() => json({ state: action }));
      assert.deepEqual(await api[fn]('f/p', { actor: 'me', note: 'n' }), { state: action });
      assert.equal(fx.last.method, 'POST');
      assert.equal(fx.last.url.pathname, `/api/alerts/notifications/f%2Fp/${action}`);
      assert.deepEqual(fx.last.options.headers, JSON_HEADERS);
      assert.deepEqual(fx.last.body, { actor: 'me', note: 'n' });
      await api[fn]('fp');
      assert.deepEqual(fx.last.body, { actor: '', note: '' });
    });

    it(`${fn} rejects with the backend message`, async () => {
      fx = stubFetch(() => json({ error: 'already resolved' }, 409));
      await assert.rejects(api[fn]('fp'), { message: 'already resolved' });
    });
  }
});

describe('updateIamUser', () => {
  it('PUTs the payload to the encoded email', async () => {
    fx = stubFetch(() => json({ ok: true }));
    assert.deepEqual(await api.updateIamUser('a+b@x.com', { role: 'admin' }), { ok: true });
    assert.equal(fx.last.method, 'PUT');
    assert.equal(fx.last.url.pathname, '/api/iam/users/a%2Bb%40x.com');
    assert.deepEqual(fx.last.body, { role: 'admin' });
  });

  it('rejects with the reason the change was refused', async () => {
    fx = stubFetch(() => json({ error: 'cannot demote the last admin' }, 400));
    await assert.rejects(api.updateIamUser('a@x', {}), { message: 'cannot demote the last admin' });
  });
});

describe('enterprise alerts table (/alerts/query)', () => {
  it('fetchAlerts2 repeats multi-select params once per value', async () => {
    fx = stubFetch(() => json({ items: [{ id: 1 }], total: 10, page: 1, size: 5, hasMore: 1, sortBy: 'severity', sortDir: 'asc' }));
    const out = await api.fetchAlerts2({
      search: 'cpu', severity: ['critical', '', 'warning'], status: ['FIRING'], service: 's',
      stream: 'st', source: 'oo', ruleId: 'r', window: 'now-24h', page: 1, size: 5, sortBy: 'severity', sortDir: 'asc',
    });
    assert.equal(fx.last.url.pathname, '/api/alerts/query');
    assert.deepEqual(paramsOf(fx.last), {
      search: 'cpu', severity: ['critical', 'warning'], status: 'FIRING', service: 's', stream: 'st',
      source: 'oo', ruleId: 'r', window: 'now-24h', page: '1', size: '5', sortBy: 'severity', sortDir: 'asc',
    });
    assert.deepEqual(out, { items: [{ id: 1 }], total: 10, page: 1, size: 5, hasMore: true, sortBy: 'severity', sortDir: 'asc' });
  });

  it('fetchAlerts2 defaults a shapeless answer, echoing the requested size', async () => {
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchAlerts2({ size: 25 }), {
      items: [], total: 0, page: 0, size: 25, hasMore: false, sortBy: 'lastFiredAt', sortDir: 'desc',
    });
    assert.deepEqual(paramsOf(fx.last), { page: '0', size: '25' });
  });

  it('fetchLiveAlerts reads /live and surfaces partial and truncated', async () => {
    fx = stubFetch(() => json({ items: [{ name: 'a' }], total: 1, partial: true, truncated: 1, windowStart: 's', windowEnd: 'e', source: 'x' }));
    const out = await api.fetchLiveAlerts({ window: 'now-1h', severity: ['critical'] });
    assert.equal(fx.last.url.pathname, '/api/alerts/query/live');
    assert.deepEqual(paramsOf(fx.last), { window: 'now-1h', severity: 'critical', page: '0', size: '50' });
    assert.deepEqual(out, {
      items: [{ name: 'a' }], total: 1, hasMore: false, source: 'x', partial: true, truncated: true,
      windowStart: 's', windowEnd: 'e',
    });
    fx.restore();
    fx = stubFetch(() => json({}));
    const empty = await api.fetchLiveAlerts();
    assert.equal(empty.source, 'live-stream');
    assert.equal(empty.partial, false);
    assert.equal(empty.windowStart, null);
  });

  it('fetchAlertSummary2 passes the window and returns the body', async () => {
    fx = stubFetch(() => json({ firing: 1 }));
    assert.deepEqual(await api.fetchAlertSummary2({ window: 'now-1h' }), { firing: 1 });
    assert.equal(fx.last.raw, `${BASE}/alerts/query/summary?window=now-1h`);
    await api.fetchAlertSummary2();
    assert.equal(fx.last.raw, `${BASE}/alerts/query/summary`);
  });

  it('fetchAlertFilterOptions defaults every list', async () => {
    fx = stubFetch(() => json({ severities: ['critical'], rules: [{ id: 'r' }] }));
    assert.deepEqual(await api.fetchAlertFilterOptions(), {
      severities: ['critical'], statuses: [], sources: [], services: [], streams: [], rules: [{ id: 'r' }],
    });
    assert.equal(fx.last.url.pathname, '/api/alerts/query/filters');
  });

  it('fetchAlertDetail reads one row by id', async () => {
    fx = stubFetch(() => json({ id: 5, audit: [] }));
    assert.deepEqual(await api.fetchAlertDetail(5), { id: 5, audit: [] });
    assert.equal(fx.last.url.pathname, '/api/alerts/query/5');
    assert.equal(fx.last.method, 'GET');
    assert.equal(fx.last.options.headers, undefined);
  });

  it('transitionAlert POSTs actor and note to /{id}/{action}', async () => {
    fx = stubFetch(() => json({ status: 'CLOSED' }));
    assert.deepEqual(await api.transitionAlert(7, 'close', { actor: 'me', note: 'done' }), { status: 'CLOSED' });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/alerts/query/7/close');
    assert.deepEqual(fx.last.options.headers, JSON_HEADERS);
    assert.deepEqual(fx.last.body, { actor: 'me', note: 'done' });
    await api.transitionAlert(7, 'reopen');
    assert.deepEqual(fx.last.body, { actor: '', note: '' });
  });

  it('bulkTransitionAlerts POSTs to /bulk and resolves on partial success', async () => {
    fx = stubFetch(() => json({ results: [{ id: 1, outcome: 'SKIPPED' }] }));
    const out = await api.bulkTransitionAlerts({ ids: [1, 2], action: 'resolve' });
    assert.equal(fx.last.url.pathname, '/api/alerts/query/bulk');
    assert.deepEqual(fx.last.body, { ids: [1, 2], action: 'resolve', actor: '', note: '' });
    assert.equal(out.results[0].outcome, 'SKIPPED');
  });

  it('treats empty and non-JSON bodies as success and rejects with the backend message', async () => {
    fx = stubFetch(() => text(''));
    assert.deepEqual(await api.transitionAlert(1, 'acknowledge'), { ok: true });
    fx.restore();
    fx = stubFetch(() => text('OK'));
    assert.deepEqual(await api.transitionAlert(1, 'acknowledge'), { ok: true });
    fx.restore();
    fx = stubFetch(() => json({ error: 'not firing' }, 409));
    await assert.rejects(api.transitionAlert(1, 'acknowledge'), { message: 'not firing' });
  });
});

describe('alert ingest', () => {
  it('fetchAlertIngestStatus reads the poller state', async () => {
    fx = stubFetch(() => json({ healthy: true, lastEventAt: 't' }));
    assert.deepEqual(await api.fetchAlertIngestStatus(), { healthy: true, lastEventAt: 't' });
    assert.equal(fx.last.url.pathname, '/api/alerts/notifications/ingest-status');
    fx.restore();
    fx = stubFetch(() => json({ error: 'poller disabled' }, 503));
    await assert.rejects(api.fetchAlertIngestStatus(), { message: 'poller disabled' });
  });

  it('triggerAlertIngest POSTs ingest-now', async () => {
    fx = stubFetch(() => json({ ingested: 3 }));
    assert.deepEqual(await api.triggerAlertIngest(), { ingested: 3 });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/alerts/notifications/ingest-now');
    fx.restore();
    fx = stubFetch(() => json({}, 500));
    await assert.rejects(api.triggerAlertIngest(), /HTTP 500/);
  });
});

describe('Product Catalog', () => {
  it('fetchCatalogCategories returns items', async () => {
    fx = stubFetch(() => json({ items: [{ code: 'DB' }] }));
    assert.deepEqual(await api.fetchCatalogCategories(), { items: [{ code: 'DB' }] });
    assert.equal(fx.last.raw, `${BASE}/product-catalog/categories`);
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchCatalogCategories(), { items: [] });
  });

  it('fetchCatalogResources sends refresh only when true', async () => {
    fx = stubFetch(() => json({ items: [{ id: 1 }], total: 1, org: 'o', filterMode: 'hide' }));
    const out = await api.fetchCatalogResources({ search: 'x', category: 'DB', status: 'ENABLED', refresh: true });
    assert.equal(fx.last.url.pathname, '/api/product-catalog');
    assert.deepEqual(paramsOf(fx.last), { search: 'x', category: 'DB', status: 'ENABLED', refresh: 'true' });
    assert.deepEqual(out, { items: [{ id: 1 }], total: 1, org: 'o', supported: true, filterMode: 'hide' });
    fx.restore();
    fx = stubFetch(() => json({ supported: false }));
    assert.deepEqual(await api.fetchCatalogResources(), {
      items: [], total: 0, org: null, supported: false, filterMode: null,
    });
    assert.equal(fx.last.raw, `${BASE}/product-catalog`);
  });

  it('fetchCatalogResource reads one by encoded id', async () => {
    fx = stubFetch(() => json({ id: 'a b' }));
    assert.deepEqual(await api.fetchCatalogResource('a b'), { id: 'a b' });
    assert.equal(fx.last.url.pathname, '/api/product-catalog/a%20b');
  });

  it('validateCatalogResource POSTs category and name', async () => {
    fx = stubFetch(() => json({ found: false }));
    assert.deepEqual(await api.validateCatalogResource({ category: 'DB', resourceName: 'pg' }), { found: false });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/product-catalog/validate');
    assert.deepEqual(fx.last.body, { category: 'DB', resourceName: 'pg' });
    assert.deepEqual(fx.last.options.headers, JSON_HEADERS);
  });

  it('fetchCatalogProducts filters by category only when given', async () => {
    fx = stubFetch(() => json({ items: [{ code: 'P' }], total: 1 }));
    assert.deepEqual(await api.fetchCatalogProducts(), { items: [{ code: 'P' }], total: 1, supported: true });
    assert.equal(fx.last.raw, `${BASE}/product-catalog/products`);
    await api.fetchCatalogProducts({ category: 'APP' });
    assert.deepEqual(paramsOf(fx.last), { category: 'APP' });
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchCatalogProducts(), { items: [], total: 0, supported: true });
  });

  it('registerCatalogResource omits empty product, version and status', async () => {
    fx = stubFetch(() => json({ id: 1 }));
    await api.registerCatalogResource({ category: 'DB', resourceName: 'pg', product: '', version: '', status: '' });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/product-catalog/register');
    assert.deepEqual(fx.last.body, { category: 'DB', resourceName: 'pg' });
    await api.registerCatalogResource({ category: 'APP', resourceName: 'svc', product: 'P', version: '1', status: 'DISABLED' });
    assert.deepEqual(fx.last.body, { category: 'APP', resourceName: 'svc', product: 'P', version: '1', status: 'DISABLED' });
  });

  for (const [fn, method, suffix] of [
    ['enableCatalogResource', 'PATCH', '/enable'],
    ['disableCatalogResource', 'PATCH', '/disable'],
    ['removeCatalogResource', 'DELETE', ''],
  ]) {
    it(`${fn} sends ${method} with no body`, async () => {
      fx = stubFetch(() => text(''));
      assert.deepEqual(await api[fn]('r/1'), { ok: true });
      assert.equal(fx.last.method, method);
      assert.equal(fx.last.url.pathname, `/api/product-catalog/r%2F1${suffix}`);
      assert.equal(fx.last.options.body, undefined);
      assert.equal(fx.last.options.headers, undefined);
    });
  }

  it('returns {ok:true} for a non-JSON body and rejects with the explanation', async () => {
    fx = stubFetch(() => text('fine'));
    assert.deepEqual(await api.enableCatalogResource('1'), { ok: true });
    fx.restore();
    fx = stubFetch(() => json({ error: 'already registered under Databases' }, 409));
    await assert.rejects(api.registerCatalogResource({ category: 'DB', resourceName: 'x' }),
      { message: 'already registered under Databases' });
  });
});

describe('Analytics Dashboard', () => {
  it('fetchAnalyticsScope returns categories and the empty-catalog flag', async () => {
    fx = stubFetch(() => json({ categories: [{ code: 'DB' }], catalogEmpty: 0 }));
    assert.deepEqual(await api.fetchAnalyticsScope(), { categories: [{ code: 'DB' }], catalogEmpty: false });
    assert.equal(fx.last.url.pathname, '/api/analytics/scope');
    fx.restore();
    fx = stubFetch(() => json({ catalogEmpty: true }));
    assert.deepEqual(await api.fetchAnalyticsScope(), { categories: [], catalogEmpty: true });
    fx.restore();
    fx = stubFetch(() => json({ error: 'catalog offline' }, 500));
    await assert.rejects(api.fetchAnalyticsScope(), { message: 'catalog offline' });
  });

  it('fetchAnalyticsLogCounts sends only the supplied drill params', async () => {
    fx = stubFetch(() => json({
      level: 'MICROSERVICE', items: [{ key: 'a' }], totals: { total: 1 }, category: 'APP',
      categoryLabel: 'Apps', product: 'P', productLabel: 'Prod', window: 'now-1h',
      windowStart: 's', windowEnd: 'e', complete: false, catalogEmpty: false, supported: true, message: 'm',
    }));
    const out = await api.fetchAnalyticsLogCounts({ category: 'APP', product: 'P', window: 'now-1h', level: 'microservice' });
    assert.equal(fx.last.url.pathname, '/api/analytics/log-counts');
    assert.deepEqual(paramsOf(fx.last), { category: 'APP', product: 'P', window: 'now-1h', level: 'microservice' });
    assert.equal(out.level, 'MICROSERVICE');
    assert.equal(out.complete, false);
    assert.equal(out.productLabel, 'Prod');
    assert.equal(out.message, 'm');
  });

  it('fetchAnalyticsLogCounts defaults to the category level with an unqueried URL', async () => {
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchAnalyticsLogCounts(), {
      level: 'CATEGORY', items: [], totals: null, category: null, categoryLabel: null, product: null,
      productLabel: null, window: null, windowStart: null, windowEnd: null, complete: true,
      catalogEmpty: false, supported: true, message: '',
    });
    assert.equal(fx.last.raw, `${BASE}/analytics/log-counts`);
  });

  it('fetchAnalyticsLogCounts surfaces the backend\'s 400 explanation', async () => {
    fx = stubFetch(() => json({ error: 'category is required when product is supplied' }, 400));
    await assert.rejects(api.fetchAnalyticsLogCounts({ product: 'P' }),
      { message: 'category is required when product is supplied' });
  });
});

describe('Real User Monitoring', () => {
  const META = { supported: true, message: '', org: '', window: '', windowStart: null, windowEnd: null, partial: false };

  it('fetchRumScope omits <ALL> and normalises meta', async () => {
    fx = stubFetch(() => json({
      meta: { supported: false, message: 'm', org: 'o', window: 'now-1h', windowStart: 's', windowEnd: 'e', partial: 1 },
      services: ['web'], environments: ['prod'], versions: ['1'], applications: ['app'],
    }));
    const out = await api.fetchRumScope({ window: 'now-1h' });
    assert.equal(fx.last.raw, `${BASE}/rum/scope?window=now-1h`);
    assert.deepEqual(out, {
      meta: { supported: false, message: 'm', org: 'o', window: 'now-1h', windowStart: 's', windowEnd: 'e', partial: true },
      services: ['web'], environments: ['prod'], versions: ['1'], applications: ['app'],
    });
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await api.fetchRumScope({ window: '<ALL>' }), {
      meta: META, services: [], environments: [], versions: [], applications: [],
    });
    assert.equal(fx.last.raw, `${BASE}/rum/scope`);
  });

  it('fetchRumPerformance sends every set filter and defaults counters to 0', async () => {
    fx = stubFetch(() => json({ vitals: [{ name: 'LCP' }], counts: { totalErrors: 3 }, api: [{ url: '/x' }] }));
    const out = await api.fetchRumPerformance({ window: 'now-1h', service: 'web', env: '<ALL>', version: '2' });
    assert.equal(fx.last.url.pathname, '/api/rum/performance');
    assert.deepEqual(paramsOf(fx.last), { window: 'now-1h', service: 'web', version: '2' });
    assert.deepEqual(out, {
      meta: META, vitals: [{ name: 'LCP' }],
      counts: { totalErrors: 3, unhandledErrors: 0, sessionsWithErrors: 0, totalSessions: 0 },
      api: [{ url: '/x' }],
    });
    fx.restore();
    fx = stubFetch(() => json({}));
    const empty = await api.fetchRumPerformance();
    assert.equal(fx.last.raw, `${BASE}/rum/performance`);
    assert.deepEqual(empty.vitals, []);
    assert.deepEqual(empty.api, []);
  });

  it('fetchRumSessions always sends paging and keeps medians null when absent', async () => {
    fx = stubFetch(() => json({ summary: { sessions: 4, bounceRatePct: 25 }, items: [{ id: 's' }], total: 4 }));
    const out = await api.fetchRumSessions({ env: 'prod', page: 2, size: 10 });
    assert.deepEqual(paramsOf(fx.last), { env: 'prod', page: '2', size: '10' });
    assert.deepEqual(out, {
      meta: META,
      summary: { sessions: 4, withErrors: 0, frustrated: 0, medianDurationMs: null, bounceRatePct: 25 },
      items: [{ id: 's' }], total: 4,
    });
    fx.restore();
    fx = stubFetch(() => json({}));
    const empty = await api.fetchRumSessions();
    assert.deepEqual(paramsOf(fx.last), { page: '0', size: '50' });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.total, 0);
  });

  it('fetchRumErrors sends handling unless "all"', async () => {
    fx = stubFetch(() => json({
      summary: { totalErrors: 5, crashFreeSessionsPct: 99.5 }, series: [{ t: 1 }], items: [{ issue: 'x' }], total: 1,
    }));
    const out = await api.fetchRumErrors({ handling: 'unhandled', service: 'web' });
    assert.equal(fx.last.url.pathname, '/api/rum/errors');
    assert.deepEqual(paramsOf(fx.last), { service: 'web', handling: 'unhandled', page: '0', size: '50' });
    assert.deepEqual(out, {
      meta: META,
      summary: { totalErrors: 5, uniqueIssues: 0, usersAffected: 0, sessionsAffected: 0, totalSessions: 0, crashFreeSessionsPct: 99.5 },
      series: [{ t: 1 }], items: [{ issue: 'x' }], total: 1,
    });
    fx.restore();
    fx = stubFetch(() => json({}));
    const empty = await api.fetchRumErrors({ handling: 'all' });
    assert.equal(fx.last.url.searchParams.has('handling'), false);
    assert.equal(empty.summary.crashFreeSessionsPct, null);
    assert.deepEqual(empty.series, []);
  });

  for (const fn of ['fetchRumScope', 'fetchRumPerformance', 'fetchRumSessions', 'fetchRumErrors']) {
    it(`${fn} rejects with the backend message`, async () => {
      fx = stubFetch(() => json({ error: 'rum stream missing' }, 404));
      await assert.rejects(api[fn](), { message: 'rum stream missing' });
    });
  }
});
