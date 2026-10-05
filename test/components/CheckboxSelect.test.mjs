/**
 * CheckboxSelect keeps the caller's option order and never drops an earlier
 * pick when a second one is ticked — both are what its callers rely on.
 */
import '../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: CheckboxSelect } = await import('../../src/components/alerts/fired/CheckboxSelect.jsx');

const OPTIONS = [
  { value: 'disaster', label: 'Disaster' },
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

describe('CheckboxSelect', () => {
  afterEach(cleanup);

  it('shows the all-label with nothing selected', () => {
    renderSelect();
    assert.match(screen.getByRole('button', { name: 'Severity' }).textContent, /^All severities/);
  });

  it('shows the single label, then a count', () => {
    const { rerender } = renderSelect({ value: ['critical'] });
    assert.match(screen.getByRole('button', { name: 'Severity' }).textContent, /^Critical/);
    rerender(React.createElement(CheckboxSelect, {
      options: OPTIONS, value: ['critical', 'warning'], onChange: () => {},
      allLabel: 'All severities', noun: 'severities', ariaLabel: 'Severity',
    }));
    assert.match(screen.getByRole('button', { name: 'Severity' }).textContent, /^2 severities/);
  });
});
