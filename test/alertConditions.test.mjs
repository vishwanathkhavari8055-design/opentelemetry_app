/**
 * Guards the alert document's aggregation half — what step 2 of the wizard writes.
 *
 * Every failure here is silent in exactly the way the drill-through ones are. An
 * aggregation whose `having.column` names the function instead of the column
 * saves cleanly and then averages nothing; a warning threshold written into the
 * field that does not apply to this alert's query type is stored and never read;
 * a form field the wizard adds but `applyForm` ignores produces an alert that
 * looks right on screen and is wrong on the wire. None of them error, and none of
 * them are visible without opening the stored JSON.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGG_NEEDS_COLUMN,
  ALERT_IF_OPTIONS,
  FILTER_OPERATORS,
  TOTAL_EVENTS,
  applyForm,
  docToForm,
  emptyAlertDoc,
  isValuelessOperator,
  parseConditions,
  toWireConditions,
  validateForm,
} from '../src/components/alerts/alertModel.js';

/** The form a freshly opened wizard holds, with the fields step 2 requires. */
const baseForm = (over = {}) => ({
  ...docToForm(emptyAlertDoc()),
  name: 'an_alert',
  streamName: 'default',
  destinations: ['Incident'],
  conditions: parseConditions({ and: [{ column: 'service_name', operator: '=', value: 'checkout' }] }),
  ...over,
});

describe('the "Alert if" control', () => {
  it('offers "total events" alongside every aggregate function', () => {
    assert.equal(ALERT_IF_OPTIONS[0].value, TOTAL_EVENTS);
    assert.equal(ALERT_IF_OPTIONS[0].label, 'total events');
    const values = ALERT_IF_OPTIONS.map((o) => o.value);
    ['avg', 'min', 'max', 'sum', 'count', 'median', 'p95'].forEach((fn) => {
      assert.ok(values.includes(fn), `${fn} missing from the Alert if list`);
    });
  });

  it('does not ask for a column for count — every other function needs one', () => {
    assert.ok(!AGG_NEEDS_COLUMN.includes('count'));
    assert.ok(AGG_NEEDS_COLUMN.includes('avg'));
    assert.ok(AGG_NEEDS_COLUMN.includes('p99'));
  });

  it('"total events" means NO aggregation and a trigger_condition threshold', () => {
    const doc = applyForm(emptyAlertDoc(), baseForm({
      aggregationEnabled: false, thresholdOperator: '>=', threshold: 25,
    }));
    assert.equal(doc.query_condition.aggregation, null);
    assert.equal(doc.trigger_condition.operator, '>=');
    assert.equal(doc.trigger_condition.threshold, 25);
  });
});

describe('the aggregated column', () => {
  it('is written to having.column, not the function name', () => {
    const doc = applyForm(emptyAlertDoc(), baseForm({
      aggregationEnabled: true,
      aggFunction: 'avg',
      aggColumn: 'elapsed_time',
      aggHavingOperator: '>=',
      aggHavingValue: '3',
      aggGroupBy: 'service_name',
    }));
    assert.deepEqual(doc.query_condition.aggregation.having, {
      column: 'elapsed_time', operator: '>=', value: 3,
    });
    assert.deepEqual(doc.query_condition.aggregation.group_by, ['service_name']);
    assert.equal(doc.query_condition.aggregation.function, 'avg');
  });

  /* The compatibility rule that lets an alert written by the one-screen editor —
     which has no column picker at all — round-trip through here untouched. */
  it('round-trips an alert whose having.column repeats the function', () => {
    const stored = {
      ...emptyAlertDoc(),
      query_condition: {
        ...emptyAlertDoc().query_condition,
        aggregation: {
          function: 'count',
          group_by: [],
          having: { column: 'count', operator: '>=', value: 5 },
          multi_alert: false,
        },
      },
    };
    const form = docToForm(stored);
    assert.equal(form.aggColumn, '', 'a repeated function name is not a column');
    const doc = applyForm(stored, { ...form, name: 'x', destinations: ['d'] });
    assert.equal(doc.query_condition.aggregation.having.column, 'count',
      're-saving must not change a field the user never saw');
  });

  it('keeps a real column across a save', () => {
    const first = applyForm(emptyAlertDoc(), baseForm({
      aggregationEnabled: true, aggFunction: 'p95', aggColumn: 'duration', aggHavingValue: '9',
    }));
    const form = docToForm(first);
    assert.equal(form.aggColumn, 'duration');
    assert.equal(applyForm(first, form).query_condition.aggregation.having.column, 'duration');
  });
});

describe('the warning tier follows the threshold it is a tier of', () => {
  it('lands in aggregation.warning_value when aggregating', () => {
    const doc = applyForm(emptyAlertDoc(), baseForm({
      aggregationEnabled: true,
      aggFunction: 'avg',
      aggColumn: 'elapsed_time',
      aggHavingOperator: '>=',
      aggHavingValue: '10',
      aggWarningValue: '5',
    }));
    assert.equal(doc.query_condition.aggregation.warning_value, 5);
    assert.ok(!('warning_threshold' in doc.trigger_condition));
  });

  it('lands in trigger_condition.warning_threshold without aggregation', () => {
    const doc = applyForm(emptyAlertDoc(), baseForm({
      aggregationEnabled: false,
      thresholdOperator: '>=',
      threshold: 10,
      warningThreshold: '5',
    }));
    assert.equal(doc.trigger_condition.warning_threshold, 5);
  });

  it('rejects a warning on the wrong side of critical', () => {
    const errors = validateForm(baseForm({
      aggregationEnabled: false, thresholdOperator: '>=', threshold: 10, warningThreshold: '20',
    }));
    assert.ok(errors.warningThreshold, 'a warning above a >= critical can never fire first');
  });
});

describe('per-group alerting', () => {
  it('needs something to group by', () => {
    const errors = validateForm(baseForm({
      aggregationEnabled: true,
      aggFunction: 'avg',
      aggColumn: 'elapsed_time',
      aggHavingValue: '3',
      multiAlert: true,
      aggGroupBy: '',
      thresholdOperator: '>=',
      threshold: 1,
    }));
    assert.ok(errors.aggGroupBy);
  });

  it('accepts the "at least 1 group" gate the wizard forces', () => {
    const errors = validateForm(baseForm({
      aggregationEnabled: true,
      aggFunction: 'avg',
      aggColumn: 'elapsed_time',
      aggHavingValue: '3',
      multiAlert: true,
      aggGroupBy: 'service_name',
      thresholdOperator: '>=',
      threshold: 1,
    }));
    assert.ok(!errors.threshold);
    assert.ok(!errors.aggGroupBy);
  });
});

describe('filter operators', () => {
  it('offers OpenObserve’s presence tests with its own wire values', () => {
    const values = FILTER_OPERATORS.map((o) => o.value);
    ['is_null', 'is_not_null', 'is_empty', 'is_not_empty'].forEach((op) => {
      assert.ok(values.includes(op), `${op} missing`);
      assert.ok(isValuelessOperator(op), `${op} must not ask for a value`);
    });
    // The comparison operators still ask for one.
    ['=', '!=', '>', 'contains'].forEach((op) => assert.ok(!isValuelessOperator(op)));
  });

  it('serialises a presence test without inventing a value', () => {
    const tree = parseConditions({ and: [{ column: 'trace_id', operator: 'is_null', value: '' }] });
    const wire = toWireConditions(tree, 1);
    assert.deepEqual(wire, {
      and: [{ column: 'trace_id', operator: 'is_null', value: '', ignore_case: false }],
    });
  });
});

describe('the wizard’s cadence', () => {
  it('writes a cron expression only in cron mode, and minutes otherwise', () => {
    const cron = applyForm(emptyAlertDoc(), baseForm({
      frequencyType: 'cron', cron: '0 */10 * * * *', frequency: 10,
    }));
    assert.equal(cron.trigger_condition.frequency_type, 'cron');
    assert.equal(cron.trigger_condition.cron, '0 */10 * * * *');

    const mins = applyForm(emptyAlertDoc(), baseForm({
      frequencyType: 'minutes', cron: '0 */10 * * * *', frequency: 120,
    }));
    assert.equal(mins.trigger_condition.frequency, 120, 'Hours is a UI unit, minutes are stored');
    assert.equal(mins.trigger_condition.cron, '', 'a stale cron must not survive the switch');
  });

  it('requires a cron expression when the unit is cron', () => {
    assert.ok(validateForm(baseForm({ frequencyType: 'cron', cron: '' })).cron);
  });
});
