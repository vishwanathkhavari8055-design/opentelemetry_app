/**
 * AlertInsight is the wizard's right-hand rail: a live Preview that runs the
 * draft rule against real data, and a Summary that reads the rule back in
 * words. Guarded here:
 *
 *  - the preview is only run for a scheduled alert with a stream, is sent to
 *    /alert-builder/preview with the rule and step-1 scope, and says why it
 *    cannot run for realtime/composite alerts instead of looking broken;
 *  - its answer is rendered as a ladder that names the condition which emptied
 *    the result, flags an empty stream/window before blaming any condition,
 *    marks partial counts, and gives the fire/no-fire verdict and groups;
 *  - an unsupported backend and a failed preview each say so;
 *  - the summary headline and lines follow the alert type, and "no
 *    destination" is called out as the warning it is.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, waitFor, cleanup } = await import('@testing-library/react');
const { baseForm } = await import('./harness.mjs');
const { default: AlertInsight } = await import('../../../../src/components/alerts/wizard/AlertInsight.jsx');

let restore = () => {};
afterEach(() => { cleanup(); restore(); });

const LONG = { timeout: 3000 };
const show = (form, props = {}) => render(React.createElement(AlertInsight, { form, ...props }));

const PREVIEW = {
  supported: true,
  steps: [
    { index: 0, label: 'window', matched: 1200, complete: true },
    { index: 1, label: 'service_name = checkout', matched: 40, removed: 1160, complete: false },
    { index: 2, label: 'code >= 500', matched: 0, removed: 40, complete: true, error: 'slow' },
  ],
  evaluation: {
    evaluated: true, wouldFire: false, observed: 0, operator: '>=', threshold: 3,
    observedLabel: 'events', summary: 'Nothing crossed the threshold.',
    groups: [{ key: { host: 'a' }, value: 5, satisfies: true }, { key: {}, value: 1, satisfies: false }],
  },
  notice: 'Scanned 1 of 2 partitions.',
  durationMs: 42,
};

describe('AlertInsight — preview', () => {
  it('asks to pick a stream before anything is previewable', () => {
    restore = stubFetch([]).restore;
    show(baseForm());
    assert.ok(screen.getByText('Select a stream type and stream name to see a preview'));
    assert.ok(screen.getByText('Configure your alert to see a summary'));
  });

  it('explains why realtime and composite alerts have no preview', () => {
    restore = stubFetch([]).restore;
    const { rerender } = show(baseForm({ alertType: 'realtime' }));
    assert.ok(screen.getByText(/evaluated per ingested row as it arrives/));
    rerender(React.createElement(AlertInsight, { form: baseForm({ alertType: 'composite' }) }));
    assert.ok(screen.getByText(/nothing to query for a preview/));
  });

  it('runs the rule with its scope and renders the ladder, culprit, groups and verdict', async () => {
    const stub = stubFetch([[/\/alert-builder\/preview/, PREVIEW]]);
    restore = stub.restore;
    show(baseForm({ streamName: 'app_logs' }), { scopeType: 'service', scopeKey: 'checkout' });
    assert.ok(screen.getByText('Running the rule against the last 10 mins…'));

    await screen.findByText('WOULD NOT TRIGGER', {}, LONG);
    const call = stub.calls[0];
    assert.equal(call.init.method, 'POST');
    const body = JSON.parse(call.init.body);
    assert.equal(body.streamType, 'logs');
    assert.equal(body.streamName, 'app_logs');
    assert.equal(body.scopeType, 'service');
    assert.equal(body.scopeKey, 'checkout');
    assert.ok(body.queryCondition);
    assert.ok(body.triggerCondition);

    assert.ok(screen.getByText('1,200'));
    assert.ok(screen.getByText('−1,160'));
    assert.ok(screen.getByText('partial'));
    assert.ok(screen.getByTitle('slow'));
    const culprit = document.querySelector('.aw-ladder-step.is-culprit');
    assert.match(culprit.textContent, /code >= 500/);
    assert.ok(screen.getByText(/Everything is removed by/));
    assert.ok(screen.getByText('Nothing crossed the threshold.'));
    assert.ok(screen.getByText(/Groups \(1 of\s*2 breaching\)/));
    assert.ok(screen.getByText('host=a'));
    assert.ok(screen.getByText('Scanned 1 of 2 partitions.'));
    assert.ok(screen.getByText('Ran in 42 ms over the last 10 mins.'));
  });

  it('says the window itself was empty before any condition is blamed', async () => {
    restore = stubFetch([[/preview/, {
      steps: [{ index: 0, label: 'window', matched: 0, complete: true }],
      evaluation: { evaluated: true, wouldFire: true, observed: 5, operator: '>=', threshold: 3 },
    }]]).restore;
    show(baseForm({ streamName: 'quiet_logs' }));
    await screen.findByText('WOULD TRIGGER', {}, LONG);
    assert.ok(screen.getByText(/Nothing at all arrived in/));
    assert.ok(screen.getByText('quiet_logs', { selector: 'code' }));
    assert.match(document.querySelector('.aw-verdict-detail').textContent, /5 matches \(5 >= 3\)/);
  });

  it('says the backend has no preview endpoint', async () => {
    restore = stubFetch([[/preview/, { supported: false, steps: [] }]]).restore;
    show(baseForm({ streamName: 'app_logs' }));
    await screen.findByText(/does not expose the alert preview endpoint/, {}, LONG);
    assert.ok(document.body.innerHTML.length > 0);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('shows the error when the preview fails', async () => {
    restore = stubFetch([[/preview/, { status: 500, body: { message: 'query timed out' } }]]).restore;
    show(baseForm({ streamName: 'app_logs' }));
    await screen.findByText('query timed out', {}, LONG);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('does not re-run for edits the preview does not read', async () => {
    const stub = stubFetch([[/preview/, PREVIEW]]);
    restore = stub.restore;
    const form = baseForm({ streamName: 'app_logs' });
    const { rerender } = show(form);
    await screen.findByText('WOULD NOT TRIGGER', {}, LONG);
    rerender(React.createElement(AlertInsight, { form: { ...form, name: 'renamed', destinations: ['x'] } }));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(stub.calls.length, 1);
  });
});

describe('AlertInsight — summary', () => {
  it('reads a realtime alert back without window lines, and warns about a missing destination', () => {
    restore = stubFetch([]).restore;
    show(baseForm({
      alertType: 'realtime', name: 'x', streamName: '',
    }));
    assert.match(document.querySelector('.aw-sum-headline').textContent,
      /the moment a row matching 0 condition\(s\) lands in the stream/);
    assert.equal(screen.queryByText('Monitors:'), null);
    assert.ok(screen.getByText('No destination'));
    assert.ok(screen.getByText('Realtime'));
  });

  it('lists every set line for a scheduled alert', () => {
    restore = stubFetch([[/preview/, { steps: [] }]]).restore;
    show(baseForm({
      name: 'errs', streamName: 'app_logs', threshold: 5, thresholdOperator: '>', toleranceSecs: '60',
      warningThreshold: '2', destinations: ['slack', 'mail'], createsIncident: true, priority: '1',
      tags: ['prod', 'web'], enabled: false, frequencyType: 'cron', cron: '0 */5 * * * *', timezone: 'UTC',
    }), { folderName: 'Payments' });
    assert.equal(document.querySelector('.aw-sum-headline').textContent,
      '"Alert me when 5 or more events occur in any 10 mins period, sustained for 60s, but no more than once every 10 mins"');
    assert.ok(screen.getByText('SELECT * FROM "app_logs"'));
    assert.ok(screen.getByText('> 2'));
    assert.ok(screen.getByText('0 */5 * * * * (UTC)'));
    assert.ok(screen.getByText('slack, mail'));
    assert.ok(screen.getByText('60s sustained'));
    assert.ok(screen.getByText('Payments'));
    assert.ok(screen.getByText('Opens an incident'));
    assert.ok(screen.getByText('P1'));
    assert.ok(screen.getByText('prod, web'));
    assert.ok(screen.getByText('Disabled — will not evaluate'));
  });

  it('reads back SQL and a composite', () => {
    restore = stubFetch([[/preview/, { steps: [] }]]).restore;
    const { rerender } = show(baseForm({ name: 'q', queryType: 'sql', sql: '', streamName: 's' }));
    assert.ok(screen.getByText('SQL not written yet'));
    assert.ok(screen.getByText('every 1 min'));
    assert.ok(screen.getByText('Fires immediately'));
    assert.ok(screen.getByText('Enabled'));

    rerender(React.createElement(AlertInsight, {
      form: baseForm({
        alertType: 'composite', compositeChildren: ['a1', 'b1'], compositeExpression: '{a1} && {b1}',
      }),
    }));
    assert.match(document.querySelector('.aw-sum-headline').textContent, /Alert me when A && B holds/);
    assert.ok(screen.getByText('Other alerts'));
    assert.ok(screen.getByText('2 sub-alert(s)'));
    assert.equal(screen.queryByText('Query Condition:'), null);
  });
});
