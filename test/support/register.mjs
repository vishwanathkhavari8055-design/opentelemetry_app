/** Installs ./hooks.mjs for every test file. Loaded with `--import` from `npm test`. */
import { createRequire, register } from 'node:module';

register('./hooks.mjs', import.meta.url);

// The ESM hooks never see a CommonJS `require('x.css')`, and @grafana/ui's
// dependencies make a few (rc-time-picker's stylesheet, for one). Loaded as an
// empty module, like the ESM stylesheet imports.
const require = createRequire(import.meta.url);
require.extensions['.css'] = (module) => {
  module.exports = {};
};
