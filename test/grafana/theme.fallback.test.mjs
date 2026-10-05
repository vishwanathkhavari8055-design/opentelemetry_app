/**
 * Guards the Grafana theme when there is no document to read tokens from.
 *
 * buildGrafanaTheme() reads the app's CSS custom properties; where there is no
 * document (a worker, a server render, an embedding host that builds the theme
 * early) it must fall back to the current index.css values rather than hand
 * Grafana `undefined` colours, and to a 16px root rather than NaN.
 *
 * @grafana/data dereferences `window` at import, so a bare `window` object is
 * provided — with NO `document` — and removed afterwards.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const hadWindow = 'window' in globalThis;
if (!hadWindow) globalThis.window = {};
after(() => { if (!hadWindow) delete globalThis.window; });

const { buildGrafanaTheme } = await import('../../src/grafana/theme.js');

describe('buildGrafanaTheme without a document', () => {
  it('uses the fallback palette', () => {
    assert.equal(typeof document, 'undefined');
    const theme = buildGrafanaTheme();
    assert.equal(theme.isDark, true);
    assert.equal(theme.colors.primary.main, '#009688');
    assert.equal(theme.colors.background.canvas, '#131313');
    assert.equal(theme.colors.background.primary, '#262626');
    assert.equal(theme.colors.error.main, '#e5484d');
    assert.equal(theme.colors.warning.text, '#f0c274');
    assert.equal(theme.colors.text.primary, '#ffffff');
    assert.equal(theme.typography.fontFamily, "'Inter', system-ui, -apple-system, sans-serif");
    assert.equal(theme.typography.fontFamilyMonospace, "'JetBrains Mono', monospace");
  });

  it('assumes a 16px root, so body text is Grafana\'s 14px', () => {
    const theme = buildGrafanaTheme();
    assert.equal(theme.typography.htmlFontSize, 16);
    assert.equal(theme.typography.body.fontSize, '0.875rem');
  });
});
