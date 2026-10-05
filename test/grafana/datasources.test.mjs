/**
 * Guards how a dashboard's datasource references become concrete `{ uid, type }`
 * pairs, and that every one of them gets a registered proxy.
 *
 * A reference that resolves to the wrong uid does not fail — its panel quietly
 * queries a datasource that answers with nothing. So these pin the awkward forms
 * Grafana allows (a bare NAME, `${DS_X}`, a missing reference, an empty variable
 * with several candidates of its type), the derived per-dashboard default, the
 * sentinels that must never be proxied, and the catalog cache that decides when
 * a renamed datasource starts resolving.
 */
import './grafanaEnv.mjs';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { stubFetch } from '../support/fetch.mjs';
import { capturing } from './grafanaEnv.mjs';

const { sceneUtils } = await import('@grafana/scenes');
const { ProxyDataSource } = await import('../../src/grafana/ProxyDataSource.js');
const ds = await import('../../src/grafana/datasources.js');

const CATALOG = [
  { uid: 'prom-b', name: 'Prometheus B', type: 'prometheus' },
  { uid: 'prom-a', name: 'Prometheus A', type: 'prometheus' },
  { uid: 'inf-2', name: 'yesoreyeram-infinity-datasource', type: 'yesoreyeram-infinity-datasource' },
  { uid: 'inf-1', name: 'OpenObserve', type: 'yesoreyeram-infinity-datasource' },
  { uid: 'loki-1', name: 'Loki', type: 'loki' },
];

// The catalog is cached for CATALOG_MAX_AGE_MS. Each test moves a fake clock past
// that so it sees the catalog it stubbed, not the previous test's.
let clock = 1_000_000_000;
let fetchStub;
const serveCatalog = (answer) => {
  fetchStub?.restore();
  fetchStub = stubFetch([[/\/dashboards\/datasources/, answer]]);
  return fetchStub;
};

describe('datasources', () => {
  beforeEach(() => {
    clock += ds.CATALOG_MAX_AGE_MS * 10;
    mock.method(Date, 'now', () => clock);
  });
  afterEach(() => {
    fetchStub?.restore();
    fetchStub = undefined;
    mock.restoreAll();
  });

  describe('reference predicates', () => {
    it('recognises expression uids in both string and object form', () => {
      assert.equal(ds.isExpressionRef('__expr__'), true);
      assert.equal(ds.isExpressionRef({ uid: '-100' }), true);
      assert.equal(ds.isExpressionRef({ uid: 'prom-a' }), false);
      assert.equal(ds.isExpressionRef(null), false);
    });

    it("treats Grafana's own built-in datasource as unqueryable, by uid or by type", () => {
      assert.equal(ds.isBuiltInRef('grafana'), true);
      assert.equal(ds.isBuiltInRef({ uid: '-- Grafana --' }), true);
      assert.equal(ds.isBuiltInRef({ type: 'datasource', uid: 'anything' }), true);
      assert.equal(ds.isBuiltInRef({ type: 'prometheus', uid: 'prom-a' }), false);
      assert.equal(ds.isBuiltInRef(undefined), false);
      assert.equal(ds.isUnqueryableRef({ uid: '__expr__' }), true);
      assert.equal(ds.isUnqueryableRef('grafana'), true);
      assert.equal(ds.isUnqueryableRef({ uid: 'prom-a', type: 'prometheus' }), false);
    });
  });

  describe('proxy registry', () => {
    it('creates one proxy per uid, registers it with Scenes, and reuses it', () => {
      const first = ds.getProxyDataSource('reg-one', 'loki');
      assert.equal(first.uid, 'reg-one');
      assert.equal(first.type, 'loki');
      assert.equal(ds.getProxyDataSource('reg-one', 'prometheus'), first);
      assert.ok(ds.knownProxies().includes(first));
    });

    it('defaults the plugin type to prometheus when none is given', () => {
      assert.equal(ds.getProxyDataSource('reg-untyped', '').type, ds.DEFAULT_DS_TYPE);
    });

    it('keeps working when something else already registered the uid', async () => {
      sceneUtils.registerRuntimeDataSource({ dataSource: new ProxyDataSource('loki', 'reg-taken') });
      let proxy;
      const warned = await capturing('warn', () => { proxy = ds.getProxyDataSource('reg-taken', 'loki'); });
      assert.equal(proxy.uid, 'reg-taken');
      assert.match(warned.join('\n'), /"reg-taken" was already registered/);
    });

    it('gives the mixed proxy the meta.mixed flag Scenes reads', () => {
      const mixed = ds.getMixedProxyDataSource();
      assert.equal(mixed.uid, ds.MIXED_DS_UID);
      assert.equal(mixed.meta.mixed, true);
      assert.equal(ds.getMixedProxyDataSource(), mixed);
    });
  });

  describe('createDataSourceSrv', () => {
    it('resolves by uid through the same proxy map', async () => {
      const srv = ds.createDataSourceSrv();
      const proxy = await srv.get({ uid: 'srv-one', type: 'loki' });
      assert.equal(proxy, ds.getProxyDataSource('srv-one'));
      assert.equal(await srv.get('srv-one'), proxy);
    });

    it('rejects a request for "the default" — there is none', async () => {
      await assert.rejects(ds.createDataSourceSrv().get(undefined), /No datasource reference given/);
    });

    it('describes only proxies it knows', () => {
      const srv = ds.createDataSourceSrv();
      ds.getProxyDataSource('srv-known', 'loki');
      const settings = srv.getInstanceSettings({ uid: 'srv-known' });
      assert.equal(settings.uid, 'srv-known');
      assert.equal(settings.type, 'loki');
      assert.deepEqual(settings.jsonData, {});
      assert.equal(srv.getInstanceSettings('never-seen'), undefined);
      assert.equal(srv.getInstanceSettings(null), undefined);
      assert.ok(srv.getList().some((d) => d.uid === 'srv-known' && d.type === 'loki'));
      assert.doesNotThrow(() => srv.reload());
    });
  });

  describe('loadDatasourceCatalog', () => {
    it('shares one request between concurrent callers and caches within the max age', async () => {
      const { calls } = serveCatalog({ items: CATALOG });
      const [a, b] = await Promise.all([ds.loadDatasourceCatalog(), ds.loadDatasourceCatalog()]);
      assert.deepEqual(a, CATALOG);
      assert.equal(a, b);
      clock += 1000;
      await ds.loadDatasourceCatalog();
      assert.equal(calls.length, 1);
    });

    it('refetches once the cache is older than the max age', async () => {
      const { calls } = serveCatalog({ items: CATALOG });
      await ds.loadDatasourceCatalog();
      clock += ds.CATALOG_MAX_AGE_MS + 1;
      await ds.loadDatasourceCatalog();
      assert.equal(calls.length, 2);
    });

    it('treats a non-array body as an empty catalog', async () => {
      serveCatalog({ items: 'nope' });
      assert.deepEqual(await ds.loadDatasourceCatalog(), []);
    });

    it('answers the last good catalog when a refetch fails, and retries next time', async () => {
      serveCatalog({ items: CATALOG });
      await ds.loadDatasourceCatalog();
      clock += ds.CATALOG_MAX_AGE_MS + 1;
      const { calls } = serveCatalog({ status: 500, body: { message: 'down' } });
      let answer;
      const warned = await capturing('warn', async () => { answer = await ds.loadDatasourceCatalog(); });
      assert.deepEqual(answer, CATALOG);
      assert.match(warned.join('\n'), /could not load the datasource catalog/);
      // catalogFetchedAt was reset, so the very next call goes out again.
      await capturing('warn', () => ds.loadDatasourceCatalog());
      assert.equal(calls.length, 2);
    });
  });

  describe('prepareDashboardDatasources', () => {
    const prepare = async (dashboard, catalog = CATALOG) => {
      serveCatalog({ items: catalog });
      let result;
      const warned = await capturing('warn', async () => {
        result = await ds.prepareDashboardDatasources(dashboard);
      });
      return { ...result, warned: warned.join('\n') };
    };

    it("derives the default from the dashboard's own first concrete reference", async () => {
      const { defaultRef, resolve } = await prepare({
        panels: [
          { datasource: { uid: '${DS_PROM}' } },
          { datasource: { uid: '-- Mixed --' } },
          { datasource: { uid: '__expr__' } },
          { datasource: { uid: 'loki-1' } },
        ],
      });
      assert.deepEqual(defaultRef, { uid: 'loki-1', type: 'loki' });
      assert.deepEqual(resolve(undefined), defaultRef);
      assert.deepEqual(resolve(null), defaultRef);
      assert.deepEqual(resolve(''), defaultRef);
    });

    it('labels a concrete reference with no type and no catalog entry as prometheus', async () => {
      const { defaultRef } = await prepare({ panels: [{ datasource: { uid: 'unknown-uid' } }] });
      assert.deepEqual(defaultRef, { uid: 'unknown-uid', type: 'prometheus' });
    });

    it('falls back to a Prometheus from the catalog, chosen by name not by order', async () => {
      const { defaultRef } = await prepare({ panels: [] });
      assert.deepEqual(defaultRef, { uid: 'prom-a', type: 'prometheus' });
    });

    it("falls back to the catalog's first entry when it has no Prometheus", async () => {
      const { defaultRef } = await prepare({}, [{ uid: 'loki-1', name: 'Loki', type: 'loki' }]);
      assert.deepEqual(defaultRef, { uid: 'loki-1', type: 'loki' });
    });

    it('has no default at all — rather than an invented uid — with an empty catalog', async () => {
      const { defaultRef, resolve, unresolved, warned } = await prepare(
        { panels: [{ datasource: 'Nope' }] }, [],
      );
      assert.equal(defaultRef, null);
      assert.equal(resolve('Nope'), null);
      assert.deepEqual(unresolved, ['Nope']);
      assert.match(warned, /could not resolve Nope — falling back to no datasource/);
    });

    it('resolves a legacy bare NAME, and a bare uid, through the catalog', async () => {
      const { resolve } = await prepare({});
      assert.deepEqual(resolve('OpenObserve'), { uid: 'inf-1', type: 'yesoreyeram-infinity-datasource' });
      assert.deepEqual(resolve('loki-1'), { uid: 'loki-1', type: 'loki' });
    });

    it("resolves ${DS_X} through the datasource variable's saved value (uid or name)", async () => {
      const { resolve } = await prepare({
        templating: {
          list: [
            { type: 'datasource', name: 'DS_PROM', query: 'prometheus', current: { value: 'prom-b' } },
            { type: 'datasource', name: 'DS_LOG', query: 'loki', current: { text: 'Loki' } },
          ],
        },
      });
      assert.deepEqual(resolve('${DS_PROM}'), { uid: 'prom-b', type: 'prometheus' });
      assert.deepEqual(resolve('$DS_PROM'), { uid: 'prom-b', type: 'prometheus' });
      assert.deepEqual(resolve({ uid: '${DS_LOG}' }), { uid: 'loki-1', type: 'loki' });
    });

    it('picks a variable with no saved value by type, deterministically, and says so', async () => {
      const { resolve, warned } = await prepare({
        templating: {
          list: [{
            type: 'datasource', name: 'DS_INFINITY',
            query: { type: 'yesoreyeram-infinity-datasource' }, current: {},
          }],
        },
        panels: [{ datasource: { uid: '${DS_INFINITY}' } }],
      });
      // "OpenObserve" sorts before "yesoreyeram-…", whichever order the catalog came in.
      assert.deepEqual(resolve({ uid: '${DS_INFINITY}' }), { uid: 'inf-1', type: 'yesoreyeram-infinity-datasource' });
      assert.match(warned, /has 2 datasources and the dashboard saved no selection — using "OpenObserve" \(inf-1\)/);
    });

    it("falls back on a templated object ref's own type when no variable matches", async () => {
      const { resolve, unresolved } = await prepare({});
      assert.deepEqual(resolve({ uid: '${DS_NONE}', type: 'loki' }), { uid: 'loki-1', type: 'loki' });
      assert.deepEqual(unresolved, []);
    });

    it('records what nothing matched and sends it to the default', async () => {
      const { resolve, defaultRef, unresolved, warned } = await prepare({
        panels: [
          { datasource: { uid: 'loki-1', type: 'loki' } },
          { datasource: '${DS_MISSING}' },
          { targets: [{ datasource: { uid: '$DS_GONE' } }, { datasource: 'No Such Name' }] },
        ],
      });
      assert.deepEqual(resolve('${DS_MISSING}'), defaultRef);
      assert.deepEqual(new Set(unresolved), new Set(['${DS_MISSING}', '$DS_GONE', 'No Such Name']));
      assert.match(warned, /falling back to loki-1/);
    });

    it('resolves an object ref with only a type to a datasource of that type', async () => {
      const { resolve, defaultRef } = await prepare({});
      assert.deepEqual(resolve({ type: 'loki' }), { uid: 'loki-1', type: 'loki' });
      assert.deepEqual(resolve({ type: 'druid' }), defaultRef);
      assert.deepEqual(resolve({ uid: '' }), defaultRef);
    });

    it('passes mixed and unqueryable references through, marked', async () => {
      const { resolve } = await prepare({});
      assert.deepEqual(resolve({ uid: '-- Mixed --' }), { uid: '-- Mixed --', type: 'mixed', mixed: true });
      assert.deepEqual(resolve({ uid: '__expr__', type: '__expr__' }), { uid: '__expr__', type: '__expr__', unqueryable: true });
      assert.deepEqual(resolve('grafana'), { uid: 'grafana', type: '__expr__', unqueryable: true });
      assert.deepEqual(resolve({ uid: 'prom-a' }), { uid: 'prom-a', type: 'prometheus' });
      assert.deepEqual(resolve({ uid: 'prom-a', type: 'custom' }), { uid: 'prom-a', type: 'custom' });
    });

    it('registers a proxy for every reachable uid — panels, targets, collapsed rows, variables, annotations', async () => {
      await prepare({
        panels: [
          { datasource: { uid: 'reach-panel', type: 'loki' } },
          { type: 'row', collapsed: true, panels: [{ targets: [{ datasource: { uid: 'reach-row' } }] }] },
          { targets: [{ datasource: { uid: '__expr__' } }, { datasource: { uid: 'grafana' } }] },
          { datasource: { uid: '-- Mixed --' } },
        ],
        templating: { list: [{ type: 'query', name: 'x', datasource: { uid: 'reach-var' } }] },
        annotations: { list: [{ datasource: { uid: 'reach-ann' } }] },
      });
      const uids = new Set(ds.knownProxies().map((p) => p.uid));
      for (const uid of ['reach-panel', 'reach-row', 'reach-var', 'reach-ann']) {
        assert.ok(uids.has(uid), `${uid} has a proxy`);
      }
      assert.equal(uids.has('__expr__'), false);
      assert.equal(uids.has('grafana'), false);
    });
  });
});
