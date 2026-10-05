/**
 * "Source Details" — the modal a log row click opens: JSON and Table tabs,
 * find-in-record, copy, Previous/Next (buttons and arrow keys), Escape and
 * backdrop close, "Search Around" with its event count, and "Open trace".
 *
 * Guarded because this is where one record is read properly: the arrow keys
 * must not fire while typing in the find box, Open trace must only appear for
 * a real trace id, and Search Around must hand back the chosen count.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react');
const { default: LogDetailsModal } = await import('../../../src/components/logs/LogDetailsModal.jsx');

const h = React.createElement;
const TRACE = 'c'.repeat(32);

const LOG = {
  _raw: {
    '@timestamp': '2026-09-25T10:00:00Z',
    'service.name': 'orders',
    body: 'payment timeout',
    stack: `Error\n${'  at frame\n'.repeat(20)}`,
    retries: 2,
    ok: false,
    none: null,
    nested: { dropped: true },
  },
  timestamp: '2026-09-25T10:00:00Z',
  traceId: TRACE,
};

const setup = (over = {}) => {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  const props = {
    log: LOG, index: 1, total: 3,
    onPrev: rec('prev'), onNext: rec('next'), onClose: rec('close'),
    onSearchAround: rec('around'), onTraceClick: rec('trace'), ...over,
  };
  const utils = render(h(LogDetailsModal, props));
  return { ...utils, calls, props };
};

describe('LogDetailsModal', () => {
  afterEach(() => { cleanup(); mock.timers.reset(); });

  it('renders nothing without a log', () => {
    const { container } = setup({ log: null });
    assert.equal(container.innerHTML, '');
  });

  it('shows the record as sorted JSON lines, skipping nested objects, with focus on Close', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Source Details' });
    assert.equal(document.activeElement, screen.getByRole('button', { name: 'Close' }));
    const keys = [...dialog.querySelectorAll('.ld-json .oo-json-key')].map((k) => k.textContent);
    assert.deepEqual(keys, ['@timestamp', 'body', 'none', 'ok', 'retries', 'service.name', 'stack']);
    assert.equal(screen.queryByText('nested'), null);
    assert.ok(screen.getByText('2 of 3'));
    assert.ok(screen.getByText('null'));
    assert.ok(screen.getByText('false'));
  });

  it('collapses and expands a long value', () => {
    setup();
    const collapse = screen.getByRole('button', { name: 'Collapse stack' });
    fireEvent.click(collapse);
    const expand = screen.getByRole('button', { name: 'Expand stack' });
    assert.equal(expand.textContent, '▸');
    const shown = expand.parentElement.querySelector('.ld-json-value').textContent;
    assert.ok(shown.endsWith('…'));
    assert.doesNotMatch(shown, /\n/);
    fireEvent.click(expand);
    assert.ok(screen.getByRole('button', { name: 'Collapse stack' }));
  });

  it('find highlights matching JSON lines and filters the table', () => {
    setup();
    const find = screen.getByRole('textbox', { name: 'Find in record' });
    fireEvent.change(find, { target: { value: 'ORDERS' } });
    const matches = [...document.querySelectorAll('.ld-json-line.is-match .oo-json-key')].map((k) => k.textContent);
    assert.deepEqual(matches, ['service.name']);

    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    const keys = [...document.querySelectorAll('.ld-td-key')].map((k) => k.textContent);
    assert.deepEqual(keys, ['service.name']);

    fireEvent.change(find, { target: { value: 'zzz' } });
    assert.ok(screen.getByText('Nothing in this record matches “zzz”.'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    assert.equal(find.value, '');
    assert.equal(document.querySelectorAll('.ld-td-key').length, 7);
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    assert.ok(document.querySelector('.ld-json'));
  });

  it('Previous/Next buttons honour the ends of the page', () => {
    const { calls, rerender, props } = setup();
    fireEvent.click(screen.getByRole('button', { name: '‹ Previous' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    assert.deepEqual(calls.map((c) => c[0]), ['prev', 'next']);
    rerender(h(LogDetailsModal, { ...props, index: 0 }));
    assert.equal(screen.getByRole('button', { name: '‹ Previous' }).disabled, true);
    rerender(h(LogDetailsModal, { ...props, index: 2 }));
    assert.equal(screen.getByRole('button', { name: 'Next ›' }).disabled, true);
  });

  it('arrow keys walk the page, but not from the find box or past the ends', () => {
    const { calls, rerender, props } = setup();
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find in record' }), { key: 'ArrowLeft' });
    assert.deepEqual(calls.map((c) => c[0]), ['prev', 'next']);
    rerender(h(LogDetailsModal, { ...props, index: 0, total: 1 }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    assert.equal(calls.length, 2);
  });

  it('closes on Escape, the × button and a backdrop click (not a dialog click)', () => {
    const { calls } = setup();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    fireEvent.mouseDown(document.querySelector('.ld-backdrop'));
    assert.deepEqual(calls.map((c) => c[0]), ['close', 'close', 'close']);
  });

  it('Search Around sends the record and the chosen count', () => {
    const { calls } = setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'Number of surrounding events' }), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Around' }));
    assert.deepEqual(calls, [['around', LOG, 50]]);
  });

  it('Open trace closes the modal then opens the trace; hidden without a trace', () => {
    const { calls, rerender, props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Open trace →' }));
    assert.deepEqual(calls, [['close'], ['trace', TRACE]]);
    rerender(h(LogDetailsModal, { ...props, log: { ...LOG, traceId: 'no-trace' } }));
    assert.equal(screen.queryByRole('button', { name: 'Open trace →' }), null);
    rerender(h(LogDetailsModal, { ...props, onTraceClick: undefined }));
    assert.equal(screen.queryByRole('button', { name: 'Open trace →' }), null);
  });

  it('copies the pretty record and a single value, reverting after two seconds', async () => {
    const written = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (t) => { written.push(t); } },
    });
    mock.timers.enable({ apis: ['setTimeout'] });
    setup();
    const copy = screen.getByRole('button', { name: 'Copy to clipboard' });
    await act(async () => { fireEvent.click(copy); });
    assert.equal(JSON.parse(written[0])['service.name'], 'orders');
    assert.match(copy.textContent, /Copied/);
    act(() => { mock.timers.tick(2000); });
    assert.match(copy.textContent, /Copy to clipboard/);

    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    const bodyRow = [...document.querySelectorAll('.ld-tr')].find((r) => r.textContent.includes('payment timeout'));
    await act(async () => { fireEvent.click(bodyRow.querySelector('button')); });
    assert.equal(written[1], 'payment timeout');
    act(() => { mock.timers.tick(2000); });
  });

  it('ignores a blocked clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: () => Promise.reject(new Error('no')) },
    });
    setup();
    const copy = screen.getByRole('button', { name: 'Copy to clipboard' });
    await act(async () => { fireEvent.click(copy); });
    assert.match(copy.textContent, /Copy to clipboard/);
  });
});
