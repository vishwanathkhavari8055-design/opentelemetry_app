/**
 * AlertSummaryCards: each card is a filter. Guarded here — clicking applies the
 * card's exact filter (Critical is critical only, Resolved is RESOLVED only, so
 * the table never shows more rows than the number clicked), an applied card
 * reads as pressed and clicking it again clears only its own key, counts are
 * abbreviated, and loading shows skeletons rather than a calm-looking "0".
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: AlertSummaryCards } = await import('../../../../src/components/alerts/fired/AlertSummaryCards.jsx');
const { EMPTY_FILTERS } = await import('../../../../src/components/alerts/fired/useAlerts.js');

const SUMMARY = { open: 3, acknowledged: 0, critical: 1234, warning: 56789, error: 2_500_000, resolved: 999 };

const renderCards = (props = {}) => {
  const applied = [];
  const utils = render(React.createElement(AlertSummaryCards, {
    summary: SUMMARY, loading: false, filters: EMPTY_FILTERS, onApply: (p) => applied.push(p), ...props,
  }));
  return { ...utils, applied };
};

const card = (label) => screen.getByRole('button', { name: new RegExp(`^${label}`) });

describe('AlertSummaryCards', () => {
  afterEach(cleanup);

  it('shows each count, abbreviated past a thousand', () => {
    renderCards();
    assert.equal(card('Open').textContent, 'Open3');
    assert.equal(card('Acknowledged').textContent, 'Acknowledged0');
    assert.equal(card('Critical').textContent, 'Critical1.2K');
    assert.equal(card('Warning').textContent, 'Warning57K');
    assert.equal(card('Error').textContent, 'Error2.5M');
    assert.equal(card('Resolved').textContent, 'Resolved999');
  });

  it('shows skeletons, not zeros, while the first load is in flight', () => {
    const { container } = renderCards({ summary: null, loading: true });
    assert.equal(container.querySelectorAll('.alerts-card-skeleton').length, 6);
    assert.equal(container.querySelectorAll('.alerts-card-value').length, 0);
  });

  it('shows a dash when the summary is absent and not loading', () => {
    renderCards({ summary: null, loading: false });
    assert.equal(card('Open').textContent, 'Open—');
  });

  it('applies exactly the card filter when clicked', () => {
    const { applied } = renderCards();
    fireEvent.click(card('Critical'));
    fireEvent.click(card('Resolved'));
    fireEvent.click(card('Open'));
    assert.deepEqual(applied, [
      { severity: ['critical'] },
      { status: ['RESOLVED'] },
      { status: ['FIRING'] },
    ]);
  });

  it('marks the applied status card pressed and clears only status on a second click', () => {
    const { applied } = renderCards({ filters: { ...EMPTY_FILTERS, status: ['FIRING'] } });
    assert.equal(card('Open').getAttribute('aria-pressed'), 'true');
    assert.equal(card('Resolved').getAttribute('aria-pressed'), 'false');
    assert.match(card('Open').title, /click to clear/);
    fireEvent.click(card('Open'));
    assert.deepEqual(applied, [{ status: EMPTY_FILTERS.status }]);
  });

  it('marks a severity card pressed only with the default status, and clears severity', () => {
    const { applied, rerender } = renderCards({ filters: { ...EMPTY_FILTERS, severity: ['warning'] } });
    assert.equal(card('Warning').getAttribute('aria-pressed'), 'true');
    fireEvent.click(card('Warning'));
    assert.deepEqual(applied, [{ severity: [] }]);

    rerender(React.createElement(AlertSummaryCards, {
      summary: SUMMARY, filters: { ...EMPTY_FILTERS, severity: ['warning'], status: ['RESOLVED'] }, onApply: () => {},
    }));
    assert.equal(card('Warning').getAttribute('aria-pressed'), 'false');
    assert.equal(card('Resolved').getAttribute('aria-pressed'), 'false', 'status card is not active while a severity is set');
  });
});
