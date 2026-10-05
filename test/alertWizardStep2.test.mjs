/**
 * Guards step 2 of the alert wizard — the screen that configures and creates.
 *
 * Two things are being protected here, and neither is visible on screen.
 *
 * The first is the PREMISE of the wizard's shape: once step 1 has chosen a
 * service, EVERY remaining required answer must have a control on step 2. There
 * is no step 3 any more to catch a straggler — the name and folder moved to the
 * title strip and the destination into the Settings card — so a required field
 * that no control draws makes Create refuse with nothing on screen to fix. That
 * is asserted directly rather than left to be discovered by a user staring at a
 * form they cannot act on.
 *
 * (It is asserted as an EXACT set, not a subset, on purpose. A new required
 * field is meant to fail this test: the fix is to give it a control on step 2 or
 * a working default, and the failure is the reminder to do one of the two.)
 *
 * The second is that the sentence the Summary panel prints is the rule that gets
 * stored. `thresholdParts` is the one place that decides which of OpenObserve's
 * two threshold fields an alert is actually using, and both the wizard footer
 * and the Summary read it. A wrong answer there is a panel that confidently
 * describes an alert nobody built.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyForm,
  docToForm,
  emptyAlertDoc,
  parseConditions,
  thresholdParts,
  validateForm,
  warningField,
} from '../src/components/alerts/alertModel.js';

/**
 * The draft as it stands once step 1 and the Conditions card are answered.
 *
 * A service was chosen, which seeds the condition row, and the stream and
 * threshold were set — and nothing in the title strip or the Settings card has
 * been filled in yet.
 */
const draftAtStep2 = (over = {}) => ({
  ...docToForm(emptyAlertDoc()),
  streamType: 'logs',
  streamName: 'default',
  conditions: parseConditions({
    and: [{ column: 'service_name', operator: '=', value: 'checkoutsvc' }],
  }),
  ...over,
});

describe('what step 2 is still required to ask for', () => {
  it('is exactly the alert name and its destinations — nothing else', () => {
    const errors = validateForm(draftAtStep2());
    assert.deepEqual(
      Object.keys(errors).sort(),
      ['destinations', 'name'],
      'a required field with no control on step 2 would disable Create with '
      + 'nothing on screen to fix — give it a control there, or a default',
    );
  });

  it('is satisfied by those two alone, for a plain scheduled alert', () => {
    const errors = validateForm(draftAtStep2({
      name: 'checkoutsvc_logs_alert',
      destinations: ['Incident'],
    }));
    assert.deepEqual(errors, {});
  });

  it('is the same two for a realtime alert, which has no window or cadence', () => {
    const errors = validateForm(draftAtStep2({ alertType: 'realtime' }));
    assert.deepEqual(Object.keys(errors).sort(), ['destinations', 'name']);
  });

  it('rejects a name with spaces before the save is attempted', () => {
    const errors = validateForm(draftAtStep2({
      name: 'checkout 5xx', destinations: ['Incident'],
    }));
    assert.match(errors.name, /no spaces/);
  });
});

describe('the document step 2 creates', () => {
  it('carries the name and destinations the strip collected', () => {
    const doc = applyForm(emptyAlertDoc(), draftAtStep2({
      name: 'checkoutsvc_logs_alert',
      destinations: ['Incident', 'oncall-webhook'],
    }));
    assert.equal(doc.name, 'checkoutsvc_logs_alert');
    assert.deepEqual(doc.destinations, ['Incident', 'oncall-webhook']);
    assert.equal(doc.is_real_time, false);
    assert.equal(doc.enabled, true);
  });

  it('keeps the service row step 1 seeded', () => {
    const doc = applyForm(emptyAlertDoc(), draftAtStep2({
      name: 'a', destinations: ['Incident'],
    }));
    assert.deepEqual(doc.query_condition.conditions, {
      and: [{
        column: 'service_name', operator: '=', value: 'checkoutsvc', ignore_case: false,
      }],
    });
  });

  it('trims the name, so a stray space cannot create an unfindable alert', () => {
    const doc = applyForm(emptyAlertDoc(), draftAtStep2({
      name: '  spaced_out  ', destinations: ['Incident'],
    }));
    assert.equal(doc.name, 'spaced_out');
  });
});

describe('the rule the Summary panel prints', () => {
  it('reads the trigger threshold when the alert does not aggregate', () => {
    const parts = thresholdParts(draftAtStep2({
      aggregationEnabled: false, thresholdOperator: '>=', threshold: 25,
    }));
    assert.deepEqual(parts, { measure: 'events', operator: '>=', value: '25' });
  });

  it('reads the HAVING value when it does, and names the column aggregated', () => {
    const parts = thresholdParts(draftAtStep2({
      aggregationEnabled: true,
      aggFunction: 'avg',
      aggColumn: 'elapsed_time',
      aggHavingOperator: '>',
      aggHavingValue: '500',
      // The trigger threshold is the GROUP GATE for an aggregating alert, not
      // the number being compared — printing it here would describe a rule the
      // alert does not have.
      threshold: 1,
    }));
    assert.deepEqual(parts, { measure: 'avg(elapsed_time)', operator: '>', value: '500' });
  });

  it('says "query result" for a SQL alert, which has no column to name', () => {
    const parts = thresholdParts(draftAtStep2({
      queryType: 'sql', sql: 'SELECT count(*) FROM default', thresholdOperator: '<', threshold: 1,
    }));
    assert.deepEqual(parts, { measure: 'query result', operator: '<', value: '1' });
  });

  it('keeps a threshold of zero, which is a real threshold', () => {
    assert.equal(thresholdParts(draftAtStep2({ threshold: 0 })).value, '0');
  });

  it('shows an em dash rather than "undefined" for an unset threshold', () => {
    assert.equal(thresholdParts(draftAtStep2({ threshold: '' })).value, '—');
  });

  it('points the warning tier at the field this alert type actually stores it in', () => {
    // The review prints "Warning at" from whichever of the three this returns;
    // reading the wrong one shows a blank next to a warning that is set.
    assert.equal(warningField(draftAtStep2({ aggregationEnabled: false })), 'trigger');
    assert.equal(warningField(draftAtStep2({ aggregationEnabled: true })), 'aggregation');
    assert.equal(warningField(draftAtStep2({ alertType: 'realtime' })), null);
  });
});

describe('"Hold for" — trigger_condition.tolerance_in_secs', () => {
  it('is null on a fresh alert, which is what the reference writes', () => {
    const doc = applyForm(emptyAlertDoc(), draftAtStep2({
      name: 'a', destinations: ['Incident'],
    }));
    assert.equal(doc.trigger_condition.tolerance_in_secs, null);
  });

  it('round-trips a stored value without the editor having to understand it', () => {
    const stored = emptyAlertDoc();
    stored.trigger_condition.tolerance_in_secs = 300;
    const form = docToForm(stored);
    assert.equal(form.toleranceSecs, '300');
    // Whole minutes read back as minutes: "300 Seconds" and "5 Minutes" are the
    // same rule, and only one of them can be checked at a glance.
    assert.equal(form.toleranceUnit, 'minutes');

    const doc = applyForm(stored, { ...form, name: 'a', destinations: ['x'] });
    assert.equal(doc.trigger_condition.tolerance_in_secs, 300);
  });

  it('reads a value that is not whole minutes in seconds', () => {
    const stored = emptyAlertDoc();
    stored.trigger_condition.tolerance_in_secs = 90;
    assert.equal(docToForm(stored).toleranceUnit, 'seconds');
  });

  it('is dropped to null on a realtime alert, which has no window to hold across', () => {
    const doc = applyForm(emptyAlertDoc(), draftAtStep2({
      name: 'a', destinations: ['Incident'], alertType: 'realtime', toleranceSecs: '120',
    }));
    assert.equal(doc.trigger_condition.tolerance_in_secs, null);
  });

  it('does not make an alert invalid on a screen with no control for it', () => {
    // The one-screen editor draws no Hold for control. A value it cannot reach
    // must never be the reason it refuses to save — the look-back comparison
    // that CAN fail lives in the wizard, which has the control.
    const errors = validateForm(draftAtStep2({
      name: 'a', destinations: ['Incident'], period: 10, toleranceSecs: '9000',
    }));
    assert.deepEqual(errors, {});
  });
});
