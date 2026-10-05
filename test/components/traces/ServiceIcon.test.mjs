/**
 * ServiceIcon derives its colour from the service NAME, so a service keeps one
 * colour across the Spans, Traces and Catalog tables and across reloads — a
 * counter-based palette would recolour everything whenever the row order
 * changed. Guarded here: same name gives the same colour, a missing name falls
 * back to the neutral text colour and a "?" glyph, and the glyph is the
 * upper-cased first letter.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, cleanup } = await import('@testing-library/react');
const { default: ServiceIcon, colorForService } = await import('../../../src/components/traces/ServiceIcon.jsx');

describe('ServiceIcon', () => {
  afterEach(cleanup);

  it('is stable per name and falls back for no name', () => {
    assert.equal(colorForService('checkout'), colorForService('checkout'));
    assert.match(colorForService('checkout'), /^#[0-9a-f]{6}$/);
    assert.equal(colorForService(''), 'var(--text-secondary)');
    assert.equal(colorForService(null), 'var(--text-secondary)');
    // Different names do not all collapse onto one hue.
    const hues = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(colorForService));
    assert.ok(hues.size > 3);
  });

  it('renders the initial in the service colour', () => {
    const { container, rerender } = render(React.createElement(ServiceIcon, { name: '  payments' }));
    const icon = container.querySelector('.tt-svc-icon');
    assert.equal(icon.textContent, 'P');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.ok(icon.style.borderColor);

    rerender(React.createElement(ServiceIcon, {}));
    assert.equal(container.querySelector('.tt-svc-icon').textContent, '?');
  });
});
