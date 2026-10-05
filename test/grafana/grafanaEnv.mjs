/**
 * What the src/grafana tests share on top of ../support/dom.mjs: a real Grafana
 * theme, DataFrames processed the way VizPanel processes them, a console
 * capture, and a stand-in 2D canvas for the @grafana/ui pieces that measure or
 * draw on one.
 *
 * Import this FIRST in a test file (it imports dom.mjs itself), then bring in
 * React, Testing Library and the module under test with `await import()`.
 */
import '../support/dom.mjs';

const data = await import('@grafana/data');
// The field-config registry the app installs (units, min/max, thresholds, the
// graph `custom.*` keys). Idempotent, and the panels register it too.
const { registerStandardFieldConfig } = await import('../../src/grafana/fieldConfig.js');
registerStandardFieldConfig();

/** A real GrafanaTheme2 — the dark one Grafana defaults to. */
export const theme = data.createTheme({ colors: { mode: 'dark' } });

/**
 * A DataFrame the way VizPanel hands one to a panel: every field has been
 * through applyFieldOverrides(), so each carries its own display processor,
 * resolved colour and thresholds. Pass the panel plugin's own
 * `fieldConfigRegistry` to get that plugin's defaults, exactly as VizPanel does.
 */
export function processedFrames(frames, fieldConfig = { defaults: {}, overrides: [] }, fieldConfigRegistry) {
  return data.applyFieldOverrides({
    data: frames.map((f) => data.toDataFrame(f)),
    fieldConfig,
    replaceVariables: (v) => v,
    theme,
    timeZone: 'utc',
    ...(fieldConfigRegistry ? { fieldConfigRegistry } : {}),
  });
}

/** Silence one console method for the duration of `fn`, returning what it logged. */
export async function capturing(method, fn) {
  const original = console[method];
  const logged = [];
  console[method] = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console[method] = original;
  }
  return logged;
}

export { data };

/**
 * A 2D canvas context for jsdom, which has none. @grafana/ui measures text on
 * one (BigValue, BarGauge) and uPlot draws on one; neither result is asserted on
 * pixel by pixel, so every drawing call is a no-op and text measures 0.6em per
 * glyph. Path2D likewise. Returns a restore function.
 */
export function installFakeCanvas() {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext() {
    const canvas = this;
    const state = { font: '14px sans-serif', canvas };
    const noop = () => proxy;
    const proxy = new Proxy(state, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'measureText') {
          return (text) => {
            const size = Number(/(\d+)px/.exec(target.font)?.[1] ?? 14);
            return { width: String(text).length * size * 0.6, actualBoundingBoxAscent: size, actualBoundingBoxDescent: 0 };
          };
        }
        if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        if (prop === 'getLineDash') return () => [];
        return noop;
      },
      set(target, prop, value) { target[prop] = value; return true; },
    });
    return proxy;
  };
  // uPlot builds its paths as Path2D objects before stroking them.
  const hadPath2D = 'Path2D' in globalThis;
  const originalPath2D = globalThis.Path2D;
  globalThis.Path2D = new Proxy(class Path2D {}, {
    construct() { return new Proxy({}, { get: () => () => {} }); },
  });
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
    if (hadPath2D) globalThis.Path2D = originalPath2D; else delete globalThis.Path2D;
  };
}
