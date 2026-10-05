/**
 * DestinationDialog creates an OpenObserve notification destination from inside
 * the alert editor. Guarded here:
 *  - a template is mandatory (without one OpenObserve silently makes a pipeline
 *    destination the editor can never list), and the template list only offers
 *    templates of the destination's own type;
 *  - the name / recipient / URL validation messages the user sees;
 *  - the exact POST body for email and webhook kinds, and that the backend's
 *    own rejection message is shown rather than swallowed;
 *  - cancel paths (backdrop, ×, Cancel) and that clicks inside do not cancel.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
const { default: DestinationDialog } = await import('../../../src/components/alerts/DestinationDialog.jsx');

const TEMPLATES = { items: [
  { name: 'email_tpl', type: 'email' },
  { name: 'http_tpl', type: 'http' },
  { name: 'any_tpl' },
] };

let restore = () => {};
const setup = (routes = [[/\/alerts\/templates/, TEMPLATES]]) => {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const cancelled = [];
  const created = [];
  render(React.createElement(DestinationDialog, {
    onCancel: () => cancelled.push(true),
    onCreated: (n) => created.push(n),
  }));
  return { ...stub, cancelled, created };
};

const change = (label, value) => fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
const templateOptions = () => [...document.querySelectorAll('#dest-template option')].map((o) => o.value);

describe('DestinationDialog', () => {
  afterEach(() => { cleanup(); restore(); });

  it('focuses the name field and offers only email-compatible templates', async () => {
    setup();
    assert.equal(document.activeElement, document.getElementById('dest-name'));
    await waitFor(() => assert.deepEqual(templateOptions(), ['', 'email_tpl', 'any_tpl']));
  });

  it('switching to webhook swaps fields and drops a now-incompatible template', async () => {
    setup();
    await waitFor(() => assert.ok(templateOptions().includes('email_tpl')));
    fireEvent.change(document.getElementById('dest-template'), { target: { value: 'email_tpl' } });
    fireEvent.change(document.getElementById('dest-type'), { target: { value: 'http' } });
    assert.deepEqual(templateOptions(), ['', 'http_tpl', 'any_tpl']);
    assert.equal(document.getElementById('dest-template').value, '');
    assert.ok(document.getElementById('dest-url'));
    assert.equal(document.getElementById('dest-emails'), null);
  });

  it('says so when no template of this type exists', async () => {
    setup([[/\/alerts\/templates/, { items: [{ name: 'http_tpl', type: 'http' }] }]]);
    await waitFor(() => screen.getByText(/No email templates exist yet/));
    assert.ok(document.body.innerHTML.length > 0);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('validates name, template and recipients in order', async () => {
    const { calls } = setup();
    await waitFor(() => assert.ok(templateOptions().includes('email_tpl')));
    save();
    screen.getByText('A name is required.');
    change('Name', 'has space');
    save();
    screen.getByText(/no spaces/);
    change('Name', 'oncall');
    save();
    screen.getByText(/A template is required/);
    fireEvent.change(document.getElementById('dest-template'), { target: { value: 'email_tpl' } });
    save();
    screen.getByText('Add at least one recipient.');
    for (const bad of ['a b@x.com', '@x.com', 'a@b@c.com', 'a@nodot', 'a@x.c']) {
      fireEvent.change(document.getElementById('dest-emails'), { target: { value: `ok@x.com, ${bad}` } });
      save();
      assert.ok(screen.getByText(/does not look like an email address/), bad);
    }
    assert.equal(calls.filter((c) => c.init.method === 'POST').length, 0);
  });

  it('POSTs an email destination and reports the created name', async () => {
    const { calls, created } = setup([
      [/\/alerts\/templates/, TEMPLATES],
      [/\/alerts\/destinations/, { ok: true }],
    ]);
    await waitFor(() => assert.ok(templateOptions().includes('email_tpl')));
    change('Name', ' oncall_email ');
    fireEvent.change(document.getElementById('dest-emails'), { target: { value: 'a@x.com; b@y.org' } });
    fireEvent.change(document.getElementById('dest-template'), { target: { value: 'email_tpl' } });
    save();
    await waitFor(() => assert.deepEqual(created, ['oncall_email']));
    const post = calls.find((c) => c.init.method === 'POST');
    assert.match(post.url, /\/alerts\/destinations$/);
    assert.deepEqual(JSON.parse(post.init.body), {
      name: 'oncall_email', type: 'email', template: 'email_tpl',
      emails: ['a@x.com', 'b@y.org'], url: '', method: 'post', skip_tls_verify: false,
    });
  });

  it('validates and POSTs a webhook destination with method and TLS skip', async () => {
    const { calls, created } = setup([
      [/\/alerts\/templates/, TEMPLATES],
      [/\/alerts\/destinations/, { ok: true }],
    ]);
    await waitFor(() => assert.ok(templateOptions().length > 1));
    change('Name', 'hook');
    fireEvent.change(document.getElementById('dest-type'), { target: { value: 'http' } });
    fireEvent.change(document.getElementById('dest-template'), { target: { value: 'http_tpl' } });
    save();
    screen.getByText('A URL is required.');
    fireEvent.change(document.getElementById('dest-url'), { target: { value: 'ftp://x' } });
    save();
    screen.getByText(/must start with http/);
    fireEvent.change(document.getElementById('dest-url'), { target: { value: 'https://hooks.example.com/x' } });
    fireEvent.change(document.getElementById('dest-method'), { target: { value: 'put' } });
    const tls = screen.getByRole('button', { name: /Skip certificate verification/ });
    fireEvent.click(tls);
    assert.equal(tls.getAttribute('aria-pressed'), 'true');
    screen.getByText(/without validating the endpoint/);
    save();
    await waitFor(() => assert.deepEqual(created, ['hook']));
    const post = calls.find((c) => c.init.method === 'POST');
    assert.deepEqual(JSON.parse(post.init.body), {
      name: 'hook', type: 'http', template: 'http_tpl', url: 'https://hooks.example.com/x',
      method: 'put', skip_tls_verify: true, emails: [],
    });
  });

  it("shows the backend's rejection and re-enables Save", async () => {
    const { created } = setup([
      [/\/alerts\/templates/, TEMPLATES],
      [/\/alerts\/destinations/, { status: 400, body: { error: 'Destination already exists' } }],
    ]);
    await waitFor(() => assert.ok(templateOptions().includes('email_tpl')));
    change('Name', 'dup');
    fireEvent.change(document.getElementById('dest-emails'), { target: { value: 'a@x.com' } });
    fireEvent.change(document.getElementById('dest-template'), { target: { value: 'email_tpl' } });
    save();
    await waitFor(() => screen.getByText('Destination already exists'));
    assert.equal(screen.getByRole('button', { name: 'Save' }).disabled, false);
    assert.deepEqual(created, []);
  });

  it('still opens when templates cannot load', async () => {
    const orig = console.error;
    const logged = [];
    console.error = (...a) => logged.push(a);
    try {
      setup([[/\/alerts\/templates/, { status: 500, body: { error: 'down' } }]]);
      await waitFor(() => assert.equal(logged.length, 1));
      assert.deepEqual(templateOptions(), ['']);
    } finally { console.error = orig; }
  });

  it('cancels from the backdrop, × and Cancel, but not from inside the form', () => {
    const { cancelled } = setup();
    fireEvent.click(document.getElementById('dest-name'));
    assert.equal(cancelled.length, 0);
    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    assert.equal(cancelled.length, 3);
  });
});
