/**
 * Guards the timeseries and stat renderers, which draw with @grafana/ui's own
 * TimeSeries and BigValue.
 *
 * Their job on top of the library is the part Grafana's panel code normally
 * does: never hand GraphNG the zero-field frame Prometheus returns for an empty
 * series (it crashes on it), show a failed query as an error rather than as "No
 * data", and map the dashboard's stat options — text mode, colour mode, graph
 * mode, orientation, reduce options — onto BigValue so a multi-series stat shows
 * every series. Rendered as VizPanel renders them: `plugin.panel` with PanelProps.
 */
import './grafanaEnv.mjs';
import { describe, it, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { processedFrames, installFakeCanvas } from './grafanaEnv.mjs';

const React = (await import('react')).default;
const { render, cleanup, screen, act } = await import('@testing-library/react');
const { dateTime } = await import('@grafana/data');
const { statPanelPlugin, timeseriesPanelPlugin } = await import('../../src/grafana/panels.jsx');

const THRESHOLDS = { mode: 'absolute', steps: [{ value: null, color: 'green' }, { value: 80, color: 'red' }] };

function renderPanel(plugin, { frames = [], fieldConfig = { defaults: { thresholds: THRESHOLDS }, overrides: [] }, data, ...props } = {}) {
  const series = processedFrames(frames, fieldConfig, plugin.fieldConfigRegistry);
  return render(React.createElement(plugin.panel, {
    data: data ?? { state: 'Done', series },
    width: 400,
    height: 200,
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

const t0 = Date.UTC(2026, 0, 1);
const timeFrame = (name, values) => ({
  fields: [
    { name: 'time', type: 'time', values: values.map((_, i) => t0 + i * 60_000) },
    { name, type: 'number', values },
  ],
});

describe('panels', () => {
  afterEach(cleanup);

  describe('timeseries', () => {
    it('shows the query error, whichever way the result carries it', () => {
      renderPanel(timeseriesPanelPlugin, { data: { state: 'Error', errors: [{ message: 'bad PromQL' }], series: [] } });
      assert.ok(screen.getByText('bad PromQL'));
      cleanup();
      renderPanel(timeseriesPanelPlugin, { data: { state: 'Error', series: [] } });
      assert.ok(screen.getByText('Query error'));
    });

    it('says "No data" rather than handing GraphNG a frame it cannot draw', () => {
      renderPanel(timeseriesPanelPlugin, {
        data: {
          state: 'Done',
          series: [
            { fields: [], length: 0 },                                               // Prometheus' empty series
            ...processedFrames([{ fields: [{ name: 'v', type: 'number', values: [1] }] }]), // no time
            ...processedFrames([{ fields: [{ name: 't', type: 'time', values: [t0] }] }]),  // no value
          ],
        },
      });
      assert.ok(screen.getByText('No data'));
      cleanup();
      renderPanel(timeseriesPanelPlugin, { data: undefined });
      assert.ok(screen.getByText('No data'));
    });

    it('hands a graphable frame to TimeSeries with its legend', () => {
      const from = dateTime(t0);
      const to = dateTime(t0 + 5 * 60_000);
      const { container } = renderPanel(timeseriesPanelPlugin, {
        frames: [timeFrame('requests', [1, 2, 3, 4, 5])],
        data: undefined,
        timeRange: { from, to, raw: { from: 'now-5m', to: 'now' } },
        options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] } },
        onChangeTimeRange: () => {},
      });
      assert.equal(screen.queryByText('No data'), null);
      assert.match(container.textContent, /requests/);
    });

    it('mounts the uPlot chart, with tooltip and zoom, on the range the result carries', async () => {
      const range = (ms) => ({ from: dateTime(t0), to: dateTime(t0 + ms), raw: { from: 'now-5m', to: 'now' } });
      const fieldConfig = { defaults: {}, overrides: [] };
      const series = processedFrames([timeFrame('requests', [1, 2, 3])], fieldConfig, timeseriesPanelPlugin.fieldConfigRegistry);
      const { container } = render(React.createElement(timeseriesPanelPlugin.panel, {
        // The result's own range wins over the scene's.
        data: { state: 'Done', series, timeRange: range(3 * 60_000) },
        timeRange: range(60 * 60_000),
        width: 400, height: 200, fieldConfig, onChangeTimeRange: () => {},
        options: { legend: { showLegend: false }, tooltip: { mode: 'multi', sort: 'desc' } },
      }));
      assert.ok(container.querySelector('[data-testid="uplot-main-div"]'));
      // Let uPlot's deferred first draw run inside the test, not after it.
      await act(() => new Promise((resolve) => { setTimeout(resolve, 30); }));
      cleanup();
      const plain = render(React.createElement(timeseriesPanelPlugin.panel, {
        data: { state: 'Done', series }, timeRange: range(60_000),
        width: 400, height: 200, fieldConfig, options: { legend: { showLegend: false } },
      }));
      assert.ok(plain.container.querySelector('[data-testid="uplot-main-div"]'));
      await act(() => new Promise((resolve) => { setTimeout(resolve, 30); }));
    });
  });

  describe('stat', () => {
    it('shows the query error instead of a value', () => {
      renderPanel(statPanelPlugin, { data: { state: 'Error', error: { message: 'timeout' }, series: [] } });
      assert.ok(screen.getByText('timeout'));
    });

    it('shows the last non-null value in the dashboard unit', () => {
      const { container } = renderPanel(statPanelPlugin, {
        frames: [timeFrame('latency', [120, 250, null])],
        fieldConfig: { defaults: { unit: 'ms', thresholds: THRESHOLDS }, overrides: [] },
      });
      assert.match(container.textContent, /250/);
      assert.match(container.textContent, /ms/);
      // One value: the panel header carries the name, so auto text mode omits it.
      assert.doesNotMatch(container.textContent, /latency/);
    });

    it('shows every series, each labelled, when there is more than one', () => {
      const { container } = renderPanel(statPanelPlugin, {
        frames: [timeFrame('alpha', [1]), timeFrame('beta', [2])],
        options: { graphMode: 'none', colorMode: 'background', orientation: 'horizontal', justifyMode: 'center' },
      });
      const text = container.textContent;
      assert.match(text, /alpha/);
      assert.match(text, /beta/);
    });

    for (const [textMode, expectName, expectValue] of [
      ['value_and_name', true, true],
      ['name', true, false],
      ['value', false, true],
      ['none', false, false],
    ]) {
      it(`honours textMode "${textMode}"`, () => {
        const { container } = renderPanel(statPanelPlugin, {
          frames: [timeFrame('gamma', [77])],
          options: { textMode, colorMode: 'background_solid', orientation: 'vertical', graphMode: 'area' },
        });
        const text = container.textContent;
        assert.equal(/gamma/.test(text), expectName, `name shown: ${text}`);
        assert.equal(/77/.test(text), expectValue, `value shown: ${text}`);
      });
    }

    it('honours reduce options and a none colour mode', () => {
      const { container } = renderPanel(statPanelPlugin, {
        frames: [timeFrame('delta', [3, 9, 6])],
        options: { reduceOptions: { calcs: ['max'], values: false, fields: '' }, colorMode: 'none', graphMode: 'none' },
      });
      assert.match(container.textContent, /9/);
    });

    it('says "No data" when there is nothing to reduce', () => {
      const { container } = renderPanel(statPanelPlugin, { data: { state: 'Done', series: [] }, fieldConfig: undefined, replaceVariables: undefined });
      assert.match(container.textContent, /No data/);
    });
  });
});
