/**
 * AlertImport turns pasted, dropped, picked or URL-fetched JSON into a
 * per-document import. Guarded here:
 *  - the JSON is validated before Import is allowed, and every export shape
 *    OpenObserve produces (object, array, {list}, {alerts}) is accepted;
 *  - Import POSTs exactly the parsed documents to the chosen folder, and the
 *    screen only closes when EVERY document landed — a partial failure keeps
 *    the report and the source side by side;
 *  - files other than .json are refused; a URL is fetched by the browser and
 *    a failure explains the CORS cause;
 *  - an inline "new folder" is created, re-listed and selected.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
const { default: AlertImport } = await import('../../../src/components/alerts/AlertImport.jsx');

const FOLDERS = [
  { folderId: 'default', name: 'default' },
  { folderId: 'f-ops', name: 'Ops' },
];

let restore = () => {};
const setup = (routes = [], props = {}) => {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const closed = [];
  const imported = [];
  const foldersCreated = [];
  const utils = render(React.createElement(AlertImport, {
    folders: FOLDERS,
    onClose: () => closed.push(true),
    onImported: (m) => imported.push(m),
    onFolderCreated: () => foldersCreated.push(true),
    ...props,
  }));
  return { ...stub, ...utils, closed, imported, foldersCreated };
};

const editor = () => screen.getByLabelText('Alert JSON');
const typeJson = (value) => fireEvent.change(editor(), { target: { value } });
const importBtn = () => screen.getByRole('button', { name: 'Import' });

describe('AlertImport', () => {
  afterEach(() => { cleanup(); restore(); });

  it('keeps Import disabled until the JSON is valid, and explains why not', () => {
    setup();
    assert.equal(importBtn().disabled, true);
    screen.getByText(/Results appear here/);
    typeJson('{ nope');
    screen.getByText(/^Invalid JSON — /);
    assert.equal(importBtn().disabled, true);
    typeJson('[]');
    screen.getByText('No alert objects found in this JSON.');
    typeJson('42');
    screen.getByText('No alert objects found in this JSON.');
  });

  it('accepts every export shape and counts the documents', () => {
    setup();
    for (const [json, n] of [
      ['{"name":"a"}', 1],
      ['[{"name":"a"},{"name":"b"}]', 2],
      ['{"list":[{"name":"a"},{"name":"b"},{"name":"c"}]}', 3],
      ['{"alerts":[{"name":"a"}]}', 1],
    ]) {
      typeJson(json);
      screen.getByText(`${n} alert document(s) ready to import.`);
      assert.equal(importBtn().disabled, false);
    }
  });

  it('imports into the chosen folder and closes when all succeed', async () => {
    const { calls, imported } = setup([
      [/\/alerts\/import$/, [{ name: 'a', ok: true }, { name: 'b', ok: true }]],
    ]);
    typeJson('{"list":[{"name":"a"},{"name":"b"}]}');
    fireEvent.change(screen.getByLabelText('Target folder'), { target: { value: 'f-ops' } });
    fireEvent.click(importBtn());
    await waitFor(() => assert.deepEqual(imported, [{ message: 'Imported 2 alert(s).' }]));
    const post = calls.find((c) => c.init.method === 'POST');
    assert.deepEqual(JSON.parse(post.init.body), {
      alerts: [{ name: 'a' }, { name: 'b' }], folderId: 'f-ops',
    });
    screen.getByText(/2 imported\./);
  });

  it('stays on screen with a per-document report when some fail', async () => {
    const { imported } = setup([
      [/\/alerts\/import$/, [
        { name: 'good', ok: true },
        { name: 'bad', ok: false, message: 'Alert with this name already exists' },
      ]],
    ]);
    typeJson('[{"name":"good"},{"name":"bad"}]');
    fireEvent.click(importBtn());
    await waitFor(() => screen.getByText(/1 imported, 1 failed\./));
    screen.getByText('Alert with this name already exists');
    screen.getByText('good');
    assert.deepEqual(imported, []);
    // Editing the JSON clears the stale report.
    typeJson('[{"name":"bad2"}]');
    screen.getByText(/Results appear here/);
  });

  it('shows the error when the import request fails', async () => {
    const { imported } = setup([[/\/alerts\/import$/, { status: 500, body: { error: 'OpenObserve down' } }]]);
    typeJson('{"name":"a"}');
    fireEvent.click(importBtn());
    await waitFor(() => screen.getByText('OpenObserve down'));
    assert.equal(importBtn().disabled, false);
    assert.deepEqual(imported, []);
  });

  it('refuses non-.json files and loads a picked .json file', async () => {
    setup();
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(['x'], 'alerts.txt')] } });
    screen.getByText('Only .json files are accepted.');
    fireEvent.change(input, { target: { files: [new File(['{"name":"picked"}'], 'alerts.json')] } });
    await waitFor(() => screen.getByText('alerts.json'));
    assert.equal(editor().value, '{"name":"picked"}');
    assert.equal(screen.queryByText('Only .json files are accepted.'), null);
  });

  it('loads a dropped file, highlights on drag-over, and clears', async () => {
    setup();
    const drop = screen.getByRole('button', { name: /Drop your file here/ });
    fireEvent.dragOver(drop);
    assert.match(drop.className, /is-over/);
    fireEvent.dragLeave(drop);
    assert.doesNotMatch(drop.className, /is-over/);
    fireEvent.drop(drop, { dataTransfer: { files: [new File(['[{"name":"d"}]'], 'drop.JSON')] } });
    await waitFor(() => screen.getByText('drop.JSON'));
    screen.getByText('1 alert document(s) ready to import.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    assert.equal(editor().value, '');
    screen.getByText('Drop your file here');
  });

  it('opens the file picker from the drop zone by click and keyboard', () => {
    setup();
    const input = document.querySelector('input[type="file"]');
    let clicks = 0;
    input.click = () => { clicks += 1; };
    const drop = screen.getByRole('button', { name: /Drop your file here/ });
    fireEvent.click(drop);
    fireEvent.keyDown(drop, { key: 'Enter' });
    fireEvent.keyDown(drop, { key: ' ' });
    fireEvent.keyDown(drop, { key: 'a' });
    assert.equal(clicks, 3);
  });

  it('fetches JSON from a URL in the browser', async () => {
    const { calls } = setup([[/example\.com\/exports\/alerts\.json/, [{ name: 'u' }]]]);
    fireEvent.click(screen.getByRole('tab', { name: 'URL Import' }));
    assert.equal(screen.getByRole('tab', { name: 'URL Import' }).getAttribute('aria-selected'), 'true');
    const load = screen.getByRole('button', { name: 'Load' });
    assert.equal(load.disabled, true);
    fireEvent.change(screen.getByLabelText('Alert JSON URL'), { target: { value: 'https://example.com/exports/alerts.json' } });
    fireEvent.click(load);
    await waitFor(() => screen.getByText('1 alert document(s) ready to import.'));
    assert.equal(calls[0].url, 'https://example.com/exports/alerts.json');
    fireEvent.click(screen.getByRole('tab', { name: 'File Upload / JSON' }));
    screen.getByText('alerts.json');
  });

  it('explains a failed URL fetch, also triggered by Enter', async () => {
    setup([[/nope/, { status: 404, body: '' }]]);
    fireEvent.click(screen.getByRole('tab', { name: 'URL Import' }));
    const input = screen.getByLabelText('Alert JSON URL');
    fireEvent.change(input, { target: { value: 'https://nope.example/a.json' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => screen.getByText(/Could not fetch that URL — HTTP 404\..*cross-origin/));
    assert.ok(document.body.innerHTML.length > 0);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('creates a folder inline, re-lists and selects it', async () => {
    const { calls, foldersCreated } = setup([
      [(u, i) => /\/alerts\/folders$/.test(u) && i.method === 'POST', { folderId: 'f-new' }],
      [/\/alerts\/folders$/, { items: [...FOLDERS, { folderId: 'f-new', name: 'Payments' }] }],
    ]);
    fireEvent.click(screen.getByTitle('New folder'));
    const name = screen.getByLabelText('New folder name');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));   // empty: ignored
    assert.equal(calls.length, 0);
    fireEvent.change(name, { target: { value: 'Payments' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => assert.equal(screen.getByLabelText('Target folder').value, 'f-new'));
    assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Payments', description: '' });
    assert.equal(foldersCreated.length, 1);
    assert.equal(screen.queryByLabelText('New folder name'), null);
  });

  it('reports a folder that could not be created, and × abandons the input', async () => {
    setup([[/\/alerts\/folders$/, { status: 409, body: { error: 'exists' } }]]);
    fireEvent.click(screen.getByTitle('New folder'));
    fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Ops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => screen.getByText('Could not create folder — exists'));
    fireEvent.click(screen.getByRole('button', { name: '×' }));
    assert.equal(screen.queryByLabelText('New folder name'), null);
  });

  it('falls back to a default folder and picks up folders that arrive later', () => {
    const { rerender } = setup([], { folders: [] });
    const options = () => [...screen.getByLabelText('Target folder').options].map((o) => o.textContent);
    assert.deepEqual(options(), ['default']);
    rerender(React.createElement(AlertImport, {
      folders: FOLDERS, initialFolderId: 'f-ops', onClose() {}, onImported() {},
    }));
    assert.deepEqual(options(), ['default', 'Ops']);
  });

  it('Back and Cancel both close', () => {
    const { closed } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Back to alerts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    assert.equal(closed.length, 2);
  });
});
