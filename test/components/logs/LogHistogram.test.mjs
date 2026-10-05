/**
 * The event-volume histogram: stacked severity bars from the sample rows, a
 * legend where click filters (and marks the active severity) and shift-click
 * mutes, and a caption stating the sample's real size and span.
 *
 * Guarded because the chart is built client-side from a SAMPLE, so its caption
 * is what stops anyone reading it as a full-retention count, and because the
 * legend click is wired to the query's severity filter.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: LogHistogram } = await import('../../../src/components/logs/LogHistogram.jsx');

const h = React.createElement;

const at = (iso, severity) => ({ timestamp: iso, severity });
const ROWS = [
  at('2026-09-25T10:00:00Z', 'INFO'),
  at('2026-09-25T10:00:30Z', 'INFO'),
  at('2026-09-25T10:05:00Z', 'error'),
  at('2026-09-25T10:10:00Z', 'CUSTOM'),
  at('2026-09-25T10:10:00Z', undefined),
  at('not a date', 'INFO'),
];

const legend = () => [...document.querySelectorAll('.histo-legend-item')]
  .map((b) => b.textContent);

describe('LogHistogram', () => {
  afterEach(cleanup);

  it('shows its empty and loading states', () => {
    const { rerender } = render(h(LogHistogram, { rows: [], sampleLimit: 500 }));
    assert.ok(screen.getByText('No events to chart for the current filters.'));
    rerender(h(LogHistogram, { rows: null, loading: true, sampleLimit: 500 }));
    assert.ok(screen.getByText('Building event distribution…'));
  });

  it('builds a legend in stack order with unknown levels appended, and a truthful caption', () => {
    render(h(LogHistogram, { rows: ROWS, sampleLimit: 500 }));
    assert.deepEqual(legend(), ['INFO3', 'ERROR1', 'CUSTOM1']);
    assert.ok(screen.getByLabelText(/Event volume by severity across 60 time buckets/));
    const caption = document.querySelector('.histo-caption').textContent;
    assert.equal(caption, 'newest 5 matching events · 10m span · 10s/bar');
    // Sub-day spans label the axis as clock time.
    assert.match(document.querySelector('.histo-xaxis').textContent, /^\d\d:\d\d/);
    // Bars carry a hover title with the bucket's event count.
    const titles = [...document.querySelectorAll('.histo-svg title')].map((t) => t.textContent);
    assert.ok(titles.some((t) => /— 2 events$/.test(t)));
    assert.ok(titles.some((t) => /— 1 event$/.test(t)));
    assert.equal(document.querySelector('.histo-yaxis').textContent, '210');
  });

  it('clicking a legend entry filters; the active one is marked', () => {
    const clicks = [];
    const { rerender } = render(h(LogHistogram, {
      rows: ROWS, sampleLimit: 500, onSeverityClick: (s) => clicks.push(s),
    }));
    fireEvent.click(screen.getByRole('button', { name: /ERROR/ }));
    assert.deepEqual(clicks, ['ERROR']);
    rerender(h(LogHistogram, { rows: ROWS, sampleLimit: 500, activeSeverity: 'error' }));
    const err = screen.getByRole('button', { name: /ERROR/ });
    assert.equal(err.getAttribute('aria-pressed'), 'true');
    assert.match(err.title, /click to clear this filter/);
  });

  it('shift-click mutes a severity locally without filtering, and again unmutes', () => {
    const clicks = [];
    render(h(LogHistogram, { rows: ROWS, sampleLimit: 500, onSeverityClick: (s) => clicks.push(s) }));
    const rectsBefore = document.querySelectorAll('.histo-svg rect').length;
    const info = screen.getByRole('button', { name: /INFO/ });
    fireEvent.click(info, { shiftKey: true });
    assert.match(info.className, /is-muted/);
    assert.ok(document.querySelectorAll('.histo-svg rect').length < rectsBefore);
    // Peak rescales to the remaining levels.
    assert.equal(document.querySelector('.histo-yaxis span').textContent, '1');
    fireEvent.click(info, { shiftKey: true });
    assert.doesNotMatch(info.className, /is-muted/);
    assert.deepEqual(clicks, []);
  });

  it('notes the sample limit, and labels multi-day spans with the date', () => {
    const rows = [at('2026-09-20T00:00:00Z', 'WARN'), at('2026-09-25T00:00:00Z', 'FATAL')];
    render(h(LogHistogram, { rows, sampleLimit: 2 }));
    const caption = document.querySelector('.histo-caption').textContent;
    assert.match(caption, /\(sample limit\)/);
    assert.match(caption, /5\.0d span/);
    assert.match(caption, /2\.0h\/bar/);
    assert.match(document.querySelector('.histo-xaxis').textContent, /^\d\d\/\d\d \d\d:\d\d/);
  });

  it('a single instant still renders one bar (its 1s span rounds to a 0s bucket)', () => {
    render(h(LogHistogram, { rows: [at('2026-09-25T10:00:00Z', 'DEBUG')], sampleLimit: 500 }));
    assert.equal(document.querySelectorAll('.histo-svg rect').length, 1);
    assert.equal(document.querySelector('.histo-caption').textContent, 'newest 1 matching events · 0s/bar');
  });

  it('abbreviates large counts', () => {
    const many = Array.from({ length: 1500 }, () => at('2026-09-25T10:00:00Z', 'INFO'));
    render(h(LogHistogram, { rows: many, sampleLimit: 500 }));
    assert.match(screen.getByRole('button', { name: /INFO/ }).textContent, /1\.5K$/);
  });

  it('spans in hours read as hours', () => {
    const rows = [at('2026-09-25T00:00:00Z', 'INFO'), at('2026-09-25T03:00:00Z', 'INFO')];
    render(h(LogHistogram, { rows, sampleLimit: 500 }));
    assert.match(document.querySelector('.histo-caption').textContent, /3\.0h span · 3m\/bar/);
  });
});
