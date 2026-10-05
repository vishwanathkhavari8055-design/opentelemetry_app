/**
 * Guards the shim for @grafana/ui's duplicate-chart bug.
 *
 * UPlotChart keeps its uPlot instance in React STATE and destroys it on
 * unmount. StrictMode (or any unmount that lands before the mount's setState
 * commits) runs mount → unmount → mount synchronously, so at unmount the state
 * is still null, the first chart's DOM is orphaned, and every timeseries panel
 * draws twice. The shim captures the instance as setState is CALLED, destroys
 * it on unmount, and clears the container as a backstop.
 *
 * uPlot cannot draw in jsdom (no canvas), so the real UPlotChart prototype is
 * exercised with its reinitPlot replaced by one that does what the real one
 * does to state — `setState({ plot })` through a React updater that does not
 * commit. componentWillUnmount is the real one. Every prototype change,
 * including the shim's own "patched" flag, is undone afterwards.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import './grafanaEnv.mjs';

const { UPlotChart } = await import('@grafana/ui');
const { patchUPlotChartRemountLeak } = await import('../../src/grafana/uplotRemountLeak.js');

const proto = UPlotChart.prototype;
const originals = {
  reinitPlot: Object.getOwnPropertyDescriptor(proto, 'reinitPlot'),
  componentWillUnmount: Object.getOwnPropertyDescriptor(proto, 'componentWillUnmount'),
};
after(() => {
  Object.defineProperty(proto, 'reinitPlot', originals.reinitPlot);
  Object.defineProperty(proto, 'componentWillUnmount', originals.componentWillUnmount);
  delete proto.__obsRemountLeakPatched;
});

/** Run fn with console.warn captured. */
function capturingWarn(fn) {
  const original = console.warn;
  const warned = [];
  console.warn = (...args) => { warned.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return warned;
}

/** A stand-in uPlot: appends its DOM to the host, removes nothing itself. */
function fakePlot(host, { throwOnDestroy = false } = {}) {
  const node = document.createElement('div');
  host.appendChild(node);
  return {
    destroyed: 0,
    destroy() {
      this.destroyed += 1;
      if (throwOnDestroy) throw new Error('already gone');
      node.remove();
    },
  };
}

/** A mounted-but-uncommitted UPlotChart: setState is queued, never applied. */
function chart(plotFactory) {
  const host = document.createElement('div');
  const inst = Object.create(proto);
  inst.props = {};
  inst.state = { plot: null };
  inst.plotContainer = { current: host };
  inst.queued = [];
  inst.updater = { enqueueSetState: (_i, partial) => { inst.queued.push(partial); } };
  inst.makePlot = () => plotFactory(host);
  return { inst, host };
}

describe('patchUPlotChartRemountLeak', () => {
  it('warns and does nothing when UPlotChart no longer has the expected shape', () => {
    delete proto.componentWillUnmount;
    try {
      const warned = capturingWarn(() => patchUPlotChartRemountLeak());
      assert.equal(warned.length, 1);
      assert.match(warned[0], /unexpected shape/);
      assert.equal(proto.__obsRemountLeakPatched, undefined);
    } finally {
      Object.defineProperty(proto, 'componentWillUnmount', originals.componentWillUnmount);
    }
  });

  it('patches once', () => {
    Object.defineProperty(proto, 'reinitPlot', {
      configurable: true,
      writable: true,
      value: function reinitPlot() {
        const plot = this.makePlot();
        this.setState({ plot });
        return 'reinit-result';
      },
    });
    patchUPlotChartRemountLeak();
    const patched = proto.reinitPlot;
    assert.notEqual(patched, originals.reinitPlot.value);
    patchUPlotChartRemountLeak();
    assert.equal(proto.reinitPlot, patched, 'a second call changes nothing');
  });

  it('destroys the chart an unmount could not see in state (the StrictMode double mount)', () => {
    const { inst, host } = chart((h) => fakePlot(h));
    assert.equal(inst.reinitPlot(), 'reinit-result');
    assert.equal(inst.queued.length, 1, 'setState still reaches React');
    assert.equal(Object.hasOwn(inst, 'setState'), false, 'the capture is removed after reinit');
    assert.equal(host.childNodes.length, 1);
    const first = inst.queued[0].plot;

    inst.componentWillUnmount();
    assert.equal(first.destroyed, 1);
    assert.equal(host.childNodes.length, 0, 'no orphaned chart left behind');

    inst.reinitPlot();
    assert.equal(host.childNodes.length, 1, 'the second mount has exactly one chart');
  });

  it('does not destroy a committed chart twice', () => {
    const { inst } = chart((h) => fakePlot(h));
    inst.reinitPlot();
    inst.state = { plot: inst.queued[0].plot };
    inst.componentWillUnmount();
    assert.equal(inst.state.plot.destroyed, 1);
  });

  it('clears whatever is left in the container even without a captured chart', () => {
    const { inst, host } = chart(() => null);
    host.appendChild(document.createElement('canvas'));
    inst.componentWillUnmount();
    assert.equal(host.childNodes.length, 0);
  });

  it('survives a chart whose destroy throws, and still clears the container', () => {
    const { inst, host } = chart((h) => fakePlot(h, { throwOnDestroy: true }));
    inst.reinitPlot();
    const warned = capturingWarn(() => inst.componentWillUnmount());
    assert.equal(warned.length, 1);
    assert.match(warned[0], /could not destroy an orphaned uPlot chart/);
    assert.equal(host.childNodes.length, 0);
  });

  it('tolerates an unmount with no container', () => {
    const { inst } = chart(() => null);
    inst.plotContainer = null;
    assert.doesNotThrow(() => inst.componentWillUnmount());
  });
});
