import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import SearchableSelect from '../../common/SearchableSelect';
import { fetchAlerts, validateCompositeExpression } from '../../../services/api';
import {
  COMPOSITE_MAX_CHILDREN, COMPOSITE_MIN_CHILDREN, STALE_CHILD_POLICIES,
  childLabel, expressionToIds, expressionToLabels,
} from '../alertModel';

/**
 * Step 2, when the alert type is Composite.
 *
 *   Sub-alerts *                                   2 of 10 children
 *     [+ Add alert]
 *     A  [checkout_latency_high  ⌄]  Scheduled  ● firing   ×
 *     B  [checkout_errors_high   ⌄]  Scheduled  ● normal   ×
 *
 *   Trigger expression *
 *     ⓘ A composite combines the CURRENT STATES of existing alerts …
 *     [ A && B                                                      ]
 *     Insert:  AND  OR  NOT  (  )
 *     ✓ would not fire right now — A && B → false
 *
 *   Settings
 *     [on] Warning counts as firing
 *     Stale-child policy  [Use last state ⌄]
 *
 * A composite is a different KIND of alert, not a variation on the other two: it
 * has no stream, no query, no window and no cadence, because it never looks at
 * telemetry at all. It reads the current states of alerts that already exist and
 * combines them with boolean logic. That is why this is a separate component
 * rather than more branches inside ConditionsStep — almost nothing on that
 * screen applies here, and the half of it that does would have to be hidden row
 * by row.
 *
 * ─── Letters are the UI, ids are the wire ───────────────────────────────────
 *
 * OpenObserve stores the expression over alert ids in braces:
 *
 *   {3J7xjrR4FBY25cvd1QbaK5ff2kl} && {3J7x1GEsDd0VHpGI36N80pr5qdz}
 *
 * which is unreadable and unwritable by hand. The box below holds the letter
 * form and the two are converted at the edges — see alertModel's
 * `expressionToLabels` / `expressionToIds`. The letter of a child is its
 * POSITION in the sub-alert list, so reordering or removing a row rewrites the
 * expression to match, and the two can never drift apart.
 *
 * ─── Validation is asked, not assumed ───────────────────────────────────────
 *
 * Local checks cover the mistakes that are local: brackets, operators, a child
 * that is listed but never used. Everything else — does this alert exist, may
 * this user read it, is it ELIGIBLE to be composed, would this composite close a
 * cycle in the reference graph — is knowledge only the server has, so the
 * expression is sent to it (debounced) and its answer is shown verbatim. That
 * same answer carries each child's current state, which is what makes the
 * preview line real rather than a guess.
 */

const IconPlus = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const IconInfo = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" />
  </svg>
);

/** Operator buttons, in the order the reference lists them. */
const INSERTS = [
  { token: '&&', label: 'AND', title: 'Both sides must be firing' },
  { token: '||', label: 'OR', title: 'Either side firing is enough' },
  { token: '!', label: 'NOT', title: 'Inverts the next term' },
  { token: '(', label: '(', title: 'Open a group' },
  { token: ')', label: ')', title: 'Close a group' },
];

/** How long to sit still before asking the server about an expression. */
const VALIDATE_DEBOUNCE_MS = 500;

/** A child's live state, as one short word. */
const stateWord = (child) => {
  if (!child) return 'unknown';
  if (child.accessible === false) return 'no access';
  if (child.enabled === false) return 'disabled';
  if (child.stale) return 'stale';
  if (child.level) return child.level;
  if (child.truth === true) return 'firing';
  if (child.truth === false) return 'normal';
  return 'no data';
};

/** Severity class for the state pill, so the colour carries the same meaning. */
const stateTone = (child) => {
  if (!child) return 'unknown';
  if (child.accessible === false || child.enabled === false) return 'bad';
  if (child.stale) return 'warn';
  if (child.level === 'critical') return 'bad';
  if (child.level === 'warning') return 'warn';
  if (child.truth === true) return 'bad';
  if (child.truth === false) return 'ok';
  return 'unknown';
};

export default function CompositeStep({ form, set, errors, showErr, compositeId }) {
  /** Every alert that could be a child. Fetched once; the list is a picker. */
  const [alerts, setAlerts] = useState([]);
  const [alertsError, setAlertsError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    // Across every folder: a composite may combine alerts that do not live
    // together, and the wizard has no folder context of its own to narrow by.
    fetchAlerts({ pageSize: 1000, signal: controller.signal })
      .then((res) => setAlerts(res.items || []))
      .catch((err) => {
        if (err.name !== 'AbortError') setAlertsError(err.message || 'Could not list alerts.');
      });
    return () => controller.abort();
  }, []);

  const byId = useMemo(() => {
    const map = new Map();
    alerts.forEach((a) => { if (a.alertId) map.set(a.alertId, a); });
    return map;
  }, [alerts]);

  /**
   * The child rows.
   *
   * <p>Held on the form rather than here so paging back to step 1 and forward
   * again does not empty the list. A row with an empty id is a slot the user has
   * added and not yet filled — kept, because removing it the moment it appears
   * would make "Add alert" look broken.</p>
   */
  const children = form.compositeChildren || [];

  /** The expression in its readable form. Stored as ids; edited as letters. */
  const labelled = form.compositeExpressionLabelled
    ?? expressionToLabels(form.compositeExpression, children);

  const exprRef = useRef(null);

  /**
   * Write both forms at once.
   *
   * <p>The labelled form is kept on the form too, not derived on every render.
   * Deriving it would round-trip the text through the id mapping on every
   * keystroke, and a letter the user has typed but not yet given a child would
   * vanish under the caret as they typed it.</p>
   */
  const setExpression = (nextLabelled, nextChildren = children) => set({
    compositeExpressionLabelled: nextLabelled,
    compositeExpression: expressionToIds(nextLabelled, nextChildren),
  });

  const setChildren = (nextChildren, nextLabelled = labelled) => set({
    compositeChildren: nextChildren,
    compositeExpressionLabelled: nextLabelled,
    compositeExpression: expressionToIds(nextLabelled, nextChildren),
  });

  const addChild = () => {
    if (children.length >= COMPOSITE_MAX_CHILDREN) return;
    const next = [...children, ''];
    /* Seeded, not left blank. Two children joined by AND is what a composite
       almost always is, and the reference fills the expression in the same way
       — an empty required box under a list the user has just populated is a
       step they have to work out for themselves. Only ever EXTENDED, never
       rewritten, so an expression the user has edited is left alone. */
    const letter = childLabel(next.length - 1);
    const grown = labelled.trim()
      ? `${labelled.trim()} && ${letter}`
      : letter;
    setChildren(next, next.length === 1 ? letter : grown);
  };

  const setChildAt = (index, alertId) => {
    const next = [...children];
    next[index] = alertId;
    setChildren(next);
  };

  /**
   * Remove a row, and rewrite the expression around it.
   *
   * <p>Every letter after the removed one shifts down, so the text has to be
   * rewritten or it would silently point at the wrong alerts — the single most
   * damaging thing this screen could do, because the result is a valid
   * expression that watches something nobody asked for. The removed letter's
   * own term is dropped along with any operator holding it on.</p>
   */
  const removeChildAt = (index) => {
    const gone = childLabel(index);
    const next = children.filter((_, i) => i !== index);

    let text = labelled
      // "A && B" → "A" when B goes; also handles a leading operator.
      .replaceAll(new RegExp(String.raw`\s*(&&|\|\|)\s*!?\s*\b${gone}\b`, 'g'), '')
      .replaceAll(new RegExp(String.raw`\b!?\s*${gone}\b\s*(&&|\|\|)\s*`, 'g'), '')
      .replaceAll(new RegExp(String.raw`\b!?\s*${gone}\b`, 'g'), '');

    // Re-letter everything above the hole.
    for (let i = index + 1; i < children.length; i += 1) {
      text = text.replace(new RegExp(String.raw`\b${childLabel(i)}\b`, 'g'), childLabel(i - 1));
    }
    text = text.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();

    setChildren(next, text);
  };

  /** Insert an operator at the caret, which is where the user is looking. */
  const insert = (token) => {
    const el = exprRef.current;
    const at = el ? el.selectionStart : labelled.length;
    const end = el ? el.selectionEnd : labelled.length;
    const before = labelled.slice(0, at);
    const after = labelled.slice(end);
    const pad = /[&|(!\s]$/.test(before) || !before ? '' : ' ';
    const next = `${before}${pad}${token} ${after}`.replace(/\s{2,}/g, ' ');
    setExpression(next);
    // Put the caret back after the token rather than at the end, or inserting
    // a bracket would throw the user to the end of the line every time.
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = (before + pad + token + ' ').length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  /* ── server-side validation, debounced ─────────────────────────────────── */

  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  const wire = form.compositeExpression || '';
  const filledChildren = children.filter(Boolean).length;

  useEffect(() => {
    // Nothing worth asking about until the expression is locally complete.
    if (!wire.trim() || filledChildren < COMPOSITE_MIN_CHILDREN || showErr('compositeExpression')) {
      setCheck(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setChecking(true);
      validateCompositeExpression({
        expression: wire,
        staleChildPolicy: form.staleChildPolicy,
        warningCountsAsFiring: form.warningCountsAsFiring,
        compositeId,
        signal: controller.signal,
      })
        .then((res) => setCheck(res))
        .catch((err) => { if (err.name !== 'AbortError') setCheck(null); })
        .finally(() => setChecking(false));
    }, VALIDATE_DEBOUNCE_MS);

    return () => { clearTimeout(timer); controller.abort(); };
    // `showErr` is deliberately not a dependency — it is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wire, filledChildren, form.staleChildPolicy, form.warningCountsAsFiring, compositeId]);

  const checkedChild = (alertId) => (check?.children || []).find((c) => c.alertId === alertId);

  const policy = STALE_CHILD_POLICIES.find((p) => p.value === form.staleChildPolicy)
    || STALE_CHILD_POLICIES[0];

  /** Alert options for a row: every alert, minus the ones already chosen. */
  const optionsFor = (index) => alerts
    .filter((a) => a.alertId && (a.alertId === children[index] || !children.includes(a.alertId)))
    .map((a) => ({
      value: a.alertId,
      label: a.folderName ? `${a.name} — ${a.folderName}` : a.name,
    }));

  return (
    <div className="aw-cond aw-comp">
      {/* ── Sub-alerts ───────────────────────────────────────────────────── */}
      <div className="aw-comp-head">
        <span className="aw-comp-title">Sub-alerts <span className="ae-req">*</span></span>
        <span className="aw-comp-count">
          {children.length} of {COMPOSITE_MAX_CHILDREN} children
        </span>
      </div>

      <div className="aw-comp-add-row">
        <button
          type="button"
          className="aw-cond-add"
          onClick={addChild}
          disabled={children.length >= COMPOSITE_MAX_CHILDREN}
          title={children.length >= COMPOSITE_MAX_CHILDREN
            ? `A composite takes at most ${COMPOSITE_MAX_CHILDREN} sub-alerts`
            : undefined}
        ><IconPlus /> Add alert</button>
        {alertsError && <span className="ae-error">{alertsError}</span>}
      </div>

      {children.length === 0 ? (
        <div className="aw-comp-empty">
          No sub-alerts yet. Add at least {COMPOSITE_MIN_CHILDREN} — a composite watches
          other alerts, not a stream.
        </div>
      ) : (
        <div className="aw-comp-list">
          {children.map((alertId, index) => {
            const live = checkedChild(alertId);
            const known = byId.get(alertId);
            return (
              <div className="aw-comp-row" key={childLabel(index)}>
                <span className="aw-comp-letter" aria-hidden="true">{childLabel(index)}</span>
                <SearchableSelect
                  className="ssel--grow"
                  options={optionsFor(index)}
                  value={alertId}
                  onChange={(v) => setChildAt(index, v)}
                  placeholder="Select an alert…"
                  searchPlaceholder="Search alerts…"
                  emptyLabel="No other alerts to combine."
                  missingSuffix="(not found)"
                  ariaLabel={`Sub-alert ${childLabel(index)}`}
                />
                {known?.alertType && (
                  <span className="aw-comp-tag">{known.alertType}</span>
                )}
                {live && (
                  <span
                    className={`aw-comp-state is-${stateTone(live)}`}
                    title={live.stale ? 'This child has not evaluated inside its freshness deadline.' : undefined}
                  >
                    <span className="aw-comp-dot" aria-hidden="true">●</span>
                    {stateWord(live)}
                  </span>
                )}
                <button
                  type="button"
                  className="cb-x"
                  onClick={() => removeChildAt(index)}
                  title="Remove this sub-alert"
                  aria-label={`Remove sub-alert ${childLabel(index)}`}
                >×</button>
              </div>
            );
          })}
        </div>
      )}
      {showErr('compositeChildren') && (
        <div className="ae-error">{errors.compositeChildren}</div>
      )}

      <div className="aw-cond-rule" />

      {/* ── Trigger expression ───────────────────────────────────────────── */}
      <div className="aw-comp-head">
        <span className="aw-comp-title">Trigger expression <span className="ae-req">*</span></span>
      </div>

      <div className="aw-comp-note">
        <IconInfo />
        <span>
          A composite alert combines the current states of existing alerts with boolean
          logic. It runs its own notification and cooldown settings and never re-queries
          the underlying data.
        </span>
      </div>

      <input
        ref={exprRef}
        type="text"
        className="ae-input aw-comp-expr"
        value={labelled}
        placeholder="e.g. A && (B || C)"
        aria-label="Trigger expression"
        onChange={(e) => setExpression(e.target.value)}
      />

      <div className="aw-comp-inserts">
        <span className="aw-cond-of">Insert:</span>
        {INSERTS.map((op) => (
          <button
            key={op.label}
            type="button"
            className="aw-comp-op"
            title={op.title}
            onClick={() => insert(op.token)}
          >{op.label}</button>
        ))}
      </div>

      {showErr('compositeExpression') && (
        <div className="ae-error">{errors.compositeExpression}</div>
      )}

      {/* ── What it evaluates to right now ───────────────────────────────── */}
      {!showErr('compositeExpression') && (
        <div className="aw-comp-preview">
          {checking && <span className="ae-hint">Checking the expression…</span>}

          {!checking && check?.supported && check.valid && (
            <>
              <span className={`aw-comp-verdict is-${check.result ? 'bad' : 'ok'}`}>
                {check.result ? 'Would fire right now' : 'Would not fire right now'}
              </span>
              {/* The per-child truth table. An expression over four alerts that
                  says "false" tells you nothing on its own; this says which of
                  them is the reason. */}
              <span className="aw-comp-steps">
                {(check.children || []).map((c) => {
                  const at = children.indexOf(c.alertId);
                  return (
                    <span className="aw-comp-step" key={c.alertId}>
                      <b>{at >= 0 ? childLabel(at) : '?'}</b>
                      <span className={`aw-comp-state is-${stateTone(c)}`}>{stateWord(c)}</span>
                      <span className="aw-comp-arrow" aria-hidden="true">→</span>
                      <code>{String(c.truth)}</code>
                    </span>
                  );
                })}
              </span>
              {(check.warnings || []).map((w) => (
                <span className="ae-hint aw-comp-warn" key={w}>{w}</span>
              ))}
            </>
          )}

          {!checking && check?.supported && !check.valid && (
            <span className="ae-error">
              {check.message || 'OpenObserve rejected this expression.'}
            </span>
          )}

          {/* Not an error: the expression may be fine and we could not ask.
              Saying so beats a silent blank where a verdict should be. */}
          {!checking && check && !check.supported && (
            <span className="ae-hint">
              Could not check the expression against OpenObserve — it will be validated
              on save.
            </span>
          )}
        </div>
      )}

      <div className="aw-cond-rule" />

      {/* ── Composite-only settings ──────────────────────────────────────── */}
      <div className="aw-cond-row">
        <span className="aw-cond-label">Warning counts as firing</span>
        <button
          type="button"
          className={`tb-switch ${form.warningCountsAsFiring !== false ? 'is-on' : ''}`}
          onClick={() => set({ warningCountsAsFiring: form.warningCountsAsFiring === false })}
          aria-pressed={form.warningCountsAsFiring !== false}
        >
          <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
          <span>{form.warningCountsAsFiring !== false ? 'Yes' : 'Critical only'}</span>
        </button>
        <span className="ae-hint aw-cond-tail">
          {form.warningCountsAsFiring !== false
            ? 'A child at warning level counts as firing.'
            : 'Only a child at critical level counts as firing.'}
        </span>
      </div>

      <div className="aw-cond-row">
        <span className="aw-cond-label">Stale-child policy</span>
        <select
          className="ae-select aw-comp-policy"
          value={form.staleChildPolicy || 'use_last_state'}
          aria-label="Stale-child policy"
          onChange={(e) => set({ staleChildPolicy: e.target.value })}
        >
          {STALE_CHILD_POLICIES.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>
      <div className="ae-hint aw-cond-note">{policy.hint}</div>
    </div>
  );
}

CompositeStep.propTypes = {
  /** The editor's form state — see alertModel.docToForm. */
  form: PropTypes.object.isRequired,
  /** Patch one or more form fields. */
  set: PropTypes.func.isRequired,
  /** Every validation error for the step, keyed by field. */
  errors: PropTypes.object.isRequired,
  /** Returns an error only once the field is worth complaining about. */
  showErr: PropTypes.func.isRequired,
  /** The composite being edited, so the server's cycle check can exempt it. */
  compositeId: PropTypes.string,
};
