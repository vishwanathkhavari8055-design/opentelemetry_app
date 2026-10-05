/**
 * The Grafana theme, built from THIS application's palette.
 *
 * ─── Why this file has to exist ─────────────────────────────────────────────
 *
 * Everything @grafana/ui draws inside a panel — axes, grid lines, legend text,
 * tooltips, BigValue backgrounds, gauge tracks, table rows, the variable pickers —
 * takes its colours from the THEME, NOT from our stylesheet. Skip this and you get
 * the app's own chrome wrapped around Grafana-default blue-grey panels, which reads
 * as an embedded foreign app rather than a screen of this one.
 *
 * Building the theme is necessary but NOT sufficient, and the distinction has
 * bitten once already: @grafana/ui reads it out of React context, not out of
 * `config.theme2`. See getSceneTheme() in ./bootstrap.js and
 * ./SceneThemeProvider.jsx — an unprovided theme is an ignored theme, and this
 * file is inert without that provider mounted.
 *
 * ─── The palette is READ, not restated ──────────────────────────────────────
 *
 * Every value below is READ from a --scene-* custom property that index.css
 * declares; not one colour is written here. A second copy of "#009688" in this
 * file would be a copy that silently stops matching the day someone retunes the
 * stylesheet, and the failure would be a panel that is *nearly* the right teal —
 * worse than an obviously wrong one, because nobody files it. The literals in
 * FALLBACKS are for the single case where reading fails (no document, or a
 * computed style that comes back empty) and are the current values of those same
 * properties.
 *
 * --scene-* rather than the app's own --bg-color/--surface-color for a reason:
 * this palette is scoped to the dashboard scenes. Logs, Traces, Alerts, IAM and
 * Settings keep the app greys, and styles/dashboards.css maps the app tokens onto
 * the scene tokens on `.gd-viewer`, so the CSS chrome and the panel interiors
 * cannot drift apart.
 *
 * ─── Where the values come from ─────────────────────────────────────────────
 *
 * This mapping is a port of grafana-embed/web/src/grafana/theme.js, so the two
 * consoles render a dashboard identically. Worth knowing before "simplifying"
 * anything here: that project reaches Grafana's DOM with ZERO CSS overrides —
 * every bit of how a scene looks (table density, cell dividers, header weight,
 * legend and axis colour, gauge tracks, BigValue backgrounds) comes out of this
 * object. Restyling a panel therefore means changing a token, not writing a
 * `.gd-scene table td` rule that the next @grafana/ui bump will break.
 *
 * The palette is six colours, but a dense table needs more than six STEPS, so
 * the ladders in index.css supply them as alpha variants of the same colours —
 * an #ffffff at 62% is still #ffffff. Three of those steps matter most here:
 * text.secondary/disabled (column headings, legends) and border.weak/medium,
 * which Grafana draws every cell divider and header rule from. Collapsing those
 * to one solid grey is what makes a table read as a wireframe.
 *
 * ─── Three deliberate exceptions ────────────────────────────────────────────
 *
 *  - accent hover/press (--scene-accent-hover/-press) are the only values in
 *    play that are neither one of the six nor an alpha of one. A solid teal
 *    button whose hover state is the same teal reads as disabled, and
 *    brightening the fill in CSS also brightens the label sitting on it.
 *  - error / warning keep their own hues, and are the SCENE's
 *    (--scene-danger/-warning), not the app's --error-color/--warn-color: those
 *    are tuned as fills on the app's lighter chrome and manage only ~3:1 on a
 *    #262626 panel, which is where "the query failed" becomes "the query is a
 *    slightly warm grey".
 *  - the VISUALIZATION palette (series colours) is left as Grafana's classic
 *    palette. Dashboards set their own via fieldConfig — the HEALTHY / WARNING /
 *    CRITICAL dots and tinted cells on Microservice Monitoring are threshold
 *    steps authored in Grafana, and the panel titles print the colour legend as
 *    text ("Errors: 🟢<10 · 🟠≥10 · 🔴≥100"). Forcing those to the accent would
 *    override the dashboard's own rules, make the printed legends lie, and turn a
 *    six-series graph into six teal lines.
 */

import { createTheme } from '@grafana/data';

/** Current values of the index.css properties, used only when reading fails. */
const FALLBACKS = {
  '--scene-bg': '#131313',
  '--scene-surface': '#262626',
  '--scene-border': '#404040',
  '--scene-tint': 'rgba(64, 64, 64, 0.4)',
  '--scene-accent': '#009688',
  '--scene-text': '#ffffff',

  '--scene-ink-muted': 'rgba(255, 255, 255, 0.62)',
  '--scene-ink-subtle': 'rgba(255, 255, 255, 0.42)',
  '--scene-ink-faint': 'rgba(255, 255, 255, 0.28)',

  '--scene-stroke-weak': 'rgba(64, 64, 64, 0.4)',
  '--scene-stroke': '#404040',
  '--scene-stroke-strong': 'rgba(255, 255, 255, 0.22)',

  '--scene-accent-hover': '#00a595',
  '--scene-accent-press': '#00796b',
  '--scene-accent-soft': 'rgba(0, 150, 136, 0.16)',
  '--scene-accent-softer': 'rgba(0, 150, 136, 0.08)',
  '--scene-disabled-bg': 'rgba(64, 64, 64, 0.24)',

  '--scene-danger': '#e5484d',
  '--scene-danger-text': '#ff9498',
  '--scene-warning': '#e2a336',
  '--scene-warning-text': '#f0c274',

  '--font-sans': "'Inter', system-ui, -apple-system, sans-serif",
  '--font-mono': "'JetBrains Mono', monospace",
};

function readToken(name) {
  if (typeof document === 'undefined' || !document.documentElement) {
    return FALLBACKS[name];
  }
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return value?.trim() || FALLBACKS[name];
  } catch {
    // Some embedding contexts refuse getComputedStyle before first paint.
    return FALLBACKS[name];
  }
}

/**
 * The font size the DOCUMENT's root element actually uses.
 *
 * ─── Why Grafana has to be TOLD this ────────────────────────────────────────
 *
 * Grafana expresses every typography size as `rem`, not px: createTypography()
 * in @grafana/data builds each variant through
 *
 *     pxToRem = (size) => `${size / htmlFontSize * coef}rem`
 *
 * and `htmlFontSize` defaults to 14 because native Grafana makes that arithmetic
 * true — its <GlobalStyles> sets `html { font-size: 14px }`.
 *
 * This application does NOT render GlobalStyles, and must not: it is an emotion
 * GLOBAL style that also repoints `html`, `body`, every heading and `p`, which
 * would restyle Logs, Traces, Metrics, Alerts, IAM and Settings to Grafana's
 * defaults. So the root element stays at the browser's 16px while Grafana goes on
 * dividing by 14 — and every panel title, axis tick, legend label and table cell
 * renders at 16/14 = 1.143x the size it was designed at. Nothing looks broken;
 * everything is uniformly a shade too big, which is precisely what reads as "this
 * is not Grafana" without being nameable.
 *
 * Telling Grafana the real root size fixes it at the layer that owns the
 * conversion. The rem values it emits then resolve to the pixels it means, with
 * no global stylesheet and not one per-element override anywhere.
 *
 * READ rather than hardcoded to 16, because the root size is not ours to assume:
 * a browser or accessibility default, an embedding host, or a future `html` rule
 * in index.css all move it, and each one would silently re-open this bug.
 */
const FALLBACK_HTML_FONT_SIZE = 16;

/**
 * How large panel text is, relative to the grafana-embed reference console.
 *
 * ─── THIS IS THE TEXT-SIZE KNOB. Change this one number. ────────────────────
 *
 *   1     identical to grafana-embed (current) — body 14px, headings 28/18px
 *   0.9   10% smaller                          — body 12.6px, small text 10.8px
 *   0.85  15% smaller                          — body 11.9px, small text 10.2px
 *   0.8   20% smaller                          — body 11.2px, small text 9.6px
 *
 * At 1 this app and grafana-embed paint the SAME PIXELS from two different
 * routes, which is worth understanding before touching either side:
 *
 *   grafana-embed  renders <GlobalStyles/>, so `html` becomes 14px, and it
 *                  leaves htmlFontSize at Grafana's default 14 -> body = 1rem
 *                  = 14px.
 *   this app        cannot render GlobalStyles (it is an emotion GLOBAL style
 *                  and would restyle Logs, Traces, Metrics, Alerts, IAM and
 *                  Settings), so `html` stays at the browser's 16px and we tell
 *                  Grafana that instead -> body = 0.875rem = 14px.
 *
 * Verified equal at every step of the ladder: h1 28, h2 24, h3 22, h4 18, h5 16,
 * h6 14, body 14, bodySmall 12.
 *
 * ─── Why it is applied to htmlFontSize and not to typography.fontSize ───────
 *
 * `typography.fontSize` looks like the obvious lever and is the wrong one twice
 * over. createTypography() feeds it to buildVariant(), which THROWS on any odd
 * number ("Font size and line height should be integer multiples of 2"), so the
 * knob only has notches at 14, 12, 10. And it does not scale the ladder
 * uniformly: at 12 the `body` step lands on 10.3px — the same value as
 * `bodySmall` — so column headings and legends stop being distinguishable from
 * body text and every table reads flat.
 *
 * Dividing the rem denominator instead scales every variant by exactly the same
 * factor, because that is all pxToRem() does: painted px = size / htmlFontSize *
 * root. The proportions Grafana designed stay intact and only the overall size
 * moves — verified across 1 / 0.95 / 0.9 / 0.85 / 0.8, with body > bodySmall at
 * every step. It also composes with the root-size reading below rather than
 * fighting it: a host page at a different root font size still lands on the same
 * relative result.
 */
const TEXT_SCALE = 1;

function readRootFontSize() {
  if (typeof document === 'undefined' || !document.documentElement) {
    return FALLBACK_HTML_FONT_SIZE;
  }
  try {
    const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number.isFinite(size) && size > 0 ? size : FALLBACK_HTML_FONT_SIZE;
  } catch {
    // Same contexts as readToken() — before first paint there is nothing to read.
    return FALLBACK_HTML_FONT_SIZE;
  }
}

/**
 * Build the theme.
 *
 * A function rather than a module constant so it runs after the stylesheet is in
 * the document — a constant evaluated at import time would read every property as
 * empty and quietly fall back to the literals above, which defeats the whole
 * point of reading them.
 */
export function buildGrafanaTheme() {
  const base = readToken('--scene-bg');
  const surface = readToken('--scene-surface');
  const raised = readToken('--scene-border');
  const veil = readToken('--scene-tint');
  const accent = readToken('--scene-accent');
  const ink = readToken('--scene-text');

  const inkMuted = readToken('--scene-ink-muted');
  const inkSubtle = readToken('--scene-ink-subtle');

  const strokeWeak = readToken('--scene-stroke-weak');
  const stroke = readToken('--scene-stroke');
  const strokeStrong = readToken('--scene-stroke-strong');

  const accentHover = readToken('--scene-accent-hover');
  const accentPress = readToken('--scene-accent-press');
  const accentSoft = readToken('--scene-accent-soft');
  const disabledBg = readToken('--scene-disabled-bg');

  // The two hues the palette deliberately does not contain — see the header.
  const danger = readToken('--scene-danger');
  const dangerText = readToken('--scene-danger-text');
  const warning = readToken('--scene-warning');
  const warningText = readToken('--scene-warning-text');

  return createTheme({
    name: 'LnM Dark',
    colors: {
      mode: 'dark',

      // The accent drives every primary affordance @grafana/ui renders: focus
      // rings, active tabs, selected variable values, spinners.
      primary: {
        main: accent,
        shade: accentHover,
        text: accent,
        border: accent,
        contrastText: ink,
      },
      secondary: {
        main: raised,
        shade: strokeStrong,
        text: ink,
        border: raised,
        contrastText: ink,
        // Ghost/secondary buttons read as the veil, not a solid slab.
        transparent: veil,
      },
      info: {
        main: accent,
        shade: accentHover,
        text: accent,
        border: accent,
        contrastText: ink,
      },
      success: {
        main: accent,
        shade: accentHover,
        text: accent,
        border: accent,
        contrastText: ink,
      },
      // Functional hues — see the header note on why these are not the accent.
      error: { main: danger, text: dangerText, border: danger },
      warning: { main: warning, text: warningText, border: warning },

      text: {
        primary: ink,
        secondary: inkMuted,
        disabled: inkSubtle,
        link: accent,
        maxContrast: ink,
      },

      background: {
        canvas: base,       // behind the dashboard grid
        primary: surface,   // panel bodies
        secondary: raised,  // things that must lift off a panel
      },

      // Three weights, separated by alpha rather than hue. This is the single
      // change that most affects how a dense table reads: Grafana draws cell
      // dividers from `weak` and header rules from `medium`, so collapsing them
      // to one solid grey turns a table into a wireframe.
      border: {
        weak: strokeWeak,
        medium: stroke,
        strong: strokeStrong,
      },

      action: {
        hover: veil,
        hoverOpacity: 0.08,
        // Teal-tinted rather than grey: a selected row should read as chosen,
        // not merely as hovered, and `hover` above is already the veil.
        selected: accentSoft,
        selectedBorder: accent,
        // The same soft tint as `selected`, NOT the stronger --scene-accent-ring.
        // Grafana paints this behind the focused item of an open dropdown, and
        // arrow-keying down a list at 35% teal per step is a strobe. The ring is
        // for a single focused control (the live dot's halo), not a list row.
        focus: accentSoft,
        disabledBackground: disabledBg,
        disabledText: inkSubtle,
        disabledOpacity: 0.45,
      },

      gradients: {
        brandHorizontal: `linear-gradient(90deg, ${accent} 0%, ${accentHover} 100%)`,
        brandVertical: `linear-gradient(0.01deg, ${accentPress} 0.01%, ${accent} 99.99%)`,
      },

      contrastThreshold: 3,
      hoverFactor: 0.03,
      tonalOffset: 0.15,
    },

    shape: {
      // Matches the control radii the app's own stylesheet uses; Grafana's
      // default is rounder and reads as a consumer app next to this chrome.
      borderRadius: (amount = 1) => `${4 * amount}px`,
    },

    typography: {
      fontFamily: readToken('--font-sans'),
      fontFamilyMonospace: readToken('--font-mono'),
      // What Grafana divides by when it converts its px sizes to rem. See
      // readRootFontSize(): get this wrong and EVERY size in every panel is off
      // by the ratio between it and the document's real root font size.
      //
      // Divided by TEXT_SCALE, which is what makes panel text smaller than
      // Grafana's native sizes — a LARGER denominator means smaller rem values
      // means smaller text. Scale of 1 divides by nothing and gives exact parity.
      htmlFontSize: readRootFontSize() / TEXT_SCALE,
    },
  });
}
