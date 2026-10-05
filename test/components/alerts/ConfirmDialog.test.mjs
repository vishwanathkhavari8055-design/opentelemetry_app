/**
 * ConfirmDialog guards the Alerts screen's unrecoverable actions (delete, and
 * trigger — which sends real notifications). What must hold: focus starts on
 * Cancel so a stray Enter is safe; Escape, the ×, and a backdrop click all
 * cancel; a click inside the panel does not; and while busy neither button can
 * be pressed twice.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react');
const { default: ConfirmDialog } = await import('../../../src/components/alerts/ConfirmDialog.jsx');

const renderDialog = (props = {}) => {
  const log = [];
  const utils = render(React.createElement(ConfirmDialog, {
    title: 'Delete alert?',
    body: 'This cannot be undone.',
    onCancel: () => log.push('cancel'),
    onConfirm: () => log.push('confirm'),
    ...props,
  }));
  return { ...utils, log };
};

describe('ConfirmDialog', () => {
  afterEach(cleanup);

  it('names itself by its title, shows the body and default labels, and focuses Cancel', () => {
    renderDialog();
    assert.ok(screen.getByRole('dialog', { name: 'Delete alert?' }));
    assert.ok(screen.getByText('This cannot be undone.'));
    assert.equal(document.activeElement, screen.getByRole('button', { name: 'Cancel' }));
    assert.ok(screen.getByRole('button', { name: 'Confirm' }));
  });

  it('uses custom labels and calls onConfirm on the confirm button', () => {
    const { log } = renderDialog({ confirmLabel: 'Delete', cancelLabel: 'Keep', danger: true });
    const del = screen.getByRole('button', { name: 'Delete' });
    assert.match(del.getAttribute('style') || '', /error-color/);
    fireEvent.click(del);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    assert.deepEqual(log, ['confirm', 'cancel']);
  });

  it('cancels on Escape, the close button and the backdrop — not on a click inside', () => {
    const { log } = renderDialog();
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByText('This cannot be undone.'));
    fireEvent.click(screen.getByRole('dialog'));
    assert.deepEqual(log, ['cancel', 'cancel', 'cancel']);
  });

  it('shows Working… and disables both buttons while busy', () => {
    renderDialog({ busy: true });
    const working = screen.getByRole('button', { name: 'Working…' });
    assert.equal(working.disabled, true);
    assert.equal(screen.getByRole('button', { name: 'Cancel' }).disabled, true);
  });
});
