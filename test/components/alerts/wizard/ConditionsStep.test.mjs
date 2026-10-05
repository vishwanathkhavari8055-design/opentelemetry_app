/**
 * ConditionsStep is step 2 of the alert wizard: alert type, stream, the rule
 * itself (builder or SQL), cadence, filters, and the Settings/Advanced tabs.
 * Guarded here, through real clicks and typing:
 *
 *  - the stream list is asked for with the step-1 scope, and the hint says
 *    honestly whether it was narrowed (an un-narrowed list presented as
 *    narrowed is how an alert ends up on a stream its service never writes);
 *  - switching stream type clears the stream name; picking a stream loads its
 *    schema, and only NUMERIC columns are offered to aggregate;
 *  - "Alert if" moves between the row-count threshold and an aggregate, and
 *    the critical/warning rows write to the matching fields;
 *  - group-by, multi-alert and the group gate write what they say;
 *  - "Check every" stores minutes (Hours is multiplied out) and Cron seeds an
 *    expression and describes it in words;
 *  - realtime and composite alerts hide what does not apply to them;
 *  - the tab badges count errors on the tab that is not on top.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const { render, screen, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
const { makeHarness, baseForm } = await import('./harness.mjs');
const { default: ConditionsStep } = await import('../../../../src/components/alerts/wizard/ConditionsStep.jsx');

const SCHEMA = {
  items: [
    { name: 'duration_ms', type: 'Int64', numeric: true },
    { name: 'service_name', type: 'Utf8', numeric: false },
  ],
};

const routes = ({ streams = { items: ['app_logs', 'edge_logs'], scoped: true } } = {}) => [
  [/\/alerts\/streams\/[^/?]+\/schema/, SCHEMA],
  [/\/alerts\/streams\?/, streams],
  [/\/alerts\/destinations/, { items: [] }],
  [/\/alerts\/templates/, { items: [] }],
  [/\/alerts\?/, { items: [] }],
];

let restore = () => {};
let calls = [];
const stub = (opts) => { const s = stubFetch(routes(opts)); restore = s.restore; calls = s.calls; return s; };
afterEach(() => { cleanup(); restore(); });

const mount = (formPatch = {}, extra = {}, opts = {}) => {
  const { element, latest } = makeHarness(ConditionsStep, { form: baseForm(formPatch), extra, ...opts });
  render(element);
  return latest;
};

/** Let the settings card's destination read settle so no update lands after cleanup. */
const settle = () => waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh destinations' }).disabled));

const pickFrom = async (label, text) => {
  fireEvent.click(screen.getByRole('button', { name: label }));
  const menu = await screen.findByRole('listbox', { name: label });
  fireEvent.click(await within(menu).findByText(text));
};

describe('ConditionsStep — stream', () => {
  it('asks for the scoped list, says it was narrowed, and loads the schema of the pick', async () => {
    stub();
    const latest = mount({}, { scopeType: 'service', scopeKey: 'checkout', scopeLabel: 'Checkout' });
    await screen.findByText('Narrowed to the 2 logs streams Checkout writes to.');
    const list = calls.find((c) => /\/alerts\/streams\?/.test(c.url));
    assert.match(list.url, /type=logs/);
    assert.match(list.url, /scopeType=service/);
    assert.match(list.url, /scopeKey=checkout/);

    await pickFrom('Stream name', 'app_logs');
    assert.equal(latest.form.streamName, 'app_logs');
    await waitFor(() => assert.ok(calls.some((c) => /\/streams\/app_logs\/schema\?type=logs/.test(c.url))));
    await settle();
  });

  it('passes on the backend notice when the list could not be narrowed', async () => {
    stub({ streams: { items: ['a'], scoped: false, notice: 'Producer index still building.' } });
    mount({}, { scopeType: 'service', scopeKey: 'checkout' });
    await screen.findByText('Producer index still building.');
    await settle();
  });

  it('warns that an un-narrowed metrics list must be checked by hand', async () => {
    stub({ streams: { items: ['m1'], scoped: false } });
    mount({ streamType: 'metrics' }, { scopeType: 'service', scopeKey: 'svc', serviceName: 'svc' });
    await screen.findByText(/Showing all 1 metric: these could not be narrowed to svc, so check the one you pick is really emitted by it\./);
    await settle();
  });

  it('says a scoped service writes to nothing of this type', async () => {
    stub({ streams: { items: [], scoped: true } });
    mount({ streamType: 'traces' }, { scopeType: 'service', scopeKey: 'svc' });
    await screen.findByText(/the selected service writes to no traces streams\./);
    await settle();
  });

  it('shows a list failure as an error, not an empty list', async () => {
    const s = stubFetch([[/\/alerts\/streams\?/, { status: 500, body: { message: 'OO unreachable' } }], ...routes()]);
    restore = s.restore;
    const orig = console.error; console.error = () => {};
    try {
      mount({}, { scopeType: 'service', scopeKey: 'svc' });
      await screen.findByText('Streams could not be listed — OO unreachable');
      assert.ok(screen.getByText(/Showing nothing — the logs streams could not be listed\./));
      await settle();
    } finally { console.error = orig; }
  });

  it('clears the stream name when the stream type changes', async () => {
    stub();
    const latest = mount({ streamName: 'app_logs', aggColumn: 'x' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Stream type' }), { target: { value: 'metrics' } });
    assert.equal(latest.form.streamType, 'metrics');
    assert.equal(latest.form.streamName, '');
    assert.equal(latest.form.aggColumn, '');
    await settle();
  });
});

describe('ConditionsStep — rule', () => {
  it('moves from total events to an aggregate over a numeric column, and back', async () => {
    stub();
    const latest = mount({ streamName: 'app_logs', threshold: 7 });
    assert.ok(screen.getByText('matching logs found'));

    fireEvent.change(screen.getByRole('combobox', { name: 'What to measure' }), { target: { value: 'avg' } });
    assert.equal(latest.form.aggregationEnabled, true);
    assert.equal(latest.form.aggFunction, 'avg');
    assert.equal(latest.form.aggHavingValue, '7');
    assert.equal(latest.form.threshold, 1);
    assert.ok(screen.getByText('Choose the column to take the avg of.'));

    fireEvent.click(screen.getByRole('button', { name: 'Column to aggregate' }));
    const menu = await screen.findByRole('listbox', { name: 'Column to aggregate' });
    await within(menu).findByText('duration_ms');
    assert.equal(within(menu).queryByText('service_name'), null);
    fireEvent.click(within(menu).getByText('duration_ms'));
    assert.equal(latest.form.aggColumn, 'duration_ms');
    assert.equal(screen.queryByText(/Choose the column/), null);

    fireEvent.change(screen.getByLabelText('Critical threshold'), { target: { value: '250' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Critical threshold operator' }), { target: { value: '>' } });
    assert.equal(latest.form.aggHavingValue, '250');
    assert.equal(latest.form.aggHavingOperator, '>');

    fireEvent.change(screen.getByRole('combobox', { name: 'What to measure' }), { target: { value: '__total_events__' } });
    assert.equal(latest.form.aggregationEnabled, false);
    assert.equal(latest.form.threshold, '250');
    assert.equal(latest.form.thresholdOperator, '>');
    await settle();
  });

  it('adds and removes a warning tier, and flags an unordered operator', async () => {
    stub();
    const latest = mount();
    fireEvent.click(screen.getByRole('button', { name: '+ Add warning' }));
    fireEvent.change(screen.getByLabelText('Warning threshold'), { target: { value: '2' } });
    assert.equal(latest.form.warningThreshold, '2');

    fireEvent.change(screen.getByRole('combobox', { name: 'Critical threshold operator' }), { target: { value: '=' } });
    assert.equal(latest.form.thresholdOperator, '=');
    assert.ok(screen.getByText(/has no\s+“less severe” side/));

    fireEvent.click(screen.getByRole('button', { name: 'Remove warning threshold' }));
    assert.equal(latest.form.warningThreshold, '');
    assert.ok(screen.getByRole('button', { name: '+ Add warning' }));
    await settle();
  });

  it('groups an aggregate, switches to multi alert and back, and writes the group gate', async () => {
    stub();
    const latest = mount({ streamName: 'app_logs', aggregationEnabled: true, aggFunction: 'count', aggHavingValue: '5' });
    await waitFor(() => assert.ok(calls.some((c) => /schema/.test(c.url))));

    fireEvent.click(screen.getByRole('button', { name: 'Add a group by column' }));
    await pickFrom('Group by column 1', 'service_name');
    assert.equal(latest.form.aggGroupBy, 'service_name');

    assert.ok(screen.getByText(/One alert for the whole query/));
    fireEvent.change(screen.getByLabelText('Group count threshold'), { target: { value: '4' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Group count operator' }), { target: { value: '>' } });
    assert.equal(latest.form.threshold, '4');
    assert.equal(latest.form.thresholdOperator, '>');

    fireEvent.click(screen.getByLabelText('Multi alert'));
    assert.equal(latest.form.multiAlert, true);
    assert.equal(latest.form.threshold, 1);
    assert.ok(screen.getByText(/Every group that breaches alerts/));
    assert.ok(screen.getByText(/fixed at “at least 1”/));
    assert.equal(screen.getByLabelText('Group count threshold').disabled, true);

    fireEvent.click(screen.getByLabelText('Simple alert'));
    assert.equal(latest.form.multiAlert, false);

    fireEvent.click(screen.getByRole('button', { name: 'Remove group by column 1' }));
    assert.equal(latest.form.aggGroupBy, '');
    assert.equal(screen.queryByText('Alert aggregation'), null);
    await settle();
  });

  it('switches to SQL, clears the aggregate, and writes the query', async () => {
    stub();
    const latest = mount({ aggregationEnabled: true, streamName: 'app_logs' });
    fireEvent.click(screen.getByRole('tab', { name: /SQL/ }));
    assert.equal(latest.form.queryType, 'sql');
    assert.equal(latest.form.aggregationEnabled, false);
    const sql = screen.getByPlaceholderText(/FROM "app_logs"/);
    fireEvent.change(sql, { target: { value: 'SELECT 1' } });
    assert.equal(latest.form.sql, 'SELECT 1');
    assert.equal(screen.queryByLabelText('Operator'), null);

    fireEvent.click(screen.getByRole('tab', { name: /Builder/ }));
    assert.equal(latest.form.queryType, 'custom');
    await settle();
  });

  it('stores the cadence in minutes, multiplies hours out, and describes a cron', async () => {
    stub();
    const latest = mount({ frequency: 10 });
    fireEvent.change(screen.getByLabelText('How often the alert is evaluated'), { target: { value: '5' } });
    assert.equal(latest.form.frequency, 5);

    fireEvent.change(screen.getByRole('combobox', { name: 'Frequency unit' }), { target: { value: 'hours' } });
    assert.equal(latest.form.frequency, 60);
    fireEvent.change(screen.getByLabelText('How often the alert is evaluated'), { target: { value: '2' } });
    assert.equal(latest.form.frequency, 120);
    assert.equal(screen.getByLabelText('How often the alert is evaluated').value, '2');

    fireEvent.change(screen.getByRole('combobox', { name: 'Frequency unit' }), { target: { value: 'cron' } });
    assert.equal(latest.form.frequencyType, 'cron');
    assert.equal(latest.form.cron, '0 0 */2 * * *');
    assert.ok(screen.getByText('every 2 hours'));

    const cron = screen.getByLabelText('Cron expression');
    const cases = [
      ['0 */10 * * * *', 'every 10 minutes'],
      ['0 */1 * * * *', 'every minute'],
      ['0 * * * * *', 'every minute'],
      ['0 0 * * * *', 'every hour, on the hour'],
      ['0 15 * * * *', 'at 15 minutes past every hour'],
      ['0 0 */1 * * *', 'every hour'],
      ['0 30 9 * * *', 'daily at 09:30'],
    ];
    for (const [expr, words] of cases) {
      fireEvent.change(cron, { target: { value: expr } });
      assert.ok(screen.getByText(words), expr);
    }
    fireEvent.change(cron, { target: { value: '0 30 9 * * 1' } });
    assert.equal(document.querySelector('.aw-cond-cron-note'), null);

    fireEvent.change(screen.getByRole('combobox', { name: 'Cron timezone' }), { target: { value: 'UTC' } });
    assert.equal(latest.form.timezone, 'UTC');

    fireEvent.change(screen.getByRole('combobox', { name: 'Frequency unit' }), { target: { value: 'minutes' } });
    assert.equal(latest.form.frequencyType, 'minutes');
    await settle();
  });

  it('collapses the filters behind a count and restates the seeded service row', async () => {
    stub();
    mount({}, { serviceName: 'checkout' });
    assert.ok(screen.getByText(/row came from step 1/));
    fireEvent.click(screen.getByRole('button', { name: /filters/ }));
    assert.ok(screen.getByText(/0 filters hidden/));
    fireEvent.click(screen.getByRole('button', { name: /filters/ }));
    assert.equal(screen.queryByText(/filter hidden/), null);
    assert.ok(screen.getByLabelText('Operator'));
    await settle();
  });

  it('shows cadence and condition errors when allowed', async () => {
    stub();
    mount({}, {}, { errors: { frequency: 'Freq bad.', conditions: 'Cond bad.', streamName: 'Stream needed.', threshold: 'Thr bad.' } });
    assert.ok(screen.getByText('Freq bad.'));
    assert.ok(screen.getByText('Cond bad.'));
    assert.ok(screen.getByText('Stream needed.'));
    assert.ok(screen.getByText('Thr bad.'));
    await settle();
  });
});

describe('ConditionsStep — alert type and tabs', () => {
  it('hides cadence and threshold on realtime, and the stream row on composite', async () => {
    stub();
    const latest = mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Realtime' }));
    assert.equal(latest.form.alertType, 'realtime');
    assert.ok(screen.getByText(/Evaluated against every row as it is ingested/));
    assert.equal(screen.queryByLabelText('How often the alert is evaluated'), null);
    assert.equal(screen.queryByLabelText('Critical threshold'), null);

    fireEvent.click(screen.getByRole('radio', { name: 'Composite' }));
    assert.equal(latest.form.alertType, 'composite');
    assert.equal(screen.queryByRole('combobox', { name: 'Stream type' }), null);
    assert.ok(screen.getByText(/Watches other alerts rather than a stream/));
    assert.ok(screen.getByText('Sub-alerts'));
    await settle();
  });

  it('switches to the Advanced tab and badges errors on each tab', async () => {
    stub();
    mount({}, {}, { errors: { tags: 'Tag bad.', period: 'Period bad.', silence: 'Silence bad.' } });
    const rules = screen.getByRole('tab', { name: /Alert Rules/ });
    const advanced = screen.getByRole('tab', { name: /Advanced/ });
    assert.equal(within(rules).getByTitle('2 field(s) need attention').textContent, '2');
    assert.equal(within(advanced).getByTitle('1 field(s) need attention').textContent, '1');
    await settle();

    fireEvent.click(advanced);
    assert.equal(advanced.getAttribute('aria-selected'), 'true');
    assert.ok(screen.getByText('Additional Settings'));
    assert.ok(screen.getByText('Tag bad.'));
    assert.equal(screen.queryByText('Conditions', { selector: '.aw-card-head' }), null);
    await waitFor(() => assert.ok(!screen.getByRole('button', { name: 'Refresh templates' }).disabled));
  });
});
