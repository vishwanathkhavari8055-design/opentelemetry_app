/**
 * Guards which renderer each Grafana panel type gets.
 *
 * - An older dashboard's `graph` / `singlestat` must render with their modern
 *   successors, not as a placeholder.
 * - An unknown type must get the placeholder — and a console line naming it
 *   ONCE, not once per panel on a dashboard with twenty of them.
 * - `text` must be flagged as data-free: its vestigial target goes to the
 *   built-in `grafana` datasource, which answers 400 and turns a static header
 *   into a red error tile.
 * - Registration must be idempotent: Scenes throws on a second registration of
 *   the same id, which would take down every dashboard after the first.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import './grafanaEnv.mjs';

const registry = await import('../../src/grafana/panelRegistry.js');
const { timeseriesPanelPlugin } = await import('../../src/grafana/panels.jsx');
const { unsupportedPanelPlugin } = await import('../../src/grafana/panelsExtra.jsx');
const { DYNAMIC_TEXT_PLUGIN_ID } = await import('../../src/grafana/panelDynamicText.jsx');

const {
  UNSUPPORTED_PLUGIN_ID, canonicalPluginId, isPanelSupported, panelSkipsData,
  registerPanelPlugins, resolvePluginId, supportedPanelTypes,
} = registry;

/** Run fn with console.warn captured. */
function capturingWarn(fn) {
  const original = console.warn;
  const warned = [];
  console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return warned;
}

describe('canonicalPluginId / isPanelSupported', () => {
  it('maps legacy ids onto their successors', () => {
    assert.equal(canonicalPluginId('graph'), 'timeseries');
    assert.equal(canonicalPluginId('grafana-singlestat-panel'), 'stat');
    assert.equal(canonicalPluginId('table-old'), 'table');
    assert.equal(canonicalPluginId('gauge'), 'gauge');
    assert.equal(canonicalPluginId(undefined), '');
  });

  it('supports the core types, their aliases and dynamic text', () => {
    for (const id of ['timeseries', 'stat', 'table', 'gauge', 'bargauge', 'piechart', 'barchart', 'text', 'graph', 'singlestat', DYNAMIC_TEXT_PLUGIN_ID]) {
      assert.equal(isPanelSupported(id), true, id);
    }
    for (const id of ['heatmap', 'toString', '', null]) assert.equal(isPanelSupported(id), false, String(id));
  });

  it('advertises the canonical types only', () => {
    const types = supportedPanelTypes();
    assert.ok(types.includes('timeseries') && types.includes(DYNAMIC_TEXT_PLUGIN_ID));
    assert.equal(types.includes('graph'), false);
  });
});

describe('panelSkipsData', () => {
  it('flags the text panel and the placeholder, and nothing that plots data', () => {
    assert.equal(panelSkipsData('text'), true);
    assert.equal(panelSkipsData(UNSUPPORTED_PLUGIN_ID), true);
    assert.equal(panelSkipsData('timeseries'), false);
    assert.equal(panelSkipsData('graph'), false);
    assert.equal(panelSkipsData(DYNAMIC_TEXT_PLUGIN_ID), false, 'dynamic text renders query results');
  });
});

describe('resolvePluginId', () => {
  it('returns the canonical id for a supported type without logging', () => {
    const warned = capturingWarn(() => {
      assert.equal(resolvePluginId('graph', 'CPU'), 'timeseries');
      assert.equal(resolvePluginId('stat'), 'stat');
    });
    assert.deepEqual(warned, []);
  });

  it('falls back to the placeholder and names an unknown type once', () => {
    const warned = capturingWarn(() => {
      assert.equal(resolvePluginId('grafana-worldmap-panel', 'Sites'), UNSUPPORTED_PLUGIN_ID);
      assert.equal(resolvePluginId('grafana-worldmap-panel', 'Other'), UNSUPPORTED_PLUGIN_ID);
    });
    assert.equal(warned.length, 1);
    assert.match(warned[0], /unsupported panel plugin "grafana-worldmap-panel" \(first seen on "Sites"\)/);
  });
});

describe('registerPanelPlugins', () => {
  it('registers every renderer under its Grafana id, and is safe to call again', () => {
    registerPanelPlugins();
    assert.doesNotThrow(() => registerPanelPlugins());
    assert.equal(timeseriesPanelPlugin.meta.id, 'timeseries');
    assert.equal(unsupportedPanelPlugin.meta.id, UNSUPPORTED_PLUGIN_ID);
  });
});
