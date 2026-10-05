/**
 * Shim for a @grafana/ui bug that makes every uPlot panel render its chart TWICE.
 *
 * ─── The symptom ────────────────────────────────────────────────────────────
 *
 * Every timeseries panel on a dashboard draws its chart, and then draws a second
 * copy of the same chart directly underneath it. Two charts do not fit in one
 * grid cell, so the second one runs off the bottom of the panel and is sliced by
 * the cell's `overflow: hidden` (see the panel-tile clipping rule in
 * styles/dashboards.css) — landing, visually, right where the next row's panel
 * titles are. It reads exactly like a grid-layout or CSS overflow bug, which is
 * the trap: the grid is correct to the pixel, and the clip is doing its job.
 * There is simply twice as much chart as there should be.
 *
 * On a 32-panel dashboard this hit 18 panels — every panel backed by uPlot.
 *
 * ─── The cause ──────────────────────────────────────────────────────────────
 *
 * @grafana/ui's `UPlotChart` is a class component that keeps its uPlot instance
 * in REACT STATE:
 *
 *     componentDidMount()    { this.reinitPlot(); }         // new uPlot(...) + setState({plot})
 *     componentWillUnmount() { this.state.plot?.destroy(); }
 *
 * uPlot builds its own DOM imperatively and appends it to the target div, so
 * React knows nothing about it: the ONLY thing that removes a chart from the
 * page is that `destroy()` call.
 *
 * `reinitPlot()` publishes the instance with `setState`, which does not take
 * effect until React commits. React 18's StrictMode deliberately exercises the
 * mount/unmount path twice —
 *
 *     componentDidMount -> componentWillUnmount -> componentDidMount
 *
 * — and runs all three synchronously, before the pending state has landed. So at
 * unmount `this.state.plot` is still `null`, `?.destroy()` does nothing, and the
 * first chart's DOM is orphaned inside the container. The second mount appends
 * another chart next to it. Hence two charts, forever.
 *
 * StrictMode makes this happen on every mount, so it is what you see in
 * development. It is not only a StrictMode problem, though: ANY unmount that
 * lands before the mount's state commits leaks a chart the same way, which is
 * why this patches the bug rather than removing <React.StrictMode> from
 * main.jsx. Keeping StrictMode also keeps its checks for the other eight screens.
 *
 * ─── The fix ────────────────────────────────────────────────────────────────
 *
 * Track the instance where an unmount can always see it — on the component —
 * instead of in state that may not have committed yet:
 *
 *   1. `reinitPlot` is wrapped so the uPlot instance is captured off the
 *      `setState({ plot })` call as it is made, onto `this[LIVE_PLOT]`.
 *   2. `componentWillUnmount` destroys that instance as well as the one in
 *      state. `destroy()` is what unregisters uPlot's window resize and pointer
 *      listeners, so this also stops the orphan from going on doing work.
 *   3. As a backstop, anything still left in uPlot's own target container is
 *      removed. React renders that div with no children of its own, so
 *      everything inside it belongs to uPlot and clearing it can never remove
 *      React-managed DOM. This is what keeps the fix working if the internals in
 *      step 1 are renamed by a future @grafana/ui.
 *
 * Idempotent, and a no-op if the shape it patches ever stops being there — a
 * @grafana/ui upgrade that fixes this upstream costs nothing but a dead shim.
 */

import { UPlotChart } from '@grafana/ui';

/** Non-enumerable-ish keys, kept off any name @grafana/ui might itself use. */
const LIVE_PLOT = '__obsLivePlot';
const PATCHED = '__obsRemountLeakPatched';

export function patchUPlotChartRemountLeak() {
  const proto = UPlotChart?.prototype;

  // Nothing to patch — a major @grafana/ui change, or a build that tree-shook
  // the export. Panels still render; they are just back to the upstream bug.
  if (!proto || typeof proto.componentWillUnmount !== 'function') {
    console.warn('[dashboards] UPlotChart has an unexpected shape — the '
      + 'duplicate-chart shim was not applied.');
    return;
  }
  if (proto[PATCHED]) return;
  proto[PATCHED] = true;

  // 1. Capture the instance synchronously, as reinitPlot publishes it.
  const reinitPlot = proto.reinitPlot;
  if (typeof reinitPlot === 'function') {
    proto.reinitPlot = function patchedReinitPlot(...args) {
      const capture = (partial, callback) => {
        if (partial?.plot) this[LIVE_PLOT] = partial.plot;
        // `this.setState` is an own property for the duration of this call, so
        // reach past it to the real implementation on the prototype chain.
        return Object.getPrototypeOf(this).setState.call(this, partial, callback);
      };

      this.setState = capture;
      try {
        return reinitPlot.apply(this, args);
      } finally {
        // Back to the inherited setState — no own property left behind.
        delete this.setState;
      }
    };
  }

  // 2 + 3. Destroy whatever exists, then make sure the container is empty.
  const componentWillUnmount = proto.componentWillUnmount;
  proto.componentWillUnmount = function patchedComponentWillUnmount(...args) {
    const captured = this[LIVE_PLOT];
    this[LIVE_PLOT] = null;

    let result;
    try {
      result = componentWillUnmount.apply(this, args);
    } finally {
      // Only when state never caught up — otherwise this is the same object
      // upstream just destroyed, and uPlot's destroy() is not re-entrant.
      if (captured && captured !== this.state?.plot) {
        try {
          captured.destroy();
        } catch (err) {
          console.warn('[dashboards] could not destroy an orphaned uPlot chart', err);
        }
      }

      // The backstop. uPlot's target div is rendered childless by React, so
      // anything in it is uPlot's and is safe to drop.
      const host = this.plotContainer?.current;
      if (host?.firstChild) host.replaceChildren();
    }
    return result;
  };
}
