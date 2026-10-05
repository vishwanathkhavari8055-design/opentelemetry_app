/**
 * AlertWizard is the two-step "New alert" flow: pick a registered service out
 * of the Product Catalog, then configure and create the alert. Driven end to
 * end through the real child components with only the backend stubbed.
 * Guarded here:
 *
 *  - Next stays disabled until a service is picked, and the footer restates
 *    the pick (and warns when discovery saw no telemetry for it);
 *  - the pick seeds a `service_name = …` filter row, scopes the stream list
 *    to that catalog row, and a traces-only service starts on traces;
 *  - the alert name is suggested from the service and stream until the user
 *    types one, and a name that already exists is refused before the save;
 *  - Create on an incomplete form reveals the errors instead of saving; on a
 *    complete one it POSTs the document into the chosen folder and reports
 *    the server's message; a failed save keeps the user on the form;
 *  - Hold-for longer than the look back window is rejected;
 *  - Back and Cancel do what they say.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
const { default: AlertWizard } = await import('../../../../src/components/alerts/wizard/AlertWizard.jsx');

const CATEGORIES = { items: [{ code: 'APP', label: 'Applications', registeredCount: 2 }] };
const RESOURCES = {
  items: [
    { id: 'r1', resourceName: 'Checkout', resolvedName: 'checkout-svc', status: 'ENABLED', category: 'APP' },
    { id: 'r2', resourceName: 'Tracer', resolvedName: 'tracer-svc', status: 'ENABLED', category: 'APP' },
  ],
};

const routes = ({ save, logs = { services: [{ name: 'checkout-svc', count: 10 }] }, traces = { items: [{ serviceName: 'tracer-svc', requests: 5 }] } } = {}) => [
  [(url, init) => init.method === 'POST' && /\/alerts$/.test(url), save || { message: 'Created OK' }],
  [/\/product-catalog\/categories/, CATEGORIES],
  [/\/product-catalog(\?|$)/, RESOURCES],
  [/\/logs\/services/, logs],
  [/\/traces\/catalog/, traces],
  [/\/alerts\/streams\/[^/?]+\/schema/, { items: [] }],
  [/\/alerts\/streams\?/, { items: ['app_logs', 'span_stream'], scoped: true }],
  [/\/alerts\/destinations/, { items: [{ name: 'slack' }] }],
  [/\/alerts\/templates/, { items: [] }],
  [/\/alert-builder\/preview/, { steps: [] }],
  [/\/alerts\?/, { items: [{ name: 'Taken_Name' }] }],
];

let restore = () => {};
let calls = [];
afterEach(() => { cleanup(); restore(); });

const mount = (opts, props = {}) => {
  const s = stubFetch(routes(opts));
  restore = s.restore; calls = s.calls;
  const out = { closed: 0, saved: [] };
  render(React.createElement(AlertWizard, {
    onClose: () => { out.closed += 1; },
    onSaved: (m) => out.saved.push(m),
    folders: [{ folderId: 'default', name: 'default' }, { folderId: 'f2', name: 'Payments' }],
    ...props,
  }));
  return out;
};

const pickService = async (name) => {
  const head = await screen.findByText('Applications', { selector: '.awp-cat-name' });
  if (head.closest('button').getAttribute('aria-expanded') !== 'true') fireEvent.click(head.closest('button'));
  fireEvent.click(await screen.findByText(name));
};

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Next' }));

const pickFrom = async (label, text) => {
  fireEvent.click(screen.getByRole('button', { name: label }));
  const menu = await screen.findByRole('listbox', { name: label });
  fireEvent.click(await within(menu).findByText(text));
};

/** Wait out the step-2 reads so nothing lands after cleanup. */
const settle = () => waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh destinations' }).disabled));

describe('AlertWizard — step 1', () => {
  it('keeps Next disabled until a service is picked, then restates it in the footer', async () => {
    const out = mount();
    assert.ok(screen.getByText('New alert'));
    assert.ok(screen.getByText('Select a service to continue.'));
    assert.equal(screen.getByRole('button', { name: 'Next' }).disabled, true);
    assert.equal(screen.getByRole('button', { name: 'Back' }).disabled, true);

    await pickService('Checkout');
    assert.equal(screen.getByRole('button', { name: 'Next' }).disabled, false);
    assert.equal(screen.getByTitle('service_name="checkout-svc"').textContent, 'Checkout');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to alerts' }));
    assert.equal(out.closed, 2);
  });

  it('warns in the footer when discovery saw no telemetry for the pick', async () => {
    mount({ logs: { services: [{ name: 'someone-else', count: 1 }] }, traces: { items: [] } });
    await screen.findByText('Only services with telemetry');
    await pickService('Checkout');
    assert.ok(screen.getByText('no telemetry in the last 24h', { selector: '.aw-foot-warn' }));
  });
});

describe('AlertWizard — step 2', () => {
  it('seeds the service filter, scopes the streams, and suggests a name from the pick', async () => {
    mount();
    await pickService('Checkout');
    next();

    assert.equal(screen.getByRole('button', { name: 'Back' }).disabled, false);
    assert.ok(screen.getByRole('button', { name: 'Create alert' }));
    assert.ok(screen.getByText(/row came from step 1/));
    assert.ok(screen.getByText('service_name = checkout-svc', { selector: 'code' }));
    await waitFor(() => assert.ok(calls.some((c) => /\/alerts\/streams\?.*scopeType=resource.*scopeKey=r1/.test(c.url))));

    await pickFrom('Stream name', 'app_logs');
    await waitFor(() => assert.equal(screen.getByLabelText('Alert name').value, 'checkout_svc_logs_alert'));
    assert.match(screen.getByTitle(/events >= 3/).textContent, /events >= 3 · every 1 min/);
    await settle();
  });

  it('starts a traces-only service on the traces stream type', async () => {
    mount();
    await screen.findByText('Only services with telemetry');
    await pickService('Tracer');
    next();
    assert.equal(screen.getByRole('combobox', { name: 'Stream type' }).value, 'traces');
    await settle();
  });

  it('reveals the errors instead of saving an incomplete alert', async () => {
    const out = mount();
    await pickService('Checkout');
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Create alert' }));
    assert.ok(screen.getByText('Fix the highlighted fields before creating this alert.'));
    assert.ok(screen.getByText(/fields need attention/));
    assert.ok(screen.getByText('Alert name is required.'));
    assert.equal(calls.some((c) => c.init.method === 'POST'), false);
    assert.equal(out.saved.length, 0);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    assert.equal(screen.queryByText(/Fix the highlighted fields/), null);
    await settle();
  });

  it('refuses a name that already exists and a hold longer than the window', async () => {
    mount();
    await pickService('Checkout');
    next();
    await waitFor(() => assert.ok(calls.some((c) => /\/alerts\?pageSize=1000/.test(c.url))));
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.change(screen.getByLabelText('Alert name'), { target: { value: 'taken_name' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Hold for unit' }), { target: { value: 'minutes' } });
    fireEvent.change(screen.getByLabelText('Hold the condition for'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create alert' }));
    await screen.findByText(/An alert called “taken_name” already exists/);
    assert.ok(screen.getByText(/Hold for \(1200s\) is longer than the look back window \(10 min\)/));
    await settle();
  });

  it('creates a complete alert in the chosen folder and reports the server message', async () => {
    const out = mount();
    await pickService('Checkout');
    next();
    await pickFrom('Stream name', 'app_logs');
    await pickFrom('Folder', 'Payments');
    fireEvent.change(screen.getByLabelText('Alert name'), { target: { value: 'checkout_errors' } });

    fireEvent.click(screen.getByRole('button', { name: 'Destinations' }));
    const list = await screen.findByRole('menu', { name: 'Destinations' });
    fireEvent.click(await within(list).findByText('slack'));

    fireEvent.click(screen.getByRole('button', { name: 'Create alert' }));
    await waitFor(() => assert.equal(out.saved.length, 1));
    assert.deepEqual(out.saved[0], { message: 'Created OK' });

    const post = calls.find((c) => c.init.method === 'POST' && /\/alerts$/.test(c.url));
    const body = JSON.parse(post.init.body);
    assert.equal(body.folderId, 'f2');
    assert.equal(body.alert.name, 'checkout_errors');
    assert.equal(body.alert.stream_name, 'app_logs');
    assert.deepEqual(body.alert.destinations, ['slack']);
    assert.match(JSON.stringify(body.alert.query_condition), /checkout-svc/);
  });

  it('keeps the user on the form with the reason when the save fails', async () => {
    const out = mount({ save: { status: 400, body: { message: 'stream missing on server' } } });
    await pickService('Checkout');
    next();
    await pickFrom('Stream name', 'app_logs');
    fireEvent.click(screen.getByRole('button', { name: 'Destinations' }));
    fireEvent.click(await within(await screen.findByRole('menu', { name: 'Destinations' })).findByText('slack'));
    fireEvent.click(screen.getByRole('button', { name: 'Create alert' }));
    await screen.findByText('stream missing on server');
    assert.equal(out.saved.length, 0);
    assert.equal(screen.getByRole('button', { name: 'Create alert' }).disabled, false);
  });

  it('goes back to step 1 with the service still selected', async () => {
    mount();
    await pickService('Checkout');
    next();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    assert.ok(screen.getByText('New alert'));
    const radio = screen.getByText('Checkout', { selector: '.awp-res-name' }).closest('label').querySelector('input');
    assert.equal(radio.checked, true);
  });

  it('summarises a composite in the footer once chosen', async () => {
    mount();
    await pickService('Checkout');
    next();
    fireEvent.click(screen.getByRole('radio', { name: 'Composite' }));
    assert.ok(screen.getByTitle('composite · no expression · 0 sub-alerts'));
    await waitFor(() => assert.equal(screen.getByLabelText('Alert name').value, 'checkout_svc_composite_alert'));
    fireEvent.click(screen.getByRole('radio', { name: 'Realtime' }));
    await settle();
  });
});
