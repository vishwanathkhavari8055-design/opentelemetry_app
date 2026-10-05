/**
 * Puts this application's Grafana theme where @grafana/ui actually looks for it.
 *
 * ─── Why this component has to exist ────────────────────────────────────────
 *
 * ./theme.js builds a theme from the --scene-* palette and ./bootstrap.js assigns
 * it to `config.theme2`. Read that pair and you would conclude the panels are
 * themed. They are not — and nothing about the code says so, which is why this
 * went unnoticed:
 *
 *   · @grafana/data creates its context as `createContext(createTheme())`. The
 *     default value is a STOCK Grafana dark theme, fixed at module-evaluation
 *     time, and `config.theme2` is never read back into it.
 *   · every emotion style in @grafana/ui resolves through `useTheme2()`, which is
 *     `useContext(ThemeContext)` — not a `config` lookup.
 *   · neither @grafana/ui nor @grafana/scenes mounts a provider of its own.
 *
 * Native Grafana supplies one high in its own tree, so nothing in the published
 * packages ever has to. A standalone app has to do it itself, and until it does,
 * the theme is built, assigned, and ignored: axes, grid lines, legends, table
 * rows and cell dividers, tooltips, BigValue, PanelChrome and the variable
 * pickers all render Grafana blue-grey inside correctly-branded chrome.
 *
 * ─── Why it is a component and not a line in bootstrap.js ───────────────────
 *
 * A React context can only be supplied by rendering a provider, so this is the
 * one part of the Grafana runtime that cannot live in the imperative bootstrap.
 * It belongs in src/grafana/ with the rest of that runtime rather than next to
 * the viewer, because what it fills is a @grafana/ui contract, not a UI concern
 * of this screen — and keeping it here holds the whole @grafana/* surface inside
 * the one directory the lazy chunk covers.
 *
 * Wrap ANY subtree that renders Grafana components in this. There is currently
 * exactly one — <scene.Component> in ../components/dashboards/DashboardSceneViewer
 * — and a second one added without this wrapper would look subtly wrong in a way
 * no error reports.
 *
 * ─── Why it also sets an inherited TEXT BASELINE ────────────────────────────
 *
 * Supplying the context is not sufficient on its own, because a large share of
 * the text Grafana renders is not sized by the theme at all — it is INHERITED:
 *
 *   · Table cell text. useTableStyles() sets fontWeight on headers and nothing
 *     else; grep the block for fontSize and there is no hit for a cell.
 *   · PanelChrome sets no font-size anywhere.
 *
 * Native Grafana gets away with that because <GlobalStyles/> puts
 * theme.typography.body onto `body`, so the whole document already sits at 14px
 * and every inherited element lands there. This app cannot render GlobalStyles —
 * it is an emotion GLOBAL style that would repoint html, body, every heading and
 * p across Logs, Traces, Metrics, Alerts, IAM and Settings — and it sets no
 * font-size baseline of its own, so inherited text fell through to the BROWSER
 * default of 16px while theme-driven text (panel titles, legends, axis ticks)
 * correctly used 14px.
 *
 * The result was a dashboard mixing two type scales, worst on a table-heavy one:
 * Microservice Monitoring is 8 tables out of 12 panels, so most of its text was
 * the inherited 16px and the theme fix appeared to do nothing at all.
 *
 * So this element carries the baseline GlobalStyles would have carried, scoped to
 * the scene. `display: contents` because it must NOT become a box: the scene's
 * own root is sized by react-grid-layout inside an overflow:auto parent, and an
 * extra block in that chain is a layout risk for no benefit. Inheritance follows
 * the ELEMENT tree, not the box tree, so the styles below still reach every
 * descendant while the wrapper itself lays nothing out.
 *
 * Colour is here for the same reason: index.css sets `body { color:
 * var(--text-primary) }`, which resolves OUTSIDE .gd-viewer to the app grey
 * #e0e0e0, so inherited table text was that rather than the scene's #ffffff.
 */

import PropTypes from 'prop-types';
import { ThemeContext } from '@grafana/data';

import { getSceneTheme } from './bootstrap';

export default function SceneThemeProvider({ children }) {
  // Not memoised, and it must not be: getSceneTheme() hands back the one theme
  // object bootstrap built, so the value is already referentially stable across
  // renders. Rebuilding it here would change identity every render and rerun
  // every memoised style in the subtree.
  const theme = getSceneTheme();

  // A guard, not a path — getSceneTheme() bootstraps on demand. Rendering
  // children unwrapped is deliberately better than providing a null: consumers
  // reach for theme.colors.* unguarded, so a null value would throw the whole
  // scene away, while no provider at all falls back to Grafana's default theme
  // and merely looks wrong.
  if (!theme) {
    console.error('[dashboards] no Grafana theme available — panels will use Grafana defaults.');
    return children;
  }

  return (
    <ThemeContext.Provider value={theme}>
      <div
        style={{
          display: 'contents',
          fontFamily: theme.typography.fontFamily,
          fontSize: theme.typography.body.fontSize,
          lineHeight: theme.typography.body.lineHeight,
          color: theme.colors.text.primary,
        }}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

SceneThemeProvider.propTypes = {
  children: PropTypes.node,
};
