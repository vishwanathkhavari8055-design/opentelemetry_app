/**
 * ConditionBuilder edits an alert's and/or condition tree, the part of a rule
 * that decides what matches. Guarded here, through the controls a user drives:
 * adding rows and nested groups, editing column/operator/value, the group-wide
 * AND/OR joiner (one joiner per group, because that is how OpenObserve stores
 * it), presence operators hiding the value box, ignore-case only on text
 * comparisons, reorder mode, removal, free-text columns without a schema, and
 * the collapsible "filters" header.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { useState } = React;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const { default: ConditionBuilder } = await import('../../../src/components/alerts/ConditionBuilder.jsx');
const { FILTER_OPERATORS } = await import('../../../src/components/alerts/alertModel.js');

const cond = (key, fields = {}) => ({
  key, kind: 'condition', column: '', operator: '=', value: '', ignoreCase: false, ...fields,
});
const group = (key, items, join = 'and') => ({ key, kind: 'group', join, items });

/** Keeps the tree in state like the editor does; `trees` records every change. */
const renderBuilder = (initial, props = {}) => {
  const trees = [];
  function Harness() {
    const [tree, setTree] = useState(initial);
    return React.createElement(ConditionBuilder, {
      tree, onChange: (t) => { trees.push(t); setTree(t); }, ...props,
    });
  }
  const utils = render(React.createElement(Harness));
  return { ...utils, trees, last: () => trees[trees.length - 1] };
};

describe('ConditionBuilder', () => {
  afterEach(cleanup);

  it('renders nothing without a tree', () => {
    const { container } = render(React.createElement(ConditionBuilder, { tree: null, onChange: () => {} }));
    assert.equal(container.innerHTML, '');
  });

  it('says an empty group matches every row, and adds a condition and a nested group', () => {
    const { last } = renderBuilder(group('root', []));
    assert.ok(screen.getByText(/No conditions yet/));
    fireEvent.click(screen.getByRole('button', { name: '⊕ Condition' }));
    assert.equal(last().items.length, 1);
    assert.equal(last().items[0].kind, 'condition');
    fireEvent.click(screen.getAllByRole('button', { name: '⊕ Condition Group' })[0]);
    assert.equal(last().items[1].kind, 'group');
    assert.equal(last().items[1].items.length, 1, 'a new group is seeded with one row');
    assert.ok(screen.getByRole('group', { name: 'Condition group' }));
  });

  it('edits a free-text column, operator and value when there is no schema', () => {
    const { last } = renderBuilder(group('root', [cond('c1')]));
    fireEvent.change(screen.getByLabelText('Column'), { target: { value: 'status' } });
    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: '>=' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '500' } });
    assert.deepEqual(
      { column: last().items[0].column, operator: last().items[0].operator, value: last().items[0].value },
      { column: 'status', operator: '>=', value: '500' },
    );
    assert.equal(screen.queryByTitle('Ignore case when comparing'), null,
      'ignore-case is only offered for text comparisons');
  });

  it('picks a column from the schema through the searchable select', () => {
    const { last } = renderBuilder(group('root', [cond('c1')]), { columns: ['level', 'service_name'] });
    fireEvent.click(screen.getByRole('button', { name: 'Column' }));
    fireEvent.click(screen.getByRole('option', { name: /service_name/ }));
    assert.equal(last().items[0].column, 'service_name');
  });

  it('toggles ignore-case on a text comparison', () => {
    const { last } = renderBuilder(group('root', [cond('c1', { operator: 'contains' })]));
    const aa = screen.getByTitle('Ignore case when comparing');
    assert.equal(aa.getAttribute('aria-pressed'), 'false');
    fireEvent.click(aa);
    assert.equal(last().items[0].ignoreCase, true);
    assert.equal(screen.getByTitle('Ignore case when comparing').getAttribute('aria-pressed'), 'true');
  });

  it('hides the value box for a presence operator but keeps the typed value', () => {
    const valueless = FILTER_OPERATORS.find((o) => !['=', '!=', '>', '>=', '<', '<=', 'contains', 'not_contains'].includes(o.value));
    assert.ok(valueless, 'the wizard list has a presence operator');
    const { last } = renderBuilder(group('root', [cond('c1', { value: 'kept' })]), { operators: FILTER_OPERATORS });
    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: valueless.value } });
    assert.equal(screen.queryByLabelText('Value'), null);
    assert.equal(last().items[0].value, 'kept');
  });

  it('flips the whole group between AND and OR from a joiner or the Match button', () => {
    const { last } = renderBuilder(group('root', [cond('a'), cond('b'), cond('c')]));
    const joiners = screen.getAllByTitle(/Joined with AND/);
    assert.equal(joiners.length, 2, 'every row but the first has a joiner');
    fireEvent.click(joiners[1]);
    assert.equal(last().join, 'or');
    assert.equal(screen.getAllByTitle(/Joined with OR/).length, 2, 'all joiners change together');
    fireEvent.click(screen.getByRole('button', { name: '⇄ Match ANY' }));
    assert.equal(last().join, 'and');
    assert.ok(screen.getByRole('button', { name: '⇄ Match ALL' }));
  });

  it('reorders rows only in reorder mode, with the ends disabled', () => {
    const { last } = renderBuilder(group('root', [cond('a', { column: 'first' }), cond('b', { column: 'second' })]));
    assert.equal(screen.queryByLabelText('Move condition up'), null);
    fireEvent.click(screen.getByRole('button', { name: '⇅ Reorder' }));
    const ups = screen.getAllByLabelText('Move condition up');
    const downs = screen.getAllByLabelText('Move condition down');
    assert.equal(ups[0].disabled, true);
    assert.equal(downs[1].disabled, true);
    fireEvent.click(downs[0]);
    assert.deepEqual(last().items.map((n) => n.column), ['second', 'first']);
    fireEvent.click(screen.getAllByLabelText('Move condition up')[1]);
    assert.deepEqual(last().items.map((n) => n.column), ['first', 'second']);
    fireEvent.click(screen.getByRole('button', { name: '⇅ Done' }));
    assert.equal(screen.queryByLabelText('Move condition up'), null);
  });

  it('removes a condition and a nested group, and flips a nested group’s parent joiner', () => {
    const tree = group('root', [cond('a'), group('g', [cond('n1'), cond('n2')])]);
    const { last } = renderBuilder(tree);
    const nested = screen.getByRole('group', { name: 'Condition group' });
    // The joiner in front of the nested group belongs to the ROOT group.
    const rootJoiners = screen.getAllByTitle(/Joined with AND/)
      .filter((b) => !nested.contains(b));
    fireEvent.click(rootJoiners[0]);
    assert.equal(last().join, 'or');
    assert.equal(last().items[1].join, 'and', 'the nested group keeps its own joiner');

    fireEvent.click(within(nested).getAllByRole('button', { name: 'Remove condition' })[0]);
    assert.equal(last().items[1].items.length, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove condition group' }));
    assert.equal(last().items.length, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove condition' }));
    assert.equal(last().items.length, 0);
  });

  it('collapses behind the filters header and reports how many rows are hidden', () => {
    renderBuilder(group('root', [cond('a'), cond('b')]));
    const header = screen.getByRole('button', { name: /filters/ });
    assert.equal(header.getAttribute('aria-expanded'), 'true');
    fireEvent.click(header);
    assert.match(screen.getByText(/conditions hidden/).textContent, /2 conditions hidden/);
    assert.equal(screen.queryByLabelText('Column'), null);
    fireEvent.click(header);
    assert.equal(screen.getAllByLabelText('Column').length, 2);
  });

  it('draws no header when the caller owns the collapse, and disables every control', () => {
    renderBuilder(group('root', [cond('a'), cond('b', { operator: '!=' })]), { collapsible: false, disabled: true });
    assert.equal(screen.queryByRole('button', { name: /filters/ }), null);
    for (const b of screen.getAllByRole('button')) assert.equal(b.disabled, true, b.textContent);
    for (const i of screen.getAllByRole('textbox')) assert.equal(i.disabled, true);
  });
});
