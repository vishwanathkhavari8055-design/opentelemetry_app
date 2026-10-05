import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

const require = createRequire(import.meta.url)

/** Where the Dashboards screen expects Grafana's own assets to be served from. */
export const GRAFANA_ASSET_BASE = 'grafana-assets'

/**
 * Serve @grafana/ui's shipped icon assets.
 *
 * Grafana's `Icon` component — which appears in panel headers, table sort
 * indicators, legend controls and tooltips — resolves its SVGs at RUNTIME from
 * `${window.__grafana_public_path__}img/icons/<set>/<name>.svg`. Those files ship
 * inside @grafana/ui (dist/public/img, ~320KB) but nothing serves them in a
 * standalone app, so every icon 404s. The visible result is a coloured empty
 * square where the icon should be — most obviously the red "panel status" button
 * Grafana puts in a failed panel's header, which renders as a solid pink block.
 *
 * Serving them from node_modules rather than copying them into the repo is
 * deliberate: a checked-in copy of another package's assets is a copy that goes
 * stale on the next @grafana/ui upgrade, silently and only for some icons.
 */
function grafanaAssetsPlugin() {
  let assetRoot
  try {
    // Resolved through the package's own entry point so it follows whatever
    // node_modules layout is in use (hoisted, nested, pnpm store).
    assetRoot = path.join(path.dirname(require.resolve('@grafana/ui')), 'public')
  } catch {
    assetRoot = null
  }

  /** Every file under assetRoot, as paths relative to it. */
  const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory()
      ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]))

  return {
    name: 'grafana-assets',
    apply() { return !!assetRoot },

    configResolved() {
      if (!assetRoot || !fs.existsSync(assetRoot)) {
        // A warning, not a failure: dashboards render perfectly well without
        // icons, and breaking every other screen's build over them would be a
        // wildly disproportionate response.
        console.warn('[grafana-assets] @grafana/ui public assets not found — '
          + 'Grafana icons will not render inside dashboard panels.')
        assetRoot = null
      }
    },

    // Dev: a plain static middleware. No watching — these files only change when
    // @grafana/ui is upgraded, which restarts the dev server anyway.
    configureServer(server) {
      if (!assetRoot) return
      server.middlewares.use(`/${GRAFANA_ASSET_BASE}`, (req, res, next) => {
        const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '')
        const file = path.join(assetRoot, rel)
        // Containment check: `rel` comes off the wire, so a `..` in it would
        // otherwise turn this middleware into an arbitrary-file reader.
        if (!file.startsWith(assetRoot) || !fs.existsSync(file)
            || !fs.statSync(file).isFile()) {
          next()
          return
        }
        res.setHeader('Content-Type', file.endsWith('.svg')
          ? 'image/svg+xml' : 'application/octet-stream')
        res.setHeader('Cache-Control', 'max-age=3600')
        res.end(fs.readFileSync(file))
      })
    },

    // Build: emit them into the bundle so a deployed app is self-contained.
    generateBundle() {
      if (!assetRoot) return
      for (const rel of walk(assetRoot)) {
        this.emitFile({
          type: 'asset',
          fileName: `${GRAFANA_ASSET_BASE}/${rel}`,
          source: fs.readFileSync(path.join(assetRoot, rel)),
        })
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const isWc = mode === 'wc';

  return {
    base: './',
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode),
      'process.env': ({}),
      'global': 'window',
    },
    plugins: [
      react(),
      // Not in the `wc` build: the web component exposes Logs/Trace/Summary and
      // never mounts the Dashboards screen, so it needs no Grafana assets — and
      // that build is a single inlined file with nowhere to put them.
      !isWc && grafanaAssetsPlugin(),
      isWc && cssInjectedByJsPlugin(),
    ].filter(Boolean),
    build: isWc ? {
      lib: {
        entry: 'src/wc-entry.jsx',
        name: 'ObservabilityUI',
        fileName: 'observability-ui',
        formats: ['es'],
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
      // Ensure everything is bundled into the single JS file
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    } : {
      // Standard App Build
      outDir: 'dist',
    },
    // The @grafana/* packages are large and CommonJS-ish. Naming them here lets
    // esbuild pre-bundle them once instead of discovering them mid-navigation:
    // without it, the first click on Dashboards stalls while the dev server
    // crawls the dependency graph, and Vite then reloads the page to apply what
    // it found. Build output is unaffected — this is a dev-server concern only.
    optimizeDeps: {
      include: [
        '@grafana/data',
        '@grafana/ui',
        '@grafana/runtime',
        '@grafana/scenes',
        '@grafana/schema',
        'rxjs',
        // CommonJS, and reached only by the dynamic text panel renderer — so
        // without naming it here the first dashboard that has one triggers a
        // mid-navigation pre-bundle and a page reload.
        'handlebars',
      ],
    },
    server: {
      proxy: {
        // Observability backend. This is the ONLY upstream the dev server
        // proxies — the app talks to nothing else.
        //
        // Target is overridable so a second backend can be run alongside the
        // usual one (`OBS_API_TARGET=http://localhost:8092 npm run dev`) —
        // useful when testing a backend change without stopping the instance
        // already on 8081. Unset, it behaves exactly as before.
        '/OpentelemetryService/api': {
          target: process.env.OBS_API_TARGET || 'http://localhost:8081',
          changeOrigin: true,
          // Strip `Origin` before forwarding.
          //
          // The browser treats /OpentelemetryService/api as SAME-ORIGIN, so it
          // applies no CORS rules of its own — but it still sends an `Origin`
          // header on POST/PUT/PATCH/DELETE (only GET and HEAD are exempt), and
          // this proxy forwarded it verbatim. Spring then saw a cross-origin
          // request from `http://localhost:<whatever port Vite picked>` and
          // answered every write with a bodyless `403 Invalid CORS request`.
          //
          // The symptom is genuinely misleading: GETs carry no Origin, so a
          // dashboard would load — title, version, folder, layout — and then
          // every panel would report "Request failed (HTTP 403)", which reads as
          // a Grafana or token problem. Vite walking up from 5173 to 5174 when
          // the port is taken is enough to trigger it.
          //
          // `changeOrigin` only rewrites Host, not Origin. Dropping Origin here
          // is what makes the backend see the plain same-origin request the
          // browser actually made. The backend is hardened for this too
          // (cors.allowed-origin-patterns), so either half fixes it alone.
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
          },
        },
      }
    }
  };
})
