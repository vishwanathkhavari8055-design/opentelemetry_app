/**
 * AlertsView is the rules screen: a folder rail and a server-filtered alert
 * list. Guarded here, through the backend seam:
 *  - which list request is sent (folder, alertType per tab, search, the All
 *    Folders switch dropping the folder) — filtering is server-side, so the
 *    request IS the behaviour;
 *  - the synthesised "default" folder when OpenObserve has not materialised it,
 *    and the folder list surviving a failed folder fetch;
 *  - every row write (enable, clone, trigger, delete) hits the right endpoint,
 *    reports success or failure in the toast and refetches;
 *  - destructive/outward actions go through a confirmation first;
 *  - folder create/delete; paging; loading/empty/error states;
 *  - read-only users (no CONFIGURE_ALERTS) see no mutating controls;
 *  - the sub-views (wizard, editor, import) open and "Back" returns to the list.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { default: AlertsView } = await import('../../../src/components/alerts/AlertsView.jsx');
const { default: AuthContext } = await import('../../../src/auth/AuthContext.jsx');

const LS_TAB = 'observability-ui:alerts:tab:v1';

const ROWS = [
  { alertId: 'a1', name: 'High CPU', owner: 'ops@x', enabled: true, alertType: 'scheduled', folderId: 'default', period: 10, frequency: 5 },
  { alertId: 'a2', name: 'Error burst', owner: '', enabled: false, alertType: 'realtime', realTime: true, folderId: 'default' },
];

const method = (init) => (init?.method || 'GET').toUpperCase();
const is = (m, re) => (url, init) => method(init) === m && re.test(url);

/** Default backend: two folders (no "default"), two alerts. */
const backend = (overrides = []) => stubFetch([
  ...overrides,
  [is('GET', /\/alerts\/folders(\?|$)/), { items: [{ folderId: 'f-z', name: 'zeta' }, { folderId: 'f-a', name: 'alpha', description: 'A folder' }] }],
  [is('GET', /\/alerts(\?|$)/), { items: ROWS }],
]);

const listCalls = (calls) => calls
  .filter((c) => method(c.init) === 'GET' && /\/alerts(\?|$)/.test(c.url))
  .map((c) => Object.fromEntries(new URL(c.url, 'http://x').searchParams));

const renderView = (role = 'ADMIN') => render(
  React.createElement(AuthContext.Provider, { value: { role } },
    React.createElement(AlertsView, { activeOrg: 'org1' })),
);

/** A button by its aria-label or, failing that, its text — getByRole's name
 *  computation is too slow on a table this size. */
const qbtn = (name, root = document.body) => {
  const q = within(root);
  return q.queryByLabelText(name, { selector: 'button' }) ?? q.queryByText(name, { selector: 'button' });
};
const btn = (name, root) => {
  const b = qbtn(name, root);
  assert.ok(b, `no button ${name}`);
  return b;
};

const waitForRows = () => screen.findByText('High CPU');

describe('AlertsView', () => {
  let stub;
  beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
  afterEach(() => { cleanup(); stub?.restore(); stub = null; });

  it('lists alerts for the default folder, with "default" synthesised first in the rail', async () => {
    stub = backend();
    renderView();
    assert.ok(screen.getByText('Loading…'));
    await waitForRows();
    assert.ok(screen.getByText('Error burst'));
    assert.ok(screen.getByText('ops@x'));
    assert.equal(screen.getByText('Error burst').closest('.alerts-row').querySelector('.alerts-owner').textContent, '—', 'a missing owner renders a dash');
    assert.ok(screen.getByText('Enabled') && screen.getByText('Disabled'));
    await waitFor(() => assert.ok(screen.getByText('alpha')));
    const rail = screen.getByLabelText('Alert folders');
    const names = [...rail.querySelectorAll('.alerts-folder-name')].map((n) => n.textContent);
    assert.deepEqual(names, ['default', 'alpha', 'zeta']);
    assert.equal(qbtn('Delete folder default', rail), null,
      'the root folder cannot be deleted');
    assert.deepEqual(listCalls(stub.calls)[0], { folder: 'default', alertType: 'all' });
    assert.ok(screen.getByText('2 Alerts'));
  });

  it('sends the tab, folder, search and All Folders choices to the server', async () => {
    stub = backend();
    renderView();
    await waitForRows();
    fireEvent.click(screen.getByText('Scheduled', { selector: '[role=tab]' }));
    await waitFor(() => assert.equal(listCalls(stub.calls).at(-1).alertType, 'scheduled'));
    assert.equal(localStorage.getItem(LS_TAB), 'scheduled');
    assert.equal(screen.queryByText('Type'), null, 'the Type column is only on All');

    fireEvent.click(screen.getByText('Realtime', { selector: '[role=tab]' }));
    await waitFor(() => assert.equal(listCalls(stub.calls).at(-1).alertType, 'realtime'));
    assert.equal(screen.queryByText('Look back window'), null, 'realtime has no window columns');

    await waitFor(() => screen.getByText('alpha'));
    fireEvent.click(screen.getByText('alpha'));
    await waitFor(() => assert.equal(listCalls(stub.calls).at(-1).folder, 'f-a'));
    fireEvent.keyDown(screen.getByText('zeta').parentElement, { key: 'Enter' });
    await waitFor(() => assert.equal(listCalls(stub.calls).at(-1).folder, 'f-z'));

    fireEvent.change(screen.getByLabelText('Search Alert'), { target: { value: ' cpu ' } });
    await waitFor(() => assert.equal(listCalls(stub.calls).at(-1).search, 'cpu'));

    fireEvent.click(screen.getByTitle('List alerts across every folder'));
    await waitFor(() => assert.equal(listCalls(stub.calls).at(-1).folder, undefined));
    assert.equal(screen.getByTitle('List alerts across every folder').getAttribute('aria-checked'), 'true');

    const before = listCalls(stub.calls).length;
    fireEvent.click(btn('Refresh'));
    await waitFor(() => assert.ok(listCalls(stub.calls).length > before));
  });

  it('restores the remembered tab', async () => {
    localStorage.setItem(LS_TAB, 'realtime');
    stub = backend();
    renderView();
    await waitForRows();
    assert.equal(screen.getByText('Realtime', { selector: '[role=tab]' }).getAttribute('aria-selected'), 'true');
    assert.equal(listCalls(stub.calls)[0].alertType, 'realtime');
  });

  it('filters the folder rail locally', async () => {
    stub = backend();
    renderView();
    await waitFor(() => screen.getByText('alpha'));
    fireEvent.change(screen.getByLabelText('Search Folder'), { target: { value: 'ZE' } });
    assert.equal(screen.queryByText('alpha'), null);
    assert.ok(screen.getByText('zeta'));
    fireEvent.change(screen.getByLabelText('Search Folder'), { target: { value: 'nothing' } });
    assert.ok(screen.getByText('No folders match.'));
  });

  it('shows the empty label, the search-specific empty label, and an unsupported backend', async () => {
    stub = backend([[is('GET', /\/alerts\?/), (url) => (/search=/.test(url)
      ? { items: [] } : { items: [], supported: /alertType=realtime/.test(url) ? false : true })]]);
    renderView();
    await screen.findByText('No data available');
    assert.ok(screen.getByText('0 Alerts'));
    fireEvent.change(screen.getByLabelText('Search Alert'), { target: { value: 'zzz' } });
    await screen.findByText('Nothing matches “zzz”.');
    fireEvent.change(screen.getByLabelText('Search Alert'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Realtime', { selector: '[role=tab]' }));
    await screen.findByText('Alerts require the OpenObserve backend.');
  });

  it('shows the server error when the list fails, and keeps a default folder when folders fail', async () => {
    const origError = console.error;
    console.error = () => {};
    try {
      stub = backend([
        [is('GET', /\/alerts\/folders/), { status: 500, body: { error: 'folders down' } }],
        [is('GET', /\/alerts\?/), { status: 502, body: { error: 'OpenObserve unreachable' } }],
      ]);
      renderView();
      await screen.findByText('OpenObserve unreachable');
      await waitFor(() => {
        const rail = screen.getByLabelText('Alert folders');
        assert.deepEqual([...rail.querySelectorAll('.alerts-folder-name')].map((n) => n.textContent), ['default']);
      });
    } finally { console.error = origError; }
  });

  it('toggles an alert off through PATCH …/enable and reports success', async () => {
    stub = backend([[is('PATCH', /\/alerts\/a1\/enable/), { message: 'Alert disabled.' }]]);
    renderView();
    await waitForRows();
    const before = listCalls(stub.calls).length;
    fireEvent.click(screen.getByTitle('Disable “High CPU”'));
    await screen.findByText('Alert disabled.');
    const call = stub.calls.find((c) => method(c.init) === 'PATCH');
    assert.match(call.url, /\/alerts\/a1\/enable\?value=false/);
    await waitFor(() => assert.ok(listCalls(stub.calls).length > before), 'refetches after the write');
  });

  it('reports a failed enable in the error toast', async () => {
    stub = backend([[is('PATCH', /\/alerts\/a2\/enable/), { status: 409, body: { error: 'locked' } }]]);
    renderView();
    await waitForRows();
    fireEvent.click(screen.getByTitle('Enable “Error burst”'));
    const alert = await waitFor(() => { const a = document.querySelector('[role=alert]'); assert.ok(a); return a; });
    assert.match(alert.textContent, /Enabling alert failed — locked/);
    fireEvent.click(btn('Dismiss', alert));
    assert.equal(document.querySelector('[role=alert]'), null);
  });

  it('clones into the row’s folder', async () => {
    stub = backend([[is('POST', /\/alerts\/a1\/clone/), {}]]);
    renderView();
    await waitForRows();
    fireEvent.click(btn('Clone High CPU'));
    await screen.findByText('Clone succeeded.');
    const call = stub.calls.find((c) => /clone/.test(c.url));
    assert.deepEqual(JSON.parse(call.init.body), { name: '', folderId: 'default' });
  });

  it('asks before evaluating, worded per alert type, and triggers only on confirm', async () => {
    stub = backend([[is('PATCH', /\/trigger/), { message: 'Alert triggered' }]]);
    renderView();
    await waitForRows();

    fireEvent.click(btn('Evaluate Error burst now'));
    assert.ok(screen.getByLabelText('Send a test notification?', { selector: 'dialog' }));
    assert.match(document.querySelector('dialog').textContent, /realtime alert/);
    fireEvent.click(btn('Cancel'));
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(stub.calls.some((c) => /trigger/.test(c.url)), false);

    fireEvent.click(btn('Evaluate High CPU now'));
    assert.ok(screen.getByLabelText('Evaluate alert now?', { selector: 'dialog' }));
    fireEvent.click(btn('Evaluate now'));
    await screen.findByText('Alert triggered');
    assert.ok(stub.calls.some((c) => method(c.init) === 'PATCH' && /\/alerts\/a1\/trigger/.test(c.url)));
  });

  it('deletes an alert after confirmation', async () => {
    stub = backend([[is('DELETE', /\/alerts\/a1/), { status: 204, body: null }]]);
    renderView();
    await waitForRows();
    fireEvent.click(btn('Delete High CPU'));
    const dialog = screen.getByLabelText('Delete alert?', { selector: 'dialog' });
    assert.match(dialog.textContent, /“High CPU” will be removed/);
    fireEvent.click(btn('Delete', dialog));
    await screen.findByText('Delete succeeded.');
    assert.ok(stub.calls.some((c) => method(c.init) === 'DELETE' && /\/alerts\/a1$/.test(c.url)));
  });

  it('creates a folder, showing the server’s refusal inline and closing on success', async () => {
    let attempt = 0;
    stub = backend([[is('POST', /\/alerts\/folders/), () => (++attempt === 1
      ? { status: 400, body: { error: 'Folder exists' } } : { folderId: 'f-new' })]]);
    renderView();
    await waitForRows();
    fireEvent.click(btn('New folder'));
    const dialog = screen.getByLabelText('New folder', { selector: 'dialog' });
    const save = btn('Save', dialog);
    assert.equal(save.disabled, true, 'Save needs a name');
    assert.equal(document.activeElement, within(dialog).getByPlaceholderText('Folder name'));
    fireEvent.change(within(dialog).getByPlaceholderText('Folder name'), { target: { value: ' ops ' } });
    fireEvent.change(within(dialog).getByPlaceholderText('Optional'), { target: { value: 'team' } });
    fireEvent.click(save);
    await within(dialog).findByText('Folder exists');
    fireEvent.submit(dialog.querySelector('form'));
    await screen.findByText('Folder “ops” created.');
    assert.equal(screen.queryByLabelText('New folder', { selector: 'dialog' }), null);
    const posts = stub.calls.filter((c) => method(c.init) === 'POST');
    assert.deepEqual(JSON.parse(posts[1].init.body), { name: 'ops', description: 'team' });
  });

  it('closes the folder dialog on Cancel and on ×', async () => {
    stub = backend();
    renderView();
    await waitForRows();
    fireEvent.click(btn('New folder'));
    fireEvent.click(btn('Cancel'));
    assert.equal(document.querySelector('dialog'), null);
    fireEvent.click(btn('New folder'));
    fireEvent.click(btn('Close'));
    assert.equal(document.querySelector('dialog'), null);
  });

  it('deletes the active folder, falling back to default; reports a refused delete', async () => {
    let attempt = 0;
    stub = backend([[is('DELETE', /\/alerts\/folders\//), () => (++attempt === 1
      ? { status: 409, body: { error: 'Folder not empty' } } : { status: 204, body: null })]]);
    renderView();
    await waitFor(() => screen.getByText('alpha'));
    fireEvent.click(screen.getByText('alpha'));
    await waitFor(() => assert.equal(listCalls(stub.calls).at(-1).folder, 'f-a'));

    fireEvent.click(btn('Delete folder alpha'));
    fireEvent.click(btn('Delete', screen.getByLabelText('Delete folder?', { selector: 'dialog' })));
    await screen.findByText('Delete folder failed — Folder not empty');

    fireEvent.click(btn('Delete folder alpha'));
    fireEvent.click(btn('Delete', screen.getByLabelText('Delete folder?', { selector: 'dialog' })));
    await screen.findByText('Folder deleted.');
    assert.ok(stub.calls.some((c) => method(c.init) === 'DELETE' && /\/alerts\/folders\/f-a$/.test(c.url)));
    await waitFor(() => assert.equal(listCalls(stub.calls).at(-1).folder, 'default'));
  });

  it('pages the list and resets to page one when the page size changes', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ alertId: `id${i}`, name: `Alert ${i + 1}`, enabled: true }));
    stub = backend([[is('GET', /\/alerts\?/), { items: many }]]);
    renderView();
    await screen.findByText('Alert 1');
    assert.equal(screen.queryByText('Alert 21'), null);
    assert.equal(btn('Previous page').disabled, true);
    fireEvent.click(btn('Next page'));
    assert.ok(screen.getByText('Alert 21'));
    assert.equal(screen.getByText('Alert 21').closest('.alerts-row').querySelector('.alerts-num').textContent, '21', 'row numbers continue across pages');
    assert.equal(btn('Next page').disabled, true);
    fireEvent.click(btn('Previous page'));
    assert.ok(screen.getByText('Alert 1'));
    fireEvent.click(btn('Next page'));
    fireEvent.change(screen.getByLabelText('Records per page'), { target: { value: '50' } });
    assert.ok(screen.getByText('Alert 1') && screen.getByText('Alert 21'));
  });

  it('gives a read-only user the list with no mutating controls', async () => {
    stub = backend();
    renderView('OPERATOR');
    await waitForRows();
    for (const name of ['New folder', 'New alert', 'Edit High CPU', 'Delete High CPU', 'Clone High CPU']) {
      assert.equal(qbtn(name), null, name);
    }
    assert.equal(qbtn(/Import/), null);
    const sw = screen.getByTitle(/Enabled — you do not have permission/);
    assert.equal(sw.disabled, true);
    assert.equal(screen.getByText('High CPU').getAttribute('role'), null, 'the name is plain text');
  });

  it('opens the wizard, the editor and the import screen, and Back returns to a refetched list', async () => {
    stub = backend();
    renderView();
    await waitForRows();

    const back = async () => {
      const before = listCalls(stub.calls).length;
      fireEvent.click(await screen.findByLabelText('Back to alerts', { selector: 'button' }));
      await waitForRows();
      await waitFor(() => assert.ok(listCalls(stub.calls).length > before));
    };

    fireEvent.click(btn('New alert'));
    assert.equal(screen.queryByText('Alert Rules'), null);
    await back();

    fireEvent.click(btn('Edit High CPU'));
    assert.equal(screen.queryByText('Alert Rules'), null);
    await back();
    assert.ok(stub.calls.some((c) => /\/alerts\/a1(\?|$)/.test(c.url)), 'the editor loads the alert');

    fireEvent.click(screen.getByRole('button', { name: 'Error burst' }));
    await back();

    fireEvent.click(btn(/Import/));
    assert.equal(screen.queryByText('Alert Rules'), null);
    await back();
  });
});
