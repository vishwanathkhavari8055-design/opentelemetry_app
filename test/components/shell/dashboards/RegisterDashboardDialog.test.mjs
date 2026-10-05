/**
 * Register Dashboard: choosing a folder lists that folder's unregistered
 * dashboards; a candidate's own Register button, or a hand-typed UID, POSTs to
 * /registry; the backend's refusal is shown verbatim (it names the fix); and
 * Escape / Cancel / backdrop close the dialog except while a request is in
 * flight. These are the paths an administrator takes and the ones that have
 * regressed before (a stale preselected folder silently breaking Register).
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { default: RegisterDashboardDialog } = await import('../../../../src/components/dashboards/RegisterDashboardDialog.jsx');

const h = React.createElement;

const FOLDERS = [
  { uid: 'ops', title: 'Ops', path: 'Ops', depth: 0 },
  { uid: 'dev', title: 'Dev', path: 'Dev', depth: 0 },
];

let stub;
const serve = (routes) => { stub = stubFetch(routes); return stub; };

const open = (props = {}) => {
  const events = { cancelled: 0, registered: [] };
  render(h(RegisterDashboardDialog, {
    folders: FOLDERS,
    onCancel: () => { events.cancelled += 1; },
    onRegistered: (row) => events.registered.push(row),
    ...props,
  }));
  return events;
};

const body = (call) => JSON.parse(call.init.body);

describe('RegisterDashboardDialog', () => {
  afterEach(() => { cleanup(); stub?.restore(); stub = null; });

  it('lists a folder\'s unregistered dashboards and registers one with a click', async () => {
    const { calls } = serve([
      [/\/dashboards\/available/, { items: [{ uid: 'n1', title: 'Node exporter' }] }],
      [(url, init) => init.method === 'POST' && /\/dashboards\/registry/.test(url),
        { uid: 'n1', title: 'Node exporter', folderTitle: 'Ops' }],
    ]);
    const events = open();
    assert.equal(screen.getByRole('button', { name: 'Register' }).disabled, true);
    assert.equal(document.activeElement, screen.getByLabelText(/Dashboard UID/));

    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'ops' } });
    assert.ok(screen.getByText('Searching Grafana…'));
    const button = await screen.findByTitle('Register Node exporter into Ops');
    assert.match(calls[0].url, /\/dashboards\/available\?folderUid=ops/);
    assert.ok(screen.getByText('n1'));

    fireEvent.click(button);
    await waitFor(() => assert.equal(events.registered.length, 1));
    const post = calls.find((c) => c.init.method === 'POST');
    assert.deepEqual(body(post), { uid: 'n1', folderUid: 'ops' });
  });

  it('registers a hand-typed UID and shows the backend\'s refusal verbatim', async () => {
    serve([
      [/\/dashboards\/available/, { items: [] }],
      [/\/dashboards\/registry/, { status: 404, body: { error: "No dashboard with UID 'zz' exists in Grafana." } }],
    ]);
    const events = open({ defaultFolderUid: 'dev' });
    assert.ok(await screen.findByText(/Every dashboard in this folder is already registered/));
    assert.equal(document.querySelector('.gd-count').textContent, '0');

    fireEvent.change(screen.getByLabelText(/Dashboard UID/), { target: { value: '  zz  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    assert.ok(screen.getByRole('button', { name: 'Registering…' }));
    const alert = await screen.findByRole('alert');
    assert.equal(alert.textContent.replace('!', ''), "No dashboard with UID 'zz' exists in Grafana.");
    assert.equal(events.registered.length, 0);
    assert.equal(stub.calls.filter((c) => c.init.method === 'POST').length, 1);
    assert.deepEqual(body(stub.calls.find((c) => c.init.method === 'POST')), { uid: 'zz', folderUid: 'dev' });

    // Editing clears the error.
    fireEvent.change(screen.getByLabelText(/Dashboard UID/), { target: { value: 'zz2' } });
    assert.equal(screen.queryByRole('alert') === null, true);
  });

  it('falls back to a generic message when the refusal has no text', async () => {
    serve([
      [/\/dashboards\/available/, { items: [] }],
      [/\/dashboards\/registry/, { status: 500, body: 'boom' }],
    ]);
    open({ folders: [FOLDERS[0]] }); // a single folder is preselected
    fireEvent.change(screen.getByLabelText(/Dashboard UID/), { target: { value: 'x' } });
    fireEvent.submit(document.querySelector('form'));
    assert.match((await screen.findByRole('alert')).textContent, /Request failed \(HTTP 500\)/);
  });

  it('keeps the form usable when the candidate lookup fails', async (t) => {
    t.mock.method(console, 'warn', () => {});
    serve([[/\/dashboards\/available/, { status: 502, body: { message: 'down' } }]]);
    open({ defaultFolderUid: 'ops' });
    assert.ok(await screen.findByText(/You can still paste any UID above/));
    assert.equal(screen.queryByRole('alert') === null, true);
  });

  it('ignores a preselected folder Grafana no longer lists', () => {
    serve([]);
    open({ defaultFolderUid: 'gone' });
    assert.equal(screen.getByLabelText('Folder').value, '');
    assert.equal(screen.queryByText(/Unregistered dashboards in/) === null, true);
  });

  it('explains an empty folder list', () => {
    serve([]);
    open({ folders: [], foldersMessage: 'Grafana is unreachable.' });
    assert.ok(screen.getByText('Grafana is unreachable.'));
    assert.equal(screen.queryByRole('combobox') === null, true);
    assert.equal(screen.getByRole('button', { name: 'Register' }).disabled, true);
  });

  it('closes on Escape, Cancel, the close button and the backdrop', () => {
    serve([]);
    const events = open();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.click(document.querySelector('form')); // inside the form does not close
    assert.equal(events.cancelled, 4);
  });
});
