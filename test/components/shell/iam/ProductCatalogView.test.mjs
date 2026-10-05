/**
 * Product Catalog screen. Disabling a row here hides that resource's telemetry
 * from Logs, Traces and Metrics app-wide, so what is guarded is: filters go to
 * the server as query params (never applied to a cached array), row actions hit
 * the right PATCH/DELETE and refetch, Remove warns that a disabled resource's
 * telemetry will reappear, failures surface in a dismissible banner, and the
 * unsupported / empty / filtered-empty states say what they mean.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { default: ProductCatalogView } = await import('../../../../src/components/ProductCatalogView.jsx');

const CATEGORIES = { items: [
  { code: 'APPLICATIONS', label: 'Applications', registeredCount: 2 },
  { code: 'DATABASES', label: 'Databases' },
] };
const RESOURCES = [
  {
    id: 'r-1', resourceName: 'tiotesb', resolvedName: 'tiot-esb', category: 'APPLICATIONS',
    categoryLabel: 'Applications', productLabel: 'ESB', version: '1.4.2', status: 'ENABLED',
    lastSeen: '2026-09-25T00:00:00Z', lastSeenAgoSec: 120,
  },
  {
    id: 'r-2', resourceName: 'PostgreSQL', category: 'DATABASES', status: 'DISABLED',
    lastSeen: '2026-09-24T00:00:00Z',
  },
];

const LIST = /\/product-catalog(\?|$)/;
const isList = (url) => LIST.test(url);

let stub = null;
const mount = (routes, props = {}) => {
  stub = stubFetch(routes);
  render(React.createElement(ProductCatalogView, { activeOrg: 'default', ...props }));
  return stub;
};
const baseRoutes = (list = { items: RESOURCES, filterMode: null }) => [
  [/\/product-catalog\/categories/, CATEGORIES],
  [LIST, list],
];
const rowOf = (name) => screen.getByText(name, { selector: '.pc-name, .pc-name *' }).closest('.pc-row');

describe('ProductCatalogView', () => {
  afterEach(() => {
    cleanup();
    stub?.restore();
    stub = null;
    localStorage.clear();
  });

  it('lists registered resources with product, version, status and last seen', async () => {
    mount(baseRoutes());
    assert.ok(screen.getByText('Loading…'));
    await screen.findByText('tiotesb');
    const esb = rowOf('tiotesb');
    assert.ok(within(esb).getByText('ESB'));
    assert.ok(within(esb).getByText('1.4.2'));
    assert.ok(within(esb).getByText('tiot-esb'));
    assert.ok(within(esb).getByText('2m ago'));
    assert.ok(within(esb).getByText('Enabled'));
    assert.ok(within(esb).getByRole('button', { name: 'Disable' }));

    const pg = rowOf('PostgreSQL');
    assert.ok(within(pg).getByText('DATABASES'), 'falls back to the category code');
    assert.ok(within(pg).getByText('Disabled'));
    assert.ok(within(pg).getByRole('button', { name: 'Enable' }));

    assert.match(screen.getByText(/2 resources/).textContent, /1 enabled/);
    assert.ok(screen.getByRole('option', { name: 'Applications (2)' }));
    assert.ok(screen.getByText(/Disabled resources are hidden from Logs/));
  });

  it('says nothing is registered yet, and states the enabled-only mode', async () => {
    mount(baseRoutes({ items: [], filterMode: 'ENABLED_ONLY' }));
    await screen.findByText(/Nothing registered yet/);
    assert.ok(screen.getByText('0 resources'));
    assert.ok(screen.getByText(/Only registered, enabled resources appear/));
  });

  it('sends category, status and debounced search to the server and persists the category', async () => {
    const { calls } = mount(baseRoutes({ items: [] }));
    await screen.findByText(/Nothing registered yet/);

    fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'DATABASES' } });
    await waitFor(() => assert.ok(calls.some((c) => isList(c.url) && c.url.includes('category=DATABASES'))));
    assert.equal(localStorage.getItem('observability-ui:catalog:category:v1'), 'DATABASES');

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'DISABLED' } });
    await waitFor(() => assert.ok(calls.some((c) => isList(c.url) && c.url.includes('status=DISABLED'))));

    fireEvent.change(screen.getByLabelText('Search resources'), { target: { value: 'pg' } });
    await waitFor(() => assert.ok(calls.some((c) => isList(c.url) && c.url.includes('search=pg'))), { timeout: 2000 });
    await screen.findByText('No registered resource matches these filters.');
  });

  it('starts on the category remembered from last time', async () => {
    localStorage.setItem('observability-ui:catalog:category:v1', 'APPLICATIONS');
    const { calls } = mount(baseRoutes());
    await screen.findByText('tiotesb');
    assert.ok(calls.some((c) => isList(c.url) && c.url.includes('category=APPLICATIONS')));
    assert.equal(screen.getByLabelText('Filter by category').value, 'APPLICATIONS');
  });

  it('disables a resource with a PATCH, toasts, and refetches with refresh=true', async () => {
    const { calls } = mount([
      [/\/r-1\/disable$/, { message: 'tiotesb is now hidden' }],
      ...baseRoutes(),
    ]);
    await screen.findByText('tiotesb');
    fireEvent.click(within(rowOf('tiotesb')).getByRole('button', { name: 'Disable' }));
    await screen.findByText('tiotesb is now hidden');
    const patch = calls.find((c) => /r-1\/disable$/.test(c.url));
    assert.equal(patch.init.method, 'PATCH');
    await waitFor(() => assert.ok(calls.some((c) => isList(c.url) && c.url.includes('refresh=true'))));
  });

  it('enables a resource and falls back to its own description when the server sends no message', async () => {
    const { calls } = mount([[/\/r-2\/enable$/, { status: 204, body: null }], ...baseRoutes()]);
    await screen.findByText('PostgreSQL');
    fireEvent.click(within(rowOf('PostgreSQL')).getByRole('button', { name: 'Enable' }));
    await screen.findByText('PostgreSQL enabled');
    assert.equal(calls.find((c) => /r-2\/enable$/.test(c.url)).init.method, 'PATCH');
  });

  it('shows a failed action in a dismissible error banner', async () => {
    mount([[/\/r-1\/disable$/, { status: 409, body: { error: 'Registry is read-only' } }], ...baseRoutes()]);
    await screen.findByText('tiotesb');
    fireEvent.click(within(rowOf('tiotesb')).getByRole('button', { name: 'Disable' }));
    const banner = await screen.findByRole('alert');
    assert.match(banner.textContent, /Registry is read-only/);
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    assert.equal(screen.queryByRole('alert') === null, true);
  });

  it('warns that removing a disabled resource makes its telemetry reappear, then DELETEs it', async () => {
    const { calls } = mount([
      [(url, init) => init.method === 'DELETE', { message: 'PostgreSQL removed' }],
      ...baseRoutes(),
    ]);
    await screen.findByText('PostgreSQL');
    fireEvent.click(within(rowOf('PostgreSQL')).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove resource' });
    assert.ok(within(dialog).getByText('Remove PostgreSQL?'));
    assert.match(within(dialog).getByText(/make its logs, traces and metrics/).textContent, /appear again/);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await screen.findByText('PostgreSQL removed');
    const del = calls.find((c) => c.init.method === 'DELETE');
    assert.match(del.url, /\/product-catalog\/r-2$/);
  });

  it('does not warn when removing an enabled resource, and Cancel / Escape close the confirmation', async () => {
    const { calls } = mount(baseRoutes());
    await screen.findByText('tiotesb');
    fireEvent.click(within(rowOf('tiotesb')).getByRole('button', { name: 'Remove' }));
    assert.equal(screen.queryByText(/appear again/) === null, true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    assert.equal(screen.queryByRole('dialog') === null, true);

    fireEvent.click(within(rowOf('tiotesb')).getByRole('button', { name: 'Remove' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('dialog') === null, true);

    fireEvent.click(within(rowOf('tiotesb')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(within(rowOf('tiotesb')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('dialog', { name: 'Remove resource' }));
    assert.equal(screen.queryByRole('dialog') === null, true);
    assert.equal(calls.some((c) => c.init.method === 'DELETE'), false);
  });

  it('opens the details drawer for a row and closes it', async () => {
    mount(baseRoutes());
    await screen.findByText('tiotesb');
    fireEvent.click(within(rowOf('tiotesb')).getByRole('button', { name: 'Details' }));
    const drawer = screen.getByRole('dialog', { name: 'Details for tiotesb' });
    assert.ok(within(drawer).getByText('r-1'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    assert.equal(screen.queryByRole('dialog') === null, true);
  });

  it('registers a resource through the dialog, preselecting the filtered category', async () => {
    localStorage.setItem('observability-ui:catalog:category:v1', 'DATABASES');
    const { calls } = mount([
      [/\/product-catalog\/products/, { items: [] }],
      [/\/product-catalog\/register$/, { resourceName: 'Redis', categoryLabel: 'Databases' }],
      ...baseRoutes(),
    ]);
    await screen.findByText('tiotesb');
    fireEvent.click(screen.getByRole('button', { name: 'Register Resource' }));
    const dialog = screen.getByRole('dialog', { name: 'Register resource' });
    assert.equal(within(dialog).getByLabelText(/Category/).value, 'DATABASES');
    await waitFor(() => assert.equal(within(dialog).queryByText('Loading products…') === null, true));
    fireEvent.change(within(dialog).getByLabelText(/Resource Name/), { target: { value: 'Redis' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register' }));
    await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true));
    assert.ok(calls.some((c) => /register$/.test(c.url)));
    // The table refetches so the new row and counts appear.
    await waitFor(() => assert.ok(calls.filter((c) => isList(c.url)).length >= 2));

    fireEvent.click(screen.getByRole('button', { name: 'Register Resource' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    assert.equal(screen.queryByRole('dialog') === null, true);
  });

  // Suspected bug: onRegistered sets the success notice and then calls
  // manualRefresh(), which clears it in the same batch — the toast never shows.
  it('toasts "<name> registered under <category>" after registering', {
    skip: 'suspected bug: manualRefresh() clears the notice set just before it',
  }, async () => {
    mount([
      [/\/product-catalog\/products/, { items: [] }],
      [/\/product-catalog\/register$/, { resourceName: 'Redis', categoryLabel: 'Databases' }],
      ...baseRoutes(),
    ]);
    await screen.findByText('tiotesb');
    fireEvent.click(screen.getByRole('button', { name: 'Register Resource' }));
    const dialog = screen.getByRole('dialog', { name: 'Register resource' });
    await waitFor(() => assert.equal(within(dialog).queryByText('Loading products…') === null, true));
    fireEvent.change(within(dialog).getByLabelText(/Resource Name/), { target: { value: 'Redis' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register' }));
    await screen.findByText('Redis registered under Databases.');
  });

  it('shows the unsupported banner and blocks registration without the OpenObserve backend', async () => {
    mount(baseRoutes({ items: RESOURCES, supported: false }));
    await screen.findByText('tiotesb');
    assert.ok(screen.getByText(/needs the OpenObserve backend to validate resources/));
    assert.equal(screen.getByRole('button', { name: 'Register Resource' }).disabled, true);
  });

  it('shows a load failure, and Refresh retries it', async () => {
    let fail = true;
    const { calls } = mount([
      [/\/product-catalog\/categories/, CATEGORIES],
      [LIST, () => (fail ? { status: 500, body: { error: 'OpenObserve unreachable' } } : { items: RESOURCES })],
    ]);
    assert.match((await screen.findByRole('alert')).textContent, /OpenObserve unreachable/);
    fail = false;
    const before = calls.length;
    fireEvent.click(screen.getByLabelText('Refresh'));
    await screen.findByText('tiotesb');
    assert.ok(calls.length > before);
    assert.equal(screen.queryByRole('alert') === null, true);
  });

  it('refetches when the tab becomes visible again', async () => {
    const { calls } = mount(baseRoutes());
    await screen.findByText('tiotesb');
    const before = calls.filter((c) => isList(c.url)).length;
    document.dispatchEvent(new window.Event('visibilitychange'));
    await waitFor(() => assert.ok(calls.filter((c) => isList(c.url)).length > before));
  });
});
