/**
 * Guards composite alerts — the letter/id translation and the document shape.
 *
 * A composite's expression is stored over 27-character alert IDs and edited over
 * single letters, and every way of getting that mapping wrong produces a VALID
 * expression that watches the wrong alerts. Removing a child without re-lettering
 * the text is the worst of them: `A && B && C` with B deleted silently becomes a
 * rule about A and the alert that used to be C, saves cleanly, and pages someone
 * about something nobody asked to be paged about. None of it errors, and none of
 * it is visible without decoding the ids by hand.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALERT_TYPES,
  COMPOSITE_MAX_CHILDREN,
  COMPOSITE_MIN_CHILDREN,
  STALE_CHILD_POLICIES,
  WIZARD_ALERT_TYPES,
  applyForm,
  childLabel,
  compositeChildIds,
  docToForm,
  emptyAlertDoc,
  expressionToIds,
  expressionToLabels,
  validateCompositeExpression,
  validateForm,
} from '../src/components/alerts/alertModel.js';

/** Real-shaped OpenObserve alert ids — long enough that letters clearly matter. */
const A = '3J7xjrR4FBY25cvd1QbaK5ff2kl';
const B = '3J7x1GEsDd0VHpGI36N80pr5qdz';
const C = '3J7vbAb6J6l2qKcwlcWtJM5zort';

const compositeForm = (over = {}) => ({
  ...docToForm(emptyAlertDoc()),
  name: 'a_composite',
  alertType: 'composite',
  destinations: ['Incident'],
  compositeChildren: [A, B],
  compositeExpressionLabelled: 'A && B',
  compositeExpression: `{${A}} && {${B}}`,
  staleChildPolicy: 'use_last_state',
  warningCountsAsFiring: true,
  ...over,
});

describe('the alert-type lists', () => {
  /* The editor cannot draw a composite — no sub-alert list, no expression box —
     so offering it there would let someone convert a working alert into one the
     same screen then cannot show or save back. */
  it('keeps Composite out of the one-screen editor', () => {
    assert.deepEqual(ALERT_TYPES.map((t) => t.value), ['scheduled', 'realtime']);
  });

  it('offers all three in the wizard', () => {
    assert.deepEqual(WIZARD_ALERT_TYPES.map((t) => t.value),
      ['scheduled', 'realtime', 'composite']);
  });
});

describe('letters and ids', () => {
  it('labels children A, B, C by position', () => {
    assert.equal(childLabel(0), 'A');
    assert.equal(childLabel(2), 'C');
  });

  it('reads child ids out of a stored expression, in order, without repeats', () => {
    assert.deepEqual(compositeChildIds(`{${A}} && ({${B}} || {${A}})`), [A, B]);
    assert.deepEqual(compositeChildIds(''), []);
  });

  it('round-trips an expression through the letter form', () => {
    const stored = `{${A}} && ({${B}} || {${C}})`;
    const ids = [A, B, C];
    const labelled = expressionToLabels(stored, ids);
    assert.equal(labelled, 'A && (B || C)');
    assert.equal(expressionToIds(labelled, ids), stored);
  });

  /* An id with no seat left is shown, not dropped: it means the expression
     references a child the list no longer holds, and that has to be visible. */
  it('leaves an unmapped id as a placeholder', () => {
    assert.equal(expressionToLabels(`{${A}} && {${C}}`, [A]), `A && {${C}}`);
  });

  it('leaves a letter with no child behind it alone', () => {
    assert.equal(expressionToIds('A && Z', [A]), `{${A}} && Z`);
  });

  it('does not substitute a letter inside a longer word', () => {
    assert.equal(expressionToIds('A AND B', [A, B]), `{${A}} AND {${B}}`);
  });
});

describe('local expression checks', () => {
  const ok = (expr, n) => assert.equal(validateCompositeExpression(expr, n), '',
    `expected "${expr}" to be accepted`);
  const bad = (expr, n) => assert.notEqual(validateCompositeExpression(expr, n), '',
    `expected "${expr}" to be rejected`);

  it('accepts the shapes the builder produces', () => {
    ok('A && B', 2);
    ok('A || B', 2);
    ok('A && (B || C)', 3);
    ok('!A && B', 2);
  });

  it('rejects an empty or one-child composite', () => {
    bad('', 0);
    bad('A', 1);
  });

  it('rejects unbalanced brackets', () => {
    bad('A && (B || C', 3);
    bad('A && B)', 2);
  });

  it('rejects a dangling operator', () => {
    bad('A &&', 2);
    bad('&& A', 2);
  });

  /* OpenObserve requires each child exactly once. Both halves matter: an unused
     child is a row the user thinks is doing something, and a repeated one makes
     the letter→id mapping ambiguous. */
  it('requires every child exactly once', () => {
    bad('A && A', 2);
    bad('A && B', 3);
  });

  it('rejects anything that is not a letter, operator or bracket', () => {
    bad('A && service_name', 2);
  });

  it('honours the documented child cap', () => {
    assert.equal(COMPOSITE_MIN_CHILDREN, 2);
    assert.equal(COMPOSITE_MAX_CHILDREN, 10);
  });
});

describe('the composite document', () => {
  it('writes alert_type and composite_condition', () => {
    const doc = applyForm(emptyAlertDoc(), compositeForm());
    assert.equal(doc.alert_type, 'composite');
    assert.deepEqual(doc.composite_condition, {
      expression: `{${A}} && {${B}}`,
      stale_child_policy: 'use_last_state',
      warning_counts_as_firing: true,
    });
    // A composite is not realtime, whatever else it is.
    assert.equal(doc.is_real_time, false);
  });

  it('reads back into the same form, letters and all', () => {
    const doc = applyForm(emptyAlertDoc(), compositeForm({
      staleChildPolicy: 'treat_as_true', warningCountsAsFiring: false,
    }));
    const form = docToForm(doc);
    assert.equal(form.alertType, 'composite');
    assert.deepEqual(form.compositeChildren, [A, B]);
    assert.equal(form.staleChildPolicy, 'treat_as_true');
    assert.equal(form.warningCountsAsFiring, false);
    assert.equal(expressionToLabels(form.compositeExpression, form.compositeChildren), 'A && B');
  });

  it('defaults warning_counts_as_firing to true, as OpenObserve does', () => {
    const form = docToForm({
      ...emptyAlertDoc(),
      alert_type: 'composite',
      composite_condition: { expression: `{${A}} && {${B}}` },
    });
    assert.equal(form.warningCountsAsFiring, true);
    assert.equal(form.staleChildPolicy, 'use_last_state');
  });

  it('falls back to a known policy when the stored one is unrecognised', () => {
    const form = docToForm({
      ...emptyAlertDoc(),
      alert_type: 'composite',
      composite_condition: { expression: `{${A}}`, stale_child_policy: 'nonsense' },
    });
    assert.ok(STALE_CHILD_POLICIES.some((p) => p.value === form.staleChildPolicy));
  });

  /* Converting away from composite must not leave the expression behind, or it
     resurfaces if the alert is ever converted back and silently re-arms a rule
     the user believed they had replaced. */
  it('removes composite_condition when the alert is not a composite', () => {
    const composite = applyForm(emptyAlertDoc(), compositeForm());
    const back = applyForm(composite, {
      ...docToForm(composite),
      alertType: 'scheduled',
      streamName: 'default',
      name: 'a_composite',
      destinations: ['Incident'],
    });
    assert.ok(!('composite_condition' in back));
    assert.ok(!('alert_type' in back));
  });
});

describe('composite validation', () => {
  it('does not demand a stream, a query or a window', () => {
    const errors = validateForm(compositeForm());
    assert.deepEqual(errors, {}, JSON.stringify(errors));
  });

  it('still demands a destination', () => {
    assert.ok(validateForm(compositeForm({ destinations: [] })).destinations);
  });

  /* One complaint, on the control that can fix it — an unfilled row also makes
     the expression look short of children, and printing both under a list that
     already shows two rows reads as a screen that cannot count. */
  it('reports an unfilled row instead of the expression', () => {
    const errors = validateForm(compositeForm({
      compositeChildren: [A, ''],
    }));
    assert.ok(errors.compositeChildren);
    assert.ok(!errors.compositeExpression);
  });

  it('reports a broken expression once the rows are filled', () => {
    const errors = validateForm(compositeForm({
      compositeExpressionLabelled: 'A &&',
      compositeExpression: `{${A}} &&`,
    }));
    assert.ok(errors.compositeExpression);
  });
});
