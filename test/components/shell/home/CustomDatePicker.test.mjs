/**
 * CustomDatePicker hands its caller a plain "YYYY-MM-DD" string (or '' on
 * Clear) — the shape the date filters feed straight into query params — and
 * closes itself after a pick or a click outside it.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: CustomDatePicker } = await import('../../../../src/components/CustomDatePicker.jsx');

const pad = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const renderPicker = (props = {}) => {
  const picked = [];
  const utils = render(React.createElement(CustomDatePicker, { onChange: (v) => picked.push(v), ...props }));
  return { ...utils, picked };
};

const day = (n) => screen.getAllByText(String(n)).find((el) => el.classList.contains('datepicker-day'));

describe('CustomDatePicker', () => {
  afterEach(cleanup);

  it('shows the placeholder, and opens on the value\'s month with it selected', () => {
    renderPicker({ placeholder: 'From' });
    assert.ok(screen.getByText('From'));
    cleanup();

    renderPicker({ value: '2024-02-10' });
    fireEvent.click(screen.getByText('2024-02-10'));
    assert.ok(screen.getByText('February 2024'));
    assert.ok(day(10).className.includes('selected'));
    // Feb 2024 starts on a Thursday: four leading blanks, 29 days.
    assert.equal(document.querySelectorAll('.datepicker-day.empty').length, 4);
    assert.equal(document.querySelectorAll('.datepicker-day:not(.empty)').length, 29);
  });

  it('pages between months and emits the picked day zero-padded, then closes', () => {
    const { picked } = renderPicker({ value: '2024-01-15' });
    fireEvent.click(screen.getByText('2024-01-15'));
    fireEvent.click(screen.getByRole('button', { name: '<' }));
    assert.ok(screen.getByText('December 2023'));
    fireEvent.click(screen.getByRole('button', { name: '>' }));
    fireEvent.click(screen.getByRole('button', { name: '>' }));
    assert.ok(screen.getByText('February 2024'));
    fireEvent.click(day(5));
    assert.deepEqual(picked, ['2024-02-05']);
    assert.equal(document.querySelector('.datepicker-popup'), null);
  });

  it('marks today, and Today / Clear emit today and the empty string', () => {
    const { picked } = renderPicker();
    fireEvent.click(screen.getByText('Select date'));
    assert.equal(document.querySelectorAll('.datepicker-day.today').length, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    fireEvent.click(screen.getByText('Select date'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    assert.deepEqual(picked, [today(), '']);
    assert.equal(document.querySelector('.datepicker-popup'), null);
  });

  it('closes on a mousedown outside, but not inside, and toggles from its input', () => {
    renderPicker();
    fireEvent.click(screen.getByText('Select date'));
    fireEvent.mouseDown(document.querySelector('.datepicker-grid'));
    assert.ok(document.querySelector('.datepicker-popup'));
    fireEvent.mouseDown(document.body);
    assert.equal(document.querySelector('.datepicker-popup'), null);
    fireEvent.click(screen.getByText('Select date'));
    fireEvent.click(screen.getByText('Select date'));
    assert.equal(document.querySelector('.datepicker-popup'), null);
  });
});
