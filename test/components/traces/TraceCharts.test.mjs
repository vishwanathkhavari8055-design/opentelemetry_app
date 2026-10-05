/**
 * TraceCharts draws Rate / Errors / Duration from ONE bucket series, so the
 * three panels always share an x axis. Guarded here: buckets are sorted and
 * unparseable timestamps dropped; the x labels span the window in the
 * viewer's clock; error bars only appear for buckets that had errors, with a
 * readable tooltip; the Duration axis uses ONE unit chosen from the peak
 * (mixing "22.05s" with "0.00ns" on one axis reads as a bug); the bucket width
 * shows as a subtitle; and loading / empty windows say so instead of drawing
 * flat lines.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, within, cleanup } = await import('@testing-library/react');
const { default: TraceCharts } = await import('../../../src/components/traces/TraceCharts.jsx');

// Naive local-time strings, as histogram() returns them. Deliberately unsorted.
const BUCKETS = [
  { timestamp: '2026-08-03T13:20:00', count: 5, errors: 3, p50Us: 500, p95Us: 900, maxUs: 1_000_000 },
  { timestamp: '2026-08-03T13:00:00', count: 10, errors: 0, p50Us: 1000, p95Us: 2000, maxUs: 2_000_000 },
  { timestamp: 'not-a-time', count: 999, errors: 999, p50Us: 1, p95Us: 1, maxUs: 99_000_000 },
  { timestamp: '2026-08-03T13:10:00', count: 20, errors: 1, p50Us: 0, p95Us: 1500, maxUs: 1_500_000 },
];

const panel = (title) => screen.getByText(title, { selector: '.tc-title, .tc-title *' }).closest('.tc-panel');
const labels = (el, cls) => Array.from(el.querySelectorAll(`.${cls} span`)).map((s) => s.textContent);

describe('TraceCharts', () => {
  afterEach(cleanup);

  it('draws the three panels over one shared, sorted x axis', () => {
    render(React.createElement(TraceCharts, { buckets: BUCKETS, interval: '10 minutes' }));
    const X = ['13:00', '13:05', '13:10', '13:15', '13:20'];
    for (const t of ['Rate', 'Errors', 'Duration']) {
      assert.deepEqual(labels(panel(t), 'tc-xaxis'), X, `${t} x axis`);
      assert.ok(within(panel(t)).getByRole('img', { name: t }));
    }
    // Rate: peak 20 → five evenly spaced counts; the path visits all three buckets in order.
    assert.deepEqual(labels(panel('Rate'), 'tc-yaxis'), ['20', '15', '10', '5', '0']);
    const d = panel('Rate').querySelector('path.tc-line').getAttribute('d');
    assert.equal(d, 'M0.00,50.00 L50.00,0.00 L100.00,75.00');
  });

  it('shows error bars only for buckets with errors, with tooltips', () => {
    render(React.createElement(TraceCharts, { buckets: BUCKETS }));
    const errors = panel('Errors');
    assert.deepEqual(labels(errors, 'tc-yaxis'), ['3', '2', '2', '1', '0']);
    const titles = Array.from(errors.querySelectorAll('rect.tc-bar title')).map((t) => t.textContent);
    assert.deepEqual(titles, ['13:10 — 1 error of 20', '13:20 — 3 errors of 5']);
  });

  it('plots p50/p95/max on one duration unit, with legend and bucket width', () => {
    render(React.createElement(TraceCharts, { buckets: BUCKETS, interval: '10 minutes' }));
    const dur = panel('Duration');
    assert.deepEqual(labels(dur, 'tc-yaxis'), ['2.00s', '1.50s', '1.00s', '0.50s', '0.00s']);
    assert.equal(dur.querySelector('.tc-subtitle').textContent, '10 minutes/bucket');
    assert.deepEqual(Array.from(dur.querySelectorAll('.tc-legend')).map((l) => l.textContent), ['max', 'p95', 'p50']);
    // 3 max + 3 p95 + 2 p50 (one bucket's p50 is zero and is not drawn).
    const dots = dur.querySelectorAll('circle.tc-dot');
    assert.equal(dots.length, 8);
    const titles = Array.from(dur.querySelectorAll('circle title')).map((t) => t.textContent);
    assert.ok(titles.includes('13:00 — max 2.00s'));
    assert.ok(titles.includes('13:20 — p50 500.00us'));
  });

  it('picks the axis unit from the peak', () => {
    const one = (maxUs) => [{ timestamp: '2026-08-03T13:00:00', count: 1, errors: 0, maxUs }];
    const { rerender } = render(React.createElement(TraceCharts, { buckets: one(120_000_000) }));
    assert.equal(labels(panel('Duration'), 'tc-yaxis')[0], '2.00m');
    rerender(React.createElement(TraceCharts, { buckets: one(4_000) }));
    assert.equal(labels(panel('Duration'), 'tc-yaxis')[0], '4.00ms');
    rerender(React.createElement(TraceCharts, { buckets: one(400) }));
    assert.equal(labels(panel('Duration'), 'tc-yaxis')[0], '400.00us');
    // A single bucket has no span to label, and no subtitle without an interval.
    assert.deepEqual(labels(panel('Duration'), 'tc-xaxis'), []);
    assert.equal(panel('Duration').querySelector('.tc-subtitle'), null);
    // …and sits mid-axis rather than at an edge.
    assert.equal(panel('Rate').querySelector('path.tc-line').getAttribute('d'), 'M50.00,0.00');
  });

  it('says Loading… while the first answer is pending', () => {
    render(React.createElement(TraceCharts, { buckets: [], loading: true }));
    assert.equal(screen.getAllByText('Loading…').length, 3);
    assert.equal(screen.queryByRole('img'), null);
  });

  it('keeps drawing the previous series while a refresh loads', () => {
    render(React.createElement(TraceCharts, { buckets: BUCKETS, loading: true }));
    assert.equal(screen.queryByText('Loading…'), null);
    assert.equal(screen.getAllByRole('img').length, 3);
  });

  it('says there is no data for an empty or unparseable window', () => {
    const { rerender } = render(React.createElement(TraceCharts, { buckets: [] }));
    assert.equal(screen.getAllByText('No data in this window.').length, 3);
    rerender(React.createElement(TraceCharts, { buckets: [{ timestamp: '' }, { timestamp: 'x' }] }));
    assert.equal(screen.getAllByText('No data in this window.').length, 3);
    rerender(React.createElement(TraceCharts, {}));
    assert.equal(screen.getAllByText('No data in this window.').length, 3);
  });
});
