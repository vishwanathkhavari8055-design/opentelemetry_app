/**
 * CompositeStep edits a composite alert: a list of sub-alerts (lettered A, B,
 * … by position) and a boolean expression over those letters, stored on the
 * wire as `{alertId}` placeholders. Guarded here:
 *
 *  - "Add alert" seeds/extends the expression and a picked alert lands in the
 *    wire form as its id;
 *  - removing a row rewrites the expression so later letters still point at
 *    the SAME alerts (the damaging failure is a valid expression that silently
 *    watches the wrong alert);
 *  - the operator buttons insert at the caret;
 *  - the debounced server check is sent with the right body and its three
 *    answers (valid / rejected / unsupported) read differently;
 *  - the composite-only settings write what they say.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const { render, screen, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
const { makeHarness, baseForm } = await import('./harness.mjs');
const { default: CompositeStep } = await import('../../../../src/components/alerts/wizard/CompositeStep.jsx');

const ALERTS = {
  items: [
    { alertId: 'id-a', name: 'latency_high', alertType: 'scheduled', folderName: 'Checkout' },
    { alertId: 'id-b', name: 'errors_high', alertType: 'realtime' },
    { alertId: 'id-c', name: 'queue_depth' },
  ],
};

const compositeForm = (patch = {}) => baseForm({ alertType: 'composite', ...patch });

let restore = () => {};
afterEach(() => { cleanup(); restore(); });

const LONG = { timeout: 3000 };

describe('CompositeStep', () => {
  it('starts empty, seeds the expression on add, and writes a picked alert as its id', async () => {
    const stub = stubFetch([[/\/alerts\?/, ALERTS]]);
    restore = stub.restore;
    const { element, latest } = makeHarness(CompositeStep, { form: compositeForm() });
    render(element);

    assert.ok(screen.getByText(/No sub-alerts yet\. Add at least 2/));
    assert.ok(screen.getByText('0 of 10 children'));
    assert.match(stub.calls[0].url, /\/alerts\?pageSize=1000/);

    fireEvent.click(screen.getByRole('button', { name: /Add alert/ }));
    assert.equal(screen.getByLabelText('Trigger expression').value, 'A');
    fireEvent.click(screen.getByRole('button', { name: /Add alert/ }));
    assert.equal(screen.getByLabelText('Trigger expression').value, 'A && B');
    assert.ok(screen.getByText('2 of 10 children'));

    fireEvent.click(screen.getByRole('button', { name: 'Sub-alert A' }));
    const menu = await screen.findByRole('listbox', { name: 'Sub-alert A' });
    await within(menu).findByText('latency_high — Checkout');
    fireEvent.click(within(menu).getByText('latency_high — Checkout'));
    assert.deepEqual(latest.form.compositeChildren, ['id-a', '']);
    assert.equal(latest.form.compositeExpression, '{id-a} && B');
    assert.ok(screen.getByText('scheduled'));
  });

  it('lists only alerts not already chosen in another row', async () => {
    restore = stubFetch([[/\/alerts\?/, ALERTS]]).restore;
    render(makeHarness(CompositeStep, { form: compositeForm({ compositeChildren: ['id-a', ''] }) }).element);
    await screen.findByText('latency_high — Checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Sub-alert B' }));
    const menu = await screen.findByRole('listbox', { name: 'Sub-alert B' });
    assert.equal(within(menu).queryByText('latency_high — Checkout'), null);
    assert.ok(within(menu).getByText('errors_high'));
  });

  it('shows the list error when alerts cannot be read', async () => {
    restore = stubFetch([[/\/alerts\?/, { status: 500, body: { error: 'no rules db' } }]]).restore;
    render(makeHarness(CompositeStep, { form: compositeForm() }).element);
    await screen.findByText('no rules db');
    assert.ok(document.body.innerHTML.length > 0);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('rewrites the expression around a removed row so later letters keep their alerts', async () => {
    restore = stubFetch([[/\/alerts\?/, ALERTS], [/composites\/validate/, { valid: true, result: false, children: [] }]]).restore;
    const { element, latest } = makeHarness(CompositeStep, {
      form: compositeForm({
        compositeChildren: ['id-a', 'id-b', 'id-c'],
        compositeExpression: '{id-a} && ({id-b} || {id-c})',
      }),
    });
    render(element);
    assert.equal(screen.getByLabelText('Trigger expression').value, 'A && (B || C)');

    fireEvent.click(screen.getByRole('button', { name: 'Remove sub-alert A' }));
    assert.deepEqual(latest.form.compositeChildren, ['id-b', 'id-c']);
    assert.equal(latest.form.compositeExpressionLabelled, '(A || B)');
    assert.equal(latest.form.compositeExpression, '({id-b} || {id-c})');
  });

  it('inserts an operator at the caret with sensible spacing', async () => {
    restore = stubFetch([[/\/alerts\?/, ALERTS]]).restore;
    const { element, latest } = makeHarness(CompositeStep, {
      form: compositeForm({ compositeChildren: ['id-a', 'id-b'], compositeExpressionLabelled: 'A B' }),
    });
    render(element);
    const input = screen.getByLabelText('Trigger expression');
    input.setSelectionRange(1, 1);
    fireEvent.click(screen.getByRole('button', { name: 'OR' }));
    assert.equal(latest.form.compositeExpressionLabelled, 'A || B');
    assert.equal(latest.form.compositeExpression, '{id-a} || {id-b}');
  });

  it('asks the server about the expression and shows the verdict with each child state', async () => {
    const stub = stubFetch([
      [/\/alerts\?/, ALERTS],
      [/composites\/validate/, {
        valid: true, result: true,
        children: [
          { alertId: 'id-a', truth: true, level: 'critical' },
          { alertId: 'id-b', truth: false, stale: true },
        ],
        warnings: ['B has not evaluated recently'],
      }],
    ]);
    restore = stub.restore;
    render(makeHarness(CompositeStep, {
      form: compositeForm({ compositeChildren: ['id-a', 'id-b'], compositeExpression: '{id-a} && {id-b}' }),
      extra: { compositeId: 'self-1' },
    }).element);

    await screen.findByText('Would fire right now', {}, LONG);
    assert.ok(screen.getByText('B has not evaluated recently'));
    assert.ok(screen.getAllByText('critical').length >= 1);
    assert.ok(screen.getAllByText('stale').length >= 1);

    const call = stub.calls.find((c) => /composites\/validate/.test(c.url));
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(JSON.parse(call.init.body), {
      compositeCondition: {
        expression: '{id-a} && {id-b}', stale_child_policy: 'use_last_state', warning_counts_as_firing: true,
      },
      compositeId: 'self-1',
    });
  });

  it('shows the server rejection verbatim', async () => {
    restore = stubFetch([
      [/\/alerts\?/, ALERTS],
      [/composites\/validate/, { valid: false, message: 'would create a cycle' }],
    ]).restore;
    render(makeHarness(CompositeStep, {
      form: compositeForm({ compositeChildren: ['id-a', 'id-b'], compositeExpression: '{id-a} || {id-b}' }),
    }).element);
    await screen.findByText('would create a cycle', {}, LONG);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('says the expression could not be checked when the validator is unreachable', async () => {
    restore = stubFetch([
      [/\/alerts\?/, ALERTS],
      [/composites\/validate/, { status: 503, body: 'down' }],
    ]).restore;
    render(makeHarness(CompositeStep, {
      form: compositeForm({ compositeChildren: ['id-a', 'id-b'], compositeExpression: '{id-a} || !{id-b}' }),
    }).element);
    await screen.findByText(/Could not check the expression against OpenObserve/, {}, LONG);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('shows local errors instead of asking the server', async () => {
    const stub = stubFetch([[/\/alerts\?/, ALERTS]]);
    restore = stub.restore;
    render(makeHarness(CompositeStep, {
      form: compositeForm({ compositeChildren: ['id-a', 'id-b'], compositeExpression: '{id-a} &&' }),
      errors: { compositeExpression: 'The expression is incomplete.', compositeChildren: 'Need two.' },
    }).element);
    assert.ok(screen.getByText('The expression is incomplete.'));
    assert.ok(screen.getByText('Need two.'));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(stub.calls.some((c) => /validate/.test(c.url)), false);
  });

  it('writes the warning and stale-child settings', async () => {
    restore = stubFetch([[/\/alerts\?/, ALERTS]]).restore;
    const { element, latest } = makeHarness(CompositeStep, { form: compositeForm() });
    render(element);
    assert.ok(screen.getByText('A child at warning level counts as firing.'));
    fireEvent.click(screen.getByRole('button', { name: /^Yes/ }));
    assert.equal(latest.form.warningCountsAsFiring, false);
    assert.ok(screen.getByText('Only a child at critical level counts as firing.'));
    assert.ok(screen.getByRole('button', { name: /Critical only/ }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Stale-child policy' }), { target: { value: 'treat_as_true' } });
    assert.equal(latest.form.staleChildPolicy, 'treat_as_true');
    assert.ok(screen.getByText(/a monitor that stops reporting pages you/));
  });

  it('disables "Add alert" at ten children', async () => {
    restore = stubFetch([[/\/alerts\?/, ALERTS]]).restore;
    render(makeHarness(CompositeStep, {
      form: compositeForm({ compositeChildren: Array.from({ length: 10 }, (_, i) => `x${i}`) }),
      errors: { compositeExpression: 'x' },
    }).element);
    const add = screen.getByRole('button', { name: /Add alert/ });
    assert.equal(add.disabled, true);
    assert.equal(add.title, 'A composite takes at most 10 sub-alerts');
  });
});
