/**
 * Guards the one function that turns ANY Grafana dashboard JSON into a Scenes
 * tree: what each panel becomes, where it sits, what it queries and through
 * which datasource, and which variables exist to interpolate those queries.
 *
 * Every rule here fails quietly in the app rather than loudly — a collapsed row
 * that adopts the next row's panels, a mixed panel whose targets all go to one
 * datasource, a text panel that fires its vestigial target, a variable set that
 * loses its `$__all` — so each is pinned against the real @grafana/scenes
 * objects the builder produces.
 */
import './grafanaEnv.mjs';
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { stubFetch } from '../support/fetch.mjs';
import { capturing } from './grafanaEnv.mjs';

const scenes = await import('@grafana/scenes');
const { VariableHide } = await import('@grafana/data');
const {
  buildDashboardScene, buildDashboardSceneAsync, sceneTimeRangeOf,
} = await import('../../src/grafana/buildScene.js');
const { MIXED_DS_UID, knownProxies, CATALOG_MAX_AGE_MS } = await import('../../src/grafana/datasources.js');
const { UNSUPPORTED_PLUGIN_ID } = await import('../../src/grafana/panelsExtra.jsx');
const { DYNAMIC_TEXT_PLUGIN_ID } = await import('../../src/grafana/panelDynamicText.jsx');
const { AWAITS_QUERY_OPTION } = await import('../../src/grafana/panelAnswer.js');
const { InterpolatingQueryRunner } = await import('../../src/grafana/queryRunner.js');
const { PROM_DEFAULT_MIN_INTERVAL, PROM_MIN_INTERVAL_TIERS } = await import('../../src/grafana/minInterval.js');

const PROM = { uid: 'bs-prom', type: 'prometheus' };
const INF = { uid: 'bs-inf', type: 'yesoreyeram-infinity-datasource' };

/** A resolver shaped like prepareDashboardDatasources()'s, over explicit refs only. */
const resolver = (defaultRef = PROM) => ({
  defaultRef,
  resolve: (ref) => {
    if (ref == null) return defaultRef;
    if (typeof ref === 'string') return ref === '__expr__' ? { uid: ref, unqueryable: true } : defaultRef;
    if (ref.uid === '-- Mixed --') return { uid: ref.uid, type: 'mixed', mixed: true };
    return { uid: ref.uid, type: ref.type || 'prometheus' };
  },
});

/** Build quietly: the builder logs unsupported plugins, repeats and skipped variables. */
async function build(dashboard, ds = resolver()) {
  let scene;
  const logs = {};
  for (const level of ['warn', 'info', 'error']) logs[level] = [];
  const originals = {};
  for (const level of Object.keys(logs)) {
    originals[level] = console[level];
    console[level] = (...args) => logs[level].push(args.map(String).join(' '));
  }
  try {
    scene = buildDashboardScene(dashboard, ds);
  } finally {
    Object.assign(console, originals);
  }
  return { scene, logs };
}

const gridChildren = (scene) => scene.state.body.state.children;
const vizOf = (item) => item.state.body;
const firstViz = async (panel, ds) => {
  const { scene, logs } = await build({ panels: [panel] }, ds);
  return { viz: vizOf(gridChildren(scene)[0]), item: gridChildren(scene)[0], logs };
};
const runnerOf = (viz) => {
  const data = viz.state.$data;
  return data instanceof scenes.SceneDataTransformer ? data.state.$data : data;
};

describe('buildDashboardScene', () => {
  afterEach(() => mock.restoreAll());

  describe('input validation', () => {
    it('rejects anything that is not an object', () => {
      assert.throws(() => buildDashboardScene(null), /expected an object/);
      assert.throws(() => buildDashboardScene('dash'), /expected an object/);
    });

    it('rejects a panels value that is not an array', () => {
      assert.throws(() => buildDashboardScene({ panels: {} }), /"panels" must be an array/);
    });
  });

  describe('the scene', () => {
    it("takes its time range, zone and week start from the dashboard", async () => {
      const { scene } = await build({
        uid: 'u1', title: 'T', time: { from: 'now-1h', to: 'now-5m' },
        timezone: 'utc', weekStart: 'monday', refresh: '30s',
      });
      const range = sceneTimeRangeOf(scene);
      assert.ok(range instanceof scenes.SceneTimeRange);
      assert.equal(range, scene.__timeRange);
      assert.equal(range.state.from, 'now-1h');
      assert.equal(range.state.to, 'now-5m');
      assert.equal(range.state.timeZone, 'utc');
      assert.equal(range.state.weekStart, 'monday');
      assert.equal(scene.__dashboardUid, 'u1');
      assert.equal(scene.__dashboardTitle, 'T');
      assert.deepEqual(scene.__defaultTime, { from: 'now-1h', to: 'now-5m' });
      assert.equal(scene.__defaultRefresh, '30s');
    });

    it('defaults to the last six hours with no refresh and a read-only, lazy grid', async () => {
      const { scene } = await build({ timezone: '' });
      assert.deepEqual(scene.__defaultTime, { from: 'now-6h', to: 'now' });
      assert.equal(scene.__defaultRefresh, '');
      assert.equal(scene.state.$variables, undefined);
      assert.equal(scene.state.controls, undefined);
      const grid = scene.state.body;
      assert.ok(grid instanceof scenes.SceneGridLayout);
      assert.equal(grid.state.isDraggable, false);
      assert.equal(grid.state.isResizable, false);
      assert.equal(grid.state.isLazy, true);
      assert.deepEqual(gridChildren(scene), []);
    });

    it('works without a resolver, taking explicit { uid } refs at face value', () => {
      const scene = buildDashboardScene({
        panels: [
          { id: 1, type: 'stat', datasource: { uid: 'bs-bare' }, targets: [{ expr: 'up' }] },
          { id: 2, type: 'stat', datasource: { uid: '${DS}' }, targets: [{ expr: 'up' }] },
        ],
      });
      const [one, two] = gridChildren(scene).map(vizOf);
      assert.deepEqual(runnerOf(one).state.datasource, { uid: 'bs-bare', type: 'prometheus' });
      assert.equal(runnerOf(two).state.datasource, null);
    });
  });

  describe('sceneTimeRangeOf', () => {
    it('answers undefined for no scene', () => {
      assert.equal(sceneTimeRangeOf(null), undefined);
    });

    it('falls back to the stashed handle when the graph cannot be asked', async () => {
      const handle = { state: { from: 'now-1h' } };
      const broken = { get state() { throw new Error('detached'); }, __timeRange: handle };
      let answer;
      const warned = await capturing('warn', () => { answer = sceneTimeRangeOf(broken); });
      assert.equal(answer, handle);
      assert.match(warned.join(), /no resolvable time range/);
    });
  });

  describe('layout', () => {
    // SceneGridLayout orders its children by position, so each panel sits where a
    // real dashboard would put it; assertions look items up by key, not by index.
    const byKey = (items) => Object.fromEntries(items.map((i) => [i instanceof scenes.SceneGridRow ? i.state.key : vizOf(i).state.key, i]));

    it('maps gridPos to the grid item, and defaults a panel that has none', async () => {
      const { scene } = await build({
        panels: [
          { id: 1, type: 'text', gridPos: { x: 3, y: 20, w: 5, h: 6 } },
          { id: 2, type: 'text' },
          { id: 3, type: 'text', gridPos: {} },
          null,
          'garbage',
        ],
      });
      const items = gridChildren(scene);
      assert.equal(items.length, 3);
      const pos = (i) => [i.state.x, i.state.y, i.state.width, i.state.height];
      const found = Object.fromEntries(items.map((i) => [vizOf(i).state.key, pos(i)]));
      assert.deepEqual(found['panel-1'], [3, 20, 5, 6]);
      assert.deepEqual(found['panel-2'], [0, 0, 12, 8]);
      assert.deepEqual(found['panel-3'], [0, 0, 12, 8]);
    });

    it('lets an expanded row own the panels that follow it, up to the next row', async () => {
      const { scene } = await build({
        panels: [
          { id: 1, type: 'text', title: 'loose', gridPos: { x: 0, y: 0, w: 24, h: 2 } },
          { id: 10, type: 'row', title: 'Open', gridPos: { y: 2 } },
          { id: 2, type: 'text', gridPos: { x: 0, y: 3, w: 12, h: 4 } },
          { id: 3, type: 'text', gridPos: { x: 12, y: 3, w: 12, h: 4 } },
          { id: 11, type: 'row', title: 'Also open', gridPos: { y: 7 } },
          { id: 4, type: 'text', gridPos: { x: 0, y: 8, w: 24, h: 4 } },
        ],
      });
      const items = gridChildren(scene);
      assert.equal(items.length, 3);
      const top = byKey(items);
      assert.ok(top['panel-1']);
      const open = top['row-10'];
      assert.ok(open instanceof scenes.SceneGridRow);
      assert.equal(open.state.title, 'Open');
      assert.equal(open.state.y, 2);
      assert.equal(open.state.isCollapsed, false);
      assert.equal(open.state.isCollapsible, true);
      assert.deepEqual(open.state.children.map((c) => vizOf(c).state.key).sort(), ['panel-2', 'panel-3']);
      assert.deepEqual(top['row-11'].state.children.map((c) => vizOf(c).state.key), ['panel-4']);
    });

    it('keeps a collapsed row to its inline panels and never adopts what follows', async () => {
      const { scene } = await build({
        panels: [
          { type: 'row', collapsed: true, gridPos: { y: 0 }, panels: [{ id: 5, type: 'text' }] },
          { id: 6, type: 'text', gridPos: { x: 0, y: 1, w: 24, h: 4 } },
        ],
      });
      const items = gridChildren(scene);
      assert.equal(items.length, 2);
      const row = items.find((i) => i instanceof scenes.SceneGridRow);
      const after = items.find((i) => i instanceof scenes.SceneGridItem);
      assert.doesNotMatch(row.state.key, /^row-/);
      assert.equal(row.state.title, '');
      assert.equal(row.state.isCollapsed, true);
      assert.deepEqual(row.state.children.map((c) => vizOf(c).state.key), ['panel-5']);
      assert.equal(vizOf(after).state.key, 'panel-6');
    });
  });

  describe('panels', () => {
    it("carries the panel's identity, title, options and normalised fieldConfig", async () => {
      const { viz } = await firstViz({
        id: 7, type: 'stat', title: 'CPU', description: 'd',
        options: { colorMode: 'background' },
        fieldConfig: { defaults: { unit: 'percent' }, overrides: 'bad' },
      });
      assert.ok(viz instanceof scenes.VizPanel);
      assert.equal(viz.state.key, 'panel-7');
      assert.equal(viz.state.pluginId, 'stat');
      assert.equal(viz.state.title, 'CPU');
      assert.equal(viz.state.description, 'd');
      assert.deepEqual(viz.state.options, { colorMode: 'background' });
      assert.deepEqual(viz.state.fieldConfig, { defaults: { unit: 'percent' }, overrides: [] });
      assert.equal(viz.state.displayMode, 'default');
      assert.equal(viz.state.hoverHeader, false);
    });

    it('gives an untitled panel a hover header, unless a time override needs the badge', async () => {
      const { scene } = await build({
        panels: [
          { id: 1, type: 'text' },
          { id: 2, type: 'text', timeFrom: '1h' },
          { id: 3, type: 'text', transparent: true, fieldConfig: { defaults: 'x' }, options: 'x' },
        ],
      });
      const [a, b, c] = gridChildren(scene).map(vizOf);
      assert.equal(a.state.hoverHeader, true);
      assert.equal(b.state.hoverHeader, false);
      assert.equal(c.state.displayMode, 'transparent');
      assert.deepEqual(c.state.fieldConfig, { defaults: {}, overrides: [] });
      assert.deepEqual(c.state.options, {});
    });

    it('gives panels without an id unique anonymous keys', async () => {
      const { scene } = await build({ panels: [{ type: 'text' }, { type: 'text' }] });
      const [a, b] = gridChildren(scene).map((i) => vizOf(i).state.key);
      assert.match(a, /^panel-anon-\d+$/);
      assert.match(b, /^panel-anon-\d+$/);
      assert.notEqual(a, b);
    });

    it('maps legacy plugin ids onto the renderer that draws them', async () => {
      const { viz } = await firstViz({ id: 1, type: 'graph', targets: [{ expr: 'up' }] });
      assert.equal(viz.state.pluginId, 'timeseries');
    });

    it('turns an unsupported plugin into a placeholder that fires no query', async () => {
      const { viz } = await firstViz({ id: 1, type: 'worldmap-panel', targets: [{ expr: 'up' }] });
      assert.equal(viz.state.pluginId, UNSUPPORTED_PLUGIN_ID);
      assert.deepEqual(viz.state.options, { originalPluginId: 'worldmap-panel' });
      assert.equal(viz.state.$data, undefined);
    });

    it('names a library panel stub instead of rendering an empty tile', async () => {
      const { viz } = await firstViz({ id: 1, type: 'timeseries', libraryPanel: { name: 'Shared CPU' }, targets: [{}] });
      assert.equal(viz.state.pluginId, UNSUPPORTED_PLUGIN_ID);
      assert.deepEqual(viz.state.options, { originalPluginId: 'library panel "Shared CPU"' });
      assert.equal(viz.state.$data, undefined);
      const { viz: nameless } = await firstViz({ id: 2, libraryPanel: {} });
      assert.deepEqual(nameless.state.options, { originalPluginId: 'library panel ""' });
    });

    it('runs no query for a text panel, whatever targets it carries', async () => {
      const { viz } = await firstViz({ id: 1, type: 'text', targets: [{ expr: 'up' }] });
      assert.equal(viz.state.$data, undefined);
    });

    it('renders a repeating panel once, and says so', async () => {
      const { logs } = await firstViz({ id: 1, type: 'text', title: 'Per host', repeat: 'host' });
      assert.match(logs.info.join(), /"Per host" repeats over "\$host"/);
    });

    it('replaces a panel that cannot be built with an error tile, keeping the rest', async () => {
      const ds = resolver();
      const throwing = { ...ds, resolve: (ref) => { if (ref?.uid === 'boom') throw new Error('kaput'); return ds.resolve(ref); } };
      const { scene, logs } = await build({
        panels: [
          { id: 1, type: 'stat', title: 'Bad', datasource: { uid: 'boom' }, targets: [{}] },
          { id: 2, type: 'stat', targets: [{}] },
          { type: 'stat', datasource: { uid: 'boom' }, targets: [{}] },
        ],
      }, throwing);
      const [bad, good, anon] = gridChildren(scene).map(vizOf);
      assert.equal(bad.state.key, 'panel-1');
      assert.equal(bad.state.pluginId, UNSUPPORTED_PLUGIN_ID);
      assert.equal(bad.state.title, 'Bad');
      assert.deepEqual(bad.state.options, { originalPluginId: 'stat — kaput' });
      assert.equal(good.state.pluginId, 'stat');
      assert.match(anon.state.key, /^panel-anon-/);
      assert.equal(anon.state.title, 'Panel');
      assert.match(logs.error.join(), /could not build panel "Bad"/);
    });
  });

  describe('queries', () => {
    it('drops hidden targets, names unnamed ones by position, and keeps their fields', async () => {
      const { viz } = await firstViz({
        id: 1, type: 'stat', datasource: PROM,
        targets: [{ expr: 'a' }, { expr: 'b', hide: true }, { refId: 'Z', expr: 'c' }],
      });
      const runner = runnerOf(viz);
      assert.ok(runner instanceof InterpolatingQueryRunner);
      assert.deepEqual(runner.state.queries, [
        { refId: 'A', expr: 'a', datasource: PROM },
        { refId: 'Z', expr: 'c', datasource: PROM },
      ]);
      assert.deepEqual(runner.state.datasource, PROM);
    });

    it('gives a Prometheus panel the default floor and its tiers, sized from width', async () => {
      const { viz } = await firstViz({ id: 1, type: 'stat', datasource: PROM, targets: [{}] });
      const { state } = runnerOf(viz);
      assert.equal(state.minInterval, PROM_DEFAULT_MIN_INTERVAL);
      assert.equal(state.minIntervalTiers, PROM_MIN_INTERVAL_TIERS);
      assert.equal(state.maxDataPointsFromWidth, true);
      assert.equal(state.maxDataPoints, undefined);
    });

    it("lets a panel's own interval, maxDataPoints and cacheTimeout win", async () => {
      const { viz } = await firstViz({
        id: 1, type: 'stat', datasource: PROM, targets: [{}],
        interval: '1m', maxDataPoints: 300, cacheTimeout: '60',
      });
      const { state } = runnerOf(viz);
      assert.equal(state.minInterval, '1m');
      assert.equal(state.minIntervalTiers, undefined);
      assert.equal(state.maxDataPoints, 300);
      assert.equal(state.maxDataPointsFromWidth, false);
      assert.equal(state.cacheTimeout, '60');
    });

    it('imposes no floor on a panel with no Prometheus-like target', async () => {
      const { viz } = await firstViz({ id: 1, type: 'stat', datasource: INF, targets: [{}] });
      const { state } = runnerOf(viz);
      assert.equal(state.minInterval, undefined);
      assert.equal(state.minIntervalTiers, undefined);
    });

    it('builds no runner when every target is unqueryable', async () => {
      const { viz } = await firstViz({
        id: 1, type: 'stat', datasource: PROM,
        targets: [{ datasource: '__expr__' }, { datasource: { uid: 'grafana', type: 'datasource' } }],
      });
      assert.equal(viz.state.$data, undefined);
    });

    it('builds no runner for a panel with no targets', async () => {
      const { viz } = await firstViz({ id: 1, type: 'stat' });
      assert.equal(viz.state.$data, undefined);
    });

    it('points a panel whose targets span datasources at the mixed proxy, each target keeping its own', async () => {
      const { viz } = await firstViz({
        id: 1, type: 'stat', datasource: { uid: '-- Mixed --' },
        targets: [{ refId: 'A', datasource: PROM }, { refId: 'B', datasource: INF }],
      });
      const { state } = runnerOf(viz);
      assert.equal(state.datasource.uid, MIXED_DS_UID);
      assert.deepEqual(state.queries.map((q) => q.datasource), [PROM, INF]);
      // Still floored: a Prometheus target given too fine a step fails outright.
      assert.equal(state.minInterval, PROM_DEFAULT_MIN_INTERVAL);
      const uids = new Set(knownProxies().map((p) => p.uid));
      assert.ok(uids.has(PROM.uid) && uids.has(INF.uid));
    });

    it('treats a "-- Mixed --" panel whose targets agree as a plain one', async () => {
      const { viz } = await firstViz({
        id: 1, type: 'stat', datasource: { uid: '-- Mixed --' },
        targets: [{ datasource: INF }, { datasource: INF }],
      });
      assert.deepEqual(runnerOf(viz).state.datasource, INF);
    });

    it('leaves the runner datasource unset when the only ref is the mixed marker', async () => {
      const { viz } = await firstViz(
        { id: 1, type: 'stat', targets: [{ expr: 'up' }] },
        resolver({ uid: '-- Mixed --', type: 'mixed', mixed: true }),
      );
      assert.equal(runnerOf(viz).state.datasource, undefined);
    });

    it('wraps the runner in a transformer when the panel declares transformations', async () => {
      const { viz } = await firstViz({
        id: 1, type: 'stat', datasource: PROM, targets: [{}],
        transformations: [{ id: 'reduce', options: {} }],
      });
      assert.ok(viz.state.$data instanceof scenes.SceneDataTransformer);
      assert.deepEqual(viz.state.$data.state.transformations, [{ id: 'reduce', options: {} }]);
      assert.ok(viz.state.$data.state.$data instanceof InterpolatingQueryRunner);
    });

    it('tells a queried dynamic text panel to await its answer — and only a queried one', async () => {
      const { viz: queried } = await firstViz({
        id: 1, type: DYNAMIC_TEXT_PLUGIN_ID, options: { content: 'x' }, datasource: PROM, targets: [{}],
      });
      assert.equal(queried.state.options[AWAITS_QUERY_OPTION], true);
      assert.equal(queried.state.options.content, 'x');
      const { viz: bare } = await firstViz({ id: 2, type: DYNAMIC_TEXT_PLUGIN_ID, options: { content: 'x' } });
      assert.equal(bare.state.options[AWAITS_QUERY_OPTION], undefined);
      const { viz: stat } = await firstViz({ id: 3, type: 'stat', datasource: PROM, targets: [{}] });
      assert.equal(stat.state.options[AWAITS_QUERY_OPTION], undefined);
    });
  });

  describe('variables', () => {
    const variablesOf = async (list, ds) => {
      const { scene, logs } = await build({ templating: { list } }, ds);
      const set = scene.state.$variables;
      return { byName: Object.fromEntries((set?.state.variables ?? []).map((v) => [v.state.name, v])), set, logs };
    };

    it('builds a query variable with its saved selection, datasource and object query', async () => {
      const { byName } = await variablesOf([
        {
          type: 'query', name: 'svc', label: 'Service', description: 'd', hide: 1,
          datasource: INF, query: { query: 'x', format: 'table' }, regex: '/a/',
          refresh: 2, sort: 1, multi: true, includeAll: true, allValue: '.*',
          current: { value: ['a', 'b'] },
        },
        { type: 'query', name: 'host', query: 'label_values(up, host)', includeAll: true, hide: 'variable' },
        { type: 'query', name: 'plain', query: { query: 'label_values(x)' }, current: { value: '' } },
      ]);
      const svc = byName.svc;
      assert.ok(svc instanceof scenes.QueryVariable);
      assert.equal(svc.state.label, 'Service');
      assert.equal(svc.state.description, 'd');
      assert.equal(svc.state.hide, VariableHide.hideLabel);
      assert.deepEqual(svc.state.datasource, INF);
      assert.deepEqual(svc.state.query, { query: 'x', format: 'table' });
      assert.equal(svc.state.regex, '/a/');
      assert.equal(svc.state.refresh, 2);
      assert.equal(svc.state.sort, 1);
      assert.equal(svc.state.isMulti, true);
      assert.equal(svc.state.includeAll, true);
      assert.equal(svc.state.allValue, '.*');
      assert.deepEqual(svc.state.value, ['a', 'b']);

      const host = byName.host;
      assert.equal(host.state.query, 'label_values(up, host)');
      assert.equal(host.state.value, '$__all');
      assert.equal(host.state.hide, VariableHide.hideVariable);
      assert.equal(host.state.refresh, 1);
      assert.deepEqual(host.state.datasource, PROM);

      assert.equal(byName.plain.state.hide, VariableHide.dontHide);
    });

    it('builds custom, textbox, constant and interval variables', async () => {
      const { byName } = await variablesOf([
        { type: 'custom', name: 'env', query: 'dev,prod', multi: true, current: { value: 'prod' } },
        { type: 'textbox', name: 'filter', query: 'default text' },
        { type: 'textbox', name: 'typed', current: { value: 'typed' } },
        { type: 'constant', name: 'region', query: 'eu-1', hide: 0 },
        { type: 'constant', name: 'fromCurrent', current: { value: 'cur' } },
        { type: 'interval', name: 'iv', query: '1m, 5m,,1h', auto: true, auto_min: '10s', auto_count: 30, current: { value: '5m' } },
        { type: 'interval', name: 'ivDefault' },
      ]);
      assert.ok(byName.env instanceof scenes.CustomVariable);
      assert.equal(byName.env.state.query, 'dev,prod');
      assert.equal(byName.env.state.isMulti, true);
      assert.equal(byName.env.state.value, 'prod');

      assert.ok(byName.filter instanceof scenes.TextBoxVariable);
      assert.equal(byName.filter.state.value, 'default text');
      assert.equal(byName.typed.state.value, 'typed');

      assert.ok(byName.region instanceof scenes.ConstantVariable);
      assert.equal(byName.region.state.value, 'eu-1');
      assert.equal(byName.region.state.hide, VariableHide.hideVariable);
      assert.equal(byName.fromCurrent.state.value, 'cur');

      assert.ok(byName.iv instanceof scenes.IntervalVariable);
      assert.deepEqual(byName.iv.state.intervals, ['1m', '5m', '1h']);
      assert.equal(byName.iv.state.value, '5m');
      assert.equal(byName.iv.state.autoEnabled, true);
      assert.equal(byName.iv.state.autoMinInterval, '10s');
      assert.equal(byName.iv.state.autoStepCount, 30);
      // No list given: Scenes' own defaults survive rather than being wiped by `undefined`.
      assert.ok(byName.ivDefault.state.intervals.length > 0);
    });

    it('builds a datasource variable pickable by plugin type', async () => {
      const { byName } = await variablesOf([
        { type: 'datasource', name: 'DS_PROM', query: 'prometheus', current: { value: 'bs-prom' } },
        { type: 'datasource', name: 'DS_OBJ', query: { type: 'loki' }, regex: '/x/' },
      ]);
      assert.ok(byName.DS_PROM instanceof scenes.DataSourceVariable);
      assert.equal(byName.DS_PROM.state.pluginId, 'prometheus');
      assert.equal(byName.DS_PROM.state.value, 'bs-prom');
      assert.equal(byName.DS_OBJ.state.pluginId, 'loki');
      assert.equal(byName.DS_OBJ.state.regex, '/x/');
    });

    it('skips ad-hoc, unknown-typed and nameless variables without losing the others', async () => {
      const { byName, logs } = await variablesOf([
        { type: 'adhoc', name: 'filters' },
        { type: 'exotic', name: 'weird' },
        { type: 'hasOwnProperty', name: 'proto' },
        { type: 'custom' },
        null,
        { type: 'custom', name: 'kept', query: 'a' },
      ]);
      assert.deepEqual(Object.keys(byName), ['kept']);
      const warned = logs.warn.join('\n');
      assert.match(warned, /ad-hoc filter variable "filters" is not supported/);
      assert.match(warned, /"weird" has unsupported type "exotic"/);
      assert.match(warned, /"proto" has unsupported type "hasOwnProperty"/);
    });

    it('logs and skips a variable that throws while being built', async () => {
      const ds = resolver();
      const { byName, logs } = await variablesOf([
        { type: 'query', name: 'broken', datasource: { uid: 'x' } },
        { type: 'custom', name: 'ok', query: 'a' },
      ], { ...ds, resolve: () => { throw new Error('nope'); } });
      assert.deepEqual(Object.keys(byName), ['ok']);
      assert.match(logs.error.join(), /could not build variable "broken"/);
    });

    it('builds no variable set when nothing survives', async () => {
      const { set } = await variablesOf([{ type: 'adhoc', name: 'f' }]);
      assert.equal(set, undefined);
    });
  });

  describe('buildDashboardSceneAsync', () => {
    it("resolves ${DS_X} through the live catalog before building", async () => {
      let clock = Date.now() + CATALOG_MAX_AGE_MS * 1000;
      mock.method(Date, 'now', () => clock);
      const { restore } = stubFetch([[/\/dashboards\/datasources/, {
        items: [{ uid: 'async-loki', name: 'Loki', type: 'loki' }],
      }]]);
      try {
        const scene = await buildDashboardSceneAsync({
          uid: 'async',
          templating: { list: [{ type: 'datasource', name: 'DS_L', query: 'loki', current: { value: 'Loki' } }] },
          panels: [{ id: 1, type: 'stat', datasource: { uid: '${DS_L}' }, targets: [{ expr: '{a="b"}' }] }],
        });
        const viz = vizOf(gridChildren(scene)[0]);
        assert.deepEqual(runnerOf(viz).state.datasource, { uid: 'async-loki', type: 'loki' });
        assert.equal(scene.__dashboardUid, 'async');
      } finally {
        restore();
        clock += 1;
      }
    });
  });
});
