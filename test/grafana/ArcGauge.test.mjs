/**
 * Guards the SVG arc gauge that replaces @grafana/ui's Gauge, which draws with a
 * jquery.flot build @grafana/ui does not ship and so renders blank here.
 *
 * The gauge is read at a glance, so its geometry is its meaning: the value arc's
 * length against min/max, threshold bands placed in absolute or percentage
 * terms, no dot at the origin for a zero, and the text Grafana formatted.
 */
import './grafanaEnv.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { theme } from './grafanaEnv.mjs';

const React = (await import('react')).default;
const { render, cleanup } = await import('@testing-library/react');
const { ArcGauge } = await import('../../src/grafana/ArcGauge.jsx');

const draw = (props) => render(React.createElement(ArcGauge, { width: 200, height: 150, theme, ...props }));
const paths = (container) => [...container.querySelectorAll('path')].map((p) => ({
  d: p.getAttribute('d'), stroke: p.getAttribute('stroke'), width: Number(p.getAttribute('stroke-width')),
}));
/** End point of an SVG arc path "M x y A r r 0 f 1 x2 y2". */
const endOf = (d) => d.split(' ').slice(-2).map(Number);
const largeArc = (d) => d.split(' ')[7];

describe('ArcGauge', () => {
  afterEach(cleanup);

  it('draws the track and a value arc in the value colour, with the formatted text', () => {
    const { container } = draw({
      value: { numeric: 50, text: '50', suffix: ' %', color: '#ff0000', title: 'CPU' },
      field: { min: 0, max: 100 },
    });
    const [track, value] = paths(container);
    assert.equal(track.stroke, theme.colors.background.secondary);
    assert.equal(value.stroke, '#ff0000');
    const texts = [...container.querySelectorAll('text')].map((t) => t.textContent);
    assert.deepEqual(texts, ['50 %', 'CPU']);
    assert.equal(container.querySelector('svg').getAttribute('aria-label'), 'Gauge: 50 %');
    // Halfway along a symmetric 220° sweep is straight up from the centre.
    const [x] = endOf(value.d);
    assert.ok(Math.abs(x - 100) < 1e-6, `midpoint x ${x}`);
  });

  it('draws no value arc for a value at (or below) min, and clamps above max', () => {
    const empty = paths(draw({ value: { numeric: -5, text: '-5' }, field: { min: 0, max: 10 } }).container);
    assert.equal(empty.length, 1, 'track only — no dot at the origin');
    cleanup();
    const [track, full] = paths(draw({ value: { numeric: 99, text: '99' }, field: { min: 0, max: 10 } }).container);
    assert.equal(full.d, track.d, 'a clamped full arc is the track');
    assert.equal(largeArc(full.d), '1');
  });

  it('defaults to 0-100 and treats a non-numeric value as empty', () => {
    const { container } = draw({ value: { text: 'N/A' } });
    assert.equal(paths(container).length, 1);
    assert.equal(container.querySelector('text').textContent, 'N/A');
  });

  it('places absolute threshold bands outside the arc, one per step', () => {
    const { container } = draw({
      value: { numeric: 10, text: '10' },
      field: {
        min: 0, max: 100,
        thresholds: { mode: 'absolute', steps: [{ value: null, color: 'green' }, { value: 90, color: 'red' }, { value: 150, color: 'purple' }] },
      },
    });
    const all = paths(container);
    // track, two bands (the 150 step lies past max and collapses), value.
    assert.equal(all.length, 4);
    const [, green, red] = all;
    assert.equal(green.stroke, 'green');
    assert.equal(red.stroke, 'red');
    assert.equal(largeArc(green.d), '1', '0→90 of a 220° sweep is 198°');
    assert.equal(largeArc(red.d), '0');
  });

  it('reads percentage thresholds against the min/max span', () => {
    const { container } = draw({
      value: { numeric: 0, text: '0' },
      field: { min: 100, max: 200, thresholds: { mode: 'percentage', steps: [{ value: -Infinity, color: 'a' }, { value: 50, color: 'b' }] } },
    });
    const [, a, b] = paths(container);
    // Both halves of the span: the boundary sits at the top of the arc.
    assert.ok(Math.abs(endOf(a.d)[0] - 100) < 1e-6);
    assert.equal(b.stroke, 'b');
  });

  it('can hide the markers and show min/max labels', () => {
    const { container } = draw({
      value: { numeric: 5, text: '5' },
      field: { min: 0, max: 10, thresholds: { steps: [{ value: null, color: 'green' }] } },
      showThresholdMarkers: false,
      showThresholdLabels: true,
      text: { valueSize: 20, titleSize: 9 },
    });
    assert.equal(paths(container).length, 2);
    const texts = [...container.querySelectorAll('text')];
    assert.deepEqual(texts.map((t) => t.textContent), ['0', '10', '5']);
    assert.equal(texts[2].getAttribute('font-size'), '20');
    assert.equal(texts[0].getAttribute('font-size'), '9');
  });

  it('ignores empty thresholds and falls back to default colours without a theme', () => {
    const { container } = draw({ value: { numeric: 50, text: '50' }, field: { thresholds: { steps: [] } }, theme: undefined });
    const [track, value] = paths(container);
    assert.equal(track.stroke, '#404040');
    assert.equal(value.stroke, '#ffffff');
  });
});
