/**
 * Settings screen (IamView). Guards: each section tab shows its own table and
 * persists across reloads; Users and Service Accounts come from the org-scoped
 * backend while Organizations comes from App's list (so the header and table
 * never disagree); search filters and resets paging; the pager walks pages;
 * a user edit saves, toasts and refetches; external users cannot be edited;
 * Organizations can switch org and export CSV; loading/error/empty/unsupported
 * states are distinct; a deep link opens the requested section.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { default: IamView } = await import('../../../../src/components/IamView.jsx');

const LS_TAB = 'observability-ui:iam:tab:v1';

const USERS = [
  { email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee', role: 'admin', createdAt: '2026-01-01T00:00:00Z' },
  { email: 'sso@example.com', role: 'viewer', external: true },
];
const ACCOUNTS = [
  { email: 'bot@example.com', description: 'Ingest bot', hasToken: true },
  { email: 'idle@example.com' },
];
const ORGS = [
  { name: 'Default', identifier: 'default', type: 'default' },
  { name: 'Data "Lake", Hub', identifier: 'DLH', type: 'custom' },
];

let stub = null;
const noop = () => {};
const mount = (routes, props = {}) => {
  stub = stubFetch(routes);
  const events = { org: [], refreshOrgs: 0 };
  const el = (p) => React.createElement(IamView, {
    activeOrg: 'default',
    onOrgChange: (o) => events.org.push(o),
    organizations: ORGS,
    organizationsLoading: false,
    onRefreshOrganizations: () => { events.refreshOrgs += 1; },
    ...props,
    ...p,
  });
  const utils = render(el());
  return { ...utils, events, calls: stub.calls, rerender: (p) => utils.rerender(el(p)) };
};
const tab = (name) => screen.getByRole('button', { name });
const userRoutes = (users = USERS) => [
  [/\/iam\/users$/, { items: users }],
  [/\/iam\/service-accounts$/, { items: ACCOUNTS }],
];
const rowFor = (text) => screen.getByText(text).closest('.iam-row');

describe('IamView', () => {
  afterEach(() => {
    cleanup();
    stub?.restore();
    stub = null;
    localStorage.clear();
  });

  it('shows the Users table from the backend, with external users not editable', async () => {
    mount(userRoutes());
    assert.ok(screen.getByRole('heading', { name: 'Settings' }));
    assert.ok(screen.getByText('Loading…'));
    await screen.findByText('ann@example.com');
    const ann = rowFor('ann@example.com');
    assert.ok(within(ann).getByText('Admin'));
    assert.ok(within(ann).getByText('Lee'));
    assert.ok(within(ann).getByLabelText('Update ann@example.com'));
    const sso = rowFor('sso@example.com');
    assert.ok(within(sso).getByText('External'));
    assert.equal(within(sso).queryByRole('button') === null, true);
    assert.equal(tab('Users').getAttribute('aria-current'), 'page');
  });

  it('searches rows, says when nothing matches, and Refresh refetches', async () => {
    const { calls } = mount(userRoutes());
    await screen.findByText('ann@example.com');
    fireEvent.change(screen.getByLabelText('Search User'), { target: { value: 'SSO' } });
    assert.equal(screen.queryByText('ann@example.com') === null, true);
    assert.ok(screen.getByText('sso@example.com'));
    fireEvent.change(screen.getByLabelText('Search User'), { target: { value: 'zzz' } });
    assert.ok(screen.getByText('Nothing matches “zzz”.'));

    const before = calls.length;
    fireEvent.click(screen.getByLabelText('Refresh'));
    await waitFor(() => assert.equal(calls.length, before + 1));
    assert.match(calls.at(-1).url, /\/iam\/users$/);
  });

  it('says "No data available" for an empty org and shows request failures', async () => {
    mount([[/\/iam\/users$/, { items: [] }], [/\/iam\/service-accounts$/, { status: 500, body: {} }]]);
    await screen.findByText('No data available');
    fireEvent.click(tab('Service Accounts'));
    await screen.findByText('HTTP error! status: 500');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('says Settings needs the OpenObserve backend when the backend is unsupported', async () => {
    mount([[/\/iam\/users$/, { supported: false, items: [] }]]);
    await screen.findByText('Settings requires the OpenObserve backend.');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('lists service accounts without ever showing a token value', async () => {
    mount(userRoutes());
    await screen.findByText('ann@example.com');
    fireEvent.click(tab('Service Accounts'));
    await screen.findByText('bot@example.com');
    assert.ok(screen.getByRole('heading', { name: 'Service Accounts' }));
    assert.ok(within(rowFor('bot@example.com')).getByText('Set — view in OpenObserve'));
    assert.ok(within(rowFor('bot@example.com')).getByText('Ingest bot'));
    assert.equal(within(rowFor('idle@example.com')).getAllByText('—').length, 2);
    assert.ok(screen.getByLabelText('Search Service Account'));
    assert.equal(localStorage.getItem(LS_TAB), 'accounts');
  });

  it('pages 20 rows at a time with first/prev/next/last and numbered buttons', async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ email: `u${i + 1}@x.io`, role: 'user' }));
    mount(userRoutes(many));
    await screen.findByText('u1@x.io');
    assert.equal(screen.queryByText('u21@x.io') === null, true);
    assert.equal(screen.getByLabelText('First page').disabled, true);
    assert.equal(screen.getByLabelText('Page 1').getAttribute('aria-current'), 'page');
    assert.ok(screen.getByLabelText('Page 3'));

    fireEvent.click(screen.getByLabelText('Next page'));
    assert.ok(screen.getByText('u21@x.io'));
    assert.ok(screen.getByText('21'), 'serial numbers continue across pages');
    fireEvent.click(screen.getByLabelText('Last page'));
    assert.ok(screen.getByText('u45@x.io'));
    assert.equal(screen.getByLabelText('Next page').disabled, true);
    fireEvent.click(screen.getByLabelText('Previous page'));
    assert.ok(screen.getByText('u21@x.io'));
    fireEvent.click(screen.getByLabelText('First page'));
    assert.ok(screen.getByText('u1@x.io'));
    fireEvent.click(screen.getByLabelText('Page 3'));
    assert.ok(screen.getByText('u41@x.io'));

    // Searching resets to the first page.
    fireEvent.change(screen.getByLabelText('Search User'), { target: { value: 'u1' } });
    assert.equal(screen.getByLabelText('Page 1').getAttribute('aria-current'), 'page');
  });

  it('edits a user, toasts the result and refetches the table', async () => {
    const { calls } = mount([
      [(url, init) => init.method === 'PUT', { message: 'ann@example.com updated.' }],
      ...userRoutes(),
    ]);
    await screen.findByText('ann@example.com');
    fireEvent.click(screen.getByLabelText('Update ann@example.com'));
    const dialog = screen.getByRole('dialog', { name: 'Update user' });
    fireEvent.change(within(dialog).getByLabelText('First Name'), { target: { value: 'Annie' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    await screen.findByRole('status');
    assert.match(screen.getByRole('status').textContent, /ann@example\.com updated\./);
    assert.equal(screen.queryByRole('dialog') === null, true);
    const put = calls.find((c) => c.init.method === 'PUT');
    assert.match(put.url, /\/iam\/users\/ann%40example\.com$/);
    await waitFor(() => assert.equal(calls.filter((c) => /\/iam\/users$/.test(c.url)).length, 2));
  });

  it('closes the edit drawer on Cancel without saving', async () => {
    const { calls } = mount(userRoutes());
    await screen.findByText('ann@example.com');
    fireEvent.click(screen.getByLabelText('Update ann@example.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    assert.equal(screen.queryByRole('dialog') === null, true);
    assert.equal(calls.some((c) => c.init.method === 'PUT'), false);
  });

  it('lists organizations from props, marks the active one, and switches org', async () => {
    const { events, calls } = mount(userRoutes());
    await screen.findByText('ann@example.com');
    const fetchesBefore = calls.length;
    fireEvent.click(tab('Organizations'));
    assert.ok(screen.getByRole('heading', { name: 'Organizations' }));
    assert.ok(within(rowFor('default')).getByText('Active'));
    assert.ok(within(rowFor('DLH')).getByText('Custom'));
    fireEvent.click(within(rowFor('DLH')).getByRole('button', { name: 'Switch to' }));
    assert.deepEqual(events.org, ['DLH']);

    fireEvent.click(screen.getByLabelText('Refresh'));
    assert.equal(events.refreshOrgs, 1);
    assert.equal(calls.length, fetchesBefore, 'organizations are not fetched by this screen');
  });

  it('shows the organizations loading state and an empty list', () => {
    localStorage.setItem(LS_TAB, 'orgs');
    const { rerender } = mount([], { organizations: null, organizationsLoading: true });
    assert.ok(screen.getByText('Loading…'));
    rerender({ organizations: [], organizationsLoading: false });
    assert.ok(screen.getByText('No data available'));
    assert.equal(screen.getByRole('button', { name: /Export/ }).disabled, true);
  });

  it('exports the filtered organizations as a UTF-8 CSV named after the org', async () => {
    localStorage.setItem(LS_TAB, 'orgs');
    const blobs = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    const origClick = window.HTMLAnchorElement.prototype.click;
    let downloaded = null;
    URL.createObjectURL = (b) => { blobs.push(b); return 'blob:csv'; };
    URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function click() { downloaded = this.download; };
    try {
      mount([], { activeOrg: 'DLH' });
      fireEvent.click(screen.getByRole('button', { name: /Export/ }));
      assert.equal(downloaded, 'organizations-DLH.csv');
      const bytes = await new Promise((resolve) => {
        const reader = new window.FileReader();
        reader.onload = () => resolve(Buffer.from(reader.result));
        reader.readAsArrayBuffer(blobs[0]);
      });
      assert.equal(blobs[0].type, 'text/csv;charset=utf-8');
      assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM so Excel reads it as UTF-8');
      assert.equal(bytes.subarray(3).toString('utf8'),'Sl.No,Name,Identifier,Type\r\n1,Default,default,default\r\n2,"Data ""Lake"", Hub",DLH,custom');
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      window.HTMLAnchorElement.prototype.click = origClick;
    }
  });

  it('restores the last section, and a deep link opens the requested one', async () => {
    localStorage.setItem(LS_TAB, 'accounts');
    const { rerender } = mount(userRoutes());
    assert.equal(tab('Service Accounts').getAttribute('aria-current'), 'page');
    await screen.findByText('bot@example.com');
    rerender({ requestedSection: { section: 'orgs', nonce: 1 } });
    assert.equal(tab('Organizations').getAttribute('aria-current'), 'page');
    rerender({ requestedSection: { section: 'bogus', nonce: 2 } });
    assert.equal(tab('Organizations').getAttribute('aria-current'), 'page');
  });

  it('ignores an unknown persisted section and starts on Users', async () => {
    localStorage.setItem(LS_TAB, 'nope');
    mount(userRoutes());
    assert.equal(tab('Users').getAttribute('aria-current'), 'page');
    await screen.findByText('ann@example.com');
  });

  it('hands the catalog, dashboard catalog and resources sections to their own screens', async () => {
    const { calls } = mount([
      [/\/product-catalog/, { items: [] }],
      ...userRoutes(),
    ]);
    await screen.findByText('ann@example.com');
    fireEvent.click(tab('Product Catalog'));
    assert.ok(screen.getByRole('heading', { name: 'Product Catalog' }));
    assert.equal(screen.queryByLabelText('Search User') === null, true);
    await waitFor(() => assert.ok(calls.some((c) => /\/product-catalog/.test(c.url))));

    fireEvent.click(tab('Dashboard Catalog'));
    assert.ok(screen.getByRole('heading', { name: 'Dashboard Catalog' }));

    fireEvent.click(tab('Resources'));
    assert.ok(screen.getByRole('heading', { name: 'Resources' }));
  });
});
