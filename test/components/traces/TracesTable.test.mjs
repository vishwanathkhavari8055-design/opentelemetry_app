/**
 * TracesTable is the Traces tab's listing. Guarded here: a row per trace with
 * root service/operation, duration, span count and status (SUCCESS when the
 * backend omits it); the Service Latency bar splits by each service's share
 * of the SUMMED span time — not the root's wall clock, which would overflow
 * 100% as child spans overlap — and skips zero-time services; rows open their
 * trace by click or keyboard; and the empty states stay distinct.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: TracesTable } = await import('../../../src/components/traces/TracesTable.jsx');

const TRACES = [
  {
    traceId: 'trace-1', timestamp: '2026-08-03T13:44:30Z', serviceName: 'gateway',
    operationName: 'POST /order', durationUs: 5_261_305, spanCount: 7, status: 'ERROR',
    services: [
      { serviceName: 'gateway', durationUs: 3000, spanCount: 1 },
      { serviceName: 'db', durationUs: 1000, spanCount: 4 },
      { serviceName: 'idle', durationUs: 0, spanCount: 2 },
    ],
  },
  {
    traceId: 'trace-2', timestamp: null, serviceName: null, operationName: null,
    durationUs: 26, spanCount: null, status: null, services: [],
  },
];

const renderTable = (props = {}) => {
  const opened = [];
  const utils = render(React.createElement(TracesTable, {
    rows: TRACES, onTraceClick: (id) => opened.push(id), ...props,
  }));
  return { ...utils, opened };
};

const bodyRows = () => screen.getAllByRole('row').filter((r) => r.classList.contains('tt-row'));

describe('TracesTable', () => {
  afterEach(cleanup);

  it('renders trace rows with formatted values and defaults', () => {
    renderTable();
    const [a, b] = bodyRows();
    assert.match(a.textContent, /gateway/);
    assert.match(a.textContent, /POST \/order/);
    assert.match(a.textContent, /5\.26s/);
    assert.match(a.textContent, /ERROR/);
    assert.ok(a.classList.contains('is-error'));
    assert.equal(a.querySelector('.tt-col-spans').textContent, '7');
    assert.equal(a.querySelector('.tt-col-spans').title, '7 spans');

    assert.match(b.textContent, /26\.00us/);
    assert.match(b.textContent, /SUCCESS/);
    assert.equal(b.querySelector('.tt-col-spans').textContent, '—');
    assert.equal(b.querySelector('.tt-col-op').textContent, '—');
    assert.equal(b.querySelector('.tt-svc-name').textContent, '—');
    assert.ok(!b.classList.contains('is-error'));
  });

  it('splits the latency bar by share of summed span time, skipping zero-time services', () => {
    renderTable();
    const [a, b] = bodyRows();
    const segs = a.querySelectorAll('.tt-lat-seg');
    assert.equal(segs.length, 2);
    assert.equal(segs[0].style.width, '75%');
    assert.equal(segs[1].style.width, '25%');
    assert.equal(segs[0].title, 'gateway — 3.00ms across 1 span (75.0%)');
    assert.equal(segs[1].title, 'db — 1.00ms across 4 spans (25.0%)');
    // A trace with no timed services gets the empty bar.
    assert.ok(b.querySelector('.tt-lat-bar--empty'));
  });

  it('opens a trace by click, Enter or Space', () => {
    const { opened } = renderTable();
    const [a, b] = bodyRows();
    fireEvent.click(b);
    fireEvent.keyDown(a, { key: 'Enter' });
    fireEvent.keyDown(a, { key: ' ' });
    fireEvent.keyDown(a, { key: 'Escape' });
    assert.deepEqual(opened, ['trace-2', 'trace-1', 'trace-1']);
  });

  it('shows the Service Latency column and distinct empty states', () => {
    const { rerender } = renderTable({ rows: [], loading: true });
    assert.ok(screen.getByRole('columnheader', { name: 'Service Latency' }));
    assert.ok(screen.getByText('Running query…'));

    rerender(React.createElement(TracesTable, { rows: [], error: 'HTTP error! status: 500', onTraceClick: () => {} }));
    assert.ok(screen.getByText('HTTP error! status: 500'));

    rerender(React.createElement(TracesTable, { rows: [], onTraceClick: () => {} }));
    assert.ok(screen.getByText('No traces matched this query in the selected time range.'));
  });
});
