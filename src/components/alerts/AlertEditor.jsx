import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  fetchAlert, createAlert, updateAlert, fetchAlertStreams, fetchAlertStreamFields,
  fetchAlertDestinations, fetchAlertFolders, fetchAlertTemplates, fetchLogs,
  createAlertFolder,
} from '../../services/api';
import {
  ALERT_TYPES, AGG_FUNCTIONS, DEFAULT_FOLDER_ID, OFFSET_UNITS, PRIORITIES,
  QUERY_TYPES, ROW_TEMPLATE_TYPES, STREAM_TYPES, THRESHOLD_OPERATORS, applyForm,
  countConditions, docToForm, emptyAlertDoc, formatMinutes, formatOffset,
  newComparisonWindow, nextKey, validateForm, warningField,
} from './alertModel';
import ConditionBuilder from './ConditionBuilder';
import DestinationDialog from './DestinationDialog';
import SearchableSelect from '../common/SearchableSelect';
import TokenInput from './TokenInput';
import CheckboxSelect from './fired/CheckboxSelect';

/**
 * Create / edit an alert.
 *
 * The one thing to understand before changing this file: the alert DOCUMENT is
 * kept alongside the form state, and saving MERGES the form into that document
 * (see `applyForm` in alertModel). It is never rebuilt from the visible fields.
 * OpenObserve's alert schema is larger than this form — `anomaly_config`,
 * `deduplication`, `search_event_type`, `multi_time_range` and more — and an
 * alert authored in OpenObserve's own UI must survive being edited here. A
 * rebuild would drop those keys with no error and no way for the user to notice.
 *
 * Layout follows the reference: name + folder pinned at the top, the definition
 * on the left, Preview and Summary on the right, Cancel/Save in the footer.
 *
 * The definition card is tabbed, and the tabs map onto the reference UI's steps:
 * Alert Rules (its Conditions + Settings steps), Compare with Past,
 * Deduplication, and Advanced. Kept as tabs rather than a linear wizard because
 * editing an existing alert is the common case here, and a wizard makes you walk
 * past four screens to change one number.
 */

/** Realtime alerts evaluate per ingested row; only scheduled ones have a window. */
const isScheduled = (form) => form.alertType === 'scheduled';

/**
 * What the threshold row is counting, in words.
 *
 * The same `trigger_condition.threshold` field means three different things
 * depending on the rest of the form, and a row labelled "count" while it is
 * actually gating the NUMBER OF GROUPS is how someone sets 100 and wonders why
 * nothing ever fires.
 */
/**
 * Form field holding the warning tier, per {@link warningField}'s answer.
 *
 * Three fields, one at a time: which one is live depends on the query type and
 * whether aggregation is on, and the two that are not are cleared on save.
 */
const WARNING_FIELDS = {
  trigger: 'warningThreshold',
  aggregation: 'aggWarningValue',
  promql: 'promqlWarningValue',
};

const thresholdNoun = (form) => {
  if (form.queryType === 'promql') return 'series';
  if (form.queryType === 'custom' && form.aggregationEnabled) {
    const grouped = (form.aggGroupBy || '').split(',').some((s) => s.trim());
    return grouped ? 'groups' : 'events';
  }
  return 'events';
};

/**
 * What to call the threshold row.
 *
 * For a PromQL alert, and for an aggregation that groups, `trigger_condition`
 * is NOT the severity threshold — the severity comparison lives in the PromQL
 * condition or the aggregation's having clause, and this field is the gate on
 * HOW MANY series or groups had to breach it. Calling both rows "Critical if"
 * makes them look like two competing severity thresholds.
 */
const thresholdLabel = (form) => {
  const noun = thresholdNoun(form);
  if (noun === 'series') return 'Having series';
  if (noun === 'groups') return 'Having groups';
  return 'Critical if';
};

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

/* Tab glyphs. Drawn rather than pulled from an icon font so the tab strip does
   not depend on a webfont having loaded to be legible. */
const IconShield = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
  </svg>
);

const IconHistory = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
    <path d="M12 8v4l3 2" />
  </svg>
);

const IconLayers = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </svg>
);

const IconSliders = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
    <path d="M1 14h6M9 8h6M17 16h6" />
  </svg>
);

const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" />
  </svg>
);

const IconChart = () => (
  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3v18h18" /><path d="m7 14 4-4 3 3 5-6" />
  </svg>
);

const IconDoc = () => (
  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

/** The confirmation shown after a save: the server's own wording when it sent one. */
function savedMessage(res, isEdit, name) {
  return res?.message
    || (isEdit ? `Alert “${name}” updated.` : `Alert “${name}” created.`);
}

/**
 * Why the Compare with Past tab has nothing to configure — or null when it
 * does.
 *
 * Said in the panel rather than by disabling the tab: a greyed-out tab tells
 * someone they cannot do the thing without telling them what to change to be
 * able to, and both blockers here are one control away on another tab.
 */
function compareBlockedFor(form) {
  if (form.queryType !== 'sql') {
    return {
      title: 'Comparison windows need a SQL alert.',
      body: "A comparison window re-runs the alert's own query over an earlier period "
        + "and holds the two results side by side, so there has to be a query to "
        + "re-run. OpenObserve supports this for SQL alerts only — switch Query "
        + "Type to SQL on the Alert Rules tab.",
    };
  }
  return null;
}

/* The tab strip.
 *
 * Compare with Past is DROPPED for a realtime alert rather than shown
 * blocked. Realtime is a different kind of alert, not a mis-set option, and
 * the reference shows a realtime alert a short strip; a permanently dead tab
 * is worse than no tab. It stays visible — and explains itself — for a
 * scheduled alert in the wrong query mode, because that really is one
 * control away.
 */
function buildTabs(form, scheduled) {
  return [
    { id: 'rules', label: 'Alert Rules', icon: <IconShield />, required: true },
    ...(scheduled ? [{
      id: 'compare',
      label: 'Compare with Past',
      icon: <IconHistory />,
      badge: form.multiWindows.length,
    }] : []),
    {
      id: 'dedup',
      label: 'Deduplication',
      icon: <IconLayers />,
      badge: form.dedupFields.length,
    },
    { id: 'advanced', label: 'Advanced', icon: <IconSliders /> },
  ];
}

/* Destination options for the multi-select.
 *
 * An alert may point at a destination that has since been renamed or deleted.
 * It is appended to the options as "(missing)" rather than left out, because
 * CheckboxSelect can only render a selection it has an option for — an unknown
 * destination would otherwise be invisible, read as "this alert notifies
 * nobody", and be saved that way on the next edit. */
function buildDestOptions(destinations, form) {
  return [
    ...destinations.map((d) => ({
      value: d.name, label: d.type ? `${d.name} — ${d.type}` : d.name,
    })),
    ...form.destinations
      .filter((name) => !destinations.some((d) => d.name === name))
      .map((name) => ({ value: name, label: `${name} (missing)` })),
  ];
}

/* Folder options for the title subtitle.
 *
 * Falls back to the root folder rather than rendering an empty list: the
 * parent loads its folders asynchronously, and a control that shows nothing
 * during that window reads as "this alert has no folder". */
function buildFolderOptions(folderList) {
  return (folderList.length
    ? folderList
    : [{ folderId: DEFAULT_FOLDER_ID, name: 'default' }]
  ).map((f) => ({ value: f.folderId, label: f.name || f.folderId }));
}

/** What actually makes this alert fire, in one line. */
function firesWhenText(form, noun) {
  if (form.queryType === 'promql') {
    return `value ${form.promqlOperator} ${form.promqlValue || '—'}`;
  }
  if (form.queryType === 'custom' && form.aggregationEnabled) {
    return `${form.aggFunction} ${form.aggHavingOperator} ${form.aggHavingValue || '—'}`;
  }
  return `${noun} ${form.thresholdOperator} ${form.threshold}`;
}

/** The operator the warning tier shares with its critical threshold. */
function warnOperatorFor(form, warnAt) {
  return {
    promql: form.promqlOperator,
    aggregation: form.aggHavingOperator,
    trigger: form.thresholdOperator,
  }[warnAt] || '';
}

export default function AlertEditor({
  alertId, folders, initialFolderId, onClose, onSaved,
}) {
  const isEdit = !!alertId;

  /** OpenObserve's document. The merge target — see the note above. */
  const baseDocRef = useRef(emptyAlertDoc());

  const [form, setForm] = useState(() => docToForm(emptyAlertDoc()));
  const [folderId, setFolderId] = useState(initialFolderId || DEFAULT_FOLDER_ID);
  // 'rules' | 'compare' | 'dedup' | 'advanced'
  const [tab, setTab] = useState('rules');

  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [touched, setTouched] = useState(false);

  const [streams, setStreams] = useState([]);
  const [columns, setColumns] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [destLoading, setDestLoading] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [showDestDialog, setShowDestDialog] = useState(false);
  // Whether the optional warning input is on screen. An alert that already has
  // a warning threshold shows it regardless — see `warnShown`.
  const [warnOpen, setWarnOpen] = useState(false);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderList, setFolderList] = useState(folders || []);

  // The parent loads its folders asynchronously, so opening the editor before
  // that finishes would otherwise leave this select stuck on whatever it was
  // mounted with — an empty list, or a stale one after a folder was added.
  // Only adopt a non-empty prop: a folder created *inside* this editor lives in
  // local state and must not be wiped by the parent's older copy.
  useEffect(() => {
    if (folders?.length) setFolderList(folders);
  }, [folders]);

  const [preview, setPreview] = useState({ loading: false, rows: [], error: '', ran: false });

  const set = useCallback((fields) => {
    setTouched(true);
    setForm((f) => ({ ...f, ...fields }));
  }, []);

  /* ── list-shaped fields ────────────────────────────────────────────────────
   *
   * Comparison windows and additional variables are both edited as rows, and
   * both are updated by their client `key` rather than by index: a row removed
   * from the middle would otherwise shift every row below it onto a different
   * key, moving the caret out of the field being typed into. */

  const setWindow = useCallback((key, fields) => {
    setTouched(true);
    setForm((f) => ({
      ...f,
      multiWindows: f.multiWindows.map((w) => (w.key === key ? { ...w, ...fields } : w)),
    }));
  }, []);

  const addWindow = useCallback(() => {
    setTouched(true);
    setForm((f) => ({ ...f, multiWindows: [...f.multiWindows, newComparisonWindow()] }));
  }, []);

  const removeWindow = useCallback((key) => {
    setTouched(true);
    setForm((f) => ({ ...f, multiWindows: f.multiWindows.filter((w) => w.key !== key) }));
  }, []);

  const setVariable = useCallback((key, fields) => {
    setTouched(true);
    setForm((f) => ({
      ...f,
      variables: f.variables.map((v) => (v.key === key ? { ...v, ...fields } : v)),
    }));
  }, []);

  const addVariable = useCallback(() => {
    setTouched(true);
    setForm((f) => ({
      ...f, variables: [...f.variables, { key: nextKey(), name: '', value: '' }],
    }));
  }, []);

  const removeVariable = useCallback((key) => {
    setTouched(true);
    setForm((f) => ({ ...f, variables: f.variables.filter((v) => v.key !== key) }));
  }, []);

  /**
   * Turn per-group / per-series alerting on or off.
   *
   * Enabling it also forces the group gate to "at least 1", exactly as the
   * reference UI does. The alert fires on ANY breaching group, so any other
   * gate is unsatisfiable — and leaving the user to discover that through a
   * validation error they then have to fix by hand is worse than moving the two
   * fields for them.
   */
  const setMultiAlert = useCallback((field, on) => {
    setTouched(true);
    setForm((f) => (on
      ? { ...f, [field]: true, thresholdOperator: '>=', threshold: 1 }
      : { ...f, [field]: false }));
  }, []);

  /* ── load the alert being edited ───────────────────────────────────────── */

  useEffect(() => {
    if (!isEdit) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setLoadError('');

    fetchAlert(alertId, { signal: controller.signal })
      .then((res) => {
        if (cancelled) return;
        if (!res.alert) {
          setLoadError('Alert not found, or the backend returned no document.');
          setLoading(false);
          return;
        }
        baseDocRef.current = res.alert;
        setForm(docToForm(res.alert));
        if (res.folderId) setFolderId(res.folderId);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setLoadError(err.message || 'Failed to load the alert.');
        setLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
  }, [alertId, isEdit]);

  /* ── dropdown data ─────────────────────────────────────────────────────── */

  /**
   * Re-read the destination list.
   *
   * Not abortable, unlike the mount fetch below: this one is a deliberate click
   * whose result the user is waiting for, so it should land even if they change
   * tab while it is in flight.
   */
  const refreshDestinations = useCallback(() => fetchAlertDestinations()
    .then((res) => setDestinations(res.items || []))
    .catch((err) => console.error('Destinations unavailable:', err))
    .finally(() => setDestLoading(false)), []);

  useEffect(() => {
    const controller = new AbortController();
    fetchAlertDestinations({ signal: controller.signal })
      .then((res) => setDestinations(res.items || []))
      .catch((err) => {
        if (err.name !== 'AbortError') console.error('Destinations unavailable:', err);
      });
    return () => controller.abort();
  }, []);

  // Templates are only needed for the optional override in Advanced, so a
  // failure here is logged and left alone: the rest of the editor works without
  // it, and the override select simply reports that it has nothing to offer.
  useEffect(() => {
    const controller = new AbortController();
    fetchAlertTemplates({ signal: controller.signal })
      .then((res) => setTemplates(res.items || []))
      .catch((err) => {
        if (err.name !== 'AbortError') console.error('Templates unavailable:', err);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!form.streamType) return undefined;
    const controller = new AbortController();
    fetchAlertStreams({ type: form.streamType, signal: controller.signal })
      .then(setStreams)
      .catch((err) => {
        if (err.name !== 'AbortError') console.error('Stream list unavailable:', err);
      });
    return () => controller.abort();
  }, [form.streamType]);

  useEffect(() => {
    if (!form.streamName || !form.streamType) { setColumns([]); return undefined; }
    const controller = new AbortController();
    fetchAlertStreamFields({
      type: form.streamType, streamName: form.streamName, signal: controller.signal,
    })
      .then(setColumns)
      // An absent schema is normal for an unwritten stream; the condition
      // builder falls back to free-text columns, so this is not surfaced.
      .catch((err) => {
        if (err.name !== 'AbortError') setColumns([]);
      });
    return () => controller.abort();
  }, [form.streamType, form.streamName]);

  // Switching an alert to Realtime removes the Compare with Past tab. If that
  // was the open one the card would otherwise render an empty body, so the
  // selection falls back instead of pointing at a tab that is gone.
  useEffect(() => {
    if (form.alertType !== 'scheduled' && tab === 'compare') setTab('rules');
  }, [form.alertType, tab]);

  /* ── validation ────────────────────────────────────────────────────────── */

  const errors = useMemo(() => validateForm(form), [form]);
  const errorCount = Object.keys(errors).length;
  // Errors are only shown after the first save attempt or once a field has been
  // touched — a form that is red before it has been filled in is just noise.
  const showErr = (key) => (touched ? errors[key] : undefined);

  /* ── preview ───────────────────────────────────────────────────────────── */

  /**
   * Fetch a sample of what the alert's conditions currently match.
   *
   * Uses the existing logs endpoint rather than running the alert: it is the
   * only read path this app has that takes a service/severity-style filter, and
   * running the alert itself would notify its destinations. So this is a
   * best-effort indication, NOT proof the alert will fire — which is why it is
   * labelled as a sample and only offered for logs streams.
   */
  const runPreview = useCallback(async () => {
    if (form.streamType !== 'logs') return;
    setPreview({ loading: true, rows: [], error: '', ran: true });
    try {
      const res = await fetchLogs({ size: 10, startDate: 'now-1h', endDate: 'now' });
      setPreview({ loading: false, rows: res.items || [], error: '', ran: true });
    } catch (err) {
      setPreview({ loading: false, rows: [], error: err.message, ran: true });
    }
  }, [form.streamType]);

  /* ── save ──────────────────────────────────────────────────────────────── */

  const onSave = async () => {
    setTouched(true);
    setSaveError('');
    const current = validateForm(form);
    if (Object.keys(current).length) {
      setSaveError('Fix the highlighted fields before saving.');
      return;
    }

    setSaving(true);
    try {
      // Merge into the document the server gave us, preserving everything this
      // form does not model.
      const doc = applyForm(baseDocRef.current, form);
      const res = isEdit
        ? await updateAlert(alertId, { alert: doc, folderId })
        : await createAlert({ alert: doc, folderId });
      onSaved({ message: savedMessage(res, isEdit, doc.name) });
} catch (err) {
  setSaveError(err.message || 'Save failed.');
  setSaving(false);
}
  };

  const onCreateFolder = async () => {
const name = newFolderName.trim();
if (!name) return;
try {
  await createAlertFolder({ name, description: '' });
  // Re-read rather than optimistically inserting: the id is assigned by
  // OpenObserve and is what the save needs.
  const res = await fetchAlertFolders();
  const items = res.items || [];
  setFolderList(items);
  const created = items.find((f) => f.name === name);
  if (created) setFolderId(created.folderId);
  setShowFolderInput(false);
  setNewFolderName('');
} catch (err) {
  setSaveError(`Could not create folder — ${err.message}`);
}
  };

  /* ── render ────────────────────────────────────────────────────────────── */

  if (loading) {
return (
  <div className="alerts-editor">
    <div className="alerts-state">Loading alert…</div>
  </div>
);
  }

  if (loadError) {
return (
  <div className="alerts-editor">
    <div className="ae-topbar">
      <button type="button" className="ae-back" onClick={onClose} aria-label="Back to alerts">
        <IconBack />
      </button>
      <span className="ae-label">Alert</span>
    </div>
    <div className="alerts-state">
      <span className="alerts-state-error">{loadError}</span>
    </div>
  </div>
);
  }

  const scheduled = isScheduled(form);
  /** Which of the three warning fields this form writes to, or null. */
  const warnAt = warningField(form);
  const noun = thresholdNoun(form);

  const compareBlocked = compareBlockedFor(form);
  const showTabs = buildTabs(form, scheduled);
  const destOptions = buildDestOptions(destinations, form);
  const folderOptions = buildFolderOptions(folderList);

  const warnKey = warnAt ? WARNING_FIELDS[warnAt] : null;
  const warnShown = !!warnKey && (warnOpen || (form[warnKey] ?? '') !== '');

  const warningControl = (operator) => (
    <WarningControl
      operator={operator} form={form} set={set}
      warnKey={warnKey} warnShown={warnShown} setWarnOpen={setWarnOpen}
    />
  );

  const firesWhen = firesWhenText(form, noun);
  const warnOperator = warnOperatorFor(form, warnAt);

  const onDestinationCreated = (name) => {
    setShowDestDialog(false);
    // Refresh the list and select what was just made, so the user does
    // not have to find it again. ADDED to the selection rather than
    // replacing it: destinations are a set now, and someone adding a
    // second channel to an alert that already pages one has not asked
    // for the first to be removed.
    setForm((f) => ({
      ...f,
      destinations: f.destinations.includes(name)
        ? f.destinations
        : [...f.destinations, name],
    }));
    setTouched(true);
    // The name is already selected, so a failed refresh only means the
    // list label lags behind — not that the alert lost its destination.
    refreshDestinations();
  };

  const formProps = { form, set, errors, showErr };

  return (
    <div className="alerts-editor">
      {/* ── Name + folder ──────────────────────────────────────────────── */}
      <EditorTopbar
        {...formProps}
        isEdit={isEdit} onClose={onClose}
        folderOptions={folderOptions} folderId={folderId} setFolderId={setFolderId}
        setTouched={setTouched}
        showFolderInput={showFolderInput} setShowFolderInput={setShowFolderInput}
        newFolderName={newFolderName} setNewFolderName={setNewFolderName}
        onCreateFolder={onCreateFolder}
      />

      <div className="ae-cols">
        {/* ── Left: the definition ─────────────────────────────────────── */}
        <div className="ae-left">
          {/* Stream Config */}
          <StreamConfigCard {...formProps} streams={streams} />

          {/* Alert Rules / Compare with Past / Deduplication / Advanced */}
          <section className="ae-card">
            {/* A segmented control, matching the reference, rather than the
                underlined text tabs this had. With four tabs the underline gave
                no boundary between one label and the next, so the strip read as
                a sentence; a pill group reads as a set of choices. */}
            <TabStrip tabs={showTabs} tab={tab} setTab={setTab} />

            {tab === 'rules' && (
              <RulesTab
                {...formProps}
                columns={columns} scheduled={scheduled} noun={noun}
                warnAt={warnAt} warnKey={warnKey} warningControl={warningControl}
                setMultiAlert={setMultiAlert} destOptions={destOptions}
                destLoading={destLoading} setDestLoading={setDestLoading}
                refreshDestinations={refreshDestinations}
                setShowDestDialog={setShowDestDialog}
              />
            )}

            {/* ── Compare with Past ──────────────────────────────────────── */}
            {tab === 'compare' && (
              <CompareTab
                {...formProps}
                compareBlocked={compareBlocked}
                setWindow={setWindow} addWindow={addWindow} removeWindow={removeWindow}
              />
            )}

            {/* ── Deduplication ─────────────────────────────────────────────
                Suppresses a REPEAT of the same alert, which is a different
                thing from the cooldown on the Alert Rules tab: the cooldown
                silences this alert for a fixed time after it fires, while
                deduplication decides whether two firings are the same alert at
                all. Grouped by `host_name`, an alert pages once per host rather
                than once per matching row. */}
            {tab === 'dedup' && <DedupTab {...formProps} columns={columns} />}

            {tab === 'advanced' && (
              <AdvancedTab
                {...formProps}
                templates={templates}
                warnAt={warnAt} warnKey={warnKey} warningControl={warningControl}
                setMultiAlert={setMultiAlert}
                setVariable={setVariable} addVariable={addVariable}
                removeVariable={removeVariable}
              />
            )}
          </section>
        </div>

        {/* ── Right: Preview + Summary ─────────────────────────────────── */}
        <div className="ae-right">
          <PreviewCard form={form} preview={preview} runPreview={runPreview} />

          <SummaryCard
            form={form} folderList={folderList} folderId={folderId}
            scheduled={scheduled} firesWhen={firesWhen}
            warnKey={warnKey} warnOperator={warnOperator}
          />
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <EditorFooter
        saveError={saveError} setSaveError={setSaveError}
        touched={touched} errorCount={errorCount} isEdit={isEdit}
        onClose={onClose} saving={saving} onSave={onSave}
      />

      {showDestDialog && (
        <DestinationDialog
          onCancel={() => setShowDestDialog(false)}
          onCreated={onDestinationCreated}
        />
      )}
    </div>
  );
}

AlertEditor.propTypes = {
  /** Alert id to edit; null creates a new one. */
  alertId: PropTypes.string,
  folders: PropTypes.array,
  initialFolderId: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  /** Called with { message } after a successful save. */
  onSaved: PropTypes.func.isRequired,
};

/* ── Sections ──────────────────────────────────────────────────────────────
 *
 * The editor's render, split by card and tab. Each is a plain view over the
 * editor's state: every value and setter is passed in and none of them holds
 * state of its own, so which one is on screen never changes what is saved. */

const formPropTypes = {
  form: PropTypes.object.isRequired,
  set: PropTypes.func.isRequired,
  errors: PropTypes.object.isRequired,
  showErr: PropTypes.func.isRequired,
};

/**
 * The optional second, lower threshold — rendered beside whichever critical
 * threshold is currently in play.
 *
 * One function rather than the same markup three times: the warning tier
 * appears next to the event count (Settings), the aggregation's having value
 * (Advanced) and the PromQL value (Alert Rules), and only ever one of them.
 * The operator is shown as TEXT because it is shared with the critical
 * threshold — a warning on a different comparison than its critical is not a
 * thing OpenObserve can store.
 */
function WarningControl({ operator, form, set, warnKey, warnShown, setWarnOpen }) {
  if (!warnKey) return null;
  if (!warnShown) {
    return (
      <button
        type="button" className="alerts-btn-ghost"
        onClick={() => setWarnOpen(true)}
      >+ Add warning</button>
    );
  }
  return (
    <span className="ae-warn">
      <span className="ae-label">Warning if</span>
      <span className="ae-warn-op">{operator}</span>
      <input
        type="number" className="ae-input ae-input--num"
        value={form[warnKey]}
        placeholder="optional"
        aria-label="Warning threshold"
        onChange={(e) => set({ [warnKey]: e.target.value })}
      />
      <button
        type="button" className="ae-warn-x"
        title="Remove warning" aria-label="Remove warning"
        onClick={() => { setWarnOpen(false); set({ [warnKey]: '' }); }}
      >×</button>
    </span>
  );
}

WarningControl.propTypes = {
  operator: PropTypes.string,
  form: PropTypes.object.isRequired,
  set: PropTypes.func.isRequired,
  warnKey: PropTypes.string,
  warnShown: PropTypes.bool,
  setWarnOpen: PropTypes.func.isRequired,
};

function EditorTopbar({
  form, set, errors, showErr, isEdit, onClose,
  folderOptions, folderId, setFolderId, setTouched,
  showFolderInput, setShowFolderInput, newFolderName, setNewFolderName, onCreateFolder,
}) {
  return (
    <div className="ae-topbar">
      <button type="button" className="ae-back" onClick={onClose} aria-label="Back to alerts">
        <IconBack />
      </button>

      {/* The name is the screen's TITLE, not a labelled field — it is what
          this alert is, and the reference treats it that way: a borderless
          heading you type into, with the folder as a subtitle beneath. The
          previous label-plus-input-plus-select strip spent the whole width on
          chrome and still left the name looking like one field among four. */}
      <div className="ae-title-block">
        <div className="ae-title-row">
          <input
            id="ae-name"
            className="ae-title-input"
            value={form.name}
            placeholder="Alert name"
            aria-label="Alert name"
            maxLength={200}
            /* Sized to its content so the asterisk and pencil sit against
               the text, as they do in the reference, instead of at the far
               end of a fixed-width box. `size` is in characters and CSS
               cannot shrink-wrap an input, so this is the mechanism — the
               floor keeps the placeholder from being clipped, the ceiling
               stops a long name from pushing the toggle off the row. */
            size={Math.min(40, Math.max(11, form.name.length + 1))}
            onChange={(e) => set({ name: e.target.value })}
          />
          <span className="ae-req" title="Required">*</span>
          {/* A label, not a button: clicking it focuses the input for free,
              and it stays out of the tab order, which a decorative button
              would not. */}
          <label className="ae-title-pencil" htmlFor="ae-name" title="Edit the alert name">
            <IconPencil />
          </label>
        </div>

        <div className="ae-subtitle">
          <span>{isEdit ? 'Edit Alert in' : 'Add Alert in'}</span>
          {/* SearchableSelect, not a native <select>.
              A native select's dropdown is painted by the browser, and it
              takes its colours from the control's own `background-color` —
              which for a control styled to read as inline text is
              `transparent`, so Chrome fell back to a white panel sized to
              nothing in particular. There is no CSS fix that keeps the
              control looking like text AND themes the popup.
              This is also the same control the Stream Name field below uses,
              so the two dropdowns in this editor now behave identically, and
              the folder list is searchable — which matters here, where
              folders are a real hierarchy rather than a handful. */}
          <SearchableSelect
            className="ssel--folder"
            options={folderOptions}
            value={folderId}
            onChange={(v) => { setTouched(true); setFolderId(v); }}
            placeholder="Select folder…"
            searchPlaceholder="Search folders…"
            emptyLabel="No folders found."
            missingSuffix="(missing)"
            ariaLabel="Folder"
          />

          {showFolderInput ? (
            <span className="ae-field">
              <input
                className="ae-input"
                value={newFolderName}
                placeholder="New folder name"
                aria-label="New folder name"
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); onCreateFolder(); }
                }}
              />
              <button
                type="button" className="alerts-btn-ghost" onClick={onCreateFolder}
              >Add</button>
              <button
                type="button" className="alerts-btn-ghost"
                onClick={() => { setShowFolderInput(false); setNewFolderName(''); }}
              >Cancel</button>
            </span>
          ) : (
            <button
              type="button" className="ae-folder-add"
              onClick={() => setShowFolderInput(true)}
              title="New folder" aria-label="New folder"
            >+</button>
          )}
        </div>

        {/* Inline under the name it belongs to, rather than a full-width red
            banner across the top of the screen. The banner shouted about one
            empty field and pushed the whole form down while doing it. */}
        {showErr('name') && <div className="ae-error">{errors.name}</div>}
      </div>

      <span className="ae-topbar-right">
        <button
          type="button"
          className={`tb-switch ${form.enabled ? 'is-on' : ''}`}
          onClick={() => set({ enabled: !form.enabled })}
          aria-pressed={form.enabled}
          title={form.enabled
            ? 'This alert will evaluate once saved'
            : 'Saved but paused — it will not evaluate or notify'}
        >
          <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
          <span>{form.enabled ? 'Enabled' : 'Disabled'}</span>
        </button>
      </span>
    </div>
  );
}

EditorTopbar.propTypes = {
  ...formPropTypes,
  isEdit: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  folderOptions: PropTypes.array.isRequired,
  folderId: PropTypes.string,
  setFolderId: PropTypes.func.isRequired,
  setTouched: PropTypes.func.isRequired,
  showFolderInput: PropTypes.bool,
  setShowFolderInput: PropTypes.func.isRequired,
  newFolderName: PropTypes.string,
  setNewFolderName: PropTypes.func.isRequired,
  onCreateFolder: PropTypes.func.isRequired,
};

function StreamConfigCard({ form, set, errors, showErr, streams }) {
  return (
    <section className="ae-card">
      <div className="ae-card-head">Stream Config <span className="ae-req">*</span></div>
      <div className="ae-card-body">
        {/* Order matches the reference — Alert Type, Stream Type, Stream
            Name — and it is the order the decisions are actually made in:
            the alert's KIND governs which of the controls below even
            appear, and the stream name is meaningless until the type
            above it is chosen. */}
        <div className="ae-inline">
          <span className="ae-field">
            <span className="ae-label">Alert Type</span>
            <select
              className="ae-select"
              value={form.alertType}
              aria-label="Alert type"
              onChange={(e) => set({ alertType: e.target.value })}
            >
              {ALERT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </span>

          <span className="ae-field">
            <span className="ae-label">Stream Type <span className="ae-req">*</span></span>
            <select
              className="ae-select"
              value={form.streamType}
              aria-label="Stream type"
              onChange={(e) => set({
                streamType: e.target.value,
                // The stream list is per type, so the previously chosen
                // name almost certainly does not exist under the new type.
                // Keeping it would send a name the backend will reject.
                streamName: '',
              })}
            >
              {STREAM_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </span>

          <span className="ae-field ae-field--grow">
            <span className="ae-label">Stream Name <span className="ae-req">*</span></span>
            {/* Searchable rather than a native select: a metrics org here
                reports ~2,000 streams, and a native list can only be
                scrolled, not filtered. SearchableSelect also keeps a
                no-longer-existing stream name selected and flagged, so
                editing an alert cannot silently repoint it. */}
            <SearchableSelect
              className="ssel--grow"
              options={streams}
              value={form.streamName}
              onChange={(v) => set({ streamName: v })}
              placeholder="Select…"
              searchPlaceholder={`Search ${form.streamType} streams…`}
              emptyLabel={`No ${form.streamType} streams found.`}
              missingSuffix="(missing)"
              ariaLabel="Stream name"
            />
          </span>
        </div>

        {showErr('streamName') && <div className="ae-error">{errors.streamName}</div>}
        {/* The ONE place realtime's difference is explained. It used to be
            said here AND again as a large block down in Settings, which
            between them took more vertical space than the settings they
            were describing. */}
        {form.alertType === 'realtime' && (
          <div className="ae-hint">
            Evaluated against every row as it is ingested, so it fires on the
            first match and has no window, cadence or threshold — only
            conditions and the cooldown. Need “N times in M minutes”? Use a
            Scheduled alert.
          </div>
        )}
      </div>
    </section>
  );
}

StreamConfigCard.propTypes = { ...formPropTypes, streams: PropTypes.array.isRequired };

function TabStrip({ tabs: showTabs, tab, setTab }) {
  return (
    <div className="ae-tabs" role="tablist" aria-label="Alert definition">
      {showTabs.map((t) => (
        <button
          key={t.id}
          type="button" role="tab" aria-selected={tab === t.id}
          className={`ae-tab ${tab === t.id ? 'is-active' : ''}`}
          onClick={() => setTab(t.id)}
        >
          <span className="ae-tab-icon">{t.icon}</span>
          <span>{t.label}</span>
          {t.required && <span className="ae-req">*</span>}
          {/* A count on the tab, because something configured on a tab
              that is not open changes what the alert does while being
              invisible from every other tab. */}
          {t.badge > 0 && <span className="ae-tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

TabStrip.propTypes = {
  tabs: PropTypes.array.isRequired,
  tab: PropTypes.string.isRequired,
  setTab: PropTypes.func.isRequired,
};

/** Alert Rules: the Conditions and Settings steps of the reference UI. */
function RulesTab(props) {
  return (
    <>
      <ConditionsSection {...props} />

      {/* Settings */}
      <SettingsSection {...props} />
    </>
  );
}

function ConditionsSection({
  form, set, errors, showErr, columns, scheduled, warnKey, warningControl, setMultiAlert,
}) {
  return (
    <>
      <div className="ae-card-head">Conditions</div>
      <div className="ae-card-body">
        <div className="ae-inline" style={{ marginBottom: '0.6rem' }}>
          <span className="ae-field">
            <span className="ae-label">Query Type</span>
            <select
              className="ae-select"
              value={form.queryType}
              aria-label="Query type"
              onChange={(e) => set({ queryType: e.target.value })}
            >
              {QUERY_TYPES.map((q) => (
                <option key={q.value} value={q.value}>{q.label}</option>
              ))}
            </select>
          </span>
          {!columns.length && form.streamName && form.queryType === 'custom' && (
            <span className="ae-hint">
              No schema reported for “{form.streamName}” — type field names directly.
            </span>
          )}
        </div>

        {form.queryType === 'custom' && (
          <>
            <ConditionBuilder
              tree={form.conditions}
              columns={columns}
              onChange={(next) => set({ conditions: next })}
            />
            {showErr('conditions') && (
              <div className="ae-error" style={{ marginTop: '0.5rem' }}>
                {errors.conditions}
              </div>
            )}
          </>
        )}

        {form.queryType === 'sql' && (
          <div className="ae-stack">
            <label className="ae-stack-label" htmlFor="ae-sql">
              SQL <span className="ae-req">*</span>
            </label>
            <textarea
              id="ae-sql"
              className="ai-editor"
              style={{ minHeight: 120 }}
              value={form.sql}
              placeholder={'SELECT count(*) AS total FROM "default" WHERE code >= 500'}
              onChange={(e) => set({ sql: e.target.value })}
            />
            {showErr('sql') && <div className="ae-error">{errors.sql}</div>}
          </div>
        )}

        {form.queryType === 'promql' && (
          <PromqlQuery
            form={form} set={set} errors={errors} showErr={showErr}
            scheduled={scheduled} warnKey={warnKey}
            warningControl={warningControl} setMultiAlert={setMultiAlert}
          />
        )}
      </div>
    </>
  );
}

/* The threshold rows are SIBLINGS of the .ae-stack, not
   children of it: `.ae-stack .ae-input` forces width:100%
   on every descendant input, which stacked the operator
   and value controls into two full-width blocks instead of
   laying them out along the row. */
function PromqlQuery({
  form, set, errors, showErr, scheduled, warnKey, warningControl, setMultiAlert,
}) {
  return (
    <>
      <div className="ae-stack">
        <label className="ae-stack-label" htmlFor="ae-promql">
          PromQL <span className="ae-req">*</span>
        </label>
        <textarea
          id="ae-promql"
          className="ai-editor"
          style={{ minHeight: 90 }}
          value={form.promql}
          placeholder="rate(http_requests_total{status=~'5..'}[5m]) > 1"
          onChange={(e) => set({ promql: e.target.value })}
        />
        {showErr('promql') && <div className="ae-error">{errors.promql}</div>}
      </div>

      {/* A PromQL alert's threshold compares the EXPRESSION'S
          RESULT and is stored in query_condition, not in
          trigger_condition where every other alert type keeps
          it. Without it the alert saves and then never fires,
          which is why it sits here next to the expression
          rather than down in Settings. */}
      {scheduled && (
        <>
          <div className="ae-row">
            <span className="ae-row-label">
              Alert if the value is{' '}
              <span
                title="Alert when the PromQL expression evaluates to this
condition for a time series. Example: >= 100 triggers when the result is 100 or more."
                style={{ cursor: 'help', opacity: 0.6 }}
              >ⓘ</span>
            </span>
            <select
              className="ae-select"
              value={form.promqlOperator}
              aria-label="PromQL threshold operator"
              onChange={(e) => set({ promqlOperator: e.target.value })}
            >
              {THRESHOLD_OPERATORS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <input
              type="number" className="ae-input ae-input--num"
              value={form.promqlValue}
              aria-label="PromQL threshold value"
              onChange={(e) => set({ promqlValue: e.target.value })}
            />
            {warningControl(form.promqlOperator)}
          </div>
          {showErr('promqlValue') && (
            <div className="ae-error">{errors.promqlValue}</div>
          )}
          {warnKey && showErr(warnKey) && (
            <div className="ae-error">{errors[warnKey]}</div>
          )}

          <div className="ae-row">
            <span className="ae-row-label">
              Multi alert (per series){' '}
              <span
                title="Evaluate every series the query returns on its own and
notify separately for each. The series' labels are its identity — use the
expression's by (…) clause to choose them."
                style={{ cursor: 'help', opacity: 0.6 }}
              >ⓘ</span>
            </span>
            <button
              type="button"
              className={`tb-switch ${form.promqlMultiAlert ? 'is-on' : ''}`}
              onClick={() => setMultiAlert(
                'promqlMultiAlert', !form.promqlMultiAlert,
              )}
              aria-pressed={form.promqlMultiAlert}
            >
              <span className="tb-switch-track">
                <span className="tb-switch-thumb" />
              </span>
              <span>{form.promqlMultiAlert ? 'Per series' : 'Single'}</span>
            </button>
            <span className="ae-hint">
              {form.promqlMultiAlert
                ? 'Each series alerts, recovers and notifies on its own.'
                : 'Every series collapses into one state and one notification.'}
            </span>
          </div>
        </>
      )}
    </>
  );
}

function SettingsSection({
  form, set, errors, showErr, scheduled, noun, warnAt, warnKey, warningControl,
  destOptions, destLoading, setDestLoading, refreshDestinations, setShowDestDialog,
}) {
  return (
    <>
      <div className="ae-card-head">Settings</div>
      <div className="ae-card-body">
        {/* Realtime alerts have no window, cadence or threshold, so
            those three rows are simply absent below — as they are in
            the reference. The explanation lives once, next to the
            Alert Type control that causes it; it used to be repeated
            here as a three-paragraph block that took more room than
            the settings it was describing. */}
        {!scheduled && (
          <div className="ae-hint" style={{ marginTop: 0 }}>
            No window, cadence or threshold for a realtime alert — it fires on
            the first matching row. The cooldown below controls how often it
            may repeat.
          </div>
        )}

        {scheduled && (
          <ScheduleSettings
            form={form} set={set} errors={errors} showErr={showErr}
            noun={noun} warnAt={warnAt} warnKey={warnKey} warningControl={warningControl}
          />
        )}

        <div className="ae-row">
          <span className="ae-row-label">
            Cooldown period <span className="ae-req">*</span>
            <span
              title="After firing, the alert stays silent for this long. Prevents one
incident becoming hundreds of notifications."
              style={{ cursor: 'help', opacity: 0.6 }}
            >ⓘ</span>
          </span>
          <span className="ae-unit-group">
            <input
              type="number" min="0" className="ae-input ae-input--num"
              value={form.silence}
              aria-label="Cooldown period"
              onChange={(e) => set({ silence: e.target.value })}
            />
            <span className="ae-unit">Minutes</span>
          </span>
        </div>
        {showErr('silence') && <div className="ae-error">{errors.silence}</div>}

        <div className="ae-row">
          <span className="ae-row-label">
            Destinations <span className="ae-req">*</span>
            <span
              title="Select one or more destinations to send alert notifications."
              style={{ cursor: 'help', opacity: 0.6 }}
            >ⓘ</span>
          </span>
          {/* `destinations` is an ARRAY in OpenObserve's document and
              multiple notification channels for one alert is the
              normal case — page the on-call webhook and post to the
              team's channel. This was a single select, which could
              only ever write one and would DROP the rest when an
              alert authored elsewhere was edited here. */}
          <CheckboxSelect
            options={destOptions}
            value={form.destinations}
            onChange={(next) => set({ destinations: next })}
            allLabel="Select…"
            noun="destinations"
            ariaLabel="Destinations"
          />
          {/* Destinations are fetched once on mount, so one created in
              another tab is not in this list. The reference offers the
              same refresh next to the same select. */}
          <button
            type="button" className="ae-icon-btn"
            onClick={() => { setDestLoading(true); refreshDestinations(); }}
            disabled={destLoading}
            title="Refresh the destination list"
            aria-label="Refresh destinations"
          ><IconRefresh /></button>
          <button
            type="button" className="alerts-btn-ghost"
            onClick={() => setShowDestDialog(true)}
          >Add Destination</button>
        </div>
        {showErr('destinations') && <div className="ae-error">{errors.destinations}</div>}

        <div className="ae-row">
          <span className="ae-row-label">
            Priority{' '}
            <span
              title="How much this alert matters to your team. Used for filtering,
sorting and notification routing — it does not affect when the alert fires."
              style={{ cursor: 'help', opacity: 0.6 }}
            >ⓘ</span>
          </span>
          <select
            className="ae-select"
            value={form.priority}
            aria-label="Priority"
            onChange={(e) => set({ priority: e.target.value })}
          >
            <option value="">Unset</option>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <span className="ae-hint">P1 is the most urgent.</span>
        </div>

        <div className="ae-row ae-row--tall">
          <span className="ae-row-label">
            Tags{' '}
            <span
              title="Labels for filtering and grouping alerts, e.g. prod or
service:checkout. Lower-cased automatically; must start with a letter."
              style={{ cursor: 'help', opacity: 0.6 }}
            >ⓘ</span>
          </span>
          <TokenInput
            value={form.tags}
            onChange={(next) => set({ tags: next })}
            placeholder="prod, service:checkout"
            ariaLabel="Tags"
            // Lower-cased on entry rather than on save, so the chip
            // the user sees is the tag that gets stored.
            normalise={(raw) => (raw || '').trim().toLowerCase()}
          />
        </div>
        {showErr('tags') && <div className="ae-error">{errors.tags}</div>}

        <div className="ae-row">
          <span className="ae-row-label">
            Creates Incident{' '}
            <span
              title="Also open an incident in OpenObserve when this alert fires."
              style={{ cursor: 'help', opacity: 0.6 }}
            >ⓘ</span>
          </span>
          <button
            type="button"
            className={`tb-switch ${form.createsIncident ? 'is-on' : ''}`}
            onClick={() => set({ createsIncident: !form.createsIncident })}
            aria-pressed={form.createsIncident}
          >
            <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
          </button>
        </div>
      </div>
    </>
  );
}

function ScheduleSettings({
  form, set, errors, showErr, noun, warnAt, warnKey, warningControl,
}) {
  return (
    <>
      <div className="ae-row">
        <span className="ae-row-label">
          Look back window <span className="ae-req">*</span>
        </span>
        <span className="ae-unit-group">
          <input
            type="number" min="1" className="ae-input ae-input--num"
            value={form.period}
            aria-label="Look back window"
            onChange={(e) => set({ period: e.target.value })}
          />
          <span className="ae-unit">Minutes</span>
        </span>
        <span className="ae-hint">
          How far back each evaluation looks.
        </span>
      </div>
      {showErr('period') && <div className="ae-error">{errors.period}</div>}

      <div className="ae-row">
        <span className="ae-row-label">
          Check every <span className="ae-req">*</span>
        </span>
        <select
          className="ae-select"
          value={form.frequencyType}
          aria-label="Schedule type"
          onChange={(e) => set({ frequencyType: e.target.value })}
        >
          <option value="minutes">Interval</option>
          <option value="cron">Cron</option>
        </select>
        {form.frequencyType === 'cron' ? (
          <input
            className="ae-input ae-input--grow"
            value={form.cron}
            placeholder="*/5 * * * *"
            aria-label="Cron expression"
            onChange={(e) => set({ cron: e.target.value })}
          />
        ) : (
          <span className="ae-unit-group">
            <input
              type="number" min="1" className="ae-input ae-input--num"
              value={form.frequency}
              aria-label="Frequency"
              onChange={(e) => set({ frequency: e.target.value })}
            />
            <span className="ae-unit">Minutes</span>
          </span>
        )}
      </div>
      {showErr('frequency') && <div className="ae-error">{errors.frequency}</div>}
      {showErr('cron') && <div className="ae-error">{errors.cron}</div>}

      <div className="ae-row">
        <span className="ae-row-label">
          {thresholdLabel(form)}
          {noun !== 'events' && (
            <span
              title={noun === 'series'
                ? 'Minimum number of time series that must satisfy the '
                  + 'condition above to trigger the alert.'
                : 'Minimum number of groups that must satisfy the '
                  + 'condition above to trigger the alert.'}
              style={{ cursor: 'help', opacity: 0.6 }}
            >ⓘ</span>
          )}
        </span>
        <span className="ae-field">
          {/* The noun is derived, not fixed: this same field
              counts events, matching GROUPS once an aggregation
              groups by something, or matching SERIES for
              PromQL. Labelling it "count" throughout is how
              someone sets 100 and never gets paged. */}
          <span className="ae-label">{noun}</span>
          <select
            className="ae-select"
            value={form.thresholdOperator}
            aria-label="Threshold operator"
            onChange={(e) => set({ thresholdOperator: e.target.value })}
          >
            {THRESHOLD_OPERATORS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <input
            type="number" min="0" className="ae-input ae-input--num"
            value={form.threshold}
            aria-label="Threshold"
            onChange={(e) => set({ threshold: e.target.value })}
          />
        </span>
        {warnAt === 'trigger' && warningControl(form.thresholdOperator)}
      </div>
      {showErr('threshold') && <div className="ae-error">{errors.threshold}</div>}
      {showErr('thresholdOperator') && (
        <div className="ae-error">{errors.thresholdOperator}</div>
      )}
      {warnAt === 'trigger' && showErr(warnKey) && (
        <div className="ae-error">{errors[warnKey]}</div>
      )}
    </>
  );
}

RulesTab.propTypes = { form: PropTypes.object.isRequired, set: PropTypes.func.isRequired };
ConditionsSection.propTypes = { ...formPropTypes, columns: PropTypes.array, scheduled: PropTypes.bool, warnKey: PropTypes.string, warningControl: PropTypes.func.isRequired, setMultiAlert: PropTypes.func };
PromqlQuery.propTypes = { ...formPropTypes, scheduled: PropTypes.bool, warnKey: PropTypes.string, warningControl: PropTypes.func.isRequired, setMultiAlert: PropTypes.func };
SettingsSection.propTypes = { ...formPropTypes, scheduled: PropTypes.bool, noun: PropTypes.string, warnAt: PropTypes.string, warnKey: PropTypes.string, warningControl: PropTypes.func.isRequired, destOptions: PropTypes.array, destLoading: PropTypes.bool, setDestLoading: PropTypes.func, refreshDestinations: PropTypes.func, setShowDestDialog: PropTypes.func };
ScheduleSettings.propTypes = { ...formPropTypes, noun: PropTypes.string, warnAt: PropTypes.string, warnKey: PropTypes.string, warningControl: PropTypes.func.isRequired };

function CompareTab({
  form, errors, showErr, compareBlocked, setWindow, addWindow, removeWindow,
}) {
  return (
    <div className="ae-card-body">
      {compareBlocked ? (
        <div className="ae-realtime-note">
          <strong>{compareBlocked.title}</strong>
          <span>{compareBlocked.body}</span>
          {/* Said out loud because the save is what removes them, and
              an alert that quietly loses its comparison windows on an
              unrelated edit is the kind of change nobody notices
              until the alert stops behaving as it used to. */}
          {form.multiWindows.length > 0 && (
            <span>
              <strong>
                This alert has {form.multiWindows.length} comparison window
                {form.multiWindows.length === 1 ? '' : 's'} configured.
              </strong>{' '}
              Saving while it is not a scheduled SQL alert will remove
              {form.multiWindows.length === 1 ? ' it' : ' them'}.
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="ae-hint" style={{ marginTop: 0 }}>
            Compare this window&rsquo;s result against the same query run over an
            earlier one — &ldquo;5xx up on last week&rdquo; rather than a fixed
            number. Each window re-runs the alert&rsquo;s own SQL, shifted back
            by its offset.
          </div>

          <div className="ae-row">
            <span className="ae-row-label">Current window</span>
            <span className="ae-hint" style={{ marginTop: 0 }}>
              Running for {formatMinutes(form.period)}, every{' '}
              {form.frequencyType === 'cron'
                ? `cron: ${form.cron || 'not set'}`
                : formatMinutes(form.frequency)}
            </span>
          </div>

          {form.multiWindows.length === 0 && (
            <div className="ae-hint">
              No comparison windows — the alert is evaluated on the current
              window alone.
            </div>
          )}

          {form.multiWindows.map((w, i) => (
            <div className="ae-window" key={w.key}>
              <div className="ae-window-head">
                <span className="ae-window-title">Reference Window {i + 1}</span>
                <button
                  type="button" className="ae-warn-x"
                  title="Remove this comparison window"
                  aria-label={`Remove reference window ${i + 1}`}
                  onClick={() => removeWindow(w.key)}
                >×</button>
              </div>
              <div className="ae-row">
                <span className="ae-row-label">Time Frame</span>
                <span className="ae-field">
                  <span className="ae-label">previous</span>
                  <input
                    type="number" min="1" className="ae-input ae-input--num"
                    value={w.amount}
                    aria-label={`Offset amount for reference window ${i + 1}`}
                    onChange={(e) => setWindow(w.key, { amount: e.target.value })}
                  />
                  <select
                    className="ae-select"
                    value={w.unit}
                    aria-label={`Offset unit for reference window ${i + 1}`}
                    onChange={(e) => setWindow(w.key, { unit: e.target.value })}
                  >
                    {OFFSET_UNITS.map((u) => (
                      <option key={u.value} value={u.value}>{u.label}</option>
                    ))}
                  </select>
                </span>
              </div>
              <div className="ae-hint">
                Comparing the current window&rsquo;s result with the result from
                previous {formatOffset(w.amount, w.unit)}.
              </div>
            </div>
          ))}

          <div className="ae-row">
            <button
              type="button" className="alerts-btn-ghost" onClick={addWindow}
            >+ Add Comparison Window</button>
          </div>
          {showErr('multiWindows') && (
            <div className="ae-error">{errors.multiWindows}</div>
          )}
        </>
      )}
    </div>
  );
}

CompareTab.propTypes = {
  ...formPropTypes,
  compareBlocked: PropTypes.shape({ title: PropTypes.string, body: PropTypes.string }),
  setWindow: PropTypes.func.isRequired,
  addWindow: PropTypes.func.isRequired,
  removeWindow: PropTypes.func.isRequired,
};

function DedupTab({ form, set, errors, showErr, columns }) {
  return (
    <div className="ae-card-body">
      <div className="ae-stack">
        <label className="ae-stack-label" htmlFor="ae-dedup-fields">
          Group similar alerts by
        </label>
        <div className="ae-hint" style={{ marginTop: 0, marginBottom: '0.4rem' }}>
          Fields that make two firings &ldquo;the same alert&rdquo; — e.g.
          hostname or service. Leave empty to auto-detect from the query
          (SQL: its GROUP BY columns, PromQL: its labels, Custom: the
          condition fields).
        </div>
        <TokenInput
          id="ae-dedup-fields"
          value={form.dedupFields}
          onChange={(next) => set({ dedupFields: next })}
          suggestions={columns}
          placeholder="host_name"
          ariaLabel="Deduplication fields"
        />
        <div className="ae-hint">
          Alerts of DIFFERENT kinds are never grouped, even from the same host —
          this only collapses repeats of this alert.
        </div>
      </div>

      <div className="ae-row">
        <span className="ae-row-label">
          Identical within{' '}
          <span
            title="How long to remember recent firings for grouping. A similar
alert inside this window is not sent again. Leave empty to use the check interval."
            style={{ cursor: 'help', opacity: 0.6 }}
          >ⓘ</span>
        </span>
        <span className="ae-unit-group">
          <input
            type="number" min="0" className="ae-input ae-input--num"
            value={form.dedupWindow}
            placeholder="auto"
            aria-label="Deduplication time window"
            onChange={(e) => set({ dedupWindow: e.target.value })}
          />
          <span className="ae-unit">Minutes</span>
        </span>
        <span className="ae-hint">
          Empty matches the check interval
          {form.frequencyType === 'cron'
            ? '.'
            : ` (${formatMinutes(form.frequency)}).`}
        </span>
      </div>
      {showErr('dedupWindow') && <div className="ae-error">{errors.dedupWindow}</div>}
    </div>
  );
}

DedupTab.propTypes = { ...formPropTypes, columns: PropTypes.array };

function AdvancedTab({
  form, set, errors, showErr, templates, warnAt, warnKey, warningControl,
  setMultiAlert, setVariable, addVariable, removeVariable,
}) {
  /* ── Advanced ─────────────────────────────────────────────── */
  return (
    <div className="ae-card-body">
      <div className="ae-row">
        <span className="ae-row-label">Aggregation</span>
        <button
          type="button"
          className={`tb-switch ${form.aggregationEnabled ? 'is-on' : ''}`}
          onClick={() => set({ aggregationEnabled: !form.aggregationEnabled })}
          aria-pressed={form.aggregationEnabled}
          title="Group matching rows and threshold on an aggregate instead of a count"
        >
          <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
          <span>{form.aggregationEnabled ? 'On' : 'Off'}</span>
        </button>
      </div>

      {form.aggregationEnabled && (
        <AggregationSettings
          form={form} set={set} errors={errors} showErr={showErr}
          warnAt={warnAt} warnKey={warnKey} warningControl={warningControl}
          setMultiAlert={setMultiAlert}
        />
      )}

      <div className="ae-row">
        <span className="ae-row-label">Timezone</span>
        <input
          className="ae-input"
          value={form.timezone}
          placeholder="UTC"
          aria-label="Timezone"
          onChange={(e) => set({ timezone: e.target.value })}
        />
      </div>

      <div className="ae-row">
        <span className="ae-row-label">
          Align time{' '}
          <span
            title="Snap each evaluation to the clock (e.g. :00, :05) instead of
running relative to when the alert was saved."
            style={{ cursor: 'help', opacity: 0.6 }}
          >ⓘ</span>
        </span>
        <button
          type="button"
          className={`tb-switch ${form.alignTime ? 'is-on' : ''}`}
          onClick={() => set({ alignTime: !form.alignTime })}
          aria-pressed={form.alignTime}
        >
          <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
        </button>
      </div>

      {/* Template Override.
          Each destination already carries its own template; setting
          one here overrides ALL of them, for this alert only. Left
          absent unless chosen, so an alert that relies on its
          destinations' templates keeps doing that. */}
      <div className="ae-row">
        <span className="ae-row-label">
          Template override{' '}
          <span
            title="The notification message that gets sent. Picking one here
overrides each destination's own template, for this alert only."
            style={{ cursor: 'help', opacity: 0.6 }}
          >ⓘ</span>
        </span>
        <select
          className="ae-select ae-select--grow"
          value={form.template}
          aria-label="Template override"
          onChange={(e) => set({ template: e.target.value })}
        >
          <option value="">
            {templates.length
              ? 'None — each destination uses its own'
              : 'No templates available'}
          </option>
          {/* A template that has since been renamed or deleted stays
              selectable, for the same reason a missing destination
              does: silently switching the alert back to its
              destinations' templates would change what it sends. */}
          {form.template && !templates.some((t) => t.name === form.template) && (
            <option value={form.template}>{form.template} (missing)</option>
          )}
          {templates.map((t) => (
            <option key={t.name} value={t.name}>{t.name}</option>
          ))}
        </select>
      </div>

      {/* Additional Variables — `context_attributes`.
          Your own values, usable as {name} anywhere in the template
          and carried on the fired alert. Previously round-tripped but
          not editable, so an alert could carry variables nobody using
          this app could see or change. */}
      <div className="ae-stack">
        <span className="ae-stack-label">Additional variables</span>
        <div className="ae-hint" style={{ marginTop: 0, marginBottom: '0.4rem' }}>
          Named values of your own. Write <code>{'{name}'}</code> in the
          template and it is filled in when the alert fires.
        </div>

        {form.variables.length === 0 && (
          <div className="ae-hint">None set.</div>
        )}

        {form.variables.map((v) => (
          <div className="ae-varrow" key={v.key}>
            <input
              className="ae-input"
              value={v.name}
              placeholder="name"
              aria-label="Variable name"
              onChange={(e) => setVariable(v.key, { name: e.target.value })}
            />
            <input
              className="ae-input ae-input--grow"
              value={v.value}
              placeholder="value"
              aria-label={`Value for ${v.name || 'variable'}`}
              onChange={(e) => setVariable(v.key, { value: e.target.value })}
            />
            <button
              type="button" className="ae-warn-x"
              title="Remove variable"
              aria-label={`Remove variable ${v.name || ''}`}
              onClick={() => removeVariable(v.key)}
            >×</button>
          </div>
        ))}

        <div className="ae-row">
          <button
            type="button" className="alerts-btn-ghost" onClick={addVariable}
          >+ Add variable</button>
        </div>
        {showErr('variables') && <div className="ae-error">{errors.variables}</div>}
      </div>

      <div className="ae-stack">
        <label className="ae-stack-label" htmlFor="ae-desc">Description</label>
        <input
          id="ae-desc"
          className="ae-input"
          value={form.description}
          placeholder="What this alert means and who should act on it"
          onChange={(e) => set({ description: e.target.value })}
        />
      </div>

      <div className="ae-stack">
        <label className="ae-stack-label" htmlFor="ae-vrl">VRL function</label>
        <textarea
          id="ae-vrl"
          className="ai-editor"
          style={{ minHeight: 70 }}
          value={form.vrlFunction}
          placeholder="Optional VRL applied to each row before evaluation"
          onChange={(e) => set({ vrlFunction: e.target.value })}
        />
      </div>

      <div className="ae-stack">
        <label className="ae-stack-label" htmlFor="ae-rowtpl">Row template</label>
        <input
          id="ae-rowtpl"
          className="ae-input"
          value={form.rowTemplate}
          placeholder="Optional per-row line in the notification body"
          onChange={(e) => set({ rowTemplate: e.target.value })}
        />
      </div>

      {/* How the per-row output is assembled: rows joined as text, or
          emitted as a JSON array. It only matters once a row template
          exists, so the control is shown with it rather than as a
          standalone setting nothing appears to affect. */}
      {form.rowTemplate.trim() !== '' && (
        <div className="ae-row">
          <span className="ae-row-label">Row template type</span>
          <select
            className="ae-select"
            value={form.rowTemplateType}
            aria-label="Row template type"
            onChange={(e) => set({ rowTemplateType: e.target.value })}
          >
            {ROW_TEMPLATE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <span className="ae-hint">
            {form.rowTemplateType === 'json'
              ? 'Rows are emitted as a JSON array.'
              : 'Rows are joined into one text block.'}
          </span>
        </div>
      )}
    </div>
  );
}

function AggregationSettings({
  form, set, errors, showErr, warnAt, warnKey, warningControl, setMultiAlert,
}) {
  return (
    <>
      <div className="ae-row">
        <span className="ae-row-label">Function</span>
        <select
          className="ae-select"
          value={form.aggFunction}
          aria-label="Aggregation function"
          onChange={(e) => set({ aggFunction: e.target.value })}
        >
          {AGG_FUNCTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select
          className="ae-select"
          value={form.aggHavingOperator}
          aria-label="Having operator"
          onChange={(e) => set({ aggHavingOperator: e.target.value })}
        >
          {THRESHOLD_OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          type="number" className="ae-input ae-input--num"
          value={form.aggHavingValue}
          aria-label="Having value"
          onChange={(e) => set({ aggHavingValue: e.target.value })}
        />
        {warnAt === 'aggregation' && warningControl(form.aggHavingOperator)}
      </div>
      {showErr('aggHavingValue') && (
        <div className="ae-error">{errors.aggHavingValue}</div>
      )}
      {warnAt === 'aggregation' && showErr(warnKey) && (
        <div className="ae-error">{errors[warnKey]}</div>
      )}

      <div className="ae-row">
        <span className="ae-row-label">
          Group by{' '}
          <span
            title="Group results by these fields — the alert then evaluates
one result per unique combination."
            style={{ cursor: 'help', opacity: 0.6 }}
          >ⓘ</span>
        </span>
        <input
          className="ae-input ae-input--grow"
          value={form.aggGroupBy}
          placeholder="service_name, host_name"
          aria-label="Group by columns"
          onChange={(e) => set({ aggGroupBy: e.target.value })}
        />
        <span className="ae-hint">Comma separated.</span>
      </div>
      {showErr('aggGroupBy') && <div className="ae-error">{errors.aggGroupBy}</div>}

      {/* Grouping alone does NOT give each group its own alert:
          without this, every group collapses into a single state,
          a single cooldown and a single notification, and a
          second breaching host is silent because the first
          already fired. That is the trap this toggle exists to
          make visible. */}
      <div className="ae-row">
        <span className="ae-row-label">
          Alert aggregation{' '}
          <span
            title="Simple: one alert for the whole query, groups collapsed
into a single result. Multi alert: every group is evaluated independently and
alerts, recovers and notifies on its own."
            style={{ cursor: 'help', opacity: 0.6 }}
          >ⓘ</span>
        </span>
        <button
          type="button"
          className={`tb-switch ${form.multiAlert ? 'is-on' : ''}`}
          onClick={() => setMultiAlert('multiAlert', !form.multiAlert)}
          aria-pressed={form.multiAlert}
        >
          <span className="tb-switch-track">
            <span className="tb-switch-thumb" />
          </span>
          <span>{form.multiAlert ? 'Multi alert' : 'Simple alert'}</span>
        </button>
        <span className="ae-hint">
          {form.multiAlert
            ? 'Each group alerts, recovers and notifies on its own.'
            : 'One alert for the whole query; groups collapse into one result.'}
        </span>
      </div>
      {showErr('multiAlert') && <div className="ae-error">{errors.multiAlert}</div>}
    </>
  );
}

AdvancedTab.propTypes = { ...formPropTypes, templates: PropTypes.array, warnAt: PropTypes.string, warnKey: PropTypes.string, warningControl: PropTypes.func.isRequired, setMultiAlert: PropTypes.func.isRequired, setVariable: PropTypes.func, addVariable: PropTypes.func, removeVariable: PropTypes.func };
AggregationSettings.propTypes = { ...formPropTypes, warnAt: PropTypes.string, warnKey: PropTypes.string, warningControl: PropTypes.func.isRequired, setMultiAlert: PropTypes.func.isRequired };

function PreviewBody({ form, preview, runPreview }) {
  if (!form.streamType || !form.streamName) {
    return (
      <div className="ae-placeholder">
        <IconChart />
        <span>Select a stream type and stream name to see a preview</span>
      </div>
    );
  }
  if (form.streamType !== 'logs') {
    return (
      <div className="ae-placeholder">
        <IconChart />
        <span>
          Preview is available for logs streams only — {form.streamType} previews
          would need a query endpoint this backend does not expose yet.
        </span>
      </div>
    );
  }
  return <PreviewSample preview={preview} runPreview={runPreview} />;
}

function PreviewCard({ form, preview, runPreview }) {
  return (
    <section className="ae-card ae-card--fill">
      <div className="ae-card-head ae-card-head--plain">Preview</div>
      <div className="ae-card-body">
        <PreviewBody form={form} preview={preview} runPreview={runPreview} />
      </div>
    </section>
  );
}

function PreviewSample({ preview, runPreview }) {
  return (
    <>
      <div className="ae-inline" style={{ marginBottom: '0.6rem' }}>
        <button
          type="button" className="alerts-btn-ghost"
          onClick={runPreview} disabled={preview.loading}
        >{preview.loading ? 'Running…' : 'Run sample'}</button>
        <span className="ae-hint">
          Recent rows from this stream — a sample, not a test of the alert.
        </span>
      </div>

      {preview.error && <div className="ae-error">{preview.error}</div>}

      {preview.ran && !preview.loading && !preview.error && (
        preview.rows.length === 0 ? (
          <div className="ae-placeholder">
            <span>No rows in the last hour.</span>
          </div>
        ) : (
          <>
            <div className="ae-preview-count">
              Showing {preview.rows.length} recent row(s).
            </div>
            <table className="ae-preview-table">
              <thead>
                <tr>
                  <th>Time</th><th>Service</th><th>Severity</th><th>Message</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={r.id || i}>
                    <td title={r.timestamp}>
                      {r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '—'}
                    </td>
                    <td title={r.serviceName}>{r.serviceName || '—'}</td>
                    <td>{r.severity || r.level || '—'}</td>
                    <td title={r.body || r.message}>{r.body || r.message || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      )}

      {!preview.ran && (
        <div className="ae-placeholder">
          <IconChart />
          <span>Run a sample to see recent rows from this stream.</span>
        </div>
      )}
    </>
  );
}

const previewPropTypes = {
  form: PropTypes.object,
  preview: PropTypes.shape({
    loading: PropTypes.bool,
    rows: PropTypes.array,
    error: PropTypes.string,
    ran: PropTypes.bool,
  }).isRequired,
  runPreview: PropTypes.func.isRequired,
};

PreviewCard.propTypes = previewPropTypes;
PreviewBody.propTypes = previewPropTypes;
PreviewSample.propTypes = {
  preview: PropTypes.shape({
    loading: PropTypes.bool,
    rows: PropTypes.array,
    error: PropTypes.string,
    ran: PropTypes.bool,
  }).isRequired,
  runPreview: PropTypes.func.isRequired,
};

function SummaryCard({
  form, folderList, folderId, scheduled, firesWhen, warnKey, warnOperator,
}) {
  return (
    <section className="ae-card ae-card--fill">
      <div className="ae-card-head ae-card-head--plain">Summary</div>
      <div className="ae-card-body">
        {!form.name && !form.streamName ? (
          <div className="ae-placeholder">
            <IconDoc />
            <span>Configure your alert to see a summary</span>
          </div>
        ) : (
          <dl className="ae-summary">
            <dt>Name</dt><dd>{form.name || '—'}</dd>
            <dt>Type</dt>
            <dd>{form.alertType === 'realtime' ? 'Realtime' : 'Scheduled'}</dd>
            <dt>Stream</dt>
            <dd>{form.streamName ? `${form.streamName} (${form.streamType})` : '—'}</dd>
            <dt>Folder</dt>
            <dd>
              {(folderList.find((f) => f.folderId === folderId)?.name) || folderId}
            </dd>

            <QuerySummary form={form} />

            {scheduled && (
              <ScheduledSummary
                form={form} firesWhen={firesWhen}
                warnKey={warnKey} warnOperator={warnOperator}
              />
            )}

            <dt>Cooldown</dt><dd>{formatMinutes(form.silence)}</dd>
            {/* Deduplication and the cooldown are easy to confuse, so the
                summary shows them adjacent and names what dedup groups
                by rather than just saying "on". */}
            <DedupSummary form={form} />
            <dt>Notifies</dt>
            <dd>{form.destinations.length ? form.destinations.join(', ') : '—'}</dd>
            {form.template && (
              <>
                <dt>Template</dt><dd>{form.template}</dd>
              </>
            )}
            {form.priority !== '' && (
              <>
                <dt>Priority</dt><dd>P{form.priority}</dd>
              </>
            )}
            {form.tags.length > 0 && (
              <>
                <dt>Tags</dt><dd>{form.tags.join(', ')}</dd>
              </>
            )}
            <dt>State</dt>
            <dd>{form.enabled ? 'Enabled' : 'Disabled (will not evaluate)'}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}

/** What the alert evaluates, in the terms of its query type. */
function QuerySummary({ form }) {
  return (
    <>
      {form.queryType === 'custom' && (
        <>
          <dt>Conditions</dt>
          <dd>{countConditions(form.conditions)} condition(s)</dd>
        </>
      )}
      {form.queryType === 'sql' && (
        <>
          <dt>SQL</dt>
          <dd className="ae-summary-sql">{form.sql || '—'}</dd>
        </>
      )}
      {form.queryType === 'promql' && (
        <>
          <dt>PromQL</dt>
          <dd className="ae-summary-sql">{form.promql || '—'}</dd>
        </>
      )}
    </>
  );
}

QuerySummary.propTypes = { form: PropTypes.object.isRequired };

function DedupSummary({ form }) {
  if (form.dedupFields.length === 0 && form.dedupWindow === '') return null;
  return (
    <>
      <dt>Deduplicates</dt>
      <dd>
        {form.dedupFields.length
          ? `by ${form.dedupFields.join(', ')}`
          : 'by auto-detected fields'}
        {form.dedupWindow !== ''
          ? ` within ${formatMinutes(form.dedupWindow)}`
          : ' within the check interval'}
      </dd>
    </>
  );
}

DedupSummary.propTypes = { form: PropTypes.object.isRequired };

function checkedLabel(form) {
  if (form.frequencyType !== 'cron') return `every ${formatMinutes(form.frequency)}`;
  return form.cron ? `cron: ${form.cron}` : 'cron (not set)';
}

function ScheduledSummary({ form, firesWhen, warnKey, warnOperator }) {
  return (
    <>
      <dt>Window</dt><dd>{formatMinutes(form.period)}</dd>
      <dt>Checked</dt>
      <dd>
        {checkedLabel(form)}
      </dd>
      <dt>Fires when</dt>
      <dd>{firesWhen}</dd>
      {warnKey && (form[warnKey] ?? '') !== '' && (
        <>
          <dt>Warning at</dt>
          <dd>{warnOperator} {form[warnKey]}</dd>
        </>
      )}
      {(form.multiAlert || form.promqlMultiAlert) && (
        <>
          <dt>Evaluates</dt>
          <dd>
            {form.promqlMultiAlert
              ? 'Each series on its own'
              : 'Each group on its own'}
          </dd>
        </>
      )}
      {form.queryType === 'sql' && form.multiWindows.length > 0 && (
        <>
          <dt>Compares with</dt>
          <dd>
            {form.multiWindows
              .map((w) => formatOffset(w.amount, w.unit))
              .join(', ')} ago
          </dd>
        </>
      )}
    </>
  );
}

SummaryCard.propTypes = { form: PropTypes.object.isRequired, folderList: PropTypes.array, folderId: PropTypes.string, scheduled: PropTypes.bool, firesWhen: PropTypes.string, warnKey: PropTypes.string, warnOperator: PropTypes.string };
ScheduledSummary.propTypes = { form: PropTypes.object.isRequired, firesWhen: PropTypes.string, warnKey: PropTypes.string, warnOperator: PropTypes.string };

function footerNote(touched, errorCount, isEdit) {
  if (touched && errorCount > 0) return `${errorCount} field(s) need attention`;
  return isEdit ? 'Editing an existing alert — unmodelled fields are preserved.' : '';
}

function EditorFooter({
  saveError, setSaveError, touched, errorCount, isEdit, onClose, saving, onSave,
}) {
  return (
    <>
      {saveError && (
        <div className="alerts-banner alerts-banner--error">
          <span className="alerts-banner-text">{saveError}</span>
          <button
            type="button" className="alerts-banner-x"
            onClick={() => setSaveError('')} aria-label="Dismiss"
          >×</button>
        </div>
      )}

      <div className="ae-foot">
        <span className="ae-foot-left">
          {footerNote(touched, errorCount, isEdit)}
        </span>
        <button
          type="button" className="alerts-btn-ghost" onClick={onClose} disabled={saving}
        >Cancel</button>
        <button
          type="button" className="alerts-btn-primary" onClick={onSave} disabled={saving}
        >{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  );
}

EditorFooter.propTypes = {
  saveError: PropTypes.string,
  setSaveError: PropTypes.func.isRequired,
  touched: PropTypes.bool,
  errorCount: PropTypes.number,
  isEdit: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  saving: PropTypes.bool,
  onSave: PropTypes.func.isRequired,
};
