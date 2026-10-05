/**
 * A browser for component tests: jsdom's window, with its globals copied onto
 * Node's so React DOM and Testing Library find `document`, `window` and friends.
 *
 * Import it first — before React or Testing Library — in any test that renders:
 *
 *   import './support/dom.mjs';
 *   const { render, screen } = await import('@testing-library/react');
 *
 * Static imports are hoisted, so modules that touch `window` at load time must
 * come in through `await import()` after this one.
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Node already has some of these (navigator, fetch, URL, Event…); where it does,
// its own stays unless jsdom's is the one the DOM needs.
const KEEP_NODE = new Set(['fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'crypto', 'performance',
  'structuredClone', 'btoa', 'atob', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask']);

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis && (KEEP_NODE.has(key) || key.startsWith('_'))) continue;
  try {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: window[key],
    });
  } catch {
    // A few of Node's globals are not configurable. Its own is fine for tests.
  }
}
globalThis.window = window;
globalThis.document = window.document;
globalThis.navigator = window.navigator;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom's own btoa/atob reject every string when run under Node; Node's are correct.
window.btoa = globalThis.btoa;
window.atob = globalThis.atob;

// Not in jsdom; charts and layout code call them.
window.matchMedia ??= () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = window.matchMedia;
class NoopObserver { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
window.ResizeObserver ??= NoopObserver;
window.IntersectionObserver ??= NoopObserver;
globalThis.ResizeObserver = window.ResizeObserver;
globalThis.IntersectionObserver = window.IntersectionObserver;
window.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {};
window.HTMLCanvasElement.prototype.getContext = () => null;

export { window };
