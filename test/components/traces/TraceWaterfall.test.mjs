/**
 * TraceWaterfall is the timeline above the trace tree. Guarded here:
 *  - collapsed, it is one strip of per-type segments sized by total time,
 *    and clicking a segment applies that type as a filter;
 *  - expanded, it draws one bar per span, selection is highlighted and a row
 *    click reports the span's uid;
 *  - when one root dominates and its children cluster late, it zooms onto the
 *    children and says so, rather than squashing them into a sliver;
 *  - with nothing to draw (no spans, no parsable times) it renders nothing.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: TraceWaterfall } = await import('../../../src/components/TraceWaterfall.jsx');

const BASE = 1_700_000_000_000; // ms

const NODES = [
  { uid: 'r', name: 'GET /api/orders', type: 'HTTP', timestamp: BASE, durationMs: 100, depth: 0, status: 'SUCCESS' },
  { uid: 'q', name: 'SELECT * FROM orders', type: 'SQL', timestamp: BASE + 10, durationMs: 30, depth: 1 },
  { uid: 'm', name: 'find orders', type: 'MONGODB', timestamp: BASE + 45, durationMs: 50, depth: 1, status: 'ERROR' },
  { uid: 'l', name: 'a log line', type: 'LOG', timestamp: new Date(BASE + 60).toISOString(), durationMs: 0, depth: 2 },
];

const renderWf = (props = {}) => {
  const picked = [];
  const types = [];
  const toggles = [];
  const utils = render(React.createElement(TraceWaterfall, {
    nodes: NODES,
    onSelectNode: (u) => picked.push(u),
    onTypeFilterClick: (t) => types.push(t),
    onToggleExpanded: () => toggles.push(true),
    ...props,
  }));
  return { ...utils, picked, types, toggles };
};

describe('TraceWaterfall', () => {
  afterEach(cleanup);

  it('renders nothing without spans or without a usable time range', () => {
    const { container } = renderWf({ nodes: [] });
    assert.equal(container.innerHTML, '');
    cleanup();
    const again = renderWf({ nodes: [{ uid: 'x', timestamp: 'garbage', durationMs: 5 }] });
    assert.equal(again.container.innerHTML, '');
  });

  it('collapsed: one segment per type, biggest first, clicking filters by that type', () => {
    const { container, types, toggles } = renderWf({ activeTypeFilter: new Set(['SQL']) });
    assert.ok(screen.getByText('100.0 ms total · 4 spans'));
    const segs = [...container.querySelectorAll('.tv-waterfall-strip-seg')];
    // LOG has zero duration, so it contributes no segment.
    assert.deepEqual(segs.map((s) => s.title), [
      'HTTP · 100.0 ms · 1 span · 55.6%',
      'MONGODB · 50.0 ms · 1 span · 27.8%',
      'SQL · 30.0 ms · 1 span · 16.7%',
    ]);
    assert.equal(segs[0].textContent, 'HTTP · 100ms');
    assert.ok(segs[2].classList.contains('tv-waterfall-strip-seg-active'));
    assert.ok(!segs[0].classList.contains('tv-waterfall-strip-seg-active'));
    fireEvent.click(segs[1]);
    assert.deepEqual(types, ['MONGODB']);

    fireEvent.click(screen.getByRole('button', { name: '▾ expand' }));
    assert.equal(toggles.length, 1);
  });

  it('collapsed: a narrow segment drops its inline label and counts plural spans', () => {
    const nodes = [
      { uid: 'a', type: 'HTTP', timestamp: BASE, durationMs: 1000, depth: 0 },
      { uid: 'b', type: 'SQL', timestamp: BASE + 1, durationMs: 10, depth: 1 },
      { uid: 'c', type: 'SQL', timestamp: BASE + 2, durationMs: 10, depth: 1 },
    ];
    const { container } = renderWf({ nodes, onToggleExpanded: undefined });
    const sql = [...container.querySelectorAll('.tv-waterfall-strip-seg')][1];
    assert.match(sql.title, /^SQL · 20\.0 ms · 2 spans/);
    assert.equal(sql.textContent, '');
    assert.equal(screen.queryByRole('button', { name: /expand/ }), null);
  });

  it('expanded: a bar per span, errors in red, selection highlighted, click reports the uid', () => {
    const { container, picked } = renderWf({ expanded: true, selectedUid: 'q' });
    assert.ok(screen.getByRole('button', { name: '▴ collapse' }));
    const rows = [...container.querySelectorAll('.tv-wf-row')];
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((r) => r.querySelector('.tv-wf-label-text').textContent),
      ['GET /api/orders', 'SELECT * FROM orders', 'find orders', 'a log line']);
    assert.ok(rows[1].classList.contains('tv-wf-row-selected'));
    assert.equal(rows[1].title, 'SELECT * FROM orders · 30.00 ms · +10.00 ms');
    assert.equal(rows[1].querySelector('.tv-wf-bar').style.left, '10%');
    assert.equal(rows[1].querySelector('.tv-wf-bar').style.width, '30%');
    assert.equal(rows[2].querySelector('.tv-wf-dot').style.background, 'rgb(248, 81, 73)');
    assert.equal(rows[3].querySelector('.tv-wf-bar-label').textContent, '·');
    assert.equal(rows[3].querySelector('.tv-wf-label').style.paddingLeft, '32px');
    fireEvent.click(rows[2]);
    assert.deepEqual(picked, ['m']);
  });

  it('expanded: a long label is shortened; spans without a start time are skipped', () => {
    const long = 'com.example.very.long.package.name.that.keeps.going.OrderService';
    const nodes = [
      { uid: 'a', operation: long, type: 'INTERNAL', timestamp: BASE, durationMs: 20, depth: 0 },
      { uid: 'b', name: 'orphan', timestamp: null, durationMs: 5, depth: 1 },
      { uid: 'c', timestamp: BASE + 5, durationMs: 5, depth: 1 },
    ];
    const { container } = renderWf({ nodes, expanded: true, onSelectNode: undefined });
    const rows = [...container.querySelectorAll('.tv-wf-row')];
    assert.equal(rows.length, 2);
    const label = rows[0].querySelector('.tv-wf-label-text').textContent;
    assert.ok(label.length <= 36 && label.includes('…'));
    assert.equal(rows[1].querySelector('.tv-wf-label-text').textContent, '-');
    fireEvent.click(rows[1]); // no handler — must not throw
  });

  it('zooms onto late-clustered children under a dominant root', () => {
    const nodes = [
      { uid: 'r', name: 'root', type: 'HTTP', timestamp: BASE, durationMs: 1000, depth: 0 },
      { uid: 'a', name: 'a', type: 'SQL', timestamp: BASE + 800, durationMs: 50, depth: 1 },
      { uid: 'b', name: 'b', type: 'SQL', timestamp: BASE + 860, durationMs: 40, depth: 1 },
    ];
    const { container } = renderWf({ nodes, expanded: true });
    assert.ok(screen.getByText('ZOOMED'));
    assert.match(container.querySelector('.tv-waterfall-total').textContent,
      /100\.0 ms shown · 1000\.0 ms total · 3 spans/);
    const win = container.querySelector('.tv-waterfall-context-window');
    assert.equal(win.style.left, '80%');
    assert.equal(win.style.width, '10%');
    const bars = [...container.querySelectorAll('.tv-wf-bar')];
    assert.equal(bars[1].style.left, '0%');
    assert.equal(bars[2].style.left, '60%');
  });
});
