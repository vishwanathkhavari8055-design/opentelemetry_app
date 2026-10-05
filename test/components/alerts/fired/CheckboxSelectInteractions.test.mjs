/**
 * CheckboxSelect's menu behaviour, beyond the face text covered in
 * test/components/CheckboxSelect.test.mjs. Guarded — the menu opens and closes
 * (button, Escape, click outside), Select all / Clear emit the full and empty
 * selections, keyboard arrows move a cursor that Space/Enter toggle, the face's
 * × clears without opening the menu, and a disabled select never opens.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const { default: CheckboxSelect } = await import('../../../../src/components/alerts/fired/CheckboxSelect.jsx');

const OPTIONS = [
  { value: 'disaster', label: 'Disaster', tone: 'disaster' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
];

const renderSelect = (props = {}) => {
  const calls = [];
  const utils = render(React.createElement(CheckboxSelect, {
    options: OPTIONS, value: [], onChange: (v) => calls.push(v),
    allLabel: 'All severities', noun: 'severities', ariaLabel: 'Severity', ...props,
  }));
  return { ...utils, calls };
};

const face = () => screen.getByRole('button', { name: 'Severity' });

describe('CheckboxSelect menu', () => {
  afterEach(cleanup);

  it('opens with a count of options and closes on a second click', () => {
    renderSelect();
    fireEvent.click(face());
    assert.equal(face().getAttribute('aria-expanded'), 'true');
    assert.match(screen.getByRole('menu').textContent, /3 options/);
    fireEvent.click(face());
    assert.equal(screen.queryByRole('menu'), null);
  });

  it('closes on Escape and on a click outside', () => {
    renderSelect();
    fireEvent.click(face());
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('menu'), null);
    fireEvent.click(face());
    fireEvent.mouseDown(document.body);
    assert.equal(screen.queryByRole('menu'), null);
  });

  it('stays open for a click inside the menu', () => {
    renderSelect();
    fireEvent.click(face());
    fireEvent.mouseDown(screen.getByRole('menu'));
    fireEvent.keyDown(document, { key: 'Tab' });
    assert.ok(screen.getByRole('menu'));
  });

  it('Select all emits every option in order; Clear emits none', () => {
    const { calls } = renderSelect({ value: ['warning'] });
    fireEvent.click(face());
    const menu = screen.getByRole('menu');
    assert.match(menu.textContent, /1 of 3 selected/);
    fireEvent.click(within(menu).getByRole('button', { name: 'Select all' }));
    fireEvent.click(within(menu).getByRole('button', { name: 'Clear' }));
    assert.deepEqual(calls, [['disaster', 'critical', 'warning'], []]);
  });

  it('hides Select all when everything is selected', () => {
    renderSelect({ value: ['disaster', 'critical', 'warning'] });
    fireEvent.click(face());
    assert.equal(within(screen.getByRole('menu')).queryByRole('button', { name: 'Select all' }), null);
  });

  it('unticking removes just that option', () => {
    const { calls } = renderSelect({ value: ['disaster', 'warning'] });
    fireEvent.click(face());
    fireEvent.click(within(screen.getByRole('menu')).getByLabelText('Disaster'));
    assert.deepEqual(calls, [['warning']]);
  });

  it('arrow keys move the cursor, wrapping, and Space/Enter toggle it', () => {
    const { calls } = renderSelect();
    fireEvent.click(face());
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: ' ' }); // cursor 0: Disaster
    fireEvent.keyDown(menu, { key: 'ArrowUp' }); // wraps to Warning
    fireEvent.keyDown(menu, { key: 'Enter' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // wraps to Disaster
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // Critical
    fireEvent.keyDown(menu, { key: 'Enter' });
    fireEvent.keyDown(menu, { key: 'x' }); // ignored
    assert.deepEqual(calls, [['disaster'], ['warning'], ['critical']]);
  });

  it('hovering an option moves the cursor to it', () => {
    const { calls, container } = renderSelect();
    fireEvent.click(face());
    const items = container.querySelectorAll('.cbs-item');
    fireEvent.mouseEnter(items[2]);
    assert.match(items[2].className, /is-cursor/);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' });
    assert.deepEqual(calls, [['warning']]);
  });

  it('the face × clears by click and by keyboard without opening the menu', () => {
    const { calls } = renderSelect({ value: ['critical'] });
    const x = screen.getByRole('button', { name: 'Clear Severity' });
    fireEvent.click(x);
    fireEvent.keyDown(x, { key: 'Enter' });
    fireEvent.keyDown(x, { key: 'a' });
    assert.deepEqual(calls, [[], []]);
    assert.equal(screen.queryByRole('menu'), null);
    assert.equal(face().title, 'Critical');
  });

  it('falls back to the raw value for an unknown selection', () => {
    renderSelect({ value: ['mystery'] });
    assert.match(face().textContent, /^mystery/);
  });

  it('never opens when disabled', () => {
    renderSelect({ disabled: true });
    fireEvent.click(face());
    assert.equal(screen.queryByRole('menu'), null);
  });
});
