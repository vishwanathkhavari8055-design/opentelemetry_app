import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import useCatalog from '../../common/useCatalog';
import SearchableSelect from '../../common/SearchableSelect';
import ServiceCatalogPicker, { resourceKey } from './ServiceCatalogPicker';
import useServiceTelemetry, { TELEMETRY_WINDOW_LABEL } from './useServiceTelemetry';
import ConditionsStep from './ConditionsStep';
import AlertInsight from './AlertInsight';
import { createAlert, fetchAlerts } from '../../../services/api';
import {
  AGG_NEEDS_COLUMN, DEFAULT_FOLDER_ID, applyForm, countConditions, docToForm,
  emptyAlertDoc, expressionToLabels, formatMinutes, nextKey, thresholdParts,
  updateNode, validateForm,
} from '../alertModel';

/**
 * Create an alert in two steps: pick the service, then configure the alert.
 *
 * Shown one step at a time, with Back and Next in the footer and no progress
 * rail above them. A two-item rail spends a band of the screen restating what
 * the footer already says and what a two-step flow makes obvious anyway — and
 * it was taking that band from step 2, which is a dense screen that wants it.
 *
 * Replaces the one-screen AlertEditor for CREATION only. Editing an existing
 * alert still opens AlertEditor — see AlertsView. That split is the point: a
 * wizard is right the first time, when you do not yet know which fields exist,
 * and wrong every time after, when you want to change one number without walking
 * past another screen to reach it.
 *
 * ─── Why there is no longer a step 3 ────────────────────────────────────────
 *
 * There used to be a "Review & Create" screen carrying the alert's name, folder
 * and destination beside a read-back of everything decided earlier. It is gone,
 * and its three inputs have moved to where the reference instance keeps them:
 * the name and folder into the title strip below, the destination into step 2's
 * Settings card, beside the cooldown it is delivered under.
 *
 * The read-back is not gone; it moved, and got better. Step 2 now carries the
 * reference's Summary panel — the same alert, restated line by line, but visible
 * WHILE the controls that produce it are still on screen, rather than one screen
 * after the last chance to change them. A review you cannot act on without going
 * back is a review most people click past. Beside it is a Preview that runs the
 * draft rule against real data, which is the question a review screen was always
 * a poor substitute for: not "did I type what I meant" but "does what I typed
 * match anything".
 *
 * ─── The draft ──────────────────────────────────────────────────────────────
 *
 * State for both steps lives HERE, in one `draft` object, and each step is a
 * controlled child that reads its slice and calls back. Steps therefore keep
 * their answers when you page back and forth.
 *
 * `draft.form` is NOT a shape invented for the wizard: it is exactly what
 * `alertModel.docToForm` produces for the one-screen editor. The save goes
 * through the same `applyForm` merge the editor uses, an alert created here
 * opens there unchanged, and every validation rule is shared rather than written
 * twice and allowed to drift.
 *
 * ─── Step 1 feeds step 2 ────────────────────────────────────────────────────
 *
 * Choosing a service is not just bookkeeping — it IS a condition, `service_name
 * = <resolved name>`, and the wizard writes that row into the filter tree so
 * step 2 opens on a rule that already scopes to what step 1 answered. See
 * `seedServiceRow` for why it is rewritten rather than re-added when the
 * selection changes.
 *
 * That answer does four more things on step 2, all of them flowing from `scope`
 * below: it narrows the stream list to what the service writes to, seeds the
 * signal type from what it is actually emitting, names the alert after it, and
 * confines the preview to the same rows the finished rule will see.
 */

/**
 * The two steps, for the card heading and for knowing which one is last.
 *
 * <p>No longer rendered as a rail: the wizard shows one step at a time and the
 * footer's Back / Next are how you move between them, so a two-item progress
 * bar was restating what the screen already made obvious. `key` is kept because
 * it is what the steps are identified by in code, not on screen.</p>
 */
const STEPS = [
  { key: 'service',    label: 'Select Service' },
  { key: 'conditions', label: 'Configure Alert' },
];

const IconSpinner = () => (
  <svg className="aw-spin" width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

const IconBack = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

const IconPencil = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const IconFolder = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

/** The column step 1's answer is written to. */
const SERVICE_COLUMN = 'service_name';

/**
 * Write the chosen service into the filter tree as `service_name = <name>`.
 *
 * Rewritten in place rather than appended, because going back to step 1 and
 * picking a different service is a CORRECTION, not an additional condition —
 * appending would leave `service_name = a AND service_name = b`, which matches
 * nothing and looks like the wizard is broken. The row is found by its previous
 * value, so a `service_name` row the user typed themselves is never overwritten.
 *
 * A row the user has DELETED stays deleted: nothing is re-added once a previous
 * name was seeded and its row is gone. The only case that adds is the first
 * selection, and then only ahead of whatever else is there.
 */
const seedServiceRow = (tree, previousName, nextName) => {
  if (tree?.kind !== 'group') return tree;

  const target = tree.items.find(
    (n) => n.kind === 'condition'
      && n.column === SERVICE_COLUMN
      && (previousName ? n.value === previousName : true),
  );
  if (target) {
    return updateNode(tree, target.key, (n) => ({ ...n, value: nextName, operator: '=' }));
  }
  if (previousName) return tree; // the user removed it on purpose

  const row = {
    key: nextKey(),
    kind: 'condition',
    column: SERVICE_COLUMN,
    operator: '=',
    value: nextName,
    ignoreCase: false,
  };
  // The blank row every new condition tree opens with is a placeholder, not an
  // answer, so it is replaced rather than kept alongside.
  const untouched = tree.items.length === 1
    && tree.items[0].kind === 'condition'
    && !tree.items[0].column;
  return { ...tree, items: untouched ? [row] : [row, ...tree.items] };
};

/** Empty draft. One place to add a field when a later step needs one. */
const emptyDraft = (baseDoc, folderId) => ({
  /** The whole Product Catalog row, not just its name — step 2 needs the category
   *  and the stream hints, and re-finding it by id after a catalog refresh is a
   *  lookup that can fail. */
  resource: null,
  /** What step 1 last wrote into the filter tree, so it can be rewritten. */
  seededName: '',
  /** Where the alert lands. Not part of the document — OpenObserve takes it
   *  alongside, as a query parameter of the create — so it is held beside the
   *  form rather than inside it. */
  folderId: folderId || DEFAULT_FOLDER_ID,
  /** The editor's form state, defaulted from OpenObserve's own new-alert document. */
  form: docToForm(baseDoc),
});

/** `s` without leading or trailing `_` — an index scan, so no regex backtracking. */
const trimUnderscores = (s) => {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === '_') start += 1;
  while (end > start && s[end - 1] === '_') end -= 1;
  return s.slice(start, end);
};

/** A name for the alert, in the shape the reference generates. */
const suggestName = (serviceName, resource, form) => {
  const base = trimUnderscores((serviceName || resource?.resourceName || form.streamName || 'service')
    .toString().toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_'));
  const kind = form.alertType === 'composite' ? 'composite' : (form.streamType || 'logs');
  return `${base || 'service'}_${kind}_alert`.slice(0, 200);
};

/**
 * Every error step 2 owns — which, with step 3 gone, is all of them.
 *
 * <p>Two rules are added here rather than in `validateForm`, because both are
 * about things only this screen knows. The aggregation COLUMN has no control
 * in the one-screen editor, so an alert that editor wrote reads back without
 * one and a form-level error would put a permanent, unfixable complaint on a
 * screen that has nothing to fix it with. The duplicate name needs the alert
 * list, which the model has no business fetching.</p>
 */
function wizardErrors(baseErrors, form, nameTaken) {
  const out = { ...baseErrors };
  // A composite carries the aggregation fields from the empty document it was
  // seeded with and never shows them, so this rule would make it permanently
  // unfinishable on a control that is not on screen.
  if (form.alertType !== 'composite'
    && form.aggregationEnabled
    && form.queryType === 'custom'
    && AGG_NEEDS_COLUMN.includes(form.aggFunction)
    && !(form.aggColumn || '').trim()) {
    out.aggColumn = `Choose the column to take the ${form.aggFunction} of.`;
  }
  /* "Hold for" cannot outlast the window it is measured inside: a condition
     cannot stay true for longer than a single evaluation can see, so such an
     alert is accepted by OpenObserve and then never fires. Checked here and
     not in `validateForm` because the one-screen editor has no Hold for
     control, and a rule it can report but not fix would make an alert
     authored elsewhere permanently unsaveable there. */
  const holdSecs = Number(form.toleranceSecs);
  const windowSecs = Number(form.period) * 60;
  if (!out.toleranceSecs && form.alertType === 'scheduled'
    && Number.isFinite(holdSecs) && holdSecs > 0
    && Number.isFinite(windowSecs) && windowSecs > 0
    && holdSecs > windowSecs) {
    out.toleranceSecs = `Hold for (${holdSecs}s) is longer than the look back window `
      + `(${form.period} min), so the condition can never be held that long.`;
  }
  if (nameTaken && !out.name) {
    out.name = `An alert called “${form.name.trim()}” already exists — `
      + 'OpenObserve requires alert names to be unique.';
  }
  return out;
}

/**
 * What step 2's stream picker, preview and scoping are narrowed to.
 *
 * <p>Step 1's answer is not only a filter row — it is also the reason the
 * stream list should be twenty names instead of three thousand, and the reason
 * the preview counts this service's rows rather than every service's. The
 * backend can work that out, but only if it is told which service, and this is
 * the only place that knows.</p>
 *
 * <p>The catalog row id is preferred over the resolved name because a
 * registered resource carries its telemetry BINDINGS — the alternate
 * identities the same service is known by on streams that have no
 * `service_name` column, such as the Kubernetes scraper's
 * `k8s_container_name`. Scoping by bare name finds only the streams that
 * happen to use the one spelling. The name is the fallback for a selection
 * with no id, where a partial narrowing still beats none.</p>
 */
function scopeFor(resource, selectedName) {
  if (resource?.id) {
    return {
      type: 'resource',
      key: String(resource.id),
      label: resource.resourceName || selectedName,
    };
  }
  if (selectedName) return { type: 'service', key: selectedName, label: selectedName };
  return { type: '', key: '', label: '' };
}

/**
 * What step 2 has decided, in one line for the footer.
 *
 * <p>Restated for the same reason step 1's answer is: the threshold is the
 * thing being routed, and a wizard that hides it after one screen is how the
 * wrong page reaches the right person.</p>
 */
function summarizeCondition(form) {
  if (form.alertType === 'composite') {
    const n = (form.compositeChildren || []).filter(Boolean).length;
    const expr = form.compositeExpressionLabelled
      || expressionToLabels(form.compositeExpression, form.compositeChildren);
    return `composite · ${expr || 'no expression'} · ${n} sub-alert${n === 1 ? '' : 's'}`;
  }
  if (form.alertType === 'realtime') {
    const n = countConditions(form.conditions);
    return `realtime · ${n} filter${n === 1 ? '' : 's'}`;
  }
  // Through the shared helper, so this line and the Summary panel's
  // restatement of the same rule cannot drift apart.
  const { measure, operator: op, value } = thresholdParts(form);
  const cadence = form.frequencyType === 'cron'
    ? `cron ${form.cron}`
    : `every ${formatMinutes(form.frequency)}`;
  return `${measure} ${op} ${value} · ${cadence}`;
}

export default function AlertWizard({
  onClose, onNavigateToCatalog, folders, initialFolderId, onSaved,
}) {
  /**
   * The document the save merges into.
   *
   * <p>Held rather than rebuilt so the merge has the same contract it has in the
   * editor: `applyForm` preserves every key of its base that the form does not
   * model, and the base here is the very document `draft.form` was projected
   * from. Rebuilding it at save time would work today and silently stop working
   * the moment `emptyAlertDoc` gains a field the form does not carry.</p>
   */
  const baseDocRef = useRef(null);
  if (!baseDocRef.current) baseDocRef.current = emptyAlertDoc();

  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState(
    () => emptyDraft(baseDocRef.current, initialFolderId),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  /**
   * Has the user changed anything on the current step?
   *
   * <p>Errors are held back until they have, because a form that is red before it
   * has been filled in is just noise. Reset on every step change so arriving at
   * step 2 does not inherit step 1's history.</p>
   */
  const [touched, setTouched] = useState(false);

  /** Has the user typed a name of their own? Only then is auto-naming off. */
  const [nameTouched, setNameTouched] = useState(false);

  const { categories, loading, error, degraded } = useCatalog();

  /**
   * What each registered service is actually emitting, per signal.
   *
   * <p>Fetched alongside the catalog rather than inside the picker so the footer
   * can warn about a silent selection without the picker having to report
   * upwards, and so step 2's stream type can be defaulted from it without a
   * second round trip.</p>
   */
  const telemetry = useServiceTelemetry({ enabled: true });

  const { form } = draft;

  /** Patch form fields. Marks the step touched, which is what un-hides errors. */
  const setForm = (fields) => {
    setTouched(true);
    if (Object.hasOwn(fields, 'name')) setNameTouched(true);
    setDraft((d) => ({ ...d, form: { ...d.form, ...fields } }));
  };

  /**
   * Adopt a service: remember it, seed its filter row, and pick its signal.
   *
   * <p>The stream TYPE is defaulted from what the service is actually emitting.
   * A service that only produces traces opening on `logs` is a wizard that hands
   * you an alert which can never fire, and the correction is two clicks away in
   * a list the user has no reason to go looking at. Only applied while no stream
   * name has been chosen, so it cannot undo an answer already given on step 2.</p>
   */
  const selectResource = (resource) => {
    const name = resourceKey(resource);
    setDraft((d) => {
      const signals = telemetry.byName.get(name) || null;
      const tracesOnly = !!signals && !signals.logs && !!signals.traces;
      const defaultType = tracesOnly ? 'traces' : 'logs';
      return {
        ...d,
        resource,
        seededName: name,
        form: {
          ...d.form,
          conditions: seedServiceRow(d.form.conditions, d.seededName, name),
          streamType: d.form.streamName ? d.form.streamType : defaultType,
        },
      };
    });
  };

  const selectedName = resourceKey(draft.resource);

  /* ── naming ────────────────────────────────────────────────────────────── */

  const suggestion = useMemo(
    () => suggestName(selectedName, draft.resource, form),
    [selectedName, draft.resource, form],
  );

  /**
   * Name the alert as soon as there is something to name it after.
   *
   * <p>The reference fills the name in the moment a stream is chosen, and doing
   * the same removes the commonest reason a finished alert cannot be saved: a
   * required field on a strip the user has already read past. It stops the
   * instant the user types, so it can only ever fill a box nobody has
   * answered.</p>
   *
   * <p>Auto-naming used to be refused here, on the grounds that OpenObserve
   * requires names to be unique and so a silently-filled name makes the SECOND
   * alert for a service fail on save with an error the user did not cause. That
   * was right about the risk and wrong about the remedy: the fix is to check the
   * name against the alerts that already exist — see `takenNames` — not to leave
   * a required field blank and hope somebody notices.</p>
   */
  useEffect(() => {
    if (nameTouched || !draft.resource) return;
    if (!form.streamName && form.alertType !== 'composite') return;
    if (form.name === suggestion) return;
    setDraft((d) => ({ ...d, form: { ...d.form, name: suggestion } }));
  }, [nameTouched, draft.resource, form.streamName, form.alertType, form.name, suggestion]);

  /**
   * Names already in use, so a collision is caught here rather than by the save.
   *
   * <p>Read across every folder, because OpenObserve scopes alert names to the
   * ORG rather than to the folder — filtering this to the chosen folder would
   * miss exactly the collisions it exists to catch. A failed lookup leaves the
   * set empty and the check quietly inactive: it is an early warning, and one
   * that breaks the screen when it cannot run is worse than none.</p>
   */
  const [takenNames, setTakenNames] = useState(() => new Set());
  useEffect(() => {
    const controller = new AbortController();
    fetchAlerts({ pageSize: 1000, signal: controller.signal })
      .then((res) => setTakenNames(new Set(
        (res.items || []).map((a) => (a.name || '').toLowerCase()).filter(Boolean),
      )))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const nameTaken = !!(form.name || '').trim()
    && takenNames.has(form.name.trim().toLowerCase());

  /* ── validation ────────────────────────────────────────────────────────── */

  const baseErrors = useMemo(() => validateForm(form), [form]);

  /** Every error step 2 owns — see `wizardErrors`. */
  const errors = useMemo(
    () => wizardErrors(baseErrors, form, nameTaken),
    [baseErrors, form, nameTaken],
  );

  /**
   * May we leave the step at `index`?
   *
   * <p>One function rather than a flag per step, because the footer, the rail and
   * the keyboard path all ask the same question and any of them drifting out of
   * step with the others is a wizard that lets you skip a required answer.</p>
   */
  const canLeave = useMemo(() => (index) => {
    if (index === 0) return !!draft.resource;
    // Step 2 is the last screen — there is nothing after it to be let into. Its
    // answers are checked by `create`, on the button that acts on them.
    return true;
  }, [draft.resource]);

  const goTo = (index) => {
    if (index === stepIndex) return;
    // Backwards is always allowed. Forwards has to pass every step in between.
    if (index > stepIndex) {
      for (let i = stepIndex; i < index; i += 1) if (!canLeave(i)) return;
    }
    setStepIndex(index);
    setTouched(false);
    setSaveError('');
  };

  /* ── create ────────────────────────────────────────────────────────────── */

  /**
   * Write the alert.
   *
   * <p>On failure the screen stays exactly where it is with the message on it — a
   * wizard that unwinds to step 1 after a duplicate-name error has thrown away
   * work the user would have to redo unchanged.</p>
   */
  const create = async () => {
    setTouched(true);
    setSaveError('');
    if (Object.keys(errors).length) {
      setSaveError('Fix the highlighted fields before creating this alert.');
      return;
    }

    setSaving(true);
    try {
      const doc = applyForm(baseDocRef.current, form);
      const res = await createAlert({ alert: doc, folderId: draft.folderId });
      onSaved({ message: res?.message || `Alert “${doc.name}” created.` });
    } catch (err) {
      setSaveError(err.message || 'Could not create the alert.');
      setSaving(false);
    }
  };

  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  /** What step 2's stream picker, preview and scoping are narrowed to — see `scopeFor`. */
  const scope = useMemo(
    () => scopeFor(draft.resource, selectedName),
    [draft.resource, selectedName],
  );

  /**
   * Chosen a service that is emitting nothing?
   *
   * <p>A warning, never a block. Alerting on a service that is quiet right now is
   * a normal thing to want — that is what a "no data" alert IS — and refusing it
   * would be wrong. But the far more common cause is a registration whose
   * resolved name does not match what the service actually emits under, and that
   * mistake is invisible until the alert has silently never fired for a month.</p>
   */
  const selectionSilent = !!draft.resource
    && telemetry.status === 'ready'
    && !telemetry.byName.has(selectedName);

  /** Is step 1's row still in the tree? Only then is it worth explaining. */
  const seededRowPresent = !!draft.seededName
    && (form.conditions?.items || []).some(
      (n) => n.kind === 'condition' && n.column === SERVICE_COLUMN
        && n.value === draft.seededName,
    );

  const folderOptions = useMemo(() => (folders?.length
    ? folders
    : [{ folderId: DEFAULT_FOLDER_ID, name: 'default' }]
  ).map((f) => ({ value: f.folderId, label: f.name || f.folderId })), [folders]);

  const folderName = folderOptions.find((f) => f.value === draft.folderId)?.label
    || draft.folderId;

  /** What step 2 has decided, in one line for the footer. */
  const conditionSummary = useMemo(() => summarizeCondition(form), [form]);

  const errorCount = Object.keys(errors).length;
  const showErr = (key) => (touched ? errors[key] : undefined);

  return (
    <div className="alerts-editor aw">
      {/* ── Title strip ──────────────────────────────────────────────────
          On step 2 this is where the alert is NAMED and FILED, which is where
          the reference keeps both. They identify the alert rather than configure
          it, and a name sitting among the thresholds reads as one more knob.
          Step 1 has nothing to name yet, so it keeps the plain title. */}
      <div className="ae-topbar aw-topbar">
        <button type="button" className="ae-back" onClick={onClose} aria-label="Back to alerts">
          <IconBack />
        </button>

        {stepIndex === 0 ? (
          <div className="aw-title-block">
            <h2 className="aw-title">New alert</h2>
          </div>
        ) : (
          <div className="aw-title-block">
            <label className="aw-name-row" htmlFor="aw-name">
              <input
                id="aw-name"
                className={`aw-name${showErr('name') ? ' is-bad' : ''}`}
                value={form.name}
                placeholder={suggestion || 'Alert name'}
                maxLength={200}
                autoComplete="off"
                aria-label="Alert name"
                onChange={(e) => setForm({ name: e.target.value })}
              />
              <IconPencil />
            </label>
            <p className="aw-subtitle aw-subtitle--folder">
              <span>Add Alert in</span>
              <IconFolder />
              <SearchableSelect
                className="ssel--folder"
                options={folderOptions}
                value={draft.folderId}
                onChange={(id) => setDraft((d) => ({ ...d, folderId: id }))}
                ariaLabel="Folder"
                placeholder="default"
              />
            </p>
          </div>
        )}
      </div>

      {/* Step 2's name is in the title strip, where there is no room for the
          message under it. Printed here instead, directly below the field. */}
      {stepIndex === 1 && showErr('name') && (
        <div className="ae-error aw-name-error">{errors.name}</div>
      )}

      {/* ── The current step ─────────────────────────────────────────────── */}
      <div className={`aw-body${stepIndex === 1 ? ' aw-body--split' : ''}`}>
        <section className="ae-card aw-panel">
          <div className="ae-card-head">
            {step.label}
            <span className="ae-req" title="Required">*</span>
          </div>

          <div className="aw-panel-body">
            {stepIndex === 0 && (
              <ServiceCatalogPicker
                categories={categories}
                loading={loading}
                error={error}
                degraded={degraded}
                selectedId={draft.resource?.id || null}
                onSelect={selectResource}
                onNavigateToCatalog={onNavigateToCatalog}
                telemetry={telemetry.byName}
                telemetryStatus={telemetry.status}
                logsStatus={telemetry.logsStatus}
                tracesStatus={telemetry.tracesStatus}
              />
            )}

            {stepIndex === 1 && (
              <ConditionsStep
                form={form}
                set={setForm}
                errors={errors}
                showErr={showErr}
                serviceName={seededRowPresent ? draft.seededName : ''}
                scopeType={scope.type}
                scopeKey={scope.key}
                scopeLabel={scope.label}
              />
            )}
          </div>
        </section>

        {/* The reference's right-hand rail: what the rule WOULD match right now,
            and the whole alert restated. Beside the controls rather than after
            them, so a summary that reads wrong can be fixed without leaving the
            line that says so. */}
        {stepIndex === 1 && (
          <AlertInsight
            form={form}
            folderName={folderName}
            scopeType={scope.type}
            scopeKey={scope.key}
          />
        )}
      </div>

      {saveError && (
        <div className="alerts-banner alerts-banner--error">
          <span className="alerts-banner-text">{saveError}</span>
          <button
            type="button" className="alerts-banner-x"
            onClick={() => setSaveError('')} aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="aw-foot">
        {/* What step 1 decided, restated on every step. The service is the thing
            every later answer is scoped to, and a wizard that hides it after one
            screen is how you configure a threshold against the wrong target. */}
        <WizardFootSummary
          draft={draft} form={form} stepIndex={stepIndex}
          selectedName={selectedName} selectionSilent={selectionSilent}
          conditionSummary={conditionSummary} touched={touched} errorCount={errorCount}
        />

        <span className="aw-foot-actions">
          <button
            type="button" className="alerts-btn-ghost"
            onClick={onClose} disabled={saving}
          >Cancel</button>
          <button
            type="button" className="alerts-btn-ghost"
            onClick={() => goTo(stepIndex - 1)}
            disabled={stepIndex === 0 || saving}
          >Back</button>
          {/* Deliberately NOT disabled while the form is invalid: this is the
              screen the remaining answers are given on, and a button that greys
              out without saying which answer is missing is how someone ends up
              staring at a form they cannot act on. Pressing it reveals the
              errors, and the tab badge says which tab they are on. */}
          {isLast ? (
            <button
              type="button" className="alerts-btn-primary aw-create"
              onClick={create}
              disabled={saving}
            >
              {saving && <IconSpinner />}
              {saving ? 'Creating…' : 'Create alert'}
            </button>
          ) : (
            <button
              type="button" className="alerts-btn-primary"
              onClick={() => goTo(stepIndex + 1)}
              disabled={!canLeave(stepIndex)}
            >Next</button>
          )}
        </span>
      </footer>
    </div>
  );
}

AlertWizard.propTypes = {
  /** Leave the wizard and return to the alert list. */
  onClose: PropTypes.func.isRequired,
  /** Optional jump to Settings → Product Catalog, offered inside empty categories. */
  onNavigateToCatalog: PropTypes.func,
  /** Folders the new alert may land in. The root folder is assumed when empty. */
  folders: PropTypes.arrayOf(PropTypes.shape({
    folderId: PropTypes.string, name: PropTypes.string,
  })),
  /** Which folder to open on — the one the list is currently filtered to. */
  initialFolderId: PropTypes.string,
  /** Called with `{ message }` once the alert exists; leaves the wizard. */
  onSaved: PropTypes.func.isRequired,
};

/** The footer's restatement of the service and, on step 2, what the rule fires on. */
function WizardFootSummary({
  draft, form, stepIndex, selectedName, selectionSilent, conditionSummary, touched, errorCount,
}) {
  return (
    <span className="aw-foot-summary">
      {draft.resource ? (
        <>
          <span className="aw-foot-key">Service</span>
          <span className="aw-foot-val" title={`service_name="${selectedName}"`}>
            {draft.resource.resourceName}
          </span>
          {selectionSilent && (
            <span
              className="aw-foot-warn"
              title={`No logs and no traces arrived for service_name="${selectedName}" in the `
                + `${TELEMETRY_WINDOW_LABEL}. Check the resolved name in the Product Catalog `
                + 'if you expected data.'}
            >
              no telemetry in the {TELEMETRY_WINDOW_LABEL}
            </span>
          )}
          {stepIndex >= 1 && (!!form.streamName || form.alertType === 'composite') && (
            <>
              <span className="aw-foot-key">Fires when</span>
              <span className="aw-foot-val" title={conditionSummary}>{conditionSummary}</span>
            </>
          )}
          {stepIndex >= 1 && touched && errorCount > 0 && (
            <span className="aw-foot-warn">
              {errorCount} field{errorCount === 1 ? ' needs' : 's need'} attention
            </span>
          )}
        </>
      ) : (
        <span className="aw-foot-hint">Select a service to continue.</span>
      )}
    </span>
  );
}

WizardFootSummary.propTypes = {
  draft: PropTypes.shape({
    resource: PropTypes.object,
  }).isRequired,
  form: PropTypes.object.isRequired,
  stepIndex: PropTypes.number.isRequired,
  selectedName: PropTypes.string,
  selectionSilent: PropTypes.bool,
  conditionSummary: PropTypes.string,
  touched: PropTypes.bool,
  errorCount: PropTypes.number,
};
