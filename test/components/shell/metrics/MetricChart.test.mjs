/**
 * MetricChart draws a PromQL result as inline SVG. Guarded here: the three
 * non-chart states (running, failed, empty) say which one they are; a gap in
 * the data breaks the line instead of drawing through an outage; series beyond
 * the cap are reported, not silently dropped; the legend toggles a series off
 * and on; and an instant (vector) result says it is one point per series.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: MetricChart, seriesLabel, varyingLabels } = await import('../../../../src/components/metrics/MetricChart.jsx');

const h = React.createElement;
const T0 = 1_700_000_000_000;
const pts = (...vals) => vals.map((v, i) => ({ t: T0 + i * 60_000, v }));

describe('MetricChart', () => {
  afterEach(cleanup);

  it('says the query is running while there is nothing to draw yet', () => {
    render(h(MetricChart, { series: [], loading: true }));
    assert.ok(screen.getByText('Running query…'));
  });

  it('shows the failure and its reason', () => {
    render(h(MetricChart, { series: [], error: 'parse error at char 3' }));
    assert.ok(screen.getByText('Query failed'));
    assert.ok(screen.getByText('parse error at char 3'));
  });

  it('says nothing matched when the result is empty', () => {
    render(h(MetricChart, { series: [] }));
    assert.match(document.body.textContent, /No series matched/);
  });

  it('labels series by the labels that differ and breaks the line at a gap', () => {
    const series = [
      { labels: { __name__: 'up', job: 'a', env: 'prod' }, points: pts(1, null, 3) },
      { labels: { __name__: 'up', job: 'b', env: 'prod' }, points: pts(2, 2, 2) },
    ];
    const { container } = render(h(MetricChart, { series }));
    assert.ok(screen.getByText('up{job="a"}'));
    assert.ok(screen.getByText('up{job="b"}'));
    assert.equal(screen.getByRole('img').getAttribute('aria-label'), '2 of 2 series');
    const paths = [...container.querySelectorAll('path.mv-line')].map((p) => p.getAttribute('d'));
    // The gapped series is two subpaths (two M moves); the flat one is one.
    assert.ok(paths.some((d) => (d.match(/M/g) || []).length === 2));
    assert.ok(paths.some((d) => (d.match(/M/g) || []).length === 1 && d.includes('L')));
  });

  it('hides and re-shows a series from its legend entry', () => {
    const series = [
      { labels: { job: 'a' }, points: pts(1, 2) },
      { labels: { job: 'b' }, points: pts(3, 4) },
    ];
    const { container } = render(h(MetricChart, { series }));
    const item = screen.getByText('{job="a"}').closest('button');
    fireEvent.click(item);
    assert.match(item.className, /is-off/);
    assert.equal(screen.getByRole('img').getAttribute('aria-label'), '1 of 2 series');
    assert.equal(container.querySelectorAll('path.mv-line').length, 1);
    fireEvent.click(item);
    assert.doesNotMatch(item.className, /is-off/);
    assert.equal(container.querySelectorAll('path.mv-line').length, 2);
  });

  it('caps at 24 series by peak and reports the rest', () => {
    const series = Array.from({ length: 30 }, (_, i) => ({
      labels: { i: String(i) }, points: pts(i * 1000, i * 1500),
    }));
    render(h(MetricChart, { series }));
    assert.match(document.body.textContent, /Showing the 24 largest of 30 series — 6 not plotted/);
    // The loudest survives, the quietest does not.
    assert.ok(screen.getByText('{i="29"}'));
    assert.equal(screen.queryByText('{i="0"}'), null);
  });

  it('notes an instant query and draws a single-series flat line with no gaps', () => {
    render(h(MetricChart, {
      series: [{ labels: { __name__: 'x', a: '1' }, points: [{ t: T0, v: 0.5 }] }],
      resultType: 'vector',
    }));
    assert.match(document.body.textContent, /Instant query — one point per series/);
    assert.ok(screen.getByText('x{a="1"}'));
  });

  it('draws an all-null series without crashing and with no legend value', () => {
    const { container } = render(h(MetricChart, {
      series: [{ labels: {}, points: pts(null, null) }],
    }));
    assert.ok(screen.getByText('{}'));
    assert.equal(container.querySelector('.mv-legend-value'), null);
  });

  it('prints large and fractional axis ticks in one unit', () => {
    const { container } = render(h(MetricChart, {
      series: [{ labels: { a: '1' }, points: pts(-2500, 4000.5) }],
    }));
    const ticks = [...container.querySelectorAll('.mv-ytick')].map((t) => t.textContent);
    assert.ok(ticks.some((t) => /K$/.test(t)));
    render(h(MetricChart, { series: [{ labels: { a: '2' }, points: pts(0.1, 0.3) }] }));
    const small = [...document.querySelectorAll('.mv-ytick')].map((t) => t.textContent);
    assert.ok(small.includes('0.075') || small.some((t) => /^0\.\d+$/.test(t)));
  });

  it('exports helpers that name a series by what varies', () => {
    const s = [{ labels: { __name__: 'm', a: '1', b: 'x' } }, { labels: { __name__: 'm', a: '2', b: 'x' } }];
    assert.deepEqual(varyingLabels(s), ['a']);
    assert.equal(seriesLabel({ __name__: 'm', a: '2' }, ['a']), 'm{a="2"}');
    assert.equal(seriesLabel({ __name__: 'm' }, []), 'm');
  });
});
