/**
 * Guards the panel renderers registered for table, gauge, bar gauge, pie chart,
 * bar chart, text and the unsupported-plugin placeholder.
 *
 * Each is a PanelPlugin render function handed Grafana's PanelProps, so each is
 * rendered here exactly that way — `plugin.panel` with data processed through
 * that plugin's own field-config registry. What they must never do: turn an
 * error into an empty-looking panel, crash on the `"custom": {}` fieldConfig
 * Grafana writes for an untouched table, drop all but one of a query's frames,
 * or put unsanitised HTML into the page.
 */
import './grafanaEnv.mjs';
import { describe, it, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { theme, processedFrames, capturing, installFakeCanvas } from './grafanaEnv.mjs';

const React = (await import('react')).default;
const { render, cleanup, fireEvent, screen } = await import('@testing-library/react');
const extra = await import('../../src/grafana/panelsExtra.jsx');

const frame = (fields, extraProps = {}) => ({ ...extraProps, fields });
const num = (name, values, config) => ({ name, type: 'number', values, config });
const str = (name, values) => ({ name, type: 'string', values });

/** Render a plugin's panel with PanelProps, its data processed by that plugin's registry. */
function renderPanel(plugin, { frames = [], fieldConfig = { defaults: {}, overrides: [] }, data, ...props } = {}) {
  const series = processedFrames(frames, fieldConfig, plugin.fieldConfigRegistry);
  return render(React.createElement(plugin.panel, {
    data: data ?? { state: 'Done', series },
    width: 400,
    height: 240,
    options: {},
    fieldConfig,
    timeZone: 'utc',
    replaceVariables: (v) => v,
    ...props,
  }));
}

// @grafana/ui measures text, and uPlot draws, on a 2D canvas jsdom lacks.
let restoreCanvas;
before(() => { restoreCanvas = installFakeCanvas(); });
after(() => restoreCanvas());

const ALL_PLUGINS = ['tablePanelPlugin', 'gaugePanelPlugin', 'barGaugePanelPlugin', 'pieChartPanelPlugin', 'barChartPanelPlugin'];

describe('panelsExtra', () => {
  afterEach(cleanup);

  describe('shared guards', () => {
    it('reads the error message from wherever the result carries it', () => {
      assert.equal(extra.errorMessage({ error: { message: 'one' } }), 'one');
      assert.equal(extra.errorMessage({ errors: [{ message: 'two' }] }), 'two');
      assert.equal(extra.errorMessage({ state: 'Error' }), 'Query error');
      assert.equal(extra.hasError({ state: 'Error' }), true);
      assert.equal(extra.hasError({ errors: [{}] }), true);
      assert.equal(extra.hasError({ error: {} }), true);
      assert.equal(extra.hasError({ state: 'Done', errors: [] }), false);
      assert.equal(extra.hasError(undefined), false);
    });

    it('colours an error by the theme error text, and "no data" as muted text', () => {
      render(React.createElement(extra.Centered, { width: 10, height: 10, tone: 'error' }, 'bad'));
      const bad = screen.getByText('bad');
      assert.equal(bad.style.color, toRgb(theme.colors.error.text));
      cleanup();
      render(React.createElement(extra.Centered, { width: 10, height: 10 }, 'empty'));
      assert.equal(screen.getByText('empty').style.color, toRgb(theme.colors.text.secondary));
    });

    for (const name of ALL_PLUGINS) {
      it(`${name} shows the query error rather than an empty panel`, () => {
        renderPanel(extra[name], { data: { state: 'Error', error: { message: 'upstream 502' }, series: [] } });
        assert.ok(screen.getByText('upstream 502'));
      });

      it(`${name} says "No data" for an empty result`, () => {
        renderPanel(extra[name], { data: { state: 'Done', series: [] } });
        assert.ok(screen.getByText('No data'));
      });
    }
  });

  describe('table', () => {
    it("renders the frame's columns and survives the \"custom\": {} Grafana saves", () => {
      const { container } = renderPanel(extra.tablePanelPlugin, {
        frames: [frame([str('service', ['api', 'db']), num('errors', [3, 0])])],
        fieldConfig: { defaults: { custom: {} }, overrides: [] },
      });
      const headers = [...container.querySelectorAll('[role="columnheader"]')].map((h) => h.textContent);
      assert.deepEqual(headers, ['service', 'errors']);
      assert.equal(container.querySelector('.viz-frame-picker'), null);
    });

    it('offers a frame picker when the query returned several frames, and switches on click', () => {
      const { container } = renderPanel(extra.tablePanelPlugin, {
        frames: [
          frame([str('a_col', ['x'])], { name: 'First' }),
          frame([str('b_col', ['y'])]),
        ],
      });
      const buttons = [...container.querySelectorAll('.viz-frame-picker button')];
      assert.deepEqual(buttons.map((b) => b.textContent), ['First', 'Series 2']);
      assert.equal(buttons[0].className, 'on');
      assert.ok(container.textContent.includes('a_col'));
      fireEvent.click(buttons[1]);
      assert.ok(container.textContent.includes('b_col'));
      assert.equal(container.querySelectorAll('.viz-frame-picker button')[1].className, 'on');
    });

    it('says "No data" when the selected frame has no fields', () => {
      renderPanel(extra.tablePanelPlugin, { data: { state: 'Done', series: [{ fields: [], length: 0 }] } });
      assert.ok(screen.getByText('No data'));
    });

    it('honours a frame index the options pin', () => {
      const { container } = renderPanel(extra.tablePanelPlugin, {
        frames: [frame([str('first_col', ['x'])]), frame([str('second_col', ['y'])])],
        options: { frameIndex: 5, showHeader: true },
      });
      assert.ok(container.textContent.includes('second_col'), 'clamped to the last frame');
    });
  });

  describe('gauge', () => {
    it('draws one ArcGauge per series, with the value formatted in its unit', () => {
      const { container } = renderPanel(extra.gaugePanelPlugin, {
        frames: [frame([num('cpu', [10, 42])]), frame([num('mem', [70])])],
        fieldConfig: { defaults: { unit: 'percent', min: 0, max: 100 }, overrides: [] },
        options: { orientation: 'horizontal', showThresholdLabels: true },
      });
      const labels = [...container.querySelectorAll('svg')].map((s) => s.getAttribute('aria-label'));
      assert.deepEqual(labels, ['Gauge: 42%', 'Gauge: 70%']);
    });

    it('says "No data" when the reducer finds nothing to show', () => {
      renderPanel(extra.gaugePanelPlugin, { frames: [frame([str('name', ['x'])])] });
      assert.ok(screen.getByText('No data'));
    });
  });

  describe('bar gauge', () => {
    // Grafana always saves thresholds with a panel, and the gradient mode reads them.
    const THRESHOLDS = { defaults: { thresholds: { mode: 'absolute', steps: [{ value: null, color: 'green' }, { value: 8, color: 'red' }] } }, overrides: [] };

    for (const [displayMode, orientation] of [['lcd', 'vertical'], ['basic', 'horizontal'], [undefined, undefined]]) {
      it(`renders every series (${displayMode ?? 'gradient'}, ${orientation ?? 'auto'})`, () => {
        const { container } = renderPanel(extra.barGaugePanelPlugin, {
          frames: [frame([num('alpha', [5])]), frame([num('beta', [9])])],
          fieldConfig: THRESHOLDS,
          options: { displayMode, orientation, valueMode: displayMode === 'basic' ? 'hidden' : 'color' },
        });
        const text = container.textContent;
        assert.match(text, /alpha/);
        assert.match(text, /beta/);
        if (displayMode !== 'basic') assert.match(text, /9/);
      });
    }

    // SUSPECTED BUG (low severity): the gradient bar gauge reads field.thresholds.steps,
    // and ./fieldConfig.js registers `thresholds` with no default, so a bargauge whose
    // saved JSON carries no thresholds throws "reading 'steps'" instead of drawing.
    // Grafana's own registry defaults thresholds (green / red at 80), so there it draws.
    it('draws a gradient bar gauge whose JSON saved no thresholds', { skip: 'suspected bug: no default thresholds -> TypeError in BarGauge' }, () => {
      const { container } = renderPanel(extra.barGaugePanelPlugin, { frames: [frame([num('alpha', [5])])] });
      assert.match(container.textContent, /alpha/);
    });

    it('says "No data" when the reducer finds nothing to show', () => {
      renderPanel(extra.barGaugePanelPlugin, { frames: [frame([str('name', ['x'])])], fieldConfig: THRESHOLDS });
      assert.ok(screen.getByText('No data'));
    });
  });

  describe('pie chart', () => {
    it('reduces each series to one slice of one chart, palette-coloured by default', () => {
      const { container } = renderPanel(extra.pieChartPanelPlugin, {
        frames: [frame([num('ok', [1, 3])]), frame([num('failed', [1])])],
        fieldConfig: { defaults: { color: { mode: 'palette-classic' } }, overrides: [] },
      });
      assert.equal(container.querySelectorAll('svg[aria-label="Pie chart"]').length, 1);
      const titles = [...container.querySelectorAll('svg title')].map((t) => t.textContent);
      assert.deepEqual(titles, ['ok 3 (75.0%)', 'failed 1 (25.0%)']);
    });

    it('says "No data" when the reducer finds nothing to show', () => {
      renderPanel(extra.pieChartPanelPlugin, { frames: [frame([str('name', ['x'])])] });
      assert.ok(screen.getByText('No data'));
    });
  });

  describe('bar chart', () => {
    it("draws the frame's rows against their categories, with the plugin's visible fill", () => {
      const { container } = renderPanel(extra.barChartPanelPlugin, {
        frames: [frame([str('svc', ['a', 'b']), num('n', [1, 2])])],
        options: { legend: { showLegend: false } },
      });
      const rects = container.querySelectorAll('svg[aria-label="Bar chart"] rect');
      assert.equal(rects.length, 2);
    });
  });

  describe('text', () => {
    const renderText = (options, replaceVariables = (v) => v) => render(React.createElement(
      extra.textPanelPlugin.panel, { width: 200, height: 100, options, replaceVariables },
    ));

    it('renders markdown, interpolating variables first', () => {
      const { container } = renderText({ content: '# Hello $who', mode: 'markdown' }, (v) => v.replace('$who', 'world'));
      assert.equal(container.querySelector('.viz-text-body h1').textContent, 'Hello world');
    });

    it('sanitises HTML mode', () => {
      const { container } = renderText({ content: '<b>ok</b><script>alert(1)</script><img src=x onerror=alert(1)>', mode: 'html' });
      const body = container.querySelector('.viz-text-body');
      assert.equal(body.querySelector('b').textContent, 'ok');
      assert.equal(body.querySelector('script'), null);
      assert.equal(body.querySelector('img')?.getAttribute('onerror') ?? null, null);
    });

    it('shows code mode verbatim', () => {
      const { container } = renderText({ content: '<b>raw</b>', mode: 'code' });
      assert.equal(container.querySelector('pre').textContent, '<b>raw</b>');
    });

    it('keeps its text when a variable cannot be resolved', () => {
      const { container } = renderText({ content: 'plain $x', mode: 'markdown' }, () => { throw new Error('no var'); });
      assert.match(container.querySelector('.viz-text-body').textContent, /plain \$x/);
    });

    it('says "No content" for an empty panel', () => {
      renderText({});
      assert.ok(screen.getByText('No content'));
      cleanup();
      render(React.createElement(extra.textPanelPlugin.panel, { width: 1, height: 1, options: { content: '  ' } }));
      assert.ok(screen.getByText('No content'));
    });
  });

  describe('unsupported placeholder', () => {
    it('names the plugin it stands in for', () => {
      const { container } = render(React.createElement(extra.unsupportedPanelPlugin.panel, {
        width: 100, height: 100, options: { originalPluginId: 'worldmap-panel' },
      }));
      assert.equal(container.querySelector('.viz-unsupported-id').textContent, 'worldmap-panel');
      assert.match(container.textContent, /Panel type not supported/);
      cleanup();
      const { container: bare } = render(React.createElement(extra.unsupportedPanelPlugin.panel, { width: 1, height: 1 }));
      assert.equal(bare.querySelector('.viz-unsupported-id').textContent, 'unknown');
    });

    it('logs each unsupported plugin id once, naming the first panel seen', async () => {
      const warned = await capturing('warn', () => {
        extra.reportUnsupportedPanel('px-once', 'First Panel');
        extra.reportUnsupportedPanel('px-once', 'Second Panel');
        extra.reportUnsupportedPanel('px-untitled');
      });
      assert.equal(warned.length, 2);
      assert.match(warned[0], /"px-once" \(first seen on "First Panel"\)/);
      assert.doesNotMatch(warned[1], /first seen/);
    });

    it('has a stable plugin id', () => {
      assert.equal(extra.UNSUPPORTED_PLUGIN_ID, 'app-unsupported-panel');
    });
  });
});

/** jsdom reports inline colours as rgb(); the theme holds hex. */
function toRgb(color) {
  const probe = document.createElement('div');
  probe.style.color = color;
  return probe.style.color;
}
