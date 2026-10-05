/**
 * The wizard's Settings and Advanced cards write the rest of the rule — look
 * back window, cooldown, hold-for, destinations, incident flag; template,
 * variables, priority, tags, description, row template. Guarded here:
 *
 *  - what each control writes into the form (hold-for is edited in a unit but
 *    stored in seconds, and switching the unit must not change the duration);
 *  - rows that exist only for scheduled alerts vanish on realtime ones;
 *  - a destination or template the list no longer has stays selectable as
 *    "(missing)" instead of silently dropping off the alert;
 *  - a list that could not be READ says so, rather than looking empty;
 *  - a destination created from the card is ADDED to the selection.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const { render, screen, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
const { makeHarness, baseForm } = await import('./harness.mjs');
const { default: SettingsCard } = await import('../../../../src/components/alerts/wizard/SettingsCard.jsx');
const { default: AdvancedCard } = await import('../../../../src/components/alerts/wizard/AdvancedCard.jsx');

let restore = () => {};
afterEach(() => { cleanup(); restore(); });

const DESTS = { items: [{ name: 'slack-oncall', type: 'http' }, { name: 'sre-mail' }] };

describe('SettingsCard', () => {
  it('lists destinations, keeps a missing one, and writes the ticked set', async () => {
    const stub = stubFetch([[/\/alerts\/destinations/, DESTS]]);
    restore = stub.restore;
    const { element, latest } = makeHarness(SettingsCard, { form: baseForm({ destinations: ['gone-hook'] }) });
    render(element);

    fireEvent.click(screen.getByRole('button', { name: 'Destinations' }));
    const list = await screen.findByRole('menu', { name: 'Destinations' });
    await within(list).findByText('slack-oncall — http');
    assert.ok(within(list).getByText('sre-mail'));
    assert.ok(within(list).getByText('gone-hook (missing)'));

    fireEvent.click(within(list).getByText('sre-mail'));
    assert.deepEqual(latest.form.destinations, ['sre-mail', 'gone-hook']);
    assert.ok(stub.calls.some((c) => /\/alerts\/destinations$/.test(c.url)));
  });

  it('says the destinations could not be listed when the read fails, and refreshes on demand', async () => {
    let fail = true;
    const stub = stubFetch([[/\/alerts\/destinations/, () => (fail
      ? { status: 500, body: { message: 'upstream down' } } : DESTS)]]);
    restore = stub.restore;
    render(makeHarness(SettingsCard).element);
    await screen.findByText('Destinations could not be listed — upstream down');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh destinations' }));
    await waitFor(() => assert.equal(screen.queryByText(/could not be listed/), null));
    assert.equal(stub.calls.length, 2);
  });

  it('stores hold-for in seconds and keeps the duration when the unit changes', async () => {
    restore = stubFetch([[/destinations/, DESTS]]).restore;
    const { element, latest } = makeHarness(SettingsCard);
    render(element);

    assert.ok(screen.getByText('fires on the first evaluation that breaches'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Hold for unit' }), { target: { value: 'minutes' } });
    fireEvent.change(screen.getByLabelText('Hold the condition for'), { target: { value: '5' } });
    assert.equal(latest.form.toleranceSecs, '300');
    assert.ok(screen.getByText('the condition must stay true this long before it fires'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Hold for unit' }), { target: { value: 'seconds' } });
    assert.equal(screen.getByLabelText('Hold the condition for').value, '300');
    assert.equal(latest.form.toleranceSecs, '300');

    fireEvent.change(screen.getByLabelText('Look back window'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Cooldown period'), { target: { value: '30' } });
    assert.equal(latest.form.period, '15');
    assert.equal(latest.form.silence, '30');
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh destinations' }).disabled));
  });

  it('hides the look back window and hold-for on a realtime alert', async () => {
    restore = stubFetch([[/destinations/, DESTS]]).restore;
    render(makeHarness(SettingsCard, { form: baseForm({ alertType: 'realtime' }) }).element);
    assert.equal(screen.queryByLabelText('Look back window'), null);
    assert.equal(screen.queryByLabelText('Hold the condition for'), null);
    assert.ok(screen.getByLabelText('Cooldown period'));
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh destinations' }).disabled));
  });

  it('shows validation errors only for fields showErr allows', async () => {
    restore = stubFetch([[/destinations/, DESTS]]).restore;
    const errors = { period: 'Period bad.', silence: 'Silence bad.', destinations: 'Pick one.', toleranceSecs: 'Hold bad.' };
    render(makeHarness(SettingsCard, { errors, shown: (f) => f !== 'silence' }).element);
    assert.ok(screen.getByText('Period bad.'));
    assert.ok(screen.getByText('Pick one.'));
    assert.ok(screen.getByText('Hold bad.'));
    assert.equal(screen.queryByText('Silence bad.'), null);
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh destinations' }).disabled));
  });

  it('toggles creates-incident and warns when it clashes with per-group alerting', async () => {
    restore = stubFetch([[/destinations/, DESTS]]).restore;
    const { element, latest } = makeHarness(SettingsCard, { form: baseForm({ multiAlert: true }) });
    render(element);
    const sw = screen.getByRole('button', { name: 'Creates incident' });
    assert.equal(sw.getAttribute('aria-pressed'), 'false');
    fireEvent.click(sw);
    assert.equal(latest.form.createsIncident, true);
    assert.equal(sw.getAttribute('aria-pressed'), 'true');
    assert.ok(screen.getByText('not available with per-group alerting'));
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh destinations' }).disabled));
  });

  it('adds a destination created from the dialog to the existing selection', async () => {
    let created = false;
    const stub = stubFetch([
      [/\/alerts\/templates/, { items: [{ name: 'mail-tpl', type: 'email' }] }],
      [(url, init) => init.method === 'POST' && /\/alerts\/destinations/.test(url), () => { created = true; return { ok: true }; }],
      [/\/alerts\/destinations/, () => (created
        ? { items: [...DESTS.items, { name: 'new_dest', type: 'email' }] } : DESTS)],
    ]);
    restore = stub.restore;
    const { element, latest } = makeHarness(SettingsCard, { form: baseForm({ destinations: ['slack-oncall'] }) });
    render(element);

    fireEvent.click(screen.getByRole('button', { name: 'Add Destination' }));
    fireEvent.change(await screen.findByPlaceholderText('oncall_email'), { target: { value: 'new_dest' } });
    fireEvent.change(screen.getByPlaceholderText('oncall@example.com, sre@example.com'), { target: { value: 'a@b.io' } });
    await screen.findByRole('option', { name: 'mail-tpl' });
    fireEvent.change(document.getElementById('dest-template'), { target: { value: 'mail-tpl' } });
    fireEvent.submit(document.getElementById('dest-name').closest('form'));

    await waitFor(() => assert.deepEqual(latest.form.destinations, ['slack-oncall', 'new_dest']));
    const post = stub.calls.find((c) => c.init.method === 'POST');
    assert.deepEqual(JSON.parse(post.init.body).emails, ['a@b.io']);
    await waitFor(() => assert.equal(screen.queryByPlaceholderText('oncall_email'), null));
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh destinations' }).disabled));
  });

  it('closes the dialog on cancel without touching the selection', async () => {
    restore = stubFetch([[/destinations/, DESTS], [/templates/, { items: [] }]]).restore;
    const { element, latest } = makeHarness(SettingsCard);
    render(element);
    fireEvent.click(screen.getByRole('button', { name: 'Add Destination' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    assert.equal(screen.queryByPlaceholderText('oncall_email'), null);
    assert.deepEqual(latest.form.destinations, []);
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh destinations' }).disabled));
  });
});

describe('AdvancedCard', () => {
  it('offers the template list, keeps a missing override, and writes the pick', async () => {
    const stub = stubFetch([[/\/alerts\/templates/, { items: [{ name: 'tpl-a' }, { name: 'tpl-b' }] }]]);
    restore = stub.restore;
    const { element, latest } = makeHarness(AdvancedCard, { form: baseForm({ template: 'old-tpl' }) });
    render(element);
    await screen.findByRole('option', { name: 'tpl-a' });
    assert.ok(screen.getByRole('option', { name: 'old-tpl (missing)' }));
    assert.ok(screen.getByRole('option', { name: /Select Template/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Template override' }), { target: { value: 'tpl-b' } });
    assert.equal(latest.form.template, 'tpl-b');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh templates' }));
    await waitFor(() => assert.equal(stub.calls.length, 2));
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh templates' }).disabled));
  });

  it('reads "No templates available" when the list fails', async () => {
    restore = stubFetch([[/templates/, { status: 500, body: { message: 'x' } }]]).restore;
    const origError = console.error;
    const logged = [];
    console.error = (...a) => logged.push(a);
    try {
      render(makeHarness(AdvancedCard).element);
      await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh templates' }).disabled));
      assert.ok(screen.getByRole('option', { name: 'No templates available' }));
      assert.ok(logged.some((a) => a[0] === 'Templates unavailable:'));
    } finally { console.error = origError; }
  });

  it('adds, edits and removes additional variables', async () => {
    restore = stubFetch([[/templates/, { items: [] }]]).restore;
    const { element, latest } = makeHarness(AdvancedCard);
    render(element);
    fireEvent.click(screen.getByRole('button', { name: 'Add Variable' }));
    fireEvent.change(screen.getByLabelText('Variable name'), { target: { value: 'team' } });
    fireEvent.change(screen.getByLabelText('Value for team'), { target: { value: 'sre' } });
    assert.equal(latest.form.variables.length, 1);
    assert.equal(latest.form.variables[0].name, 'team');
    assert.equal(latest.form.variables[0].value, 'sre');
    fireEvent.click(screen.getByRole('button', { name: 'Remove variable team' }));
    assert.deepEqual(latest.form.variables, []);
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh templates' }).disabled));
  });

  it('writes priority, lower-cased tags, description and a typed row template', async () => {
    restore = stubFetch([[/templates/, { items: [] }]]).restore;
    const errors = { variables: 'Var bad.', tags: 'Tag bad.' };
    const { element, latest } = makeHarness(AdvancedCard, { errors });
    render(element);
    assert.ok(screen.getByText('Var bad.'));
    assert.ok(screen.getByText('Tag bad.'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), { target: { value: '2' } });
    assert.equal(latest.form.priority, '2');

    const tags = screen.getByRole('textbox', { name: 'Tags' });
    fireEvent.change(tags, { target: { value: '  Prod ' } });
    fireEvent.keyDown(tags, { key: 'Enter' });
    assert.deepEqual(latest.form.tags, ['prod']);

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'who acts' } });
    assert.equal(latest.form.description, 'who acts');

    assert.equal(screen.queryByRole('radiogroup', { name: 'Row template type' }), null);
    fireEvent.change(screen.getByLabelText(/Row Template/), { target: { value: 'at {timestamp}' } });
    assert.ok(screen.getByText('Rows are joined into one text block.'));
    fireEvent.click(screen.getByRole('radio', { name: 'JSON' }));
    assert.equal(latest.form.rowTemplateType, 'json');
    assert.ok(screen.getByText('Rows are emitted as a JSON array.'));
    assert.equal(screen.getByRole('radio', { name: 'JSON' }).getAttribute('aria-checked'), 'true');
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh templates' }).disabled));
  });
});
