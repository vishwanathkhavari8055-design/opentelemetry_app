import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { previewAlert } from '../../../services/api';
import {
  applyForm, countConditions, expressionToLabels, formatMinutes,
  thresholdParts, warningField,
} from '../alertModel';

/**
 * The right-hand rail of step 2: Preview on top, Summary underneath.
 *
 *   Preview  │ ✓ WOULD TRIGGER  102,721 rows match (102721 >= 3)
 *   ─────────────────────────────────────────────────────────────
 *   Everything in the window              102,721
 *   + service_name = checkout               8,204   −94,517
 *   + code >= 500                               0   −8,204   ←
 *   ─────────────────────────────────────────────────────────────
 *   Summary
 *   "Alert me when 3+ events occur in any 10-minute period, but no
 *    more than once every 10 minutes"
 *   ✓ Data Source:     Logs · default
 *   ✓ Alert Type:      Scheduled
 *   ✓ Query Condition: SELECT * FROM "default"
 *   ✓ Monitors:        the last 10 minutes of data
 *   ✓ Triggers when:   3 (≥) or more events detected
 *   ✓ Sends to:        No destination (not set up yet) ⚠
 *   ✓ Cooldown:        10 minutes between alerts
 *   ✓ Hold for:        Fires immediately
 *
 * ─── Why the preview is a ladder and not a chart ────────────────────────────
 *
 * The reference draws a time series of the stream with the threshold across it,
 * which answers "is there data" well and "why does my rule match nothing" not at
 * all — and the second question is the one people actually open the preview
 * with. The backend this app talks to returns the ladder instead: step 0 is the
 * window with NO conditions, and each later step adds exactly one and reports
 * what it removed.
 *
 * That shape separates the four causes of an empty result, which a single number
 * — or a chart of the unfiltered stream — cannot. An empty step 0 means the
 * stream or the window is wrong and no condition is at fault. A collapse at step
 * 3 names condition 3. A full ladder that still would not fire means the
 * threshold is the problem, not the query. The verdict line above it is the
 * reference's own "WOULD TRIGGER" banner, which answers the remaining question.
 *
 * ─── Why it is debounced and not live ───────────────────────────────────────
 *
 * Every run is a real query against real data, and the conditions are edited a
 * keystroke at a time. Runs are therefore coalesced, the previous one is aborted
 * before the next starts, and the panel keeps showing the LAST good answer while
 * a new one is in flight — a preview that blanks on every keystroke is a preview
 * nobody can read while typing.
 */

const DEBOUNCE_MS = 700;

const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4 12 6 6L20 6" />
  </svg>
);

const IconCross = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

const IconChart = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3v18h18" /><path d="m7 14 3-4 3 3 4-6" />
  </svg>
);

const IconDoc = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </svg>
);

const IconWarn = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 2 20h20Z" /><path d="M12 10v4M12 17.5v.5" />
  </svg>
);

const IconSpin = () => (
  <svg className="aw-spin" width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

/** Thousands separators. A seven-digit row count is unreadable without them. */
const nf = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : '—');

/** The operator, spelled the way the summary sentence needs to read it. */
const OPERATOR_WORD = {
  '>=': 'or more', '>': 'or more', '<=': 'or fewer', '<': 'or fewer',
  '=': 'exactly', '!=': 'other than',
};

/* ── Preview ─────────────────────────────────────────────────────────────── */

function PreviewPanel({ form, scopeType, scopeKey }) {
  const [state, setState] = useState({
    ran: false, loading: false, error: '', supported: true,
    steps: [], evaluation: { evaluated: false }, notice: '', durationMs: 0,
  });

  /**
   * The document the preview is run against.
   *
   * <p>Built through `applyForm` rather than assembled here, so what is previewed
   * is byte-for-byte what a save would store. A preview of a hand-assembled
   * approximation is a preview of a different rule, and the whole value of the
   * panel is that it is not.</p>
   */
  const previewable = form.alertType === 'scheduled'
    && !!form.streamType && !!form.streamName;

  const doc = useMemo(
    () => (previewable ? applyForm({}, form) : null),
    [previewable, form],
  );

  /* Only the parts of the document the preview actually READS. Keyed on this
     rather than on the whole form so typing a name or picking a destination —
     neither of which changes what matches — does not fire a query. */
  const signature = useMemo(() => (doc ? JSON.stringify({
    t: form.streamType,
    n: form.streamName,
    q: doc.query_condition,
    p: doc.trigger_condition?.period,
    o: doc.trigger_condition?.operator,
    v: doc.trigger_condition?.threshold,
    st: scopeType,
    sk: scopeKey,
  }) : ''), [doc, form.streamType, form.streamName, scopeType, scopeKey]);

  const abortRef = useRef(null);

  const run = useCallback(() => {
    if (!doc) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((s) => ({ ...s, loading: true, error: '' }));
    previewAlert({
      streamType: form.streamType,
      streamName: form.streamName,
      queryCondition: doc.query_condition,
      triggerCondition: doc.trigger_condition,
      sampleSize: 0,
      scopeType,
      scopeKey,
      signal: controller.signal,
    })
      .then((res) => {
        if (controller.signal.aborted) return;
        setState({
          ran: true,
          loading: false,
          error: res.error || '',
          supported: res.supported,
          steps: res.steps || [],
          evaluation: res.evaluation || { evaluated: false },
          notice: res.notice || '',
          durationMs: res.durationMs || 0,
        });
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setState((s) => ({
          ...s, loading: false, ran: true, error: err.message || 'The preview failed.',
        }));
      });
  }, [doc, form.streamType, form.streamName, scopeType, scopeKey]);

  useEffect(() => {
    if (!signature) return undefined;
    const timer = setTimeout(run, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `run` is rebuilt whenever `doc` is, and `doc` is rebuilt on every
    // keystroke — so the SIGNATURE is what may schedule a query, not the
    // callback identity. Depending on `run` here would defeat the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  /* The header stays even when there is nothing to preview. A card whose title
     disappears with its content reads as a card that failed to load, and this
     one is EXPECTED to be empty until a stream is chosen — which is exactly what
     the placeholder underneath says. */
  if (!previewable) {
    let emptyMsg = 'Select a stream type and stream name to see a preview';
    if (form.alertType === 'composite') {
      emptyMsg = 'A composite reads the states of other alerts rather than a stream, so '
        + 'there is nothing to query for a preview.';
    } else if (form.alertType === 'realtime') {
      emptyMsg = 'A realtime alert is evaluated per ingested row as it arrives — there is '
        + 'no window to run a preview over.';
    }

    return (
      <>
      <div className="aw-ins-head">
        <span className="aw-ins-title">Preview</span>
      </div>
      <div className="aw-ins-body">
      <div className="aw-ins-empty">
        <IconChart />
        <span>{emptyMsg}</span>
      </div>
      </div>
      </>
    );
  }

  const { evaluation, steps } = state;

  /* Which rung the set collapsed on. The eye goes to the running totals, but the
     condition that emptied them is the answer, so it is marked rather than left
     to be worked out by subtracting adjacent rows. */
  const collapseAt = steps.findIndex(
    (s, i) => i > 0 && s.matched === 0 && steps[i - 1].matched > 0,
  );

  const widest = steps.reduce((m, s) => Math.max(m, s.matched), 0) || 1;

  return (
    <>
      <div className="aw-ins-head">
        <span className="aw-ins-title">Preview</span>
        {state.loading && (
          <span className="aw-ins-running"><IconSpin /> running…</span>
        )}
        {!state.loading && state.ran && !state.error && evaluation.evaluated && (
          <span className={`aw-verdict ${evaluation.wouldFire ? 'is-fire' : 'is-quiet'}`}>
            {evaluation.wouldFire ? <IconCheck /> : <IconCross />}
            <b>{evaluation.wouldFire ? 'WOULD TRIGGER' : 'WOULD NOT TRIGGER'}</b>
            <span className="aw-verdict-detail">
              {nf(evaluation.observed)} {evaluation.observedLabel || 'matches'}
              {' ('}{nf(evaluation.observed)} {evaluation.operator} {nf(evaluation.threshold)}{')'}
            </span>
          </span>
        )}
      </div>

      <div className="aw-ins-body">
        {!state.supported && (
          <div className="ae-hint">
            This backend does not expose the alert preview endpoint, so the rule cannot
            be run before it is saved.
          </div>
        )}
        {state.error && <div className="ae-error">{state.error}</div>}

        {!state.ran && !state.error && (
          <div className="aw-ins-empty">
            <IconChart />
            <span>Running the rule against the last {formatMinutes(form.period)}…</span>
          </div>
        )}

        {state.ran && !state.error && steps.length > 0 && (
          <>
            {/* The ladder. Step 0 carries no condition, so an empty first row is
                the stream or the window — and says so before any condition is
                blamed for it. */}
            <ol className="aw-ladder">
              {steps.map((s, i) => (
                <li
                  key={s.label || crypto.randomUUID()}
                  className={`aw-ladder-step${i === collapseAt ? ' is-culprit' : ''}`}
                >
                  <span className="aw-ladder-label" title={s.where || s.label}>
                    {i > 0 && <span className="aw-ladder-plus">+</span>}
                    {s.label}
                  </span>
                  <span className="aw-ladder-bar" aria-hidden="true">
                    <span
                      className="aw-ladder-fill"
                      style={{ width: `${Math.max(1, (s.matched / widest) * 100)}%` }}
                    />
                  </span>
                  <span className="aw-ladder-count">{nf(s.matched)}</span>
                  {i > 0 && s.removed > 0 && (
                    <span className="aw-ladder-removed">−{nf(s.removed)}</span>
                  )}
                  {s.error && <span className="aw-ladder-err" title={s.error}>!</span>}
                  {!s.complete && (
                    <span
                      className="aw-ladder-partial"
                      title="The window could not be scanned in full, so this count is a floor, not a total."
                    >partial</span>
                  )}
                </li>
              ))}
            </ol>

            {collapseAt > 0 && (
              <div className="aw-ins-note aw-ins-note--warn">
                <IconWarn />
                <span>
                  Everything is removed by <code>{steps[collapseAt].label}</code> — that is
                  the condition to look at, not the ones after it.
                </span>
              </div>
            )}
            {steps[0]?.matched === 0 && (
              <div className="aw-ins-note aw-ins-note--warn">
                <IconWarn />
                <span>
                  Nothing at all arrived in <code>{form.streamName}</code> over the
                  last {formatMinutes(form.period)}, so no condition is at fault yet —
                  check the stream and the window first.
                </span>
              </div>
            )}

            {evaluation.evaluated && evaluation.summary && (
              <p className="aw-ins-verdict-text">{evaluation.summary}</p>
            )}

            {!!evaluation.groups?.length && (
              <div className="aw-ins-groups">
                <span className="aw-ins-subhead">
                  Groups ({evaluation.groups.filter((g) => g.satisfies).length} of{' '}
                  {evaluation.groups.length} breaching)
                </span>
                {evaluation.groups.slice(0, 8).map((g, i) => (
                  <div
                    key={JSON.stringify(g.key) || `group-${i}`}
                    className={`aw-ins-group${g.satisfies ? ' is-breaching' : ''}`}
                  >
                    <span className="aw-ins-group-key">
                      {Object.entries(g.key || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}
                    </span>
                    <span className="aw-ins-group-val">{nf(g.value)}</span>
                  </div>
                ))}
              </div>
            )}

            {state.notice && <div className="ae-hint">{state.notice}</div>}
            <div className="aw-ins-foot">
              Ran in {state.durationMs} ms over the last {formatMinutes(form.period)}.
            </div>
          </>
        )}
      </div>
    </>
  );
}

PreviewPanel.propTypes = {
  form: PropTypes.object.isRequired,
  scopeType: PropTypes.string,
  scopeKey: PropTypes.string,
};

/* ── Summary ─────────────────────────────────────────────────────────────── */

/** One ✓ line. `warn` turns the value amber and appends the reason. */
const Line = ({ term, children, warn }) => (
  <div className={`aw-sum-line${warn ? ' is-warn' : ''}`}>
    <span className="aw-sum-tick" aria-hidden="true">✓</span>
    <span className="aw-sum-term">{term}:</span>
    <span className="aw-sum-val">{children}</span>
  </div>
);
Line.propTypes = {
  term: PropTypes.string.isRequired,
  children: PropTypes.node,
  warn: PropTypes.bool,
};

const Chip = ({ children, tone }) => {
  const toneClass = tone ? ` is-${tone}` : '';
  return <span className={`aw-sum-chip${toneClass}`}>{children}</span>;
};
Chip.propTypes = { children: PropTypes.node, tone: PropTypes.string };

function SummaryPanel({ form, folderName }) {
  const composite = form.alertType === 'composite';
  const realtime = form.alertType === 'realtime';
  const { measure, operator, value } = thresholdParts(form);
  const warnAt = warningField(form);
  const warnKey = {
    trigger: 'warningThreshold',
    aggregation: 'aggWarningValue',
    promql: 'promqlWarningValue',
  }[warnAt];
  const warnValue = warnKey ? form[warnKey] : '';

  const tolerance = Number(form.toleranceSecs) || 0;

  let alertTypeLabel = 'Scheduled';
  if (composite) alertTypeLabel = 'Composite';
  else if (realtime) alertTypeLabel = 'Realtime';

  let queryConditionLabel = `SELECT * FROM "${form.streamName || 'stream'}"`;
  if (form.queryType === 'sql') {
    queryConditionLabel = form.sql || 'SQL not written yet';
  } else if (form.queryType === 'promql') {
    queryConditionLabel = form.promql || 'PromQL not written yet';
  }

  /**
   * The rule as one sentence, which is the line most people read and the only
   * one that states the whole thing at once.
   *
   * <p>Derived from the same `form` every control writes and the save merges
   * back — never re-computed from the document — so it cannot drift from what
   * gets stored. A summary that disagrees with the alert is worse than none,
   * because it is the line the user trusted.</p>
   */
  const headline = useMemo(() => {
    if (composite) {
      const expr = form.compositeExpressionLabelled
        || expressionToLabels(form.compositeExpression, form.compositeChildren);
      return `"Alert me when ${expr || 'the sub-alerts combine'} holds, but no more `
        + `than once every ${formatMinutes(form.silence)}"`;
    }
    if (realtime) {
      return `"Alert me the moment a row matching ${countConditions(form.conditions)} `
        + `condition(s) lands in ${form.streamName || 'the stream'}, but no more than `
        + `once every ${formatMinutes(form.silence)}"`;
    }
    const word = OPERATOR_WORD[operator] || operator;
    const held = tolerance > 0 ? `, sustained for ${tolerance}s` : '';
    return `"Alert me when ${value} ${word} ${measure} occur in any `
      + `${formatMinutes(form.period)} period${held}, but no more than once every `
      + `${formatMinutes(form.silence)}"`;
  }, [
    composite, realtime, form, operator, value, measure, tolerance,
  ]);

  if (!form.streamName && !composite && !form.name) {
    return (
      <div className="aw-ins-empty">
        <IconDoc />
        <span>Configure your alert to see a summary</span>
      </div>
    );
  }

  return (
    <div className="aw-sum">
      <blockquote className="aw-sum-headline">{headline}</blockquote>

      {composite ? (
        <Line term="Data Source">
          <Chip>Other alerts</Chip>
          <span className="aw-sum-plain">
            {(form.compositeChildren || []).filter(Boolean).length} sub-alert(s)
          </span>
        </Line>
      ) : (
        <Line term="Data Source">
          <Chip>{(form.streamType || 'logs').replace(/^./, (c) => c.toUpperCase())}</Chip>
          <span className="aw-sum-dash">·</span>
          <Chip>{form.streamName || 'not selected'}</Chip>
        </Line>
      )}

      <Line term="Alert Type">
        <Chip>{alertTypeLabel}</Chip>
      </Line>

      {!composite && (
        <Line term="Query Condition">
          <Chip tone="mono">
            {queryConditionLabel}
          </Chip>
        </Line>
      )}

      {!composite && form.queryType === 'custom' && (
        <Line term="Filters">
          <Chip>{countConditions(form.conditions)}</Chip>
          <span className="aw-sum-plain">condition(s) applied</span>
        </Line>
      )}

      {!realtime && !composite && (
        <Line term="Monitors">
          <Chip>the last {formatMinutes(form.period)}</Chip>
          <span className="aw-sum-plain">of data</span>
        </Line>
      )}

      {!realtime && !composite && (
        <Line term="Triggers when">
          <Chip>{value} ({operator}) {OPERATOR_WORD[operator] || ''}</Chip>
          <span className="aw-sum-plain">{measure} detected</span>
        </Line>
      )}

      {/* Only when one is set. A "Warning: none" line on every alert is a row of
          noise on the panel whose job is to be scannable. */}
      {!!warnKey && (warnValue ?? '').toString().trim() !== '' && (
        <Line term="Warns at">
          <Chip tone="warn">{operator} {warnValue}</Chip>
          <span className="aw-sum-plain">a lower tier on the same comparison</span>
        </Line>
      )}

      {!realtime && !composite && (
        <Line term="Checked">
          <Chip>
            {form.frequencyType === 'cron'
              ? `${form.cron || 'cron not set'} (${form.timezone})`
              : `every ${formatMinutes(form.frequency)}`}
          </Chip>
        </Line>
      )}

      {/* The one line that is a WARNING rather than a statement: an alert with no
          destination saves, syncs, evaluates, fires — and notifies nobody. */}
      <Line term="Sends to" warn={!(form.destinations || []).length}>
        {(form.destinations || []).length ? (
          <Chip>{form.destinations.join(', ')}</Chip>
        ) : (
          <>
            <Chip tone="warn">No destination</Chip>
            <span className="aw-sum-plain">(not set up yet)</span>
            <IconWarn />
          </>
        )}
      </Line>

      <Line term="Cooldown">
        <Chip>{formatMinutes(form.silence)}</Chip>
        <span className="aw-sum-plain">between alerts</span>
      </Line>

      {!realtime && !composite && (
        <Line term="Hold for">
          <Chip>
            {tolerance > 0
              ? `${tolerance}s sustained`
              : 'Fires immediately'}
          </Chip>
        </Line>
      )}

      <Line term="Folder">
        <Chip>{folderName || 'default'}</Chip>
      </Line>

      {form.createsIncident && (
        <Line term="Also">
          <Chip>Opens an incident</Chip>
        </Line>
      )}

      {form.priority !== '' && form.priority !== undefined && (
        <Line term="Priority"><Chip>P{form.priority}</Chip></Line>
      )}

      {!!(form.tags || []).length && (
        <Line term="Tags"><Chip>{form.tags.join(', ')}</Chip></Line>
      )}

      <Line term="On create" warn={!form.enabled}>
        <Chip tone={form.enabled ? '' : 'warn'}>
          {form.enabled ? 'Enabled' : 'Disabled — will not evaluate'}
        </Chip>
      </Line>
    </div>
  );
}

SummaryPanel.propTypes = {
  form: PropTypes.object.isRequired,
  folderName: PropTypes.string,
};

/* ── The rail ────────────────────────────────────────────────────────────── */

export default function AlertInsight({ form, folderName, scopeType, scopeKey }) {
  return (
    <aside className="aw-ins" aria-label="Preview and summary">
      <section className="aw-ins-card">
        <PreviewPanel form={form} scopeType={scopeType} scopeKey={scopeKey} />
      </section>

      <section className="aw-ins-card">
        <div className="aw-ins-head">
          <span className="aw-ins-title">Summary</span>
        </div>
        <div className="aw-ins-body">
          <SummaryPanel form={form} folderName={folderName} />
        </div>
      </section>
    </aside>
  );
}

AlertInsight.propTypes = {
  /** The editor's form state — see alertModel.docToForm. */
  form: PropTypes.object.isRequired,
  /** The folder the alert will land in, named rather than identified. */
  folderName: PropTypes.string,
  /** What step 1 scoped the rule to, so the preview counts the same rows. */
  scopeType: PropTypes.string,
  scopeKey: PropTypes.string,
};
