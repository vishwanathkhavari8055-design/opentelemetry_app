import React, { useState } from 'react';
import PropTypes from 'prop-types';
import {
  CONDITION_OPERATORS, isValuelessOperator, moveNode, newCondition, newGroup,
  removeNode, updateNode,
} from './alertModel';
import SearchableSelect from '../common/SearchableSelect';

/**
 * The Conditions editor: a recursive and/or tree over stream columns.
 *
 * Mirrors how OpenObserve actually stores conditions — a group is joined by ONE
 * operator, either all-AND or all-OR, and its entries are conditions or further
 * groups. That is why the joiner is a property of the group rather than of each
 * row: rendering a per-row and/or picker would imply `a AND b OR c` is
 * expressible at one level, which it is not, and the user would have no way to
 * see how it had actually been grouped. Clicking any joiner flips the whole
 * group and every joiner in it changes together, which makes the real semantics
 * visible.
 *
 * The tree is edited immutably through the helpers in alertModel so React sees
 * each change; see `updateNode` there for why.
 *
 * `columns` is the stream's schema when it is known. When it is empty — a stream
 * that has not been written to yet has no schema — the column control falls back
 * to free text rather than presenting an empty dropdown the user cannot get past.
 *
 * `operators` lets a caller offer a wider set than the eight comparisons this
 * defaults to — the wizard offers OpenObserve's presence tests as well. It is a
 * prop rather than a constant here because the two screens write into the same
 * store: an operator one of them offers has to be one the OTHER can still open,
 * which is why the value box below keys off the operator's own semantics rather
 * than off which list it came from.
 */
export default function ConditionBuilder({
  tree, columns, onChange, disabled, operators, collapsible,
}) {
  const hasSchema = Array.isArray(columns) && columns.length > 0;
  const operatorList = operators?.length ? operators : CONDITION_OPERATORS;

  /* Reorder is a MODE rather than always-visible arrows.
   *
   * A condition row is already six controls wide, and a pair of arrows on every
   * row of a rule nobody is reordering is six more things to look past. The
   * reference UI makes the same call — a "Reorder" action rather than permanent
   * handles. */
  const [reorder, setReorder] = useState(false);

  /* Collapsing the filter block. Open by default: conditions ARE the alert, and
     a rule that starts folded away hides the thing the screen is for. */
  const [open, setOpen] = useState(true);

  const setTree = (next) => onChange(next);

  const patch = (key, fields) =>
    setTree(updateNode(tree, key, (node) => ({ ...node, ...fields })));

  const addTo = (groupKey, factory) =>
    setTree(updateNode(tree, groupKey, (group) => ({
      ...group,
      items: [...group.items, factory()],
    })));

  const remove = (key) => setTree(removeNode(tree, key));

  const flipJoin = (groupKey) =>
    setTree(updateNode(tree, groupKey, (group) => ({
      ...group,
      join: group.join === 'and' ? 'or' : 'and',
    })));

  const move = (groupKey, index, delta) =>
    setTree(moveNode(tree, groupKey, index, delta));

  /** Up/down arrows, shown per row only while reorder mode is on. */
  const renderMove = (group, index) => (reorder ? (
    <span className="cb-move">
      <button
        type="button" className="cb-move-btn"
        disabled={disabled || index === 0}
        title="Move up" aria-label="Move condition up"
        onClick={() => move(group.key, index, -1)}
      >↑</button>
      <button
        type="button" className="cb-move-btn"
        disabled={disabled || index === group.items.length - 1}
        title="Move down" aria-label="Move condition down"
        onClick={() => move(group.key, index, 1)}
      >↓</button>
    </span>
  ) : null);

  /** One leaf row: column, operator, value, ignore-case, remove. */
  const renderCondition = (node, group, index) => (
    <div className="cb-item" key={node.key}>
      {/* First row has nothing to join to, so its slot is inert — kept rather
          than omitted so every row's controls stay in the same columns. */}
      {index === 0 ? (
        <span className="cb-join cb-join--static" aria-hidden="true">if</span>
      ) : (
        <button
          type="button"
          className="cb-join"
          onClick={() => flipJoin(group.key)}
          disabled={disabled}
          title={`Joined with ${group.join.toUpperCase()} — click to switch the whole group`}
        >{group.join}</button>
      )}

      {hasSchema ? (
        /* Searchable, because a stream's schema is routinely 100+ fields and a
           native select can only be scrolled. A column the schema no longer
           reports stays selected and flagged rather than being blanked — see
           SearchableSelect's note on why that matters for a live alert. */
        <SearchableSelect
          className="ssel--col"
          options={columns}
          value={node.column}
          onChange={(v) => patch(node.key, { column: v })}
          disabled={disabled}
          placeholder="Select field…"
          searchPlaceholder="Search fields…"
          missingSuffix="(not in schema)"
          ariaLabel="Column"
        />
      ) : (
        <input
          type="text"
          className="ae-input cb-col"
          value={node.column}
          disabled={disabled}
          placeholder="Field name"
          aria-label="Column"
          onChange={(e) => patch(node.key, { column: e.target.value })}
        />
      )}

      <select
        className="ae-select cb-op"
        value={node.operator}
        disabled={disabled}
        aria-label="Operator"
        onChange={(e) => patch(node.key, { operator: e.target.value })}
      >
        {operatorList.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* A presence test compares the column against nothing, so the box that
          asks what to compare it to is absent rather than disabled. The stored
          value is deliberately NOT cleared when one is selected: switching to
          "Is Null" and back is a thing people do while reading a rule, and
          losing the typed value to that is worse than carrying a value the wire
          format ignores. */}
      {isValuelessOperator(node.operator) ? (
        <span className="cb-val cb-val--none" aria-hidden="true">—</span>
      ) : (
        <input
          type="text"
          className="ae-input cb-val"
          value={node.value}
          disabled={disabled}
          placeholder="Value"
          aria-label="Value"
          onChange={(e) => patch(node.key, { value: e.target.value })}
        />
      )}

      {/* Case-insensitivity only means anything for text comparisons. */}
      {['=', '!=', 'contains', 'not_contains'].includes(node.operator) && (
        <button
          type="button"
          className={`tb-switch cb-case ${node.ignoreCase ? 'is-on' : ''}`}
          onClick={() => patch(node.key, { ignoreCase: !node.ignoreCase })}
          disabled={disabled}
          aria-pressed={node.ignoreCase}
          title="Ignore case when comparing"
        >
          <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
          <span>Aa</span>
        </button>
      )}

      {renderMove(group, index)}

      <button
        type="button"
        className="cb-x"
        onClick={() => remove(node.key)}
        disabled={disabled}
        title="Remove condition"
        aria-label="Remove condition"
      >×</button>
    </div>
  );

  /** A group: its rows, nested groups, and its own add controls. */
  const renderGroup = (group, isRoot) => (
    <fieldset
      className={`cb-group native-el ${isRoot ? '' : 'cb-group--nested'}`}
      key={group.key}
      aria-label={isRoot ? 'Conditions' : 'Condition group'}
    >
      <div className="cb-items">
        {group.items.length === 0 && (
          <div className="cb-empty">
            No conditions yet — the alert would match every row.
          </div>
        )}
        {group.items.map((node, index) => (
          node.kind === 'group'
            ? (
              <div className="cb-item" key={node.key} style={{ alignItems: 'flex-start' }}>
                {index === 0 ? (
                  <span className="cb-join cb-join--static" aria-hidden="true">if</span>
                ) : (
                  <button
                    type="button"
                    className="cb-join"
                    onClick={() => flipJoin(group.key)}
                    disabled={disabled}
                    title={`Joined with ${group.join.toUpperCase()} — click to switch the whole group`}
                  >{group.join}</button>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>{renderGroup(node, false)}</div>
                {renderMove(group, index)}
                <button
                  type="button"
                  className="cb-x"
                  onClick={() => remove(node.key)}
                  disabled={disabled}
                  title="Remove group"
                  aria-label="Remove condition group"
                >×</button>
              </div>
            )
            : renderCondition(node, group, index)
        ))}
      </div>

      <div className="cb-toolbar">
        <button
          type="button" className="cb-add" disabled={disabled}
          onClick={() => addTo(group.key, newCondition)}
        >⊕ Condition</button>
        <button
          type="button" className="cb-add" disabled={disabled}
          onClick={() => addTo(group.key, newGroup)}
        >⊕ Condition Group</button>
        {group.items.length > 1 && (
          <button
            type="button" className="cb-add" disabled={disabled}
            onClick={() => flipJoin(group.key)}
            title="Switch this group between AND and OR"
          >⇄ Match {group.join === 'and' ? 'ALL' : 'ANY'}</button>
        )}
        {/* Only on the root toolbar, and only once there is something to
            reorder — a nested group gets its arrows from its parent's row. */}
        {isRoot && group.items.length > 1 && (
          <button
            type="button"
            className={`cb-add ${reorder ? 'is-on' : ''}`}
            disabled={disabled}
            onClick={() => setReorder((r) => !r)}
            title="Show arrows for moving conditions up and down"
            aria-pressed={reorder}
          >⇅ {reorder ? 'Done' : 'Reorder'}</button>
        )}
      </div>
    </fieldset>
  );

  if (!tree) return null;

  // A caller that draws its own "filters" control owns the collapse, and the
  // header below is simply absent rather than rendered and ignored: two toggles
  // for one block is a reader wondering which of them the alert obeys.
  const showing = open || !collapsible;

  return (
    <div className="cb-wrap">
      {/* The reference labels the condition block "filters" and makes the label
          the collapse control. Kept as a real toggle rather than a decorative
          heading: a SQL or PromQL alert has no conditions at all, and on a long
          custom rule this is the only way to get the Settings below it on
          screen without scrolling past every row. */}
      {collapsible && (
        <button
          type="button"
          className={`cb-filters ${open ? 'is-open' : ''}`}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="cb-filters-icon" aria-hidden="true">▽</span>
          <span>filters</span>
          <span className="cb-filters-caret" aria-hidden="true">⌄</span>
        </button>
      )}

      {showing
        ? renderGroup(tree, true)
        : (
          <div className="cb-collapsed">
            {/* Count rather than nothing: a collapsed block that says only
                "filters" gives no clue whether the rule is empty. */}
            {tree.items.length} condition{tree.items.length === 1 ? '' : 's'} hidden —
            {' '}click <strong>filters</strong> to show them.
          </div>
        )}
    </div>
  );
}

ConditionBuilder.propTypes = {
  /** Root group of the condition tree, as produced by parseConditions. */
  tree: PropTypes.object,
  /** Stream schema field names; empty falls back to free-text columns. */
  columns: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
  /** Operator choices; defaults to CONDITION_OPERATORS. */
  operators: PropTypes.arrayOf(PropTypes.shape({
    value: PropTypes.string, label: PropTypes.string,
  })),
  /** Draw the "filters" collapse header. Off when the caller draws its own. */
  collapsible: PropTypes.bool,
};

ConditionBuilder.defaultProps = {
  collapsible: true,
};
