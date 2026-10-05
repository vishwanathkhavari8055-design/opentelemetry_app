/**
 * Guards the SVG pie/donut that stands in for Grafana's piechart panel, which
 * @grafana/ui does not ship.
 *
 * A part-of-whole chart has a few ways to lie quietly: a zero or negative value
 * taking a slice, a single 100% slice drawn as a zero-length arc (a blank
 * panel), legend rows and slices disagreeing about what hideFrom hid, labels in
 * a unit the dashboard never asked for. Fed real FieldDisplay values from
 * @grafana/data's own reducer, as the panel does.
 */
import './grafanaEnv.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { theme, data, processedFrames } from './grafanaEnv.mjs';

const React = (await import('react')).default;
const { render, cleanup } = await import('@testing-library/react');
const { PieChart } = await import('../../src/grafana/PieChart.jsx');

/**
 * One FieldDisplay per series, reduced to its last value — the panel's default —
 * from frames already through applyFieldOverrides, as VizPanel hands them over.
 */
const displays = (series, defaults = {}) => {
  const fieldConfig = { defaults: { color: { mode: 'palette-classic' }, ...defaults }, overrides: [] };
  return data.getFieldDisplayValues({
    data: processedFrames(series.map((s) => ({
      fields: [{ name: s.name, type: 'number', values: [s.value], config: s.config ?? {} }],
    })), fieldConfig),
    reduceOptions: { calcs: ['lastNotNull'], values: false },
    fieldConfig,
    replaceVariables: (v) => v,
    theme,
    timeZone: 'utc',
  });
};

const draw = (values, props = {}) => render(React.createElement(PieChart, {
  values, width: 300, height: 300, options: {}, theme, ...props,
}));

const slices = (container) => [...container.querySelectorAll('svg > g')].map((g) => ({
  shape: g.firstElementChild.tagName,
  d: g.querySelector('path')?.getAttribute('d'),
  fill: g.firstElementChild.getAttribute('fill'),
  stroke: g.firstElementChild.getAttribute('stroke'),
  title: g.querySelector('title').textContent,
  label: g.querySelector('text')?.textContent,
}));
const legendRows = (container) => [...(container.firstChild.children[1]?.children ?? [])]
  .map((row) => [...row.children].slice(1).map((c) => c.textContent));

describe('PieChart', () => {
  afterEach(cleanup);

  it('says "No data" when nothing is positive', () => {
    for (const values of [undefined, [], displays([{ name: 'a', value: 0 }, { name: 'b', value: -3 }])]) {
      assert.equal(draw(values).container.textContent, 'No data');
      cleanup();
    }
  });

  it('gives each positive value a slice sized by its share, with name, value and percent', () => {
    const { container } = draw(displays([
      { name: 'ok', value: 30 }, { name: 'zero', value: 0 }, { name: 'err', value: 10 },
    ]));
    const drawn = slices(container);
    assert.equal(drawn.length, 2);
    assert.deepEqual(drawn.map((s) => s.title), ['ok 30 (75.0%)', 'err 10 (25.0%)']);
    assert.ok(drawn.every((s) => s.shape === 'path'));
    // Pie, not donut: each slice is a wedge from the centre.
    assert.ok(drawn[0].d.startsWith('M 150 '), drawn[0].d);
    // 75% sweeps more than half the circle — the large-arc flag says so.
    assert.match(drawn[0].d, / A [\d.]+ [\d.]+ 0 1 1 /);
    assert.match(drawn[1].d, / A [\d.]+ [\d.]+ 0 0 1 /);
    assert.notEqual(drawn[0].fill, drawn[1].fill, 'palette gives each slice its own colour');
    assert.equal(container.querySelector('svg').getAttribute('aria-label'), 'Pie chart');
  });

  it('draws a single 100% slice as a stroked circle, not a zero-length arc', () => {
    const drawn = slices(draw(displays([{ name: 'all', value: 5 }])).container);
    assert.equal(drawn.length, 1);
    assert.equal(drawn[0].shape, 'circle');
    assert.equal(drawn[0].fill, 'none');
    assert.ok(drawn[0].stroke);
  });

  it('cuts a hole in a donut', () => {
    const { container } = draw(displays([{ name: 'a', value: 1 }, { name: 'b', value: 1 }]), {
      options: { pieType: 'donut' },
    });
    const [first] = slices(container);
    // Outer arc, a line in, and an inner arc back the other way.
    assert.match(first.d, /A .* L .* A [\d.]+ [\d.]+ 0 0 0 /);
    cleanup();
    const circle = draw(displays([{ name: 'a', value: 1 }]), { options: { pieType: 'donut' } })
      .container.querySelector('circle');
    assert.ok(Number(circle.getAttribute('stroke-width')) < 150, 'ring, not a full disc');
  });

  it('labels slices with the columns the panel asked for, in its unit', () => {
    const { container } = draw(
      displays([{ name: 'a', value: 1500 }, { name: 'b', value: 500 }], { unit: 'ms' }),
      { options: { displayLabels: ['name', 'value', 'percent'] } },
    );
    const labels = slices(container).map((s) => s.label);
    assert.deepEqual(labels, ['a 1.50 s 75.0%', 'b 500 ms 25.0%']);
  });

  it('lists legend rows with their requested values, below the chart by default', () => {
    const { container } = draw(displays([{ name: 'a', value: 3 }, { name: 'b', value: 1 }]), {
      options: { legend: { values: ['value', 'percent'] } },
    });
    assert.deepEqual(legendRows(container), [['a', '3', '75.0%'], ['b', '1', '25.0%']]);
    assert.equal(container.firstChild.style.flexDirection, 'column');
  });

  it('puts the legend on the right, as a table, when asked', () => {
    const { container } = draw(displays([{ name: 'a', value: 1 }]), {
      options: { legend: { placement: 'right', displayMode: 'table', values: ['percent', 'bogus'] } },
    });
    assert.equal(container.firstChild.style.flexDirection, 'row');
    // An unrecognised column falls back to the formatted value, never a blank cell.
    assert.deepEqual(legendRows(container), [['a', '100.0%', '1']]);
    assert.equal(container.firstChild.children[1].children[0].children[2].style.minWidth, '52px');
  });

  it('hides the legend when told to', () => {
    const { container } = draw(displays([{ name: 'a', value: 1 }]), { options: { legend: { showLegend: false } } });
    assert.equal(container.firstChild.children.length, 1);
  });

  it('treats hideFrom.viz and hideFrom.legend as independent flags', () => {
    const { container } = draw(displays([
      { name: 'shown', value: 1 },
      { name: 'noViz', value: 1, config: { custom: { hideFrom: { viz: true } } } },
      { name: 'noLegend', value: 2, config: { custom: { hideFrom: { legend: true } } } },
    ]));
    // A slice hidden from the viz is not part of the whole at all.
    assert.deepEqual(slices(container).map((s) => s.title), ['shown 1 (33.3%)', 'noLegend 2 (66.7%)']);
    assert.deepEqual(legendRows(container).map((r) => r[0]), ['shown']);
  });

  it('falls back to default ink without a theme or colours', () => {
    const values = [{ display: { numeric: 2, text: '2', title: 't' } }, { display: { numeric: 2, text: '2' } }];
    const { container } = draw(values, { theme: undefined });
    const drawn = slices(container);
    assert.equal(drawn[0].fill, '#ffffff');
    assert.equal(drawn[1].title, ' 2 (50.0%)');
  });
});
