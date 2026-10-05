/**
 * Guards alertModel's round trip and its validation, through the public exports.
 *
 * The module's contract is that editing an alert changes only what the user
 * changed: `applyForm` merges into the document the server sent, keys the form
 * does not cover survive, and an empty field is ABSENT unless the document
 * already carried it. Breaking any of that does not error — the save succeeds
 * and quietly drops a workflow, writes a warning into a field nothing reads, or
 * stores the VRL body as plain text OpenObserve then fails to decode.
 *
 * `validateForm` is the other half: it is what turns OpenObserve's single opaque
 * rejection into a message on the control that can fix it, so each rule is
 * checked against the field it reports on.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

import {
  alertTypeLabel,
  applyForm,
  childLabel,
  compositeChildIds,
  countConditions,
  decodeVrl,
  docToForm,
  emptyAlertDoc,
  encodeVrl,
  expressionToIds,
  expressionToLabels,
  formatFrequency,
  formatMinutes,
  formatOffset,
  formatTimestamp,
  moveNode,
  newComparisonWindow,
  newCondition,
  newGroup,
  nextKey,
  normaliseTags,
  parseConditions,
  parseOffset,
  removeNode,
  thresholdParts,
  toWireConditions,
  updateNode,
  validateCompositeExpression,
  validateForm,
  warningField,
} from '../src/components/alerts/alertModel.js';

/* ── fixtures ───────────────────────────────────────────────────────────── */

const leaf = (column, value = 'x', extra = {}) => ({
  key: nextKey(), kind: 'condition', column, operator: '=', value, ignoreCase: false, ...extra,
});
const group = (join, items, extra = {}) => ({ key: nextKey(), kind: 'group', join, items, ...extra });

/** A scheduled custom alert that validates clean; each test breaks one thing. */
const validForm = (over = {}) => ({
  ...docToForm(emptyAlertDoc()),
  name: 'cpu_high',
  streamName: 'default',
  destinations: ['email'],
  conditions: group('and', [leaf('level', 'error')], { wireVersion: 1 }),
  ...over,
});

/* ── VRL encoding ───────────────────────────────────────────────────────── */

describe('VRL body encoding', () => {
  it('encodes to OpenObserve’s base64url alphabet and decodes back', () => {
    const body = '.level = upcase!(.level) ?? "x"';
    const wire = encodeVrl(`  ${body}  `);
    assert.match(wire, /^[A-Za-z0-9\-_.]+$/, 'no +, / or = on the wire');
    assert.equal(decodeVrl(wire), body, 'trimmed on the way in, identical on the way out');
  });

  it('round-trips non-ASCII text through the UTF-8 step', () => {
    assert.equal(decodeVrl(encodeVrl('.msg = "café ✓"')), '.msg = "café ✓"');
  });

  it('writes nothing for a blank body', () => {
    assert.equal(encodeVrl('   '), null);
    assert.equal(encodeVrl(undefined), null);
  });

  it('falls back to the raw text when it cannot be encoded', () => {
    // A lone surrogate makes encodeURIComponent throw.
    assert.equal(encodeVrl('\uD800'), '\uD800');
  });

  it('shows a body this app once stored as plain text unchanged', () => {
    const plain = 'if .status >= 500 { abort }';
    assert.equal(decodeVrl(plain), plain);
    assert.equal(decodeVrl(''), '');
    assert.equal(decodeVrl(null), '');
  });

  it('leaves valid base64 that is not UTF-8 as it was stored', () => {
    // "_w.." is "/w==", the single byte 0xFF — not a UTF-8 sequence.
    assert.equal(decodeVrl('_w..'), '_w..');
  });

  it('undoes a double encoding from a UI that re-encoded a plain value', () => {
    assert.equal(decodeVrl(encodeVrl(encodeVrl('abort'))), 'abort');
  });
});

/* ── comparison windows ─────────────────────────────────────────────────── */

describe('comparison-window offsets', () => {
  it('splits an offset, keeping capital M (months) distinct from m', () => {
    assert.deepEqual(parseOffset('30h'), { amount: '30', unit: 'h' });
    assert.deepEqual(parseOffset(' 2M '), { amount: '2', unit: 'M' });
  });

  it('defaults junk and absence to 15 minutes', () => {
    assert.deepEqual(parseOffset('fortnight'), { amount: '15', unit: 'm' });
    assert.deepEqual(parseOffset(null), { amount: '15', unit: 'm' });
  });

  it('labels singular and plural, and tolerates an unknown unit', () => {
    assert.equal(formatOffset('1', 'm'), '1 Minute');
    assert.equal(formatOffset(15, 'm'), '15 Minutes');
    assert.equal(formatOffset('x', 'h'), '— Hours');
    assert.equal(formatOffset(3, 'q'), '3 q');
  });

  describe('new window ids', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    afterEach(() => { Object.defineProperty(globalThis, 'crypto', original); });

    it('uses a real uuid where the browser offers one', () => {
      const w = newComparisonWindow();
      assert.match(w.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.deepEqual({ amount: w.amount, unit: w.unit }, { amount: '15', unit: 'm' });
      assert.match(w.key, /^c\d+$/);
    });

    it('falls back to getRandomValues outside a secure context', () => {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: { getRandomValues: (arr) => arr.fill(7) },
      });
      const w = newComparisonWindow();
      assert.match(w.uuid, /^w[0-9a-z]+777777$/);
    });

    it('still gives unique ids with no crypto at all', () => {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      const a = newComparisonWindow().uuid;
      const b = newComparisonWindow().uuid;
      assert.match(a, /^w[0-9a-z]+$/);
      assert.notEqual(a, b);
    });
  });
});

/* ── condition tree: reading ────────────────────────────────────────────── */

describe('parseConditions', () => {
  it('gives an empty v1 group for no conditions', () => {
    const root = parseConditions(null);
    assert.equal(root.kind, 'group');
    assert.equal(root.join, 'and');
    assert.deepEqual(root.items, []);
    assert.equal(root.wireVersion, 1);
  });

  it('reads a bare array with a nested OR group and drops non-objects', () => {
    const root = parseConditions([
      { column: 'a', operator: '>', value: 5, ignore_case: true },
      { or: [{ column: 'b', value: null }, 7] },
      null,
    ]);
    assert.equal(root.wireVersion, 1);
    assert.equal(root.items.length, 2);
    const [a, nested] = root.items;
    assert.deepEqual(
      { column: a.column, operator: a.operator, value: a.value, ignoreCase: a.ignoreCase },
      { column: 'a', operator: '>', value: '5', ignoreCase: true },
    );
    assert.equal(nested.join, 'or');
    assert.equal(nested.items.length, 1);
    assert.deepEqual([nested.items[0].operator, nested.items[0].value], ['=', '']);
  });

  it('wraps a single v1 leaf at the root in a group', () => {
    const root = parseConditions({ column: 'svc', operator: '=', value: 'x' });
    assert.equal(root.kind, 'group');
    assert.equal(root.items[0].column, 'svc');
    assert.equal(root.wireVersion, 1);
  });

  it('treats an unreadable non-object as no conditions', () => {
    const root = parseConditions('nonsense');
    assert.deepEqual([root.kind, root.items.length, root.wireVersion], ['group', 0, 1]);
  });

  it('reads v2 nested groups with their logical operators', () => {
    const root = parseConditions({
      version: 2,
      conditions: {
        filterType: 'group', logicalOperator: 'or', conditions: [
          { filterType: 'condition', column: 'a', operator: '=', value: '1' },
          { filterType: 'group', conditions: [{ filterType: 'condition', column: 'b', value: 2 }] },
          'junk',
        ],
      },
    });
    assert.equal(root.wireVersion, 2);
    assert.equal(root.join, 'or');
    assert.equal(root.items.length, 2);
    assert.equal(root.items[1].join, 'and', 'absent logicalOperator reads as AND');
    assert.equal(root.items[1].items[0].value, '2');
  });

  it('wraps a v2 root leaf, and keeps v2 when the root is unreadable', () => {
    const wrapped = parseConditions({ version: 2, conditions: { filterType: 'condition', column: 'a' } });
    assert.deepEqual([wrapped.kind, wrapped.items[0].column, wrapped.wireVersion], ['group', 'a', 2]);

    const empty = parseConditions({ version: 2, conditions: 'garbage' });
    assert.deepEqual([empty.items.length, empty.wireVersion], [0, 2]);
  });
});

/* ── condition tree: writing ────────────────────────────────────────────── */

describe('toWireConditions', () => {
  it('writes v1 with typed values, dropping unfinished rows and empty groups', () => {
    const tree = group('and', [
      leaf(' code ', '500'),
      leaf('flag', 'true'),
      leaf('off', 'false'),
      leaf('id', '007'),
      leaf('ratio', '-3.5'),
      leaf('name', '  x  ', { ignoreCase: true, operator: 'contains' }),
      leaf('', 'dropped'),
      group('or', [leaf('   ', 'also dropped')]),
      group('or', [leaf('b', '')]),
    ]);
    assert.deepEqual(toWireConditions(tree, 1), {
      and: [
        { column: 'code', operator: '=', value: 500, ignore_case: false },
        { column: 'flag', operator: '=', value: true, ignore_case: false },
        { column: 'off', operator: '=', value: false, ignore_case: false },
        { column: 'id', operator: '=', value: '007', ignore_case: false },
        { column: 'ratio', operator: '=', value: -3.5, ignore_case: false },
        { column: 'name', operator: 'contains', value: 'x', ignore_case: true },
        { or: [{ column: 'b', operator: '=', value: '', ignore_case: false }] },
      ],
    });
  });

  it('defaults a missing operator to =', () => {
    const tree = group('and', [leaf('a', '1', { operator: '' })]);
    assert.equal(toWireConditions(tree).and[0].operator, '=');
  });

  it('returns null when nothing usable remains, in either version', () => {
    const tree = group('and', [leaf('')]);
    assert.equal(toWireConditions(tree, 1), null);
    assert.equal(toWireConditions(tree, 2), null);
    assert.equal(toWireConditions(null, 1), null);
  });

  it('writes v2 with stringified values and the parent join on every leaf', () => {
    const tree = group('or', [leaf('a', '1'), group('and', [leaf('b', ''), leaf('', 'x')])]);
    assert.deepEqual(toWireConditions(tree, '2'), {
      version: 2,
      conditions: {
        filterType: 'group', logicalOperator: 'OR', conditions: [
          { filterType: 'condition', column: 'a', operator: '=', value: '1', logicalOperator: 'OR' },
          {
            filterType: 'group', logicalOperator: 'AND', conditions: [
              { filterType: 'condition', column: 'b', operator: '=', value: '', logicalOperator: 'AND' },
            ],
          },
        ],
      },
    });
  });

  it('counts only leaves that have a column', () => {
    assert.equal(countConditions(null), 0);
    assert.equal(countConditions(group('and', [leaf('a'), leaf(''), group('or', [leaf('b'), leaf(' ')])])), 2);
  });
});

/* ── condition tree: editing ────────────────────────────────────────────── */

describe('tree editing', () => {
  it('seeds a new group with one blank condition', () => {
    const g = newGroup();
    assert.equal(g.kind, 'group');
    assert.equal(g.items.length, 1);
    assert.equal(g.items[0].kind, 'condition');
    assert.notEqual(newCondition().key, newCondition().key);
  });

  it('updateNode replaces a nested node and reuses untouched subtrees', () => {
    const target = leaf('a');
    const untouched = group('or', [leaf('b')]);
    const inner = group('and', [target]);
    const tree = group('and', [untouched, inner]);

    const next = updateNode(tree, target.key, (n) => ({ ...n, column: 'changed' }));
    assert.notEqual(next, tree);
    assert.equal(next.items[0], untouched, 'sibling subtree is the same object');
    assert.equal(next.items[1].items[0].column, 'changed');
    assert.equal(tree.items[1].items[0].column, 'a', 'original not mutated');
  });

  it('updateNode returns the same tree when the key is not found', () => {
    const tree = group('and', [leaf('a')]);
    assert.equal(updateNode(tree, 'missing', () => ({})), tree);
    assert.equal(updateNode(null, 'k', () => ({})), null);
    const lone = leaf('a');
    assert.equal(updateNode(lone, 'missing', () => ({})), lone);
  });

  it('removeNode removes at any depth but never the root', () => {
    const deep = leaf('deep');
    const tree = group('and', [leaf('a'), group('or', [deep, leaf('b')])]);
    const next = removeNode(tree, deep.key);
    assert.deepEqual(next.items[1].items.map((n) => n.column), ['b']);
    assert.equal(removeNode(tree, tree.key), tree, 'root is untouched');
    assert.equal(removeNode(tree, 'missing'), tree);
    const lone = leaf('a');
    assert.equal(removeNode(lone, lone.key), lone, 'a leaf has nothing to remove from');
  });

  it('moveNode swaps neighbours and ignores out-of-range moves', () => {
    const tree = group('and', [leaf('a'), leaf('b'), leaf('c')]);
    const down = moveNode(tree, tree.key, 0, 1);
    assert.deepEqual(down.items.map((n) => n.column), ['b', 'a', 'c']);
    assert.equal(moveNode(tree, tree.key, 0, -1), tree);
    assert.equal(moveNode(tree, tree.key, 2, 1), tree);
  });
});

/* ── composite expressions ──────────────────────────────────────────────── */

describe('composite expressions', () => {
  it('maps ids to letters positionally and back', () => {
    const expr = '{id1} && ({ id2 } || {id3}) && {id1}';
    const ids = compositeChildIds(`${expr} {}`);
    assert.deepEqual(ids, ['id1', 'id2', 'id3']);
    assert.equal(childLabel(2), 'C');
    assert.equal(expressionToLabels(expr, ids), 'A && (B || C) && A');
    assert.equal(expressionToIds('A && (B || C)', ids), '{id1} && ({id2} || {id3})');
  });

  it('keeps an id with no seat, and a letter with no child, visible', () => {
    assert.equal(expressionToLabels('{gone} && {id1}', ['id1']), '{gone} && A');
    assert.equal(expressionToIds('A && Z', ['id1']), '{id1} && Z');
    assert.equal(expressionToLabels(null, null), '');
    assert.equal(expressionToIds(undefined, undefined), '');
  });

  const cases = [
    ['', 2, /Write an expression/],
    ['A', 1, /at least 2 sub-alerts/],
    ['A', 11, /at most 10 sub-alerts/],
    ['A + B', 2, /Use only the sub-alert letters/],
    [')A && B(', 2, /closing bracket has nothing to close/],
    ['(A && B', 2, /bracket is left open/],
    ['A && C', 3, /B is not used/],
    ['A && B && C', 2, /C has no sub-alert behind it/],
    ['A && B || A', 2, /A appears 2 times/],
    ['A B', 2, /incomplete/],
    ['A !B', 2, /incomplete/],
    ['A && B &&', 2, /incomplete/],
    ['(|| A) && B', 2, /incomplete/],
  ];
  for (const [text, count, expected] of cases) {
    it(`rejects ${JSON.stringify(text)} with ${count} children`, () => {
      assert.match(validateCompositeExpression(text, count), expected);
    });
  }

  it('accepts well-formed expressions in either operator spelling', () => {
    assert.equal(validateCompositeExpression('A && (B || !C)', 3), '');
    assert.equal(validateCompositeExpression('NOT A AND B', 2), '');
  });
});

/* ── document → form ────────────────────────────────────────────────────── */

describe('docToForm', () => {
  it('reads aggregation values, comparison windows and tolerance units', () => {
    const form = docToForm({
      query_condition: {
        type: 'sql',
        aggregation: {
          function: 'avg', group_by: ['host'], multi_alert: true, warning_value: 0,
          having: { column: 'cpu', operator: '>', value: 0 },
        },
        multi_time_range: [{ uuid: 'u1', offSet: '1h' }, { offSet: 'bad' }, null],
      },
      trigger_condition: { tolerance_in_secs: 300 },
    });
    assert.equal(form.aggHavingValue, '0', 'a zero threshold is not an empty box');
    assert.equal(form.aggWarningValue, '0');
    assert.equal(form.aggColumn, 'cpu');
    assert.equal(form.aggGroupBy, 'host');
    assert.equal(form.multiAlert, true);
    assert.deepEqual(form.multiWindows.map(({ uuid, amount, unit }) => ({ uuid, amount, unit })), [
      { uuid: 'u1', amount: '1', unit: 'h' },
      { uuid: '', amount: '15', unit: 'm' },
      { uuid: '', amount: '15', unit: 'm' },
    ]);
    assert.deepEqual([form.toleranceSecs, form.toleranceUnit], ['300', 'minutes']);
  });

  it('shows a non-minute tolerance in seconds, and an unset one as 0', () => {
    assert.deepEqual(
      [docToForm({ trigger_condition: { tolerance_in_secs: 90 } }).toleranceUnit],
      ['seconds'],
    );
    const unset = docToForm({});
    assert.deepEqual([unset.toleranceSecs, unset.toleranceUnit], ['0', 'seconds']);
    assert.equal(unset.conditions.items.length, 1, 'an empty tree opens with one blank row');
  });

  it('reads a composite and falls back from an unknown stale policy', () => {
    const form = docToForm({
      alert_type: 'composite',
      composite_condition: {
        expression: '{x} || {y}', stale_child_policy: 'whatever', warning_counts_as_firing: false,
      },
    });
    assert.equal(form.alertType, 'composite');
    assert.deepEqual(form.compositeChildren, ['x', 'y']);
    assert.equal(form.staleChildPolicy, 'use_last_state');
    assert.equal(form.warningCountsAsFiring, false);
  });

  it('turns context_attributes into editable rows', () => {
    const form = docToForm({ context_attributes: { team: 'ops', n: 1, empty: null }, priority: 2 });
    assert.deepEqual(form.variables.map(({ name, value }) => [name, value]),
      [['team', 'ops'], ['n', '1'], ['empty', '']]);
    assert.equal(form.priority, '2');
  });
});

/* ── form → document ────────────────────────────────────────────────────── */

describe('applyForm', () => {
  it('merges into the server document, keeping keys the form never renders', () => {
    const base = {
      ...emptyAlertDoc(),
      anomaly_config: { sensitivity: 3 },
      workflows: ['w1'],
      query_condition: { ...emptyAlertDoc().query_condition, search_event_type: 'ui' },
      trigger_condition: { ...emptyAlertDoc().trigger_condition, notify_on_warning: true },
    };
    const destinations = ['email'];
    const doc = applyForm(base, validForm({ name: '  cpu_high  ', destinations }));
    assert.deepEqual(doc.anomaly_config, { sensitivity: 3 });
    assert.deepEqual(doc.workflows, ['w1']);
    assert.equal(doc.query_condition.search_event_type, 'ui');
    assert.equal(doc.name, 'cpu_high');
    assert.deepEqual(doc.destinations, ['email']);
    assert.notEqual(doc.destinations, destinations, 'copied, not aliased');
    assert.equal('notify_on_warning' in doc.trigger_condition, false, 'dead field cleaned up');
    assert.equal(base.name, '', 'base not mutated');
  });

  it('writes template only when set, or when clearing one the document had', () => {
    assert.equal('template' in applyForm(emptyAlertDoc(), validForm({ template: '  ' })), false);
    assert.equal(applyForm({ template: 'old' }, validForm({ template: '' })).template, '');
    assert.equal(applyForm(null, validForm({ template: ' t ' })).template, 't');
  });

  it('writes row_template_type for json, or when the document already had one', () => {
    assert.equal(applyForm({}, validForm({ rowTemplateType: 'json' })).row_template_type, 'json');
    assert.equal(applyForm({ row_template_type: 'json' }, validForm({ rowTemplateType: 'string' }))
      .row_template_type, 'string');
    assert.equal('row_template_type' in applyForm({}, validForm({ rowTemplateType: 'string' })), false);
  });

  it('sends priority as a number, or not at all', () => {
    assert.equal(applyForm({}, validForm({ priority: '2' })).priority, 2);
    assert.equal('priority' in applyForm({ priority: 4 }, validForm({ priority: '' })), false);
  });

  it('normalises tags, and omits an empty list', () => {
    assert.deepEqual(applyForm({}, validForm({ tags: [' Foo ', 'foo', 'bar', ''] })).tags, ['foo', 'bar']);
    assert.equal('tags' in applyForm({ tags: ['x'] }, validForm({ tags: [] })), false);
    assert.deepEqual(normaliseTags(null), []);
  });

  it('collapses variable rows into context_attributes, dropping half rows', () => {
    const doc = applyForm({}, validForm({
      variables: [{ name: ' team ', value: ' ops ' }, { name: 'x', value: '' }, { name: '', value: 'y' }, {}],
    }));
    assert.deepEqual(doc.context_attributes, { team: 'ops' });
  });

  describe('deduplication', () => {
    it('derives enabled from the fingerprint fields and merges over the old block', () => {
      const doc = applyForm(
        { deduplication: { grouping: 'keep' } },
        validForm({ dedupFields: [' host ', ''], dedupWindow: '5' }),
      );
      assert.deepEqual(doc.deduplication, {
        grouping: 'keep', enabled: true, fingerprint_fields: ['host'], time_window_minutes: 5,
      });
    });

    it('keeps a window with no fields, disabled', () => {
      const doc = applyForm({}, validForm({ dedupFields: [], dedupWindow: '10' }));
      assert.deepEqual(doc.deduplication, { enabled: false, fingerprint_fields: [], time_window_minutes: 10 });
    });

    it('clears a block the document had, and omits one it never had', () => {
      const cleared = applyForm({ deduplication: { enabled: true, fingerprint_fields: ['a'], x: 1 } }, validForm());
      assert.deepEqual(cleared.deduplication, { enabled: false, fingerprint_fields: [], time_window_minutes: null, x: 1 });
      assert.equal('deduplication' in applyForm({}, validForm()), false);
    });
  });

  describe('query_condition', () => {
    it('SQL mode: writes the SQL, drops aggregation and keeps positive windows', () => {
      const doc = applyForm(emptyAlertDoc(), validForm({
        queryType: 'sql',
        sql: 'SELECT count(*) FROM t',
        promql: 'up',
        aggregationEnabled: true,
        vrlFunction: '.a = 1',
        multiWindows: [
          { amount: '1', unit: 'h', uuid: 'u1' },
          { amount: '2' },
          { amount: '0', unit: 'm' },
          { amount: 'x', unit: 'm' },
        ],
        warningThreshold: '1',
      }));
      const qc = doc.query_condition;
      assert.equal(qc.type, 'sql');
      assert.equal(qc.sql, 'SELECT count(*) FROM t');
      assert.equal(qc.promql, null);
      assert.equal(qc.aggregation, null);
      assert.equal(qc.promql_condition, null);
      assert.equal(qc.promql_multi_alert, false);
      assert.equal(decodeVrl(qc.vrl_function), '.a = 1');
      assert.deepEqual(qc.multi_time_range, [{ offSet: '1h', uuid: 'u1' }, { offSet: '2m' }]);
      assert.equal(doc.trigger_condition.warning_threshold, 1, 'SQL warning lives on the trigger');
    });

    it('writes an empty group in the serialisation the alert was read in', () => {
      const v1 = applyForm({}, validForm({ conditions: group('and', [leaf('')]) }));
      assert.deepEqual(v1.query_condition.conditions, { and: [] });
      const v2 = applyForm({}, validForm({ conditions: group('and', [], { wireVersion: 2 }) }));
      assert.deepEqual(v2.query_condition.conditions,
        { version: 2, conditions: { filterType: 'group', logicalOperator: 'AND', conditions: [] } });
    });

    it('PromQL mode: threshold in promql_condition, warning in promql_warning_value', () => {
      const base = {
        query_condition: { promql_condition: { extra: 'kept' }, promql_warning_value: 9 },
        trigger_condition: { warning_threshold: 4 },
      };
      const doc = applyForm(base, validForm({
        queryType: 'promql', promql: 'rate(x[5m])', promqlOperator: '<', promqlValue: 'junk',
        promqlMultiAlert: true, promqlWarningValue: '3', warningThreshold: '2',
        multiWindows: [{ amount: '1', unit: 'h' }], sql: 'ignored',
      }));
      const qc = doc.query_condition;
      assert.equal(qc.promql, 'rate(x[5m])');
      assert.equal(qc.sql, null);
      assert.deepEqual(qc.promql_condition, { extra: 'kept', column: 'value', operator: '<', value: 1 });
      assert.equal(qc.promql_multi_alert, true);
      assert.equal(qc.promql_warning_value, 3);
      assert.deepEqual(qc.multi_time_range, []);
      assert.equal('warning_threshold' in doc.trigger_condition, false);
    });

    it('PromQL mode: an unset operator and warning are defaulted and dropped', () => {
      const doc = applyForm(
        { query_condition: { promql_warning_value: 9 } },
        validForm({ queryType: 'promql', promql: '', promqlOperator: '', promqlValue: '2', promqlWarningValue: '' }),
      );
      assert.equal(doc.query_condition.promql, '');
      assert.equal(doc.query_condition.promql_condition.operator, '>=');
      assert.equal(doc.query_condition.promql_condition.value, 2);
      assert.equal('promql_warning_value' in doc.query_condition, false);
    });

    it('custom aggregation: group-by split, column fallback, warning on the aggregation', () => {
      const base = { query_condition: { aggregation: { legacy: true, warning_value: 8 } } };
      const doc = applyForm(base, validForm({
        aggregationEnabled: true, aggFunction: 'avg', aggColumn: '  ', aggGroupBy: 'host, , pod',
        aggHavingOperator: '>', aggHavingValue: 'x', multiAlert: 1, aggWarningValue: '5',
        warningThreshold: '1',
      }));
      assert.deepEqual(doc.query_condition.aggregation, {
        legacy: true, function: 'avg', group_by: ['host', 'pod'],
        having: { column: 'avg', operator: '>', value: 0 },
        multi_alert: true, warning_value: 5,
      });
      assert.equal('warning_threshold' in doc.trigger_condition, false);
    });

    it('custom aggregation: a blank warning removes the stale one', () => {
      const base = { query_condition: { aggregation: { warning_value: 8 } } };
      const doc = applyForm(base, validForm({
        aggregationEnabled: true, aggFunction: 'sum', aggColumn: 'bytes', aggWarningValue: '',
      }));
      assert.equal(doc.query_condition.aggregation.having.column, 'bytes');
      assert.equal(doc.query_condition.aggregation.group_by.length, 0);
      assert.equal('warning_value' in doc.query_condition.aggregation, false);
    });
  });

  describe('trigger_condition', () => {
    it('coerces numbers with fallbacks and writes cron only in cron mode', () => {
      const doc = applyForm({}, validForm({
        period: 'x', threshold: '', frequency: 'y', silence: 'z', timezone: '',
        frequencyType: 'cron', cron: '0 * * * *', alignTime: 0, toleranceSecs: '90.4',
      }));
      const t = doc.trigger_condition;
      // Number('') is 0, so an empty threshold is written as 0 rather than the fallback.
      assert.deepEqual(
        [t.period, t.threshold, t.frequency, t.silence, t.timezone, t.cron, t.align_time, t.tolerance_in_secs],
        [10, 0, 1, 10, 'UTC', '0 * * * *', false, 90],
      );
      assert.equal(applyForm({}, validForm({ frequencyType: 'minutes', cron: 'x' })).trigger_condition.cron, '');
      assert.equal(applyForm({}, validForm({ frequencyType: 'cron', cron: undefined })).trigger_condition.cron, '');
    });

    it('writes null tolerance for unset, zero, or a realtime alert', () => {
      assert.equal(applyForm({}, validForm({ toleranceSecs: '0' })).trigger_condition.tolerance_in_secs, null);
      assert.equal(applyForm({}, validForm({ toleranceSecs: '' })).trigger_condition.tolerance_in_secs, null);
      const rt = applyForm({}, validForm({ alertType: 'realtime', toleranceSecs: '120', warningThreshold: '1' }));
      assert.equal(rt.is_real_time, true);
      assert.equal(rt.trigger_condition.tolerance_in_secs, null);
      assert.equal('warning_threshold' in rt.trigger_condition, false, 'realtime has no warning tier');
    });
  });

  describe('composite', () => {
    it('writes the composite block over the one the document carried', () => {
      const doc = applyForm({ composite_condition: { id_map: { a: 1 } } }, validForm({
        alertType: 'composite', compositeExpression: ' {x} && {y} ', staleChildPolicy: '',
        warningCountsAsFiring: undefined,
      }));
      assert.equal(doc.alert_type, 'composite');
      assert.deepEqual(doc.composite_condition, {
        id_map: { a: 1 }, expression: '{x} && {y}',
        stale_child_policy: 'use_last_state', warning_counts_as_firing: true,
      });
    });

    it('removes the composite block and type when converted away', () => {
      const doc = applyForm({ alert_type: 'composite', composite_condition: { expression: '{a}' } },
        validForm({ alertType: 'scheduled' }));
      assert.equal('composite_condition' in doc, false);
      assert.equal('alert_type' in doc, false);
      const kept = applyForm({ alert_type: 'scheduled' }, validForm());
      assert.equal(kept.alert_type, 'scheduled', 'a non-composite label is left alone');
    });
  });
});

/* ── validation ─────────────────────────────────────────────────────────── */

describe('validateForm', () => {
  it('accepts the baseline form', () => {
    assert.deepEqual(validateForm(validForm()), {});
  });

  it('requires a name OpenObserve will accept', () => {
    assert.match(validateForm(validForm({ name: ' ' })).name, /required/);
    assert.match(validateForm(validForm({ name: 'has space' })).name, /no spaces/);
  });

  describe('composite', () => {
    const composite = (over) => validForm({
      alertType: 'composite', streamName: '', compositeChildren: ['a', 'b'],
      compositeExpression: '{a} && {b}', ...over,
    });

    it('skips the stream and query checks entirely', () => {
      assert.deepEqual(validateForm(composite()), {});
    });

    it('reports an unfilled child row instead of the expression', () => {
      const errors = validateForm(composite({ compositeChildren: ['a', ''], compositeExpression: '' }));
      assert.match(errors.compositeChildren, /needs an alert selected/);
      assert.equal('compositeExpression' in errors, false);
    });

    it('validates the labelled text when the wizard supplies it', () => {
      const errors = validateForm(composite({ compositeExpressionLabelled: 'A && B ||' }));
      assert.match(errors.compositeExpression, /incomplete/);
    });

    it('still checks cooldown and destinations', () => {
      const errors = validateForm(composite({ silence: '-1', destinations: [] }));
      assert.match(errors.silence, /negative/);
      assert.match(errors.destinations, /notifies nobody/);
    });
  });

  it('requires a stream and the query text of the chosen type', () => {
    const e1 = validateForm(validForm({ streamType: '', streamName: '', queryType: 'sql', sql: ' ' }));
    assert.ok(e1.streamType && e1.streamName && e1.sql);
    const e2 = validateForm(validForm({ queryType: 'promql', promql: '' }));
    assert.match(e2.promql, /PromQL query is required/);
  });

  it('checks the schedule of a scheduled alert only', () => {
    assert.match(validateForm(validForm({ period: '0' })).period, /at least 1 minute/);
    assert.match(validateForm(validForm({ frequency: '0' })).frequency, /at least 1 minute/);
    assert.match(validateForm(validForm({ frequencyType: 'cron', cron: ' ' })).cron, /cron expression/);
    assert.equal('frequency' in validateForm(validForm({ frequencyType: 'cron', cron: '* * * * *', frequency: 0 })), false);
    const rt = validateForm(validForm({ alertType: 'realtime', period: 0, frequency: 0 }));
    assert.equal('period' in rt || 'frequency' in rt, false);
  });

  it('checks "Hold for"', () => {
    assert.match(validateForm(validForm({ toleranceSecs: 'abc' })).toleranceSecs, /number of seconds/);
    assert.match(validateForm(validForm({ toleranceSecs: '-5' })).toleranceSecs, /negative/);
  });

  it('requires a condition in custom mode and a threshold for an aggregation', () => {
    assert.match(validateForm(validForm({ conditions: group('and', []) })).conditions, /at least one condition/);
    assert.match(validateForm(validForm({ aggregationEnabled: true, aggHavingValue: '' })).aggHavingValue,
      /Threshold for the aggregation/);
    assert.equal('conditions' in validateForm(validForm({
      queryType: 'sql', sql: 'SELECT 1', conditions: group('and', []),
    })), false);
  });

  describe('warning tier', () => {
    it('rejects a non-number and an unordered operator', () => {
      assert.match(validateForm(validForm({ warningThreshold: 'x' })).warningThreshold, /must be a number/);
      assert.match(validateForm(validForm({ thresholdOperator: '=', warningThreshold: '1' })).warningThreshold,
        /not allowed with the = operator/);
    });

    it('requires the warning on the safe side of the critical', () => {
      assert.match(validateForm(validForm({ thresholdOperator: '>=', threshold: 3, warningThreshold: '5' }))
        .warningThreshold, /must be lower than critical \(3\)/);
      assert.match(validateForm(validForm({ thresholdOperator: '<=', threshold: 3, warningThreshold: '1' }))
        .warningThreshold, /must be higher than critical \(3\)/);
      assert.equal('warningThreshold' in validateForm(validForm({ threshold: 3, warningThreshold: '2' })), false);
      assert.equal('warningThreshold' in validateForm(validForm({ thresholdOperator: '<', threshold: 3, warningThreshold: '4' })), false);
      assert.equal('warningThreshold' in validateForm(validForm({ threshold: '', warningThreshold: '99' })), false,
        'no critical to compare with');
    });

    it('compares the aggregation warning with the aggregation threshold', () => {
      const errors = validateForm(validForm({
        aggregationEnabled: true, aggHavingValue: '10', aggWarningValue: '20',
        aggHavingOperator: '>', thresholdOperator: '>',
      }));
      assert.match(errors.aggWarningValue, /lower than critical \(10\)/);
    });

    it('compares the PromQL warning with the PromQL value and operator', () => {
      const errors = validateForm(validForm({
        queryType: 'promql', promql: 'up', promqlOperator: '<', promqlValue: '5', promqlWarningValue: '2',
      }));
      assert.match(errors.promqlWarningValue, /higher than critical \(5\) for </);
    });
  });

  it('requires a PromQL comparison value on a scheduled alert', () => {
    assert.match(validateForm(validForm({ queryType: 'promql', promql: 'up', promqlValue: '' })).promqlValue,
      /value to compare/);
  });

  describe('per-group and per-series alerting', () => {
    const perGroup = (over) => validForm({
      aggregationEnabled: true, aggHavingValue: '5', multiAlert: true, aggGroupBy: 'host',
      thresholdOperator: '>=', threshold: 1, ...over,
    });

    it('accepts ">= 1" with a group-by', () => {
      assert.deepEqual(validateForm(perGroup()), {});
    });

    it('needs a group-by and cannot create incidents', () => {
      const errors = validateForm(perGroup({ aggGroupBy: ' , ', createsIncident: true }));
      assert.match(errors.aggGroupBy, /Group By/);
      assert.match(errors.multiAlert, /incident creation/);
    });

    it('needs an ordered operator and a gate of exactly ">= 1"', () => {
      assert.match(validateForm(perGroup({ thresholdOperator: '=' })).thresholdOperator, /ordered comparison/);
      assert.match(validateForm(perGroup({ threshold: 2 })).threshold, /at least 1/);
      assert.match(validateForm(perGroup({ thresholdOperator: '>' })).threshold, /at least 1/);
    });

    it('applies the same gate to a per-series PromQL alert', () => {
      const errors = validateForm(validForm({
        queryType: 'promql', promql: 'up', promqlMultiAlert: true, thresholdOperator: '<',
      }));
      assert.match(errors.threshold, /at least 1/);
    });
  });

  it('allows comparison windows only in SQL mode, each with a positive offset', () => {
    assert.match(validateForm(validForm({ multiWindows: [{ amount: '1', unit: 'h' }] })).multiWindows,
      /only supported in SQL mode/);
    assert.match(validateForm(validForm({
      queryType: 'sql', sql: 'SELECT 1', multiWindows: [{ amount: '0', unit: 'h' }],
    })).multiWindows, /positive offset/);
    assert.equal('multiWindows' in validateForm(validForm({
      queryType: 'sql', sql: 'SELECT 1', multiWindows: [{ amount: '2', unit: 'h' }],
    })), false);
  });

  it('checks the dedup window, tag syntax and half-filled variables', () => {
    assert.match(validateForm(validForm({ dedupWindow: '-1' })).dedupWindow, /non-negative/);
    assert.match(validateForm(validForm({ dedupWindow: 'x' })).dedupWindow, /non-negative/);
    assert.equal('dedupWindow' in validateForm(validForm({ dedupWindow: '0' })), false);
    assert.match(validateForm(validForm({ tags: ['ok', '9lives'] })).tags, /“9lives” is not a valid tag/);
    assert.equal('tags' in validateForm(validForm({ tags: ['Team:Ops'] })), false, 'checked after lower-casing');
    assert.match(validateForm(validForm({ variables: [{ name: 'a', value: '' }] })).variables, /both a name and a value/);
    assert.equal('variables' in validateForm(validForm({ variables: [{ name: '', value: '' }] })), false);
  });
});

/* ── display helpers ────────────────────────────────────────────────────── */

describe('display helpers', () => {
  it('formats minutes', () => {
    assert.deepEqual([null, undefined, '', 'x', 1, '10'].map(formatMinutes),
      ['—', '—', '—', '—', '1 min', '10 mins']);
  });

  it('formats the "Check every" column', () => {
    assert.equal(formatFrequency(null), '—');
    assert.equal(formatFrequency({ frequencyType: 'cron', cron: '*/5 * * * *' }), 'cron: */5 * * * *');
    assert.equal(formatFrequency({ frequencyType: 'cron' }), 'cron');
    assert.equal(formatFrequency({ frequencyType: 'minutes', frequency: 5 }), '5 mins');
  });

  it('formats timestamps, with a dash for never or junk', () => {
    assert.equal(formatTimestamp(null), '—');
    assert.equal(formatTimestamp('not a date'), '—');
    const iso = '2026-01-02T03:04:05Z';
    assert.equal(formatTimestamp(iso), new Date(iso).toLocaleString());
  });

  it('labels alert types, including the anomaly type', () => {
    assert.deepEqual(['realtime', 'scheduled', 'anomaly_detection', 'custom', ''].map(alertTypeLabel),
      ['Realtime', 'Scheduled', 'Anomaly', 'custom', '—']);
  });

  it('knows which field holds the warning tier', () => {
    assert.equal(warningField({ alertType: 'realtime', queryType: 'promql' }), null);
    assert.equal(warningField({ alertType: 'scheduled', queryType: 'promql' }), 'promql');
    assert.equal(warningField({ alertType: 'scheduled', queryType: 'custom', aggregationEnabled: true }), 'aggregation');
    assert.equal(warningField({ alertType: 'scheduled', queryType: 'sql', aggregationEnabled: true }), 'trigger');
  });

  it('splits the threshold into measure, operator and value per mode', () => {
    assert.deepEqual(thresholdParts({ queryType: 'promql', promqlOperator: '>', promqlValue: '' }),
      { measure: 'value', operator: '>', value: '—' });
    assert.deepEqual(thresholdParts({
      queryType: 'custom', aggregationEnabled: true, aggFunction: 'count', aggColumn: '',
      aggHavingOperator: '>=', aggHavingValue: 0,
    }), { measure: 'count(*)', operator: '>=', value: '0' });
    assert.deepEqual(thresholdParts({
      queryType: 'custom', aggregationEnabled: true, aggFunction: 'avg', aggColumn: 'cpu',
      aggHavingOperator: '>', aggHavingValue: null,
    }), { measure: 'avg(cpu)', operator: '>', value: '—' });
    assert.deepEqual(thresholdParts({ queryType: 'sql', thresholdOperator: '<', threshold: 4 }),
      { measure: 'query result', operator: '<', value: '4' });
    assert.deepEqual(thresholdParts({ queryType: 'custom', thresholdOperator: '>=', threshold: undefined }),
      { measure: 'events', operator: '>=', value: '—' });
  });
});
