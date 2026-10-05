/**
 * Module hooks that let Node's own test runner load the app the way Vite does.
 *
 * Three things Vite does that Node does not:
 *  - `.jsx` is compiled. Here esbuild compiles it with an inline source map, so
 *    `--enable-source-maps` puts coverage back on the original lines — the lcov
 *    Sonar reads would otherwise point at compiled output.
 *  - Relative imports may drop the extension (`./components/LogsView`).
 *  - Stylesheets and images are imports. They load as an empty module here; no
 *    test asserts on them.
 *
 * Registered by ./register.mjs through `--import` in `npm test`.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const ASSET = /\.(css|png|svg|jpe?g|gif|webp|woff2?)$/i;
const ASSET_URL = 'stub-asset:';
const TRY_SUFFIXES = ['.js', '.jsx', '/index.js', '/index.jsx'];
const NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

const isRelative = (specifier) => specifier.startsWith('./') || specifier.startsWith('../');

export async function resolve(specifier, context, nextResolve) {
  if (ASSET.test(specifier)) return { url: `${ASSET_URL}${specifier}`, shortCircuit: true };
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!isRelative(specifier) || !NOT_FOUND.has(err?.code)) throw err;
    for (const suffix of TRY_SUFFIXES) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        // Try the next candidate.
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(ASSET_URL)) {
    return { format: 'module', source: 'export default "";', shortCircuit: true };
  }
  if (url.startsWith('file:') && url.endsWith('.jsx')) {
    const file = fileURLToPath(url);
    // Coverage starts at the first generated line that maps back to the source.
    // The automatic JSX runtime's injected import maps to the first JSX site, and
    // esbuild drops comments, so either way every line above the first real
    // statement — a file's doc comment, its imports — would read as never run.
    // So: the classic transform, with its factory imported at the very start of
    // the source's own line 1. Line numbers are unchanged and line 1 is mapped.
    const source = `import { createElement as __jsxC, Fragment as __jsxF } from "react";${await readFile(file, 'utf8')}`;
    const { code } = await transform(source, {
      loader: 'jsx',
      jsx: 'transform',
      jsxFactory: '__jsxC',
      jsxFragment: '__jsxF',
      format: 'esm',
      sourcemap: 'inline',
      sourcefile: file,
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
