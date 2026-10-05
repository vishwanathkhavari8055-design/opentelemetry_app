import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import ConditionBuilder from '../ConditionBuilder';
import CompositeStep from './CompositeStep';
import SettingsCard from './SettingsCard';
import AdvancedCard from './AdvancedCard';
import SearchableSelect from '../../common/SearchableSelect';
import { fetchAlertStreamSchema, fetchScopedAlertStreams } from '../../../services/api';
import {
  AGG_NEEDS_COLUMN, ALERT_IF_OPTIONS, FILTER_OPERATORS, FREQUENCY_UNITS,
  ORDERED_OPERATORS, STREAM_TYPES, THRESHOLD_OPERATORS, TOTAL_EVENTS,
  WIZARD_ALERT_TYPES, countConditions,
} from '../alertModel';

/**
 * Step 2 of the alert wizard: when should this alert fire?
 *
 *   Alert Type   [Scheduled] [Realtime]
 *   Stream Type  [logs ⌄]   Stream Name [default ⌄]
 *   ─────────────────────────────────────────────────────
 *   [Builder] [SQL]
 *   Alert if *      [avg ⌄] of [elapsed_time ⌄]
 *      Critical if  [>= ⌄] [3]
 *      Warning if      >=  [optional] ×
 *   Group by        [service_name ⌄] × +
 *   Alert aggregation  ( ) Simple alert  (•) Multi alert
 *   Having groups   [>= ⌄] [1]
 *   Check every *   [10] [Minutes ⌄] on these [filters 1 ⌄]
 *      if [service_name] [=] [checkout] ×
 *      ⊕ Condition   ⊕ Condition Group   ⇅ Reorder
 *
 * A faithful rebuild of OpenObserve's own "Conditions" card, read off the
 * reference instance rather than reconstructed from its docs — including the
 * rows that only appear once an earlier answer makes them meaningful, which is
 * most of them. Its SETTINGS card (look back window, cooldown, hold for,
 * destination) is deliberately NOT here: those belong with the notification
 * questions, which is step 3.
 *
 * ─── It edits the editor's form, not a shape of its own ─────────────────────
 *
 * Everything below writes into the same `form` object `alertModel.docToForm`
 * produces, so step 3 saves through the same `applyForm` merge the one-screen
 * editor uses and an alert created here opens there unchanged. That is why, for
 * instance, Group By is held as a comma-separated string even though it is
 * edited as a list of selects: the string is the form's shape, and inventing a
 * second one here would mean a translation layer that only this screen knows
 * about.
 *
 * ─── "Alert if" is one control over two different document fields ───────────
 *
 * OpenObserve asks "what number am I comparing?" once, but stores the answer in
 * two places depending on which it is:
 *
 *   total events  → aggregation: null, and the count is compared through
 *                   trigger_condition.operator / .threshold
 *   avg / sum / … → aggregation: {function, having:{column, operator, value}},
 *                   and trigger_condition's threshold becomes the GROUP GATE
 *                   ("Having groups"), counting how many groups breached
 *
 * So switching this one select moves which field the "Critical if" row writes
 * to, and makes a second, different threshold row appear underneath. Both are
 * handled by `alertModel`'s existing `aggregationEnabled` flag and
 * `warningField`; nothing new is introduced here to express it.
 */

const IconFilter = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 5h18l-7 8v6l-4-2v-4Z" />
  </svg>
);

const IconBuilder = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 7 9.5 2.5 2 10l4.5 4.5Z" /><path d="m13 13 8 8" />
  </svg>
);

const IconShield = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6Z" />
  </svg>
);

const IconSliders = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
    <circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" />
  </svg>
);

/**
 * Which tab owns which validation error.
 *
 * <p>Load-bearing now that there is no step 3. Every error the form can report
 * is reachable from this one screen, and two of them — a malformed tag and a
 * half-filled variable — live on a tab that is not on screen by default. Without
 * a count on the tab, pressing Create would refuse with a complaint about a
 * control the user cannot see.</p>
 */
const ADVANCED_FIELDS = new Set(['tags', 'variables']);

const IconSql = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
);

/**
 * OpenObserve's cron has SIX fields, the first of which is SECONDS.
 *
 * <p>Its own new-alert form seeds the six-field expression for "every ten
 * minutes" — a literal zero, then a ten-minute step, then four stars — and labels
 * it exactly that. Read as ordinary five-field crontab, the same string instead
 * means "minute zero of every tenth hour". Getting this wrong does not error:
 * the expression is accepted and the alert then evaluates sixty times less often
 * than intended. So the seed below and the describer are both written for six
 * fields, and anything else is described as nothing at all.</p>
 *
 * <p>(The expression cannot be written out here: a cron step contains the two
 * characters that end a block comment.)</p>
 */
const CRON_FIELDS = 6;

/** The expression seeded when the unit is switched to Cron, for N minutes. */
const cronEvery = (minutes) => {
  const n = Math.max(1, Math.round(Number(minutes) || 1));
  return n >= 60 && n % 60 === 0
    ? `0 0 */${n / 60} * * *`
    : `0 */${n} * * * *`;
};

/** `describeCron` for the every-N-minutes shapes; null when it is not one. */
const describeIntervalCron = (min, hour) => {
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === '*') {
    return everyMin[1] === '1' ? 'every minute' : `every ${everyMin[1]} minutes`;
  }
  if (min === '*' && hour === '*') return 'every minute';
  return null;
};

/** `describeCron` for a fixed minute: hourly, every N hours, or daily. */
const describeClockCron = (min, hour) => {
  const atMin = /^(\d+)$/.exec(min);
  if (!atMin) return '';
  if (hour === '*') {
    return atMin[1] === '0' ? 'every hour, on the hour' : `at ${atMin[1]} minutes past every hour`;
  }
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) {
    return everyHour[1] === '1' ? 'every hour' : `every ${everyHour[1]} hours`;
  }
  const atHour = /^(\d+)$/.exec(hour);
  if (atHour) {
    return `daily at ${atHour[1].padStart(2, '0')}:${atMin[1].padStart(2, '0')}`;
  }
  return '';
};

/**
 * Turn a cron expression into something a human can check at a glance.
 *
 * Deliberately narrow: it recognises the shapes {@link cronEvery} produces plus
 * the obvious hourly / daily ones, and says nothing at all about anything else.
 * A cron describer that guesses is worse than none — a wrong "every 5 minutes"
 * under an expression that actually runs monthly is a confident lie, whereas
 * silence sends the user to go and read the expression itself.
 */
const describeCron = (expr) => {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== CRON_FIELDS) return '';
  const [, min, hour, dom, mon, dow] = parts;
  // Only an expression that runs on every date can be summarised as an interval.
  if (!(dom === '*' && mon === '*' && dow === '*')) return '';

  return describeIntervalCron(min, hour) ?? describeClockCron(min, hour);
};

/** Split the form's comma-joined Group By back into rows the UI can edit. */
const groupByRows = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);

/** What the list holds. A metric IS its own stream in OpenObserve, and calling
 *  twenty metric names "streams" is the single most confusing thing this
 *  screen used to say. */
const streamNounFor = (form) => (form.streamType === 'metrics' ? 'metrics' : `${form.streamType} streams`);

/** The same noun with a count in front of it, agreeing in number. A hint that
 *  reads "the 1 logs streams" undermines the very line that is asking to be
 *  trusted about what is in the list. */
const countedStreamsFor = (form, n) => {
  const s = n === 1 ? '' : 's';
  if (form.streamType === 'metrics') {
    return `${n} metric${s}`;
  }
  return `${n} ${form.streamType} stream${s}`;
};

/** What the chosen scope writes: metrics are emitted, streams are written to. */
const streamVerbFor = (form) => (form.streamType === 'metrics' ? 'emits' : 'writes to');

/** The line under the stream picker saying which list is on screen. */
const streamHintFor = (form, streamsMeta, streams, scopeName) => {
  const streamNoun = streamNounFor(form);
  const streamVerb = streamVerbFor(form);
  const countedStreams = (n) => countedStreamsFor(form, n);
  if (streamsMeta.loading) return `Finding the ${streamNoun} ${scopeName} ${streamVerb}…`;
  if (streamsMeta.error) return `Showing nothing — the ${streamNoun} could not be listed.`;
  if (streamsMeta.scoped) {
    return streams.length
      ? `Narrowed to the ${countedStreams(streams.length)} ${scopeName} ${streamVerb}.`
      : `${scopeName} ${streamVerb} no ${streamNoun}. `
        + 'Try another stream type, or check the resolved name in the Product Catalog.';
  }
  /* NOT narrowed. The backend says why in its own words, which are more
     specific than anything that can be written here — it knows whether the
     producer index was still building, whether the catalog row was missing,
     or whether the service has simply never been seen. */
  return streamsMeta.notice
    || `Showing all ${countedStreams(streams.length)}: these could not be narrowed to `
      + `${scopeName}, so check the one you pick is really ${
        form.streamType === 'metrics' ? 'emitted by it' : 'written to by it'}.`;
};

/** The form fields the "Alert if" select writes for a choice of `value`. */
const alertIfPatch = (value, form, aggregating) => {
  if (value === TOTAL_EVENTS) {
    // Leaving aggregation turns the group gate back into the row-count
    // threshold, and the two are different numbers with different meanings.
    // Carrying the gate's "at least 1" across as a row count would silently
    // turn a considered threshold into "fire on anything".
    return {
      aggregationEnabled: false,
      multiAlert: false,
      threshold: form.aggHavingValue === '' ? 1 : form.aggHavingValue,
      thresholdOperator: form.aggHavingOperator || '>=',
      aggWarningValue: '',
    };
  }
  return {
    aggregationEnabled: true,
    aggFunction: value,
    // `count` needs no column; every other function does, and a column that
    // was valid for the previous function stays valid for the new one.
    aggColumn: form.aggColumn,
    // The threshold the user already typed is the same number they meant,
    // so it moves with them rather than resetting to a default.
    aggHavingValue: form.aggHavingValue === '' ? String(form.threshold ?? 3) : form.aggHavingValue,
    aggHavingOperator: form.aggHavingOperator || form.thresholdOperator || '>=',
    warningThreshold: '',
    // The group gate only ever counts groups, and 1 is what the reference
    // opens it at.
    threshold: aggregating ? form.threshold : 1,
    thresholdOperator: aggregating ? form.thresholdOperator : '>=',
  };
};

/** The form fields a change of the Check every unit writes. */
const freqUnitPatch = (unit, form) => {
  if (unit === 'cron') {
    return {
      frequencyType: 'cron',
      // Seeded from the cadence already chosen rather than left blank: an
      // empty cron box is a required field the user did not ask to fill in,
      // and the seed doubles as an example of the six-field dialect.
      cron: (form.cron || '').trim() || cronEvery(form.frequency),
    };
  }
  const current = Number(form.frequency) || 1;
  return {
    frequencyType: 'minutes',
    // Hours re-reads the same stored minutes, so switching units does not
    // change how often the alert runs — only how the number is written.
    frequency: unit === 'hours' ? Math.max(60, Math.round(current / 60) * 60) : current,
  };
};

// Which pair of form fields the "Critical if" row is bound to. The threshold
// moves between query_condition and trigger_condition with the Alert if
// choice — see the note at the top — so the row is written once against
// whichever pair is live rather than duplicated per branch.
const criticalBinding = (form, aggregating) => (aggregating
  ? {
    criticalOperator: form.aggHavingOperator,
    criticalValue: form.aggHavingValue,
    criticalKey: 'aggHavingValue',
    warnKey: 'aggWarningValue',
  }
  : {
    criticalOperator: form.thresholdOperator,
    criticalValue: form.threshold,
    criticalKey: 'threshold',
    warnKey: 'warningThreshold',
  });

/** The fields a Critical if edit writes, on the same live pair. */
const criticalPatch = (fields, form, aggregating) => (aggregating
  ? { aggHavingOperator: fields.operator ?? form.aggHavingOperator,
    aggHavingValue: fields.value ?? form.aggHavingValue }
  : { thresholdOperator: fields.operator ?? form.thresholdOperator,
    threshold: fields.value ?? form.threshold });

export default function ConditionsStep({
  form, set, errors, showErr, serviceName, scopeType, scopeKey, scopeLabel,
}) {
  /**
   * Which tab is on screen.
   *
   * <p>Local rather than lifted: it is a view state, not an answer, and a wizard
   * that remembers which tab you were on when you page back to step 1 is
   * remembering something nobody asked it to.</p>
   */
  const [tab, setTab] = useState('rules');

  const composite = form.alertType === 'composite';
  const scheduled = form.alertType === 'scheduled';
  const custom = form.queryType === 'custom';
  const aggregating = form.aggregationEnabled && custom;

  /* ── stream metadata ───────────────────────────────────────────────────── */

  const [streams, setStreams] = useState([]);
  const [schema, setSchema] = useState([]);

  /**
   * How the stream list came back, kept beside the list itself.
   *
   * <p>`scoped` is not cosmetic. When step 1 chose a service, the list is
   * supposed to be the streams THAT service writes to — and a backend that
   * could not work that out answers with every stream in the tenant rather
   * than with nothing. Those two lists look identical in a dropdown, so the
   * flag is what lets the hint below say which one is on screen. Without it,
   * someone picks a stream their service never touches, and the rule they
   * write validates, syncs, reports itself healthy and never fires.</p>
   */
  const [streamsMeta, setStreamsMeta] = useState({
    loading: false, scoped: false, notice: '', error: '',
  });

  useEffect(() => {
    if (!form.streamType) return undefined;
    const controller = new AbortController();
    setStreamsMeta((m) => ({ ...m, loading: true, error: '' }));

    fetchScopedAlertStreams({
      type: form.streamType, scopeType, scopeKey, signal: controller.signal,
    })
      .then((res) => {
        setStreams(res.items);
        setStreamsMeta({
          loading: false, scoped: res.scoped, notice: res.notice, error: '',
        });
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        console.error('Stream list unavailable:', err);
        // Cleared rather than left stale: the previous type's streams under a
        // new type's label is worse than an empty list, because every one of
        // them is a name this type does not have.
        setStreams([]);
        setStreamsMeta({
          loading: false,
          scoped: false,
          notice: '',
          error: err.message || 'The stream list could not be read.',
        });
      });
    return () => controller.abort();
  }, [form.streamType, scopeType, scopeKey]);

  useEffect(() => {
    if (!form.streamName || !form.streamType) { setSchema([]); return undefined; }
    const controller = new AbortController();
    fetchAlertStreamSchema({
      type: form.streamType, streamName: form.streamName, signal: controller.signal,
    })
      .then(setSchema)
      // An absent schema is normal for a stream nothing has been written to.
      // Both column controls fall back on their own, so this is not surfaced.
      .catch((err) => { if (err.name !== 'AbortError') setSchema([]); });
    return () => controller.abort();
  }, [form.streamType, form.streamName]);

  const columns = useMemo(() => schema.map((f) => f.name), [schema]);

  /**
   * Columns an aggregate can actually be computed over.
   *
   * <p>"avg of service_name" is not a question with an answer, and OpenObserve's
   * own picker offers only the numeric columns here. When the backend could not
   * tell us the types every column is reported numeric, so the control degrades
   * to offering everything rather than to offering nothing.</p>
   */
  const numericColumns = useMemo(
    () => schema.filter((f) => f.numeric).map((f) => f.name), [schema],
  );

  /* ── how the stream picker describes itself ────────────────────────────── */

  /** Was a narrowing even asked for? Nothing below is worth saying otherwise. */
  const scoped = !!(scopeType && scopeKey);

  const streamNoun = streamNounFor(form);

  const scopeName = scopeLabel || serviceName || 'the selected service';

  const streamHint = streamHintFor(form, streamsMeta, streams, scopeName);

  const emptyStreamLabel = scoped && streamsMeta.scoped
    ? `No ${streamNoun} for ${scopeName}.`
    : `No ${streamNoun} found.`;

  /* ── the "Alert if" control ────────────────────────────────────────────── */

  const alertIf = aggregating ? form.aggFunction : TOTAL_EVENTS;

  const setAlertIf = (value) => set(alertIfPatch(value, form, aggregating));


  const needsColumn = aggregating && AGG_NEEDS_COLUMN.includes(form.aggFunction);

  /* ── critical / warning ────────────────────────────────────────────────── */

  const {
    criticalOperator, criticalValue, criticalKey, warnKey,
  } = criticalBinding(form, aggregating);
  const warnValue = form[warnKey];

  const setCritical = (fields) => set(criticalPatch(fields, form, aggregating));

  /* Whether the optional warning row is on screen.
   *
   * Opened permanently once it holds a value, so paging back to this step does
   * not hide a threshold that is really set. */
  const [warnOpen, setWarnOpen] = useState(false);
  const warnShown = warnOpen || (warnValue ?? '').toString().trim() !== '';

  /* ── group by ──────────────────────────────────────────────────────────── */

  const groups = groupByRows(form.aggGroupBy);
  // One empty slot is kept on screen once the user has asked for Group By, so
  // the control they just added does not vanish before they pick a column.
  const [groupSlots, setGroupSlots] = useState(() => (groups.length ? groups.length : 0));
  const groupRows = Array.from(
    { length: Math.max(groupSlots, groups.length) }, (_, i) => groups[i] || '',
  );

  const writeGroups = (rows) => set({ aggGroupBy: rows.filter(Boolean).join(', ') });

  const setGroupAt = (index, value) => {
    const rows = [...groupRows];
    rows[index] = value;
    writeGroups(rows);
  };

  const removeGroupAt = (index) => {
    const rows = [...groupRows];
    rows.splice(index, 1);
    setGroupSlots((n) => Math.max(0, n - 1));
    writeGroups(rows);
    // Per-group alerting has nothing left to group by, and OpenObserve rejects
    // it in that state rather than ignoring it.
    if (!rows.filter(Boolean).length) set({ multiAlert: false });
  };

  /* ── check every ───────────────────────────────────────────────────────── */

  /* The unit is UI-only for Minutes/Hours: `trigger_condition.frequency` is
     minutes and there is no hourly frequency_type, so Hours multiplies out on
     the way in. Cron is a real frequency_type and is stored as one. */
  const [freqUnit, setFreqUnit] = useState(
    () => (form.frequencyType === 'cron' ? 'cron' : 'minutes'),
  );

  const freqAmount = freqUnit === 'hours'
    ? String(Math.max(1, Math.round(Number(form.frequency || 1) / 60)))
    : String(form.frequency ?? 1);

  const setFreqAmount = (raw) => {
    const n = Number(raw);
    const minutes = freqUnit === 'hours' ? n * 60 : n;
    set({ frequency: Number.isFinite(minutes) ? minutes : raw });
  };

  const setFreqUnitTo = (unit) => {
    setFreqUnit(unit);
    set(freqUnitPatch(unit, form));
  };


  const cronNote = form.frequencyType === 'cron' ? describeCron(form.cron) : '';

  /* ── filters ───────────────────────────────────────────────────────────── */

  const [filtersOpen, setFiltersOpen] = useState(true);
  const filterCount = countConditions(form.conditions);

  /* ── the Critical / Warning / Having rows, as markup ───────────────────── */

  const thresholdRows = (
    <ThresholdRows
      set={set} errors={errors} showErr={showErr} alertIf={alertIf}
      criticalOperator={criticalOperator} criticalValue={criticalValue}
      criticalKey={criticalKey} setCritical={setCritical}
      warnKey={warnKey} warnValue={warnValue} warnShown={warnShown} setWarnOpen={setWarnOpen}
    />
  );

  return (
    <div className="aw-cond">
      {/* ── What kind of alert, over which stream ───────────────────────── */}
      <div className="aw-cond-row">
        <span className="aw-cond-label">Alert Type</span>
        <div className="aw-seg" role="radiogroup" aria-label="Alert type">
          {WIZARD_ALERT_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={form.alertType === t.value}
              className={`aw-seg-btn ${form.alertType === t.value ? 'is-on' : ''}`}
              onClick={() => set({ alertType: t.value })}
            >{t.label}</button>
          ))}
        </div>
      </div>

      {/* ── Which stream, above the tabs ──────────────────────────────────
          Above the tab strip rather than inside the Conditions card, because it
          is the one answer BOTH tabs depend on: the columns the builder offers,
          the preview's query and the row template's fields all come from it.
          The reference puts it in the same place for the same reason.

          A composite has no stream at all — it reads the current states of other
          alerts — so the row is absent rather than disabled. Nine controls greyed
          out reads as a broken screen; a different screen reads as a different
          kind of alert, which is what it is. */}
      {!composite && (
        <StreamPicker
          form={form} set={set} errors={errors} showErr={showErr}
          streams={streams} streamsMeta={streamsMeta} streamNoun={streamNoun}
          emptyStreamLabel={emptyStreamLabel} scoped={scoped} streamHint={streamHint}
        />
      )}

      {/* ── Alert Rules | Advanced ────────────────────────────────────────
          The asterisk is the whole distinction in one character: everything
          under Alert Rules is required for the alert to fire correctly, and
          nothing under Advanced is. The count beside it is not decorative —
          with step 3 gone, every error the form can report is reachable from
          this screen, and two of them live on the tab that is not on top. */}
      <StepTabs tab={tab} setTab={setTab} errors={errors} showErr={showErr} />


      <div className="aw-tabpanel" role="tabpanel">
      {tab === 'rules' && (
      <>
      <section className="aw-card">
      <div className="aw-card-head">
        <span className="aw-card-bar" aria-hidden="true" />{' '}
        Conditions
      </div>
      <div className="aw-card-body">

      {composite && (
        <>
          <div className="ae-hint aw-cond-note">
            Watches other alerts rather than a stream, so it has no stream, query or
            window of its own — only the sub-alerts below, their combination, and its
            own notification settings.
          </div>
          <CompositeStep form={form} set={set} errors={errors} showErr={showErr} />
        </>
      )}

      {!composite && (
      <>
      {/* Realtime's difference is stated once, here, where the choice was made.
          Everything it removes simply disappears below rather than being greyed
          out — a disabled threshold on a realtime alert invites the user to ask
          why they cannot set it. */}
      {!scheduled && (
        <div className="ae-hint aw-cond-note">
          Evaluated against every row as it is ingested, so it fires on the first match
          and has no window, cadence or threshold — only the filters below. Need
          “N times in M minutes”? Use a Scheduled alert.
        </div>
      )}

      {/* ── Builder | SQL ───────────────────────────────────────────────── */}
      {scheduled && <QueryModeSeg form={form} set={set} custom={custom} />}

      {/* ── Builder ─────────────────────────────────────────────────────── */}
      {scheduled && custom && (
        <BuilderRows
          form={form} set={set} errors={errors} showErr={showErr}
          alertIf={alertIf} setAlertIf={setAlertIf} aggregating={aggregating}
          numericColumns={numericColumns} needsColumn={needsColumn}
          thresholdRows={thresholdRows} columns={columns} groups={groups}
          groupRows={groupRows} setGroupAt={setGroupAt} removeGroupAt={removeGroupAt}
          setGroupSlots={setGroupSlots}
        />
      )}

      {/* ── SQL ─────────────────────────────────────────────────────────── */}
      {scheduled && form.queryType === 'sql' && (
        <SqlRows
          form={form} set={set} errors={errors} showErr={showErr} thresholdRows={thresholdRows}
        />
      )}

      {/* ── Cadence ─────────────────────────────────────────────────────── */}
      {scheduled && (
        <CadenceRows
          form={form} set={set} errors={errors} showErr={showErr}
          freqAmount={freqAmount} setFreqAmount={setFreqAmount}
          freqUnit={freqUnit} setFreqUnitTo={setFreqUnitTo}
          filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen}
          filterCount={filterCount} cronNote={cronNote}
        />
      )}

      {/* ── The filter tree ─────────────────────────────────────────────── */}
      {(custom || !scheduled) && (
        <FilterTree
          form={form} set={set} errors={errors} showErr={showErr}
          columns={columns} filtersOpen={filtersOpen} scheduled={scheduled}
          serviceName={serviceName} filterCount={filterCount}
        />
      )}
      </>
      )}

      </div>
      </section>

      {/* ── Settings ──────────────────────────────────────────────────────
          The rest of the rule, not a review of it: the look back window is the
          other half of the threshold, the cooldown the other half of the
          cadence. Under Conditions and inside the same tab, where the reference
          puts it — and where the number and the window it is measured over can
          be read in one pass. */}
      <section className="aw-card">
        <SettingsCard form={form} set={set} errors={errors} showErr={showErr} />
      </section>
      </>
      )}

      {tab === 'advanced' && (
        <section className="aw-card">
          <AdvancedCard form={form} set={set} errors={errors} showErr={showErr} />
        </section>
      )}
      </div>
    </div>
  );
}

ConditionsStep.propTypes = {
  /** The editor's form state — see alertModel.docToForm. */
  form: PropTypes.object.isRequired,
  /** Patch one or more form fields. */
  set: PropTypes.func.isRequired,
  /** Every validation error for the form, keyed by field. */
  errors: PropTypes.object.isRequired,
  /** Returns an error only once the field is worth complaining about. */
  showErr: PropTypes.func.isRequired,
  /** The service step 1 chose, named in the seeded-filter note. */
  serviceName: PropTypes.string,
  /** What the stream list is narrowed to: `resource`, `service` or `product`. */
  scopeType: PropTypes.string,
  /** The scope's key — a catalog row id, a resolved service_name, a product code. */
  scopeKey: PropTypes.string,
  /** How to name that scope in the hint under the stream picker. */
  scopeLabel: PropTypes.string,
};

/* ── Sections ──────────────────────────────────────────────────────────────
 *
 * The step's render, split by row group. None of them holds state: every value
 * and setter comes from ConditionsStep, so the split changes nothing about what
 * is edited or when. */

const formPropTypes = {
  form: PropTypes.object.isRequired,
  set: PropTypes.func.isRequired,
  errors: PropTypes.object.isRequired,
  showErr: PropTypes.func.isRequired,
};

/** The Critical / Warning rows, bound to whichever threshold pair is live. */
function ThresholdRows({
  set, errors, showErr, alertIf, criticalOperator, criticalValue, criticalKey, setCritical,
  warnKey, warnValue, warnShown, setWarnOpen,
}) {
  return (
    <>
      <div className="aw-cond-row aw-cond-row--sub">
        <span className="aw-cond-label aw-cond-label--crit">
          Critical if <span className="ae-req">*</span>
        </span>
        <select
          className="ae-select aw-cond-op"
          value={criticalOperator}
          aria-label="Critical threshold operator"
          onChange={(e) => setCritical({ operator: e.target.value })}
        >
          {THRESHOLD_OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          type="number"
          className="ae-input aw-cond-num"
          value={criticalValue}
          aria-label="Critical threshold"
          onChange={(e) => setCritical({ value: e.target.value })}
        />
        {alertIf === TOTAL_EVENTS && (
          <span className="ae-hint aw-cond-tail">matching logs found</span>
        )}
      </div>
      {showErr(criticalKey) && <div className="ae-error">{errors[criticalKey]}</div>}

      {/* The second, lower tier. Shares the critical operator rather than
          offering its own — a warning that compares in the other direction is
          not a warning, and the reference prints the operator as static text
          for exactly that reason. */}
      {warnShown ? (
        <>
          <div className="aw-cond-row aw-cond-row--sub">
            <span className="aw-cond-label aw-cond-label--warn">Warning if</span>
            <span className="aw-cond-op aw-cond-op--static" aria-hidden="true">
              {criticalOperator}
            </span>
            <input
              type="number"
              className="ae-input aw-cond-num"
              value={warnValue}
              placeholder="optional"
              aria-label="Warning threshold"
              onChange={(e) => set({ [warnKey]: e.target.value })}
            />
            <button
              type="button"
              className="cb-x"
              title="Remove the warning threshold"
              aria-label="Remove warning threshold"
              onClick={() => { setWarnOpen(false); set({ [warnKey]: '' }); }}
            >×</button>
          </div>
          {showErr(warnKey) && <div className="ae-error">{errors[warnKey]}</div>}
          {!ORDERED_OPERATORS.includes(criticalOperator) && (
            <div className="ae-hint">
              A warning tier needs an ordered comparison — “{criticalOperator}” has no
              “less severe” side.
            </div>
          )}
        </>
      ) : (
        <div className="aw-cond-row aw-cond-row--sub">
          <span className="aw-cond-label" />
          <button
            type="button"
            className="aw-cond-add"
            onClick={() => setWarnOpen(true)}
          >+ Add warning</button>
        </div>
      )}
    </>
  );
}

ThresholdRows.propTypes = {
  set: PropTypes.func.isRequired,
  errors: PropTypes.object.isRequired,
  showErr: PropTypes.func.isRequired,
  alertIf: PropTypes.string,
  criticalOperator: PropTypes.string,
  criticalValue: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  criticalKey: PropTypes.string.isRequired,
  setCritical: PropTypes.func.isRequired,
  warnKey: PropTypes.string.isRequired,
  warnValue: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  warnShown: PropTypes.bool,
  setWarnOpen: PropTypes.func.isRequired,
};

function StreamPicker({
  form, set, errors, showErr, streams, streamsMeta, streamNoun, emptyStreamLabel, scoped,
  streamHint,
}) {
  return (
    <>
      <div className="aw-cond-row">
        <span className="aw-cond-label">Stream Type <span className="ae-req">*</span></span>
        <select
          className="ae-select aw-cond-stream-type"
          value={form.streamType}
          aria-label="Stream type"
          onChange={(e) => set({
            streamType: e.target.value,
            // The stream list is per type, so the chosen name almost
            // certainly does not exist under the new one.
            streamName: '',
            aggColumn: '',
          })}
        >
          {STREAM_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>

        <span className="aw-cond-label aw-cond-label--inline">
          Stream Name <span className="ae-req">*</span>
        </span>
        <SearchableSelect
          className="ssel--grow"
          options={streams}
          value={form.streamName}
          onChange={(v) => set({ streamName: v, aggColumn: '' })}
          placeholder="Select…"
          loading={streamsMeta.loading}
          searchPlaceholder={`Search ${streamNoun}…`}
          emptyLabel={emptyStreamLabel}
          missingSuffix="(missing)"
          ariaLabel="Stream name"
        />
      </div>

      {/* Which list is on screen. Only worth a line when a scope was asked
          for: without one there is nothing to have narrowed, and a hint
          saying so on every alert is noise. This is also the only visible
          trace of step 1 on this screen besides the seeded filter row, so it
          is what stops the narrowing looking like an accident. */}
      {scoped && (
        <div className={`aw-cond-scope${streamsMeta.scoped ? '' : ' is-wide'}`}>
          {streamHint}
        </div>
      )}
      {!!streamsMeta.error && (
        <div className="ae-error">Streams could not be listed — {streamsMeta.error}</div>
      )}
      {showErr('streamName') && <div className="ae-error">{errors.streamName}</div>}
    </>
  );
}

StreamPicker.propTypes = {
  ...formPropTypes,
  streams: PropTypes.array.isRequired,
  streamsMeta: PropTypes.shape({
    loading: PropTypes.bool, scoped: PropTypes.bool, notice: PropTypes.string, error: PropTypes.string,
  }).isRequired,
  streamNoun: PropTypes.string,
  emptyStreamLabel: PropTypes.string,
  scoped: PropTypes.bool,
  streamHint: PropTypes.string,
};

function StepTabs({ tab, setTab, errors, showErr }) {
  return (
    <div className="aw-tabs" role="tablist" aria-label="Alert definition">
      {[
        { id: 'rules', label: 'Alert Rules', required: true, Icon: IconShield },
        { id: 'advanced', label: 'Advanced', required: false, Icon: IconSliders },
      ].map(({ id, label, required, Icon }) => {
        const owned = Object.keys(errors).filter(
          (k) => (id === 'advanced') === ADVANCED_FIELDS.has(k),
        );
        const count = owned.filter((k) => showErr(k)).length;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`aw-tab ${tab === id ? 'is-on' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon />
            <span>{label}</span>
            {required && <span className="ae-req" title="Required">*</span>}
            {count > 0 && (
              <span className="aw-tab-badge" title={`${count} field(s) need attention`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

StepTabs.propTypes = {
  tab: PropTypes.string.isRequired,
  setTab: PropTypes.func.isRequired,
  errors: PropTypes.object.isRequired,
  showErr: PropTypes.func.isRequired,
};

function BuilderRows({
  form, set, errors, showErr, alertIf, setAlertIf, aggregating, numericColumns, needsColumn,
  thresholdRows, columns, groups, groupRows, setGroupAt, removeGroupAt, setGroupSlots,
}) {
  return (
    <>
      <div className="aw-cond-row">
        <span className="aw-cond-label">Alert if <span className="ae-req">*</span></span>
        <select
          className="ae-select aw-cond-agg"
          value={alertIf}
          aria-label="What to measure"
          onChange={(e) => setAlertIf(e.target.value)}
        >
          {ALERT_IF_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {aggregating && (
          <>
            <span className="aw-cond-of">of</span>
            <SearchableSelect
              className="ssel--col"
              options={numericColumns}
              value={form.aggColumn}
              onChange={(v) => set({ aggColumn: v })}
              placeholder="Select column…"
              searchPlaceholder="Search numeric columns…"
              emptyLabel={form.streamName
                ? 'No numeric columns on this stream.'
                : 'Choose a stream first.'}
              allowClear={form.aggFunction === 'count'}
              missingSuffix="(not in schema)"
              ariaLabel="Column to aggregate"
            />
          </>
        )}
      </div>

      {needsColumn && !(form.aggColumn || '').trim() && (
        <div className="ae-error">
          Choose the column to take the {form.aggFunction} of.
        </div>
      )}

      {thresholdRows}

      {/* ── Group by ─────────────────────────────────────────────────
          Only for an aggregate: there is nothing to group a bare row count
          by, and the reference hides it for "total events" too. */}
      {aggregating && (
        <GroupByRow
          errors={errors} showErr={showErr} columns={columns} groupRows={groupRows}
          setGroupAt={setGroupAt} removeGroupAt={removeGroupAt}
          setGroupSlots={setGroupSlots}
        />
      )}

      {/* ── One alert, or one per group ─────────────────────────────── */}
      {aggregating && groups.length > 0 && (
        <AggregationModeRows form={form} set={set} errors={errors} showErr={showErr} />
      )}
    </>
  );
}

function GroupByRow({
  errors, showErr, columns, groupRows, setGroupAt, removeGroupAt, setGroupSlots,
}) {
  return (
    <div className="aw-cond-row aw-cond-row--wrap">
      <span className="aw-cond-label">Group by</span>
      {groupRows.map((value, idx) => {
        const rowKey = `gb-${value}-${idx}`;
        return (
        <span className="aw-cond-group" key={rowKey}>
          <SearchableSelect
            className="ssel--col"
            options={columns}
            value={value}
            onChange={(v) => setGroupAt(idx, v)}
            placeholder="Select column…"
            searchPlaceholder="Search columns…"
            emptyLabel="No columns reported for this stream."
            missingSuffix="(not in schema)"
            ariaLabel={`Group by column ${idx + 1}`}
          />
          <button
            type="button" className="cb-x"
            title="Remove this grouping"
            aria-label={`Remove group by column ${idx + 1}`}
            onClick={() => removeGroupAt(idx)}
          >×</button>
        </span>
        );
      })}
      <button
        type="button"
        className="aw-cond-add aw-cond-add--icon"
        title="Group the aggregate by another column"
        aria-label="Add a group by column"
        onClick={() => setGroupSlots((n) => Math.max(n, groupRows.length) + 1)}
      >+</button>
      {showErr('aggGroupBy') && <div className="ae-error">{errors.aggGroupBy}</div>}
    </div>
  );
}

/** Simple vs multi alert, and the group gate that goes with it. */
function AggregationModeRows({ form, set, errors, showErr }) {
  return (
    <>
      <div className="aw-cond-row aw-cond-row--wrap">
        <span className="aw-cond-label">Alert aggregation</span>
        <label className="aw-radio">
          <input
            type="radio" name="aw-multi-alert"
            checked={!form.multiAlert}
            onChange={() => set({ multiAlert: false })}
          />
          <span>Simple alert</span>
        </label>
        <label className="aw-radio">
          <input
            type="radio" name="aw-multi-alert"
            checked={!!form.multiAlert}
            // Per-group alerting fires on ANY breaching group, so the
            // gate below can only be "at least 1" — OpenObserve rejects
            // anything else, and moving the two fields here beats
            // bouncing the user off a validation error they then have to
            // fix by hand. Same rule the one-screen editor applies.
            onChange={() => set({
              multiAlert: true, thresholdOperator: '>=', threshold: 1,
            })}
          />
          <span>Multi alert</span>
        </label>
      </div>
      <div className="ae-hint aw-cond-note">
        {form.multiAlert
          ? 'Every group that breaches alerts, recovers and notifies on its own.'
          : 'One alert for the whole query. Groups are collapsed into a single result.'}
      </div>
      {showErr('multiAlert') && <div className="ae-error">{errors.multiAlert}</div>}

      {/* ── The group gate ───────────────────────────────────────
          A SECOND threshold, and the most easily misread control on the
          screen: "Critical if" asks how big a group has to be, this asks
          how many groups have to be that big. */}
      <div className="aw-cond-row">
        <span className="aw-cond-label">
          Having groups{' '}
          <span
            className="aw-cond-help"
            title="How many groups must breach the critical threshold before the
alert fires. Not the same number as Critical if — that one measures inside a
group, this one counts the groups."
          >ⓘ</span>
        </span>
        <select
          className="ae-select aw-cond-op"
          value={form.thresholdOperator}
          disabled={form.multiAlert}
          aria-label="Group count operator"
          onChange={(e) => set({ thresholdOperator: e.target.value })}
        >
          {THRESHOLD_OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          type="number"
          className="ae-input aw-cond-num"
          value={form.threshold}
          disabled={form.multiAlert}
          aria-label="Group count threshold"
          onChange={(e) => set({ threshold: e.target.value })}
        />
        {form.multiAlert && (
          <span className="ae-hint aw-cond-tail">
            fixed at “at least 1” — a per-group alert fires on any breaching group
          </span>
        )}
      </div>
      {showErr('threshold') && <div className="ae-error">{errors.threshold}</div>}
      {showErr('thresholdOperator') && (
        <div className="ae-error">{errors.thresholdOperator}</div>
      )}
    </>
  );
}

const builderPropTypes = {
  ...formPropTypes,
  alertIf: PropTypes.string,
  setAlertIf: PropTypes.func,
  aggregating: PropTypes.bool,
  numericColumns: PropTypes.array,
  needsColumn: PropTypes.bool,
  thresholdRows: PropTypes.node,
  columns: PropTypes.array,
  groups: PropTypes.array,
  groupRows: PropTypes.array,
  setGroupAt: PropTypes.func,
  removeGroupAt: PropTypes.func,
  setGroupSlots: PropTypes.func,
};

BuilderRows.propTypes = builderPropTypes;
GroupByRow.propTypes = {
  errors: PropTypes.object.isRequired,
  showErr: PropTypes.func.isRequired,
  columns: PropTypes.array,
  groupRows: PropTypes.array,
  setGroupAt: PropTypes.func,
  removeGroupAt: PropTypes.func,
  setGroupSlots: PropTypes.func,
};
AggregationModeRows.propTypes = formPropTypes;

function QueryModeSeg({ form, set, custom }) {
  return (
    <div className="aw-seg aw-seg--mode" role="tablist" aria-label="How the condition is expressed">
      <button
        type="button" role="tab" aria-selected={custom}
        className={`aw-seg-btn ${custom ? 'is-on' : ''}`}
        onClick={() => set({ queryType: 'custom' })}
      ><IconBuilder /> Builder</button>
      <button
        type="button" role="tab" aria-selected={form.queryType === 'sql'}
        className={`aw-seg-btn ${form.queryType === 'sql' ? 'is-on' : ''}`}
        onClick={() => set({
          queryType: 'sql',
          // Aggregation is compiled into the query OpenObserve builds from
          // the builder's answers; there is nothing to compile it into once
          // the user writes their own SQL. Dropped here rather than sent and
          // silently ignored, which reads as a threshold that does not work.
          aggregationEnabled: false,
          multiAlert: false,
        })}
      ><IconSql /> SQL</button>
    </div>
  );
}

QueryModeSeg.propTypes = {
  form: PropTypes.object.isRequired,
  set: PropTypes.func.isRequired,
  custom: PropTypes.bool,
};

function SqlRows({ form, set, errors, showErr, thresholdRows }) {
  return (
    <>
      <div className="ae-stack">
        <label className="ae-stack-label" htmlFor="aw-sql">
          SQL <span className="ae-req">*</span>
        </label>
        <textarea
          id="aw-sql"
          className="ai-editor"
          style={{ minHeight: 120 }}
          value={form.sql}
          placeholder={`SELECT count(*) AS total FROM "${form.streamName || 'stream'}" WHERE code >= 500`}
          onChange={(e) => set({ sql: e.target.value })}
        />
        {showErr('sql') && <div className="ae-error">{errors.sql}</div>}
      </div>
      {thresholdRows}
    </>
  );
}

SqlRows.propTypes = { ...formPropTypes, thresholdRows: PropTypes.node };

function CadenceRows({
  form, set, errors, showErr, freqAmount, setFreqAmount, freqUnit, setFreqUnitTo,
  filtersOpen, setFiltersOpen, filterCount, cronNote,
}) {
  return (
    <>
      <div className="aw-cond-row aw-cond-row--wrap">
        <span className="aw-cond-label">Check every <span className="ae-req">*</span></span>
        {form.frequencyType === 'cron' ? (
          <input
            type="text"
            className="ae-input aw-cond-cron"
            value={form.cron}
            placeholder="0 */10 * * * *"
            aria-label="Cron expression"
            onChange={(e) => set({ cron: e.target.value })}
          />
        ) : (
          <input
            type="number"
            min="1"
            className="ae-input aw-cond-num"
            value={freqAmount}
            aria-label="How often the alert is evaluated"
            onChange={(e) => setFreqAmount(e.target.value)}
          />
        )}

        <select
          className="ae-select aw-cond-unit"
          value={freqUnit}
          aria-label="Frequency unit"
          onChange={(e) => setFreqUnitTo(e.target.value)}
        >
          {FREQUENCY_UNITS.map((u) => (
            <option key={u.value} value={u.value}>{u.label}</option>
          ))}
        </select>

        {form.frequencyType === 'cron' && (
          <select
            className="ae-select aw-cond-tz"
            value={form.timezone}
            aria-label="Cron timezone"
            onChange={(e) => set({ timezone: e.target.value })}
          >
            {/* The instance's own zone alongside UTC. A cron read in the
                wrong zone is an alert that runs at the wrong hour and looks
                like it is simply not running. */}
            {Array.from(new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, form.timezone]))
              .filter(Boolean)
              .map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        )}

        <span className="aw-cond-onthese">on these</span>
        <button
          type="button"
          className={`aw-filters-toggle ${filtersOpen ? 'is-open' : ''}`}
          onClick={() => setFiltersOpen((o) => !o)}
          aria-expanded={filtersOpen}
        >
          <IconFilter />
          <span>filters</span>
          {filterCount > 0 && <span className="aw-filters-count">{filterCount}</span>}
          <span className="aw-filters-caret" aria-hidden="true">⌄</span>
        </button>
      </div>
      {cronNote && <div className="ae-hint aw-cond-cron-note">{cronNote}</div>}
      {showErr('frequency') && <div className="ae-error">{errors.frequency}</div>}
      {showErr('cron') && <div className="ae-error">{errors.cron}</div>}
    </>
  );
}

CadenceRows.propTypes = {
  ...formPropTypes,
  freqAmount: PropTypes.string,
  setFreqAmount: PropTypes.func.isRequired,
  freqUnit: PropTypes.string,
  setFreqUnitTo: PropTypes.func.isRequired,
  filtersOpen: PropTypes.bool,
  setFiltersOpen: PropTypes.func.isRequired,
  filterCount: PropTypes.number,
  cronNote: PropTypes.string,
};

function FilterTree({
  form, set, errors, showErr, columns, filtersOpen, scheduled, serviceName, filterCount,
}) {
  return (
    <div className="aw-cond-filters">
      {filtersOpen || !scheduled ? (
        <>
          {/* `collapsible={false}`: the "filters" control lives up in the
              Check every row, where the reference puts it. A second one
              inside the block would be two toggles over one list. */}
          <ConditionBuilder
            tree={form.conditions}
            columns={columns}
            operators={FILTER_OPERATORS}
            collapsible={false}
            onChange={(next) => set({ conditions: next })}
          />
          {/* Restated rather than assumed. The row was put there by step 1
              and nothing on screen says so, which is how it gets deleted by
              someone who thinks the wizard added it by accident. */}
          {serviceName && (
            <div className="ae-hint aw-cond-seeded">
              The <code>service_name = {serviceName}</code> row came from step 1. Remove
              it and this alert watches the whole stream, not just that service.
            </div>
          )}
        </>
      ) : (
        <div className="cb-collapsed">
          {filterCount} filter{filterCount === 1 ? '' : 's'} hidden —
          {' '}click <strong>filters</strong> to show them.
        </div>
      )}
      {showErr('conditions') && <div className="ae-error">{errors.conditions}</div>}
    </div>
  );
}

FilterTree.propTypes = {
  ...formPropTypes,
  columns: PropTypes.array,
  filtersOpen: PropTypes.bool,
  scheduled: PropTypes.bool,
  serviceName: PropTypes.string,
  filterCount: PropTypes.number,
};
