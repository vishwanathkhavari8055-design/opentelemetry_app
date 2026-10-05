/**
 * SpansTable is the Spans tab's listing. Guarded here: every span renders its
 * service, operation, duration (µs → unit ladder) and status; a row opens its
 * trace on click and on Enter/Space — but only when the span HAS a trace id,
 * since opening "undefined" would land on a blank drill-down; and the empty
 * body tells loading, error and no-match apart, because they need different
 * actions from the operator.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: SpansTable } = await import('../../../src/components/traces/SpansTable.jsx');

const SPANS = [
  {
    spanId: 's1', traceId: 't-aaa', timestamp: '2026-08-03T13:44:30Z',
    serviceName: 'checkout', operationName: 'GET /cart', durationUs: 1410, spanStatus: 'ERROR',
  },
  {
    spanId: 's2', traceId: '', timestamp: null,
    serviceName: '', operationName: '', durationUs: null, spanStatus: '',
  },
];

const renderTable = (props = {}) => {
  const opened = [];
  const utils = render(React.createElement(SpansTable, {
    rows: SPANS, onTraceClick: (id) => opened.push(id), ...props,
  }));
  return { ...utils, opened };
};

const bodyRows = () => screen.getAllByRole('row').filter((r) => r.classList.contains('tt-row'));

describe('SpansTable', () => {
  afterEach(cleanup);

  it('renders one row per span with formatted cells and placeholders', () => {
    renderTable();
    const rows = bodyRows();
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /checkout/);
    assert.match(rows[0].textContent, /GET \/cart/);
    assert.match(rows[0].textContent, /1\.41ms/);
    assert.match(rows[0].textContent, /ERROR/);
    assert.ok(rows[0].classList.contains('is-error'));
    // Missing values fall back rather than rendering blanks.
    assert.match(rows[1].textContent, /UNSET/);
    assert.equal(rows[1].querySelector('.tt-col-op').textContent, '—');
    assert.equal(rows[1].querySelector('.tt-col-dur').textContent, '—');
    assert.equal(rows[1].querySelector('.tt-col-ts').textContent, '--');
    assert.ok(!rows[1].classList.contains('is-error'));
    // Service icon shows the initial.
    assert.equal(rows[0].querySelector('.tt-svc-icon').textContent, 'C');
    assert.equal(rows[1].querySelector('.tt-svc-icon').textContent, '?');
  });

  it('labels the columns, with the local time zone on the timestamp', () => {
    renderTable();
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    assert.match(heads[0], /^Timestamp \(.+\)$/);
    assert.deepEqual(heads.slice(1), ['Service', 'Operation Name', 'Duration', 'Span Status']);
  });

  it('opens the trace on click, Enter and Space', () => {
    const { opened } = renderTable();
    const [first] = bodyRows();
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: 'Enter' });
    fireEvent.keyDown(first, { key: ' ' });
    fireEvent.keyDown(first, { key: 'a' });
    assert.deepEqual(opened, ['t-aaa', 't-aaa', 't-aaa']);
  });

  it('does not open anything for a span without a trace id', () => {
    const { opened } = renderTable();
    const second = bodyRows()[1];
    fireEvent.click(second);
    fireEvent.keyDown(second, { key: 'Enter' });
    assert.deepEqual(opened, []);
  });

  it('distinguishes loading, error and no-match when empty', () => {
    const { rerender } = renderTable({ rows: [], loading: true });
    assert.ok(screen.getByText('Running query…'));
    assert.ok(screen.getByRole('progressbar', { name: 'Running query' }));

    rerender(React.createElement(SpansTable, { rows: [], error: 'boom', onTraceClick: () => {} }));
    assert.equal(screen.getByText('boom').className, 'log-empty-error');
    assert.equal(screen.queryByRole('progressbar'), null);

    rerender(React.createElement(SpansTable, { rows: [], onTraceClick: () => {} }));
    assert.ok(screen.getByText('No spans matched this query in the selected time range.'));
  });
});
