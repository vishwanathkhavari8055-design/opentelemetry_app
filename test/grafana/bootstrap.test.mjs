/**
 * Guards the Grafana runtime bootstrap.
 *
 * In a standalone app, the singletons Grafana core fills at boot start EMPTY,
 * and most fail silently: a dashboard renders and is quietly wrong. This file
 * checks each one is filled, once, and behaves:
 *  - runRequest maps a datasource packet into PanelData, defaulting the state
 *    to Done and the series to [] (a missing state leaves a panel spinning);
 *  - plugin import utils refuse an unregistered plugin rather than hanging;
 *  - the icon public path points at /grafana-assets/ (else every icon 404s);
 *  - config.theme2 / theme are the app's theme, and the provider's theme
 *    (getSceneTheme) is the SAME object, built on demand.
 * A second bootstrap must be a no-op: registries throw on duplicate ids.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import './grafanaEnv.mjs';

const { firstValueFrom, of } = await import('rxjs');
const { EventBusSrv, LoadingState } = await import('@grafana/data');
const runtime = await import('@grafana/runtime');
const { bootstrapGrafanaRuntime, getSceneTheme } = await import('../../src/grafana/bootstrap.js');

const savedPublicPath = globalThis.__grafana_public_path__;
after(() => {
  if (savedPublicPath === undefined) delete globalThis.__grafana_public_path__;
  else globalThis.__grafana_public_path__ = savedPublicPath;
});

describe('bootstrapGrafanaRuntime', () => {
  it('builds the scene theme on demand and makes it the config theme', () => {
    const theme = getSceneTheme();
    assert.ok(theme);
    assert.equal(theme.colors.primary.main, '#009688');
    assert.equal(runtime.config.theme2, theme);
    assert.equal(runtime.config.theme, theme.v1);
    assert.equal(runtime.config.bootData.user.theme, 'dark');
    assert.equal(runtime.config.bootData.user.lightTheme, false);
  });

  it('is idempotent and returns the same theme', () => {
    const first = bootstrapGrafanaRuntime();
    const second = bootstrapGrafanaRuntime();
    assert.equal(first.theme, second.theme);
    assert.equal(second.theme, getSceneTheme());
  });

  it('points Grafana\'s icon lookups at the served assets', () => {
    assert.equal(window.__grafana_public_path__, '/grafana-assets/');
    assert.equal(globalThis.__grafana_public_path__, '/grafana-assets/');
  });

  it('installs app events and a datasource service', () => {
    assert.ok(runtime.getAppEvents() instanceof EventBusSrv);
    assert.equal(typeof runtime.getDataSourceSrv().get, 'function');
  });

  it('refuses to import a panel plugin that was not registered', async () => {
    const utils = runtime.getPluginImportUtils();
    assert.equal(utils.getPanelPluginFromCache('timeseries'), undefined);
    await assert.rejects(utils.importPanelPlugin('heatmap'), /No panel plugin registered for "heatmap"/);
  });

  it('maps a datasource response into PanelData', async () => {
    const request = { requestId: 'r1', range: { raw: { from: 'now-1h', to: 'now' } } };
    const frame = { name: 'A', fields: [] };
    const ds = { query: (req) => of({ data: [frame], state: LoadingState.Streaming, errors: [{ message: 'partial' }], error: undefined, req }) };
    const out = await firstValueFrom(runtime.getRunRequest()(ds, request));
    assert.deepEqual(out, {
      state: LoadingState.Streaming,
      series: [frame],
      errors: [{ message: 'partial' }],
      error: undefined,
      request,
      timeRange: request.range,
      structureRev: 1,
    });
  });

  it('defaults a bare packet to Done with no series', async () => {
    const request = { range: {} };
    const out = await firstValueFrom(runtime.getRunRequest()({ query: () => of({}) }, request));
    assert.equal(out.state, LoadingState.Done);
    assert.deepEqual(out.series, []);
  });
});
