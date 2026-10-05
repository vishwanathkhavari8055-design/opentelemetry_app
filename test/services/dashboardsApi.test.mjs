/**
 * Guards the Dashboard Catalog client (src/services/dashboardsApi.js) — the whole
 * surface the browser has onto Grafana, because the Grafana token lives on the
 * backend and nowhere else.
 *
 * Pinned: every call goes to `/api/dashboards/...` under the SAME base and org as
 * the telemetry client (a second copy of either would ignore setApiBase/setOrg in
 * the embedded build), empty params are dropped, writes send JSON with the right
 * verb, a 204 from a proxy is not a parse failure, and a failure carries the
 * backend's own sentence plus `.status` so a caller can branch on 404 vs 409.
 * runDashboardQuery must pass the abort signal through — without it a panel can
 * not cancel its query when the time range changes.
 *
 * fetch is stubbed per test (./fetchStub.mjs) and restored afterwards.
 */

import '../support/dom.mjs';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { json, paramsOf, stubFetch, text } from './fetchStub.mjs';

const { setApiBase, setOrg } = await import('../../src/services/api.js');
const dash = await import('../../src/services/dashboardsApi.js');

const BASE = 'http://api.test/api';
let fx;

beforeEach(() => {
  setApiBase(`${BASE}/`);
  setOrg('');
});

afterEach(() => {
  fx?.restore();
  fx = undefined;
  setOrg('');
});

describe('reads', () => {
  it('fetchDashboardHealth reads /dashboards/health under the shared base', async () => {
    fx = stubFetch(() => json({ configured: true }));
    const signal = new AbortController().signal;
    assert.deepEqual(await dash.fetchDashboardHealth({ signal }), { configured: true });
    assert.equal(fx.last.raw, `${BASE}/dashboards/health`);
    assert.equal(fx.last.options.signal, signal);
  });

  it('fetchDashboardRegistrations sends enabledOnly only when true', async () => {
    fx = stubFetch(() => json([]));
    await dash.fetchDashboardRegistrations();
    assert.equal(fx.last.raw, `${BASE}/dashboards/registry`);
    await dash.fetchDashboardRegistrations({ enabledOnly: true, folderUid: 'f1' });
    assert.deepEqual(paramsOf(fx.last), { enabledOnly: 'true', folderUid: 'f1' });
    assert.equal(fx.last.url.searchParams.has('signal'), false);
  });

  it('reads folder tiles, Grafana folders and registerable dashboards', async () => {
    fx = stubFetch(() => json({ ok: 1 }));
    await dash.fetchDashboardFolderTiles();
    assert.equal(fx.last.url.pathname, '/api/dashboards/registry/folder-summary');
    await dash.fetchGrafanaFolders();
    assert.equal(fx.last.url.pathname, '/api/dashboards/folders');
    await dash.fetchRegisterableDashboards({ folderUid: 'f', query: 'cpu' });
    assert.equal(fx.last.url.pathname, '/api/dashboards/available');
    assert.deepEqual(paramsOf(fx.last), { folderUid: 'f', query: 'cpu' });
    await dash.fetchRegisterableDashboards();
    assert.equal(fx.last.url.search, '');
  });

  it('fetchDashboardDefinition encodes the uid', async () => {
    fx = stubFetch(() => json({ dashboard: { uid: 'a/b' } }));
    assert.deepEqual(await dash.fetchDashboardDefinition('a/b'), { dashboard: { uid: 'a/b' } });
    assert.equal(fx.last.url.pathname, '/api/dashboards/registry/a%2Fb/definition');
  });

  it('fetchDashboardDatasources returns items, or [] for any other shape', async () => {
    fx = stubFetch(() => json({ items: [{ uid: 'p', name: 'Prom', type: 'prometheus' }] }));
    assert.deepEqual(await dash.fetchDashboardDatasources({ type: 'prometheus' }),
      [{ uid: 'p', name: 'Prom', type: 'prometheus' }]);
    assert.deepEqual(paramsOf(fx.last), { type: 'prometheus' });
    fx.restore();
    fx = stubFetch(() => json({}));
    assert.deepEqual(await dash.fetchDashboardDatasources(), []);
  });

  it('fetchDashboardLabelValues sends label, metric and range', async () => {
    fx = stubFetch(() => json({ values: ['a', 'b'] }));
    const out = await dash.fetchDashboardLabelValues({ uid: 'p 1', label: 'job', metric: 'up', from: '1', to: '2' });
    assert.equal(fx.last.url.pathname, '/api/dashboards/datasources/p%201/label-values');
    assert.deepEqual(paramsOf(fx.last), { label: 'job', metric: 'up', from: '1', to: '2' });
    assert.deepEqual(out, ['a', 'b']);
    fx.restore();
    fx = stubFetch(() => json({ values: 'x' }));
    assert.deepEqual(await dash.fetchDashboardLabelValues({ uid: 'p', label: 'job' }), []);
    assert.deepEqual(paramsOf(fx.last), { label: 'job' });
  });
});

describe('organization', () => {
  it('appends the active org with ? or & as the URL needs', async () => {
    setOrg('DLH');
    fx = stubFetch(() => json({}));
    await dash.fetchDashboardHealth();
    assert.equal(fx.last.raw, `${BASE}/dashboards/health?org=DLH`);
    await dash.fetchDashboardRegistrations({ enabledOnly: true });
    assert.equal(fx.last.raw, `${BASE}/dashboards/registry?enabledOnly=true&org=DLH`);
    await dash.unregisterDashboard('u');
    assert.equal(fx.last.raw, `${BASE}/dashboards/registry/u?org=DLH`);
  });
});

describe('writes', () => {
  it('registerDashboard POSTs the registration as JSON', async () => {
    fx = stubFetch(() => json({ uid: 'u' }));
    const out = await dash.registerDashboard({ uid: 'u', folderUid: 'f', enabled: true, displayOrder: 2 });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/dashboards/registry');
    assert.deepEqual(fx.last.options.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(fx.last.body, { uid: 'u', folderUid: 'f', enabled: true, displayOrder: 2 });
    assert.deepEqual(out, { uid: 'u' });
  });

  it('updateDashboardRegistration PATCHes only the supplied fields', async () => {
    fx = stubFetch(() => json({}));
    await dash.updateDashboardRegistration('u/1', { enabled: false });
    assert.equal(fx.last.method, 'PATCH');
    assert.equal(fx.last.url.pathname, '/api/dashboards/registry/u%2F1');
    assert.deepEqual(fx.last.body, { enabled: false });
    await dash.updateDashboardRegistration('u');
    assert.deepEqual(fx.last.body, {});
  });

  it('syncDashboardRegistration POSTs /refresh with no body', async () => {
    fx = stubFetch(() => json({ title: 't' }));
    assert.deepEqual(await dash.syncDashboardRegistration('u'), { title: 't' });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/dashboards/registry/u/refresh');
    assert.equal(fx.last.options.body, undefined);
  });

  it('unregisterDashboard DELETEs and treats an empty body as {}', async () => {
    fx = stubFetch(() => new Response(null, { status: 204 }));
    assert.deepEqual(await dash.unregisterDashboard('u'), {});
    assert.equal(fx.last.method, 'DELETE');
  });
});

describe('failures', () => {
  it('carry the backend sentence and the status', async () => {
    fx = stubFetch(() => json({ error: "No dashboard with UID 'x' exists in Grafana" }, 404));
    await assert.rejects(dash.registerDashboard({ uid: 'x' }), (err) => {
      assert.equal(err.message, "No dashboard with UID 'x' exists in Grafana");
      assert.equal(err.status, 404);
      return true;
    });
  });

  it('fall back to message, then to the status for a non-JSON body', async () => {
    fx = stubFetch(() => json({ message: 'already registered' }, 409));
    await assert.rejects(dash.fetchDashboardRegistrations(), { message: 'already registered', status: 409 });
    fx.restore();
    fx = stubFetch(() => text('<html>bad gateway</html>', 502));
    await assert.rejects(dash.fetchGrafanaFolders(), { message: 'Request failed (HTTP 502)', status: 502 });
  });
});

describe('runDashboardQuery', () => {
  it('POSTs the ds/query payload with the signal and unwraps results', async () => {
    const payload = { from: '1', to: '2', queries: [{ refId: 'A', expr: 'up' }] };
    const controller = new AbortController();
    fx = stubFetch(() => json({ results: { A: { frames: [] } }, envelope: 'dropped' }));
    const out = await dash.runDashboardQuery(payload, { signal: controller.signal });
    assert.equal(fx.last.method, 'POST');
    assert.equal(fx.last.url.pathname, '/api/dashboards/query');
    assert.deepEqual(fx.last.body, payload);
    assert.equal(fx.last.options.signal, controller.signal);
    assert.deepEqual(out, { results: { A: { frames: [] } } });
  });

  it('answers empty results for a body without them', async () => {
    fx = stubFetch(() => json(null));
    assert.deepEqual(await dash.runDashboardQuery({}), { results: {} });
  });

  it('rejects with the backend message', async () => {
    fx = stubFetch(() => json({ error: 'datasource not found' }, 400));
    await assert.rejects(dash.runDashboardQuery({}), { message: 'datasource not found', status: 400 });
  });
});
