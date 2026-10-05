/**
 * One extra module hook for wc-entry.jsx: Vite's `?inline` CSS import
 * (`./index.css?inline`), which test/support/hooks.mjs does not recognise
 * because its asset pattern is anchored at the extension. Loads as a short CSS
 * string so the shadow-root <style> the element injects has content to check.
 */
const PREFIX = 'stub-inline-css:';

export async function resolve(specifier, context, nextResolve) {
  if (/\.css\?inline$/.test(specifier)) return { url: `${PREFIX}${specifier}`, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(PREFIX)) {
    return { format: 'module', source: 'export default ":host{--bg-color:#000}";', shortCircuit: true };
  }
  return nextLoad(url, context);
}
