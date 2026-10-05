/**
 * Register Resource dialog and the resource Details drawer.
 *
 * The dialog: the Product row appears exactly for categories that have products
 * (read from the data, not a hard-coded list), changing category clears the
 * product, empty product/version are not sent, and the server's validation
 * refusal is shown in place so the name can be corrected.
 *
 * The drawer: it is the only place the matched identifiers are visible, and it
 * must distinguish "disabled but has telemetry" from "never matched".
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { default: RegisterResourceDialog } = await import('../../../../src/components/catalog/RegisterResourceDialog.jsx');
const { default: ResourceDetailsDrawer, agoLabel } = await import('../../../../src/components/catalog/ResourceDetailsDrawer.jsx');

const CATEGORIES = [
  { code: 'APPLICATIONS', label: 'Applications', registeredCount: 2 },
  { code: 'DATABASES', label: 'Databases' },
];
const PRODUCTS = [
  { code: 'esb', label: 'ESB', category: 'APPLICATIONS', note: 'bus', registeredCount: 1 },
  { code: 'crm', label: 'CRM', category: 'APPLICATIONS' },
];

let stub = null;
const renderDialog = (props = {}) => {
  const events = { cancel: 0, registered: [] };
  render(React.createElement(RegisterResourceDialog, {
    categories: CATEGORIES,
    onCancel: () => { events.cancel += 1; },
    onRegistered: (c) => events.registered.push(c),
    ...props,
  }));
  return events;
};
const registerBtn = () => screen.getByRole('button', { name: 'Register' });

describe('RegisterResourceDialog', () => {
  afterEach(() => { cleanup(); stub?.restore(); stub = null; });

  it('requires a product for a category that has products, then registers with it', async () => {
    stub = stubFetch([
      [/\/product-catalog\/products$/, { items: PRODUCTS }],
      [/\/product-catalog\/register$/, { resourceName: 'tiotesb', categoryLabel: 'Applications' }],
    ]);
    const events = renderDialog();
    assert.ok(screen.getByText('Loading products…'));
    const product = await screen.findByLabelText(/Product/);
    assert.equal(screen.queryByText('Loading products…') === null, true);
    assert.ok(screen.getByRole('option', { name: 'ESB — bus (1)' }));
    assert.ok(screen.getByRole('option', { name: 'Applications (2 registered)' }));
    assert.ok(screen.getByLabelText(/Microservice/));

    fireEvent.change(screen.getByLabelText(/Microservice/), { target: { value: '  tiotesb ' } });
    assert.equal(registerBtn().disabled, true, 'no product picked yet');
    fireEvent.change(product, { target: { value: 'esb' } });
    assert.equal(registerBtn().disabled, false);

    fireEvent.click(registerBtn());
    await waitFor(() => assert.equal(events.registered.length, 1));
    const post = stub.calls.find((c) => /register$/.test(c.url));
    assert.equal(post.init.method, 'POST');
    assert.deepEqual(JSON.parse(post.init.body), { category: 'APPLICATIONS', resourceName: 'tiotesb', product: 'esb' });
  });

  it('has no product row for a category without products, and sends the version when given', async () => {
    stub = stubFetch([
      [/\/products$/, { items: PRODUCTS }],
      [/\/register$/, { resourceName: 'PostgreSQL' }],
    ]);
    const events = renderDialog({ defaultCategory: 'DATABASES' });
    await waitFor(() => assert.equal(screen.queryByText('Loading products…') === null, true));
    assert.equal(screen.queryByLabelText(/Product/) === null, true);
    fireEvent.change(screen.getByLabelText(/Resource Name/), { target: { value: 'PostgreSQL' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: ' 15.2 ' } });
    fireEvent.click(registerBtn());
    await waitFor(() => assert.equal(events.registered.length, 1));
    const post = stub.calls.find((c) => /register$/.test(c.url));
    assert.deepEqual(JSON.parse(post.init.body), { category: 'DATABASES', resourceName: 'PostgreSQL', version: '15.2' });
  });

  it('clears the picked product when the category changes', async () => {
    stub = stubFetch([[/\/products$/, { items: PRODUCTS }]]);
    renderDialog();
    fireEvent.change(await screen.findByLabelText(/Product/), { target: { value: 'crm' } });
    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: 'DATABASES' } });
    assert.equal(screen.queryByLabelText(/Product/) === null, true);
    fireEvent.change(screen.getByLabelText(/Category/), { target: { value: 'APPLICATIONS' } });
    assert.equal(screen.getByLabelText(/Product/).value, '');
  });

  it('shows the server validation refusal and lets the name be corrected', async () => {
    stub = stubFetch([
      [/\/products$/, { items: [] }],
      [/\/register$/, { status: 422, body: { error: 'Resource not found in OpenObserve' } }],
    ]);
    const events = renderDialog({ defaultCategory: 'DATABASES' });
    await waitFor(() => assert.equal(screen.queryByText('Loading products…') === null, true));
    fireEvent.change(screen.getByLabelText(/Resource Name/), { target: { value: 'nope' } });
    fireEvent.click(registerBtn());
    assert.match((await screen.findByRole('alert')).textContent, /Resource not found in OpenObserve/);
    assert.equal(events.registered.length, 0);
    // Typing clears the stale error.
    fireEvent.change(screen.getByLabelText(/Resource Name/), { target: { value: 'pg' } });
    assert.equal(screen.queryByRole('alert') === null, true);
    assert.equal(registerBtn().disabled, false);
  });

  it('still lets a product-less category register when the product list fails to load', async () => {
    stub = stubFetch([[/\/products$/, { status: 500, body: {} }]]);
    renderDialog({ defaultCategory: 'DATABASES' });
    await waitFor(() => assert.equal(screen.queryByText('Loading products…') === null, true));
    fireEvent.change(screen.getByLabelText(/Resource Name/), { target: { value: 'pg' } });
    assert.equal(registerBtn().disabled, false);
  });

  it('closes on Cancel, ✕, Escape and backdrop, but not on a click inside', async () => {
    stub = stubFetch([[/\/products$/, { items: [] }]]);
    const events = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Register Resource'));
    assert.equal(events.cancel, 3);
    fireEvent.click(screen.getByRole('dialog', { name: 'Register resource' }));
    assert.equal(events.cancel, 4);
    await waitFor(() => assert.equal(screen.queryByText('Loading products…') === null, true));
  });
});

const BASE_RESOURCE = {
  id: 'r-1', resourceName: 'tiotesb', category: 'APPLICATIONS', categoryLabel: 'Applications',
  registeredAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
};

describe('ResourceDetailsDrawer', () => {
  afterEach(cleanup);

  it('formats ages in s/m/h/d and nothing for null', () => {
    assert.equal(agoLabel(null), null);
    assert.equal(agoLabel(5), '5s ago');
    assert.equal(agoLabel(125), '2m ago');
    assert.equal(agoLabel(7300), '2h ago');
    assert.equal(agoLabel(200000), '2d ago');
  });

  it('lists the matched identifiers and the facts for an enabled resource', () => {
    render(React.createElement(ResourceDetailsDrawer, {
      resource: {
        ...BASE_RESOURCE, status: 'ENABLED', resolvedName: 'tiot-esb', source: 'CONFIG',
        lastSeen: '2026-01-03T00:00:00Z', lastSeenAgoSec: 90,
        signals: { logs: true, traces: false, metrics: true, available: ['logs', 'metrics'] },
        bindings: [{ signal: 'logs', stream: 'default', column: 'service_name', value: 'tiot-esb' }],
      },
      onClose: () => {},
    }));
    const dialog = screen.getByRole('dialog', { name: 'Details for tiotesb' });
    assert.ok(dialog);
    assert.ok(screen.getByText('tiot-esb', { selector: 'code' }));
    assert.ok(screen.getByText('(1m ago)', { exact: false }));
    assert.ok(screen.getByText(/from configuration/));
    assert.ok(screen.getByText('service_name'));
    assert.ok(screen.getByText('r-1'));
    assert.equal(screen.getAllByText('available').length, 2);
    assert.equal(screen.getAllByText('not available').length, 1);
    assert.equal(screen.queryByText(/No telemetry has been matched/) === null, true);
  });

  it('says a disabled resource still has telemetry, naming which', () => {
    render(React.createElement(ResourceDetailsDrawer, {
      resource: { ...BASE_RESOURCE, status: 'DISABLED', signals: { available: ['logs', 'traces'] } },
      onClose: () => {},
    }));
    assert.match(screen.getByText(/This resource is disabled/).textContent, /logs, traces/);
    assert.ok(screen.getByText('not resolved yet'));
    assert.ok(screen.getByText(/None\. While a resource has no matched identifier/));
  });

  it('says an enabled resource with no telemetry has not been matched yet', () => {
    render(React.createElement(ResourceDetailsDrawer, {
      resource: { ...BASE_RESOURCE, status: 'ENABLED', categoryLabel: '', category: '' },
      onClose: () => {},
    }));
    assert.ok(screen.getByText(/No telemetry has been matched to this resource yet/));
  });

  it('closes on ✕, Escape and backdrop, not on a click inside', () => {
    let closed = 0;
    render(React.createElement(ResourceDetailsDrawer, {
      resource: { ...BASE_RESOURCE, status: 'ENABLED' }, onClose: () => { closed += 1; },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByText('Matched identifiers'));
    assert.equal(closed, 2);
    fireEvent.click(screen.getByRole('dialog'));
    assert.equal(closed, 3);
  });
});
