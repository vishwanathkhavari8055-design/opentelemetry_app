/**
 * Update User drawer. Guards the contract the backend depends on: only the
 * fields the user actually changed are PUT (OpenObserve reads a supplied null as
 * "clear this"), password changes are validated before any request, root's role
 * cannot be changed, and a refusal from the server is shown rather than lost.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { default: UserEditDrawer } = await import('../../../../src/components/iam/UserEditDrawer.jsx');

const USER = { email: 'ann@example.com', firstName: 'Ann', lastName: '', role: 'editor' };

let stub = null;
const renderDrawer = (user = USER) => {
  const events = { cancel: 0, saved: [] };
  render(React.createElement(UserEditDrawer, {
    user,
    onCancel: () => { events.cancel += 1; },
    onSaved: (e) => events.saved.push(e),
  }));
  return events;
};
const updateBtn = () => screen.getByRole('button', { name: 'Update' });

describe('UserEditDrawer', () => {
  afterEach(() => { cleanup(); stub?.restore(); stub = null; });

  it('shows the email as read-only text, the loaded fields, and Update disabled until something changes', () => {
    renderDrawer();
    assert.ok(screen.getByText('ann@example.com'));
    assert.ok(screen.getByText('email cannot be changed.'));
    assert.equal(screen.getByLabelText('First Name').value, 'Ann');
    assert.equal(screen.getByLabelText('Role').value, 'editor');
    assert.equal(updateBtn().disabled, true);
    assert.match(screen.getByText(/shared service account/).textContent, /Recorded in OpenObserve/);
    // First field receives focus so the user can type immediately.
    assert.equal(document.activeElement, screen.getByLabelText('First Name'));
  });

  it('PUTs only the changed fields and reports the server message', async () => {
    stub = stubFetch([[/\/iam\/users\/ann%40example\.com$/, { message: 'Ann saved' }]]);
    const events = renderDrawer();
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Lee' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'viewer' } });
    fireEvent.click(updateBtn());
    await waitFor(() => assert.equal(events.saved.length, 1));
    assert.deepEqual(events.saved[0], { message: 'Ann saved', passwordChanged: false });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].init.method, 'PUT');
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), { lastName: 'Lee', role: 'viewer' });
  });

  it('falls back to "<email> updated." when the server sends no message', async () => {
    stub = stubFetch([[/\/iam\/users\//, {}]]);
    const events = renderDrawer();
    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Anne' } });
    fireEvent.click(updateBtn());
    await waitFor(() => assert.equal(events.saved.length, 1));
    assert.equal(events.saved[0].message, 'ann@example.com updated.');
  });

  it('shows the server refusal in the notice panel and re-enables the form', async () => {
    stub = stubFetch([[/\/iam\/users\//, { status: 400, body: { error: 'Role not allowed' } }]]);
    const events = renderDrawer();
    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Anne' } });
    fireEvent.click(updateBtn());
    const alert = await screen.findByRole('alert');
    assert.equal(alert.textContent.includes('Role not allowed'), true);
    assert.equal(events.saved.length, 0);
    assert.equal(screen.getByLabelText('First Name').disabled, false);
    assert.equal(updateBtn().disabled, false);
  });

  it('validates the new password length and match before sending anything', async () => {
    stub = stubFetch([[/\/iam\/users\//, { message: 'ok' }]]);
    const events = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Change Password/ }));
    assert.match(screen.getByText(/replaces this user's password/).textContent, /tell them out of band/);

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'short' } });
    fireEvent.click(updateBtn());
    assert.match(screen.getByRole('alert').textContent, /at least 8 characters/);

    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'longenough1' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'different1' } });
    fireEvent.click(updateBtn());
    assert.match(screen.getByRole('alert').textContent, /do not match/);
    assert.equal(stub.calls.length, 0);

    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'longenough1' } });
    fireEvent.click(updateBtn());
    await waitFor(() => assert.equal(events.saved.length, 1));
    assert.equal(events.saved[0].passwordChanged, true);
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), { changePassword: true, newPassword: 'longenough1' });
  });

  it('forgets a typed password when the toggle is switched back off', () => {
    renderDrawer();
    const toggle = screen.getByRole('button', { name: /Change Password/ });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'secret123' } });
    assert.equal(updateBtn().disabled, false);
    fireEvent.click(toggle);
    assert.equal(screen.queryByLabelText('New Password') === null, true);
    assert.equal(updateBtn().disabled, true);
    fireEvent.click(toggle);
    assert.equal(screen.getByLabelText('New Password').value, '');
  });

  it('locks the role control for root and keeps its unlisted role selectable', () => {
    renderDrawer({ email: 'root@example.com', role: 'Root' });
    const role = screen.getByLabelText('Role');
    assert.equal(role.disabled, true);
    assert.equal(role.value, 'root');
    assert.ok(screen.getByRole('option', { name: 'Root' }));
    assert.match(screen.getByText(/root user's role cannot be changed/).textContent, /lock everyone out/);
  });

  it('closes on Cancel, the ✕, Escape and a backdrop click — not on a click inside', () => {
    const events = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Update User'));
    assert.equal(events.cancel, 3);
    fireEvent.click(screen.getByRole('dialog', { name: 'Update user' }));
    assert.equal(events.cancel, 4);
  });

  it('cancels instead of sending an empty PUT when an edit was reverted', () => {
    stub = stubFetch([]);
    // A user whose role differs only by case: nothing the form would send.
    const events = renderDrawer({ email: 'x@example.com', role: 'viewer' });
    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: '' } });
    fireEvent.submit(updateBtn().closest('form'));
    assert.equal(events.cancel, 1);
    assert.equal(stub.calls.length, 0);
  });
});
