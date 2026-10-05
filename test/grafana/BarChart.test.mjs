/**
 * Guards the SVG bar chart that stands in for Grafana's barchart panel, which
 * @grafana/ui does not ship.
 *
 * What it must get right is where the ink goes: frames JOINED on their x values
 * (a Prometheus query with a label returns one frame per series), gaps drawn as
 * gaps rather than zero-height bars, a baseline always on the axis, stacks that
 * accumulate positives and negatives separately, and labels formatted by each
 * field's own display processor. Rendered with real, override-processed
 * DataFrames — the exact input VizPanel hands the panel.
 */
import './grafanaEnv.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { theme, processedFrames as process } from './grafanaEnv.mjs';

const React = (await import('react')).default;
const { render, cleanup } = await import('@testing-library/react');
const { BarChart, BAR_FILL_OPACITY } = await import('../../src/grafana/BarChart.jsx');
const { barChartPanelPlugin } = await import('../../src/grafana/panelsExtra.jsx');

/** Frames processed with the barchart plugin's own defaults (palette-classic, fill 80). */
const processedFrames = (frames, fieldConfig = { defaults: {}, overrides: [] }) => (
  process(frames, fieldConfig, barChartPanelPlugin.fieldConfigRegistry)
);

const str = (name, values) => ({ name, type: 'string', values });
const num = (name, values, config) => ({ name, type: 'number', values, config });

const draw = (series, props = {}) => render(React.createElement(BarChart, {
  series, width: 400, height: 200, options: { legend: { showLegend: false } }, theme, ...props,
}));

const bars = (container) => [...container.querySelectorAll('svg rect')].map((r) => ({
  x: Number(r.getAttribute('x')),
  y: Number(r.getAttribute('y')),
  width: Number(r.getAttribute('width')),
  height: Number(r.getAttribute('height')),
  fill: r.getAttribute('fill'),
  opacity: Number(r.getAttribute('fill-opacity')),
  title: r.parentElement.querySelector('title')?.textContent,
}));
const texts = (container) => [...container.querySelectorAll('svg text')].map((t) => t.textContent);
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

describe('BarChart', () => {
  afterEach(cleanup);

  it('says "No data" for no frames, empty frames, or frames with no numeric field', () => {
    for (const series of [undefined, [], [{ fields: [] }], processedFrames([{ fields: [str('s', ['a'])] }]),
      processedFrames([{ fields: [str('s', []), num('v', [])] }])]) {
      const { container } = draw(series);
      assert.equal(container.textContent, 'No data');
      cleanup();
    }
  });

  it('draws one bar per category, heights proportional to value from a zero baseline', () => {
    const { container } = draw(processedFrames([{ fields: [str('svc', ['a', 'b', 'c']), num('count', [10, 20, 5])] }]));
    const drawn = bars(container);
    assert.equal(drawn.length, 3);
    close(drawn[1].height, drawn[0].height * 2, 'b is twice a');
    close(drawn[0].height, drawn[2].height * 2, 'a is twice c');
    // Vertical: all bars rest on the same baseline.
    close(drawn[0].y + drawn[0].height, drawn[1].y + drawn[1].height, 'common baseline');
    assert.ok(drawn[0].x < drawn[1].x && drawn[1].x < drawn[2].x, 'first-seen category order');
    assert.deepEqual(drawn.map((b) => b.title), ['a · count: 10', 'b · count: 20', 'c · count: 5']);
    assert.equal(drawn[0].opacity, BAR_FILL_OPACITY / 100);
    const labels = texts(container);
    for (const expected of ['0', '5', '10', '15', '20', 'a', 'b', 'c']) {
      assert.ok(labels.includes(expected), `axis label ${expected}`);
    }
    assert.equal(container.querySelector('svg').getAttribute('aria-label'), 'Bar chart');
  });

  it('joins frames on their x values, leaving a gap where a series has no value', () => {
    const series = processedFrames([
      { refId: 'A', fields: [str('region', ['eu', 'us']), num('A', [4, 8])] },
      { refId: 'B', fields: [str('region', ['us', 'ap']), num('B', [2, 6])] },
    ]);
    const { container } = draw(series);
    const titles = bars(container).map((b) => b.title).sort();
    assert.deepEqual(titles, ['ap · B: 6', 'eu · A: 4', 'us · A: 8', 'us · B: 2']);
    const labels = texts(container);
    for (const c of ['eu', 'us', 'ap']) assert.ok(labels.includes(c));
  });

  it('draws a null as a gap, never as a bar at zero, and reads Vector-style .get() values', () => {
    const [frame] = processedFrames([{ fields: [str('k', ['x', 'y', 'z']), num('v', [3, null, 0])] }]);
    const valueField = frame.fields[1];
    const raw = valueField.values;
    const vectorFrame = {
      ...frame,
      fields: [frame.fields[0], { ...valueField, values: { length: raw.length, get: (i) => raw[i] } }],
    };
    const drawn = bars(draw([vectorFrame]).container);
    // x has a bar, y has none, z is a real zero: present but zero-extent.
    assert.deepEqual(drawn.map((b) => b.title), ['x · v: 3', 'z · v: 0']);
    assert.equal(drawn[1].height, 0);
  });

  it('falls back to row ordinals for a frame with no string or time field', () => {
    const { container } = draw(processedFrames([{ fields: [num('a', [1, 2]), num('b', [3, 4])] }]));
    const titles = bars(container).map((b) => b.title);
    assert.deepEqual(titles, ['1 · a: 1', '1 · b: 3', '2 · a: 2', '2 · b: 4']);
  });

  it('uses the xField the panel names, matched by display name', () => {
    const series = processedFrames([{
      fields: [str('ignored', ['p', 'q']), { ...str('x_axis_1', ['m', 'n']), config: { displayName: 'DAG' } }, num('v', [1, 2])],
    }]);
    const titles = bars(draw(series, { options: { xField: 'DAG', legend: { showLegend: false } } }).container).map((b) => b.title);
    assert.deepEqual(titles, ['m · v: 1', 'n · v: 2']);
  });

  it('formats labels through the field display processor (units)', () => {
    const series = processedFrames(
      [{ fields: [str('k', ['a']), num('lat', [250])] }],
      { defaults: { unit: 'ms' }, overrides: [] },
    );
    const { container } = draw(series);
    assert.equal(bars(container)[0].title, 'a · lat: 250 ms');
  });

  it('goes horizontal on a tall tile or when asked, lengths proportional to value', () => {
    const series = processedFrames([{ fields: [str('k', ['a', 'b']), num('v', [10, 30])] }]);
    for (const props of [{ width: 200, height: 400 }, { options: { orientation: 'horizontal', legend: { showLegend: false } } }]) {
      const drawn = bars(draw(series, props).container);
      close(drawn[1].width, drawn[0].width * 3, 'b is three times a');
      close(drawn[0].x, drawn[1].x, 'common baseline on the left');
      assert.ok(drawn[0].y < drawn[1].y);
      cleanup();
    }
    // …and stays vertical on a tall tile that asked for vertical.
    const drawn = bars(draw(series, { width: 200, height: 400, options: { orientation: 'vertical' } }).container);
    close(drawn[0].y + drawn[0].height, drawn[1].y + drawn[1].height, 'vertical baseline');
  });

  it('stacks series, accumulating positives upward and negatives downward separately', () => {
    const series = processedFrames([{ fields: [str('k', ['a']), num('p1', [2]), num('p2', [3]), num('n1', [-4])] }]);
    const [p1, p2, n1] = bars(draw(series, { options: { stacking: 'normal', legend: { showLegend: false } } }).container);
    // p2 sits directly on top of p1; n1 hangs below the baseline p1 starts from.
    close(p2.y + p2.height, p1.y, 'p2 on top of p1');
    close(p1.height * 3, p2.height * 2, 'heights 2:3');
    close(n1.y, p1.y + p1.height, 'negative starts at the baseline');
    close(n1.height * 2, p1.height * 4, 'negative is 4 units');
    // Stacked bars share one column.
    close(p1.x, p2.x, 'same column');
  });

  it('reads stacking from the field config form too, and normalises percent stacks', () => {
    const series = processedFrames([{ fields: [str('k', ['a', 'b']), num('x', [1, 0]), num('y', [3, 0])] }]);
    const { container } = draw(series, {
      options: { legend: { showLegend: false } },
      fieldConfig: { defaults: { custom: { stacking: { mode: 'percent' } } } },
    });
    const labels = texts(container);
    assert.ok(labels.includes('0%') && labels.includes('100%'), `percent ticks in ${labels}`);
    const [x, y] = bars(container);
    close(x.height * 3, y.height, 'x is 25%, y is 75%');
    close(y.y + y.height, x.y, 'y on top of x');
  });

  it('honours explicit min/max from the field config', () => {
    const series = processedFrames(
      [{ fields: [str('k', ['a']), num('v', [50])] }],
      { defaults: { min: 0, max: 200 }, overrides: [] },
    );
    const labels = texts(draw(series).container);
    assert.ok(labels.includes('200'), `ticks run to max: ${labels}`);
  });

  it('draws value labels when asked, and never when told not to', () => {
    const series = processedFrames([{ fields: [str('k', ['a', 'b']), num('v', [-3, 7])] }]);
    const always = texts(draw(series, { options: { showValue: 'always', legend: { showLegend: false } } }).container);
    assert.ok(always.includes('7') && always.includes('-3'));
    cleanup();
    const horiz = texts(draw(series, { options: { showValue: 'always', orientation: 'horizontal', legend: { showLegend: false } } }).container);
    assert.ok(horiz.includes('7') && horiz.includes('-3'));
    cleanup();
    const stackedAlways = texts(draw(series, { options: { showValue: 'always', stacking: 'normal', legend: { showLegend: false } } }).container);
    assert.ok(stackedAlways.includes('7'));
    cleanup();
    const never = texts(draw(series, { options: { showValue: 'never', legend: { showLegend: false } } }).container);
    // Only axis labels: no bar value appears as its own text.
    assert.equal(never.filter((t) => t === '7').length, 0);
  });

  it('colours each bar by its own value under a by-value colour mode', () => {
    const series = processedFrames([{ fields: [str('k', ['low', 'high']), num('v', [10, 90])] }], {
      defaults: {
        color: { mode: 'thresholds' },
        thresholds: { mode: 'absolute', steps: [{ value: null, color: 'green' }, { value: 50, color: 'red' }] },
      },
      overrides: [],
    });
    const [low, high] = bars(draw(series).container);
    assert.notEqual(low.fill, high.fill);
    assert.equal(low.fill, theme.visualization.getColorByName('green'));
    assert.equal(high.fill, theme.visualization.getColorByName('red'));
  });

  it('applies fill opacity and line width from custom config, clamped', () => {
    const series = processedFrames([{ fields: [str('k', ['a']), num('v', [1])] }], {
      defaults: { custom: { fillOpacity: 250, lineWidth: 0 } }, overrides: [],
    });
    const rect = draw(series).container.querySelector('svg rect');
    assert.equal(rect.getAttribute('fill-opacity'), '1');
    assert.equal(rect.getAttribute('stroke'), 'none');
  });

  it('drops a field hidden from the viz', () => {
    const series = processedFrames([{
      fields: [str('k', ['a']), num('shown', [1]), num('hidden', [2], { custom: { hideFrom: { viz: true } } })],
    }]);
    assert.deepEqual(bars(draw(series).container).map((b) => b.title), ['a · shown: 1']);
  });

  it('rotates, truncates, and thins category labels rather than overlapping them', () => {
    const cats = Array.from({ length: 40 }, (_, i) => `category-number-${i}`);
    const series = processedFrames([{ fields: [str('k', cats), num('v', cats.map((_, i) => i + 1))] }]);
    const thinned = texts(draw(series, { width: 400, height: 200, options: { legend: { showLegend: false } } }).container)
      .filter((t) => t.startsWith('category'));
    assert.ok(thinned.length > 0 && thinned.length < cats.length, `some labels dropped: ${thinned.length}`);
    cleanup();

    const { container } = draw(series, { options: { xTickLabelRotation: -45, xTickLabelMaxLength: 8, legend: { showLegend: false } } });
    const rotated = [...container.querySelectorAll('svg text')].filter((t) => t.textContent.startsWith('categ'));
    assert.equal(rotated.length, cats.length, 'every label kept once rotated');
    assert.equal(rotated[0].textContent, 'categor…');
    assert.match(rotated[0].getAttribute('transform'), /^rotate\(-45 /);
    assert.equal(rotated[0].getAttribute('text-anchor'), 'end');
    cleanup();
    const positive = [...draw(series, { options: { xTickLabelRotation: 30, legend: { showLegend: false } } })
      .container.querySelectorAll('svg text')].find((t) => t.textContent.startsWith('categ'));
    assert.equal(positive.getAttribute('text-anchor'), 'start');
  });

  it('renders an empty box when the tile is too small to plot in', () => {
    const series = processedFrames([{ fields: [str('k', ['a']), num('v', [1])] }]);
    const { container } = draw(series, { width: 20, height: 20 });
    assert.equal(container.querySelector('svg'), null);
    assert.equal(container.firstChild.style.width, '20px');
  });

  it("falls back to the raw value when a field's display processor throws", () => {
    const [frame] = processedFrames(
      [{ fields: [str('k', ['a']), num('v', [42])] }],
      { defaults: { color: { mode: 'palette-classic' } }, overrides: [] },
    );
    frame.fields[1] = { ...frame.fields[1], display: () => { throw new Error('bad unit'); } };
    assert.equal(bars(draw([frame]).container)[0].title, 'a · v: 42');
  });

  // SUSPECTED BUG: textOf() guards a throwing display processor ("costs this one
  // label its formatting, not the panel its chart"), but barPaint() calls the same
  // processor unguarded for by-value colour modes — thresholds, the stat default —
  // so the same throw takes down the whole chart there.
  it('survives a throwing display processor under a by-value colour mode', { skip: 'suspected bug: barPaint() calls field.display() unguarded' }, () => {
    const [frame] = processedFrames(
      [{ fields: [str('k', ['a']), num('v', [42])] }],
      { defaults: { color: { mode: 'thresholds' } }, overrides: [] },
    );
    frame.fields[1] = { ...frame.fields[1], display: () => { throw new Error('bad unit'); } };
    assert.equal(bars(draw([frame]).container)[0].title, 'a · v: 42');
  });

  describe('legend', () => {
    // The legend is the chart's sibling; the SVG's own <title>s name every series too.
    const legendText = (container) => container.firstChild.children[1]?.textContent ?? '';

    const series = () => processedFrames([{
      fields: [str('k', ['a', 'b']), num('alpha', [1, 5]), num('beta', [2, 3], { custom: { hideFrom: { legend: true } } })],
    }]);

    it('lists each series once by default, below the chart, omitting ones hidden from it', () => {
      const { container } = draw(series(), { options: {} });
      const text = legendText(container);
      assert.match(text, /alpha/);
      assert.doesNotMatch(text, /beta/);
      assert.equal(container.firstChild.style.flexDirection, 'column');
    });

    it('sits on the right when placed there', () => {
      const { container } = draw(series(), { options: { legend: { placement: 'right' } } });
      assert.equal(container.firstChild.style.flexDirection, 'row');
      assert.match(legendText(container), /alpha/);
    });

    it('is absent when hidden', () => {
      const { container } = draw(series(), { options: { legend: { displayMode: 'hidden' } } });
      assert.equal(container.firstChild.children.length, 1);
      assert.equal(legendText(container), '');
    });

    it('shows the requested calcs in table mode, formatted by the field', () => {
      const { container } = draw(series(), {
        width: 600, height: 300,
        options: { legend: { displayMode: 'table', calcs: ['max', 'mean'] } },
      });
      const text = legendText(container);
      assert.match(text, /alpha/);
      assert.match(text, /Max/i);
      assert.match(text, /5/);
      assert.match(text, /3/);
    });
  });
});
