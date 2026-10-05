/**
 * The two toolbar pickers: the time range (relative preset grid, absolute
 * from/to staged until Apply) and the auto-refresh interval (with the paused
 * reason the container supplies).
 *
 * Guarded because the time-range value object goes straight into the query,
 * absolute edits must not commit keystroke by keystroke, and a paused
 * auto-refresh must say why instead of looking broken.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const {
  default: TimeRangePicker, relativeLabel, rangeLabel,
} = await import('../../../src/components/logs/TimeRangePicker.jsx');
const { default: RefreshIntervalPicker } = await import('../../../src/components/logs/RefreshIntervalPicker.jsx');

const h = React.createElement;
const REL = { mode: 'relative', relative: '15m', from: '', to: '' };

describe('relativeLabel / rangeLabel', () => {
  it('spells out the relative window, singular and plural', () => {
    assert.equal(relativeLabel('15m'), 'Past 15 Minutes');
    assert.equal(relativeLabel('1h'), 'Past 1 Hour');
    assert.equal(relativeLabel('2M'), 'Past 2 Months');
    assert.equal(relativeLabel('bogus'), 'Past 15 Minutes');
    assert.equal(relativeLabel(undefined), 'Past 15 Minutes');
  });
  it('shows both ends of an absolute range, with placeholders for gaps', () => {
    assert.match(rangeLabel({ mode: 'absolute', from: '2026-08-03T12:45', to: '' }), /→ —$/);
    assert.equal(rangeLabel({ mode: 'absolute', from: 'garbage', to: '' }), 'garbage → —');
    assert.equal(rangeLabel(REL), 'Past 15 Minutes');
  });
});

describe('TimeRangePicker', () => {
  afterEach(cleanup);

  const setup = (value = REL) => {
    const changes = [];
    const utils = render(h(TimeRangePicker, { value, onChange: (v) => changes.push(v) }));
    return { ...utils, changes };
  };

  it('opens, marks the active preset, and commits a relative pick', () => {
    const { changes } = setup();
    const btn = screen.getByRole('button', { name: /Past 15 Minutes/ });
    fireEvent.click(btn);
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    const panel = screen.getByRole('dialog', { name: 'Time range' });
    assert.ok(panel.querySelector('.trp-preset.is-active'));
    assert.equal(panel.querySelector('.trp-preset.is-active').textContent, '15');
    // First "6" is under Hours (Minutes has 5,10,…). Pick 1 Hour: second "1".
    fireEvent.click(screen.getAllByRole('button', { name: '1' })[1]);
    assert.deepEqual(changes, [{ mode: 'relative', relative: '1h', from: '', to: '' }]);
    assert.equal(screen.queryByRole('dialog'), null);
  });

  it('closes on Escape and on an outside click, not on an inside one', () => {
    setup();
    const btn = screen.getByRole('button', { name: /Past 15 Minutes/ });
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: 'x' });
    assert.ok(screen.getByRole('dialog'));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('dialog'), null);
    fireEvent.click(btn);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    assert.ok(screen.getByRole('dialog'));
    fireEvent.mouseDown(document.body);
    assert.equal(screen.queryByRole('dialog'), null);
  });

  it('stages an absolute range and commits only on Apply', () => {
    const { changes, container } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Past 15 Minutes/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Absolute' }));
    const apply = screen.getByRole('button', { name: 'Apply' });
    assert.equal(apply.disabled, true);
    const [from, to] = container.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(from, { target: { value: '2026-08-03T12:45' } });
    fireEvent.change(to, { target: { value: '2026-08-03T13:00' } });
    assert.equal(changes.length, 0);
    fireEvent.click(apply);
    assert.deepEqual(changes, [{
      mode: 'absolute', relative: '15m', from: '2026-08-03T12:45', to: '2026-08-03T13:00',
    }]);
  });

  it('Clear empties the drafts and disables Apply; Relative tab returns to presets', () => {
    const { container } = setup({ mode: 'absolute', relative: '15m', from: '2026-08-03T12:45', to: '2026-08-03T13:00' });
    fireEvent.click(screen.getByRole('button', { name: /→/ }));
    assert.equal(screen.getByRole('tab', { name: 'Absolute' }).getAttribute('aria-selected'), 'true');
    const [from] = container.querySelectorAll('input[type="datetime-local"]');
    assert.equal(from.value, '2026-08-03T12:45');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    assert.equal(from.value, '');
    assert.equal(screen.getByRole('button', { name: 'Apply' }).disabled, true);
    fireEvent.click(screen.getByRole('tab', { name: 'Relative' }));
    assert.ok(screen.getByText('Minutes'));
    // No preset is active while the committed range is absolute.
    assert.equal(document.querySelector('.trp-preset.is-active'), null);
  });
});

describe('RefreshIntervalPicker', () => {
  afterEach(cleanup);

  const setup = (props) => {
    const picks = [];
    const utils = render(h(RefreshIntervalPicker, { value: 0, onChange: (v) => picks.push(v), ...props }));
    return { ...utils, picks };
  };

  it('reads "off" and picks an interval from the menu', () => {
    const { picks } = setup();
    const btn = screen.getByTitle('Auto-refresh is off');
    fireEvent.click(btn);
    assert.equal(screen.getByRole('menuitemradio', { name: 'Off' }).getAttribute('aria-checked'), 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: '5 min' }));
    assert.deepEqual(picks, [300]);
    assert.equal(screen.queryByRole('menu'), null);
  });

  it('shows the compact interval on its face', () => {
    const { rerender } = setup({ value: 30 });
    assert.ok(screen.getByTitle('Auto-refreshing every 30s'));
    assert.equal(document.querySelector('.rip-value').textContent, '30s');
    rerender(h(RefreshIntervalPicker, { value: 300, onChange: () => {} }));
    assert.equal(document.querySelector('.rip-value').textContent, '5m');
    rerender(h(RefreshIntervalPicker, { value: 3600, onChange: () => {} }));
    assert.equal(document.querySelector('.rip-value').textContent, '1h');
  });

  it('says why it is paused, in the title and in the menu', () => {
    setup({ value: 60, pausedReason: 'Paused while you are off the first page' });
    const btn = screen.getByTitle('Auto-refresh 1m — Paused while you are off the first page');
    assert.match(btn.className, /is-paused/);
    fireEvent.click(btn);
    assert.ok(screen.getByText('Paused while you are off the first page'));
  });

  it('closes on Escape and on an outside click', () => {
    setup({ value: 5 });
    const btn = screen.getByTitle('Auto-refreshing every 5s');
    fireEvent.click(btn);
    fireEvent.mouseDown(screen.getByRole('menu'));
    assert.ok(screen.getByRole('menu'));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('menu'), null);
    fireEvent.click(btn);
    fireEvent.mouseDown(document.body);
    assert.equal(screen.queryByRole('menu'), null);
    fireEvent.click(btn);
    fireEvent.keyDown(document, { key: 'q' });
    fireEvent.click(btn);
    assert.equal(screen.queryByRole('menu'), null);
  });
});
