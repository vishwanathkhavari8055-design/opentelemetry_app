import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import CheckboxSelect from '../fired/CheckboxSelect';
import DestinationDialog from '../DestinationDialog';
import { fetchAlertDestinations } from '../../../services/api';
import { HOLD_FOR_UNITS } from '../alertModel';

/**
 * The "Settings" card of step 2 — what happens AROUND the condition.
 *
 *   ▌Settings
 *   Look back window * ⓘ  [10] Minutes
 *   Cooldown period *  ⓘ  [10] Minutes
 *   Hold for           ⓘ  [0]  [Minutes ⌄]
 *   Destination *      ⓘ  [slack-oncall ⌄] ⟳ [Add Destination]
 *   Creates Incident   ⓘ  (•—)
 *
 * A faithful rebuild of the reference instance's own Settings block, read off
 * it rather than reconstructed from its docs, and sitting where it sits there:
 * under Conditions, inside the "Alert Rules" tab, not on a screen of its own.
 *
 * ─── Why this is not the old step 3 under a new name ────────────────────────
 *
 * The wizard used to ask for the destination on a third screen, beside a
 * read-back of the alert. These five rows are not a review — they are the rest
 * of the RULE. The look back window is the other half of the threshold ("3
 * events" means nothing without "in how long"), the cooldown is the other half
 * of the cadence, and hold-for qualifies both. Splitting them from the threshold
 * they qualify is what let someone set "fires at 3" on one screen and only
 * discover the window was ten minutes on the next.
 *
 * ─── What is NOT here ───────────────────────────────────────────────────────
 *
 * The alert's NAME and FOLDER. The reference puts those in the title strip above
 * the form, and so does the wizard — see AlertWizard. They identify the alert
 * rather than configure it, and the two questions read quite differently when
 * they are not in the same list.
 */

const IconRefresh = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" />
  </svg>
);

/** The help bubbles, worded as the reference words them. */
const HELP = {
  period: 'How far back each evaluation looks. The threshold counts what happened '
    + 'inside this window, so "3 events" means 3 events in this many minutes.',
  silence: 'After firing, the alert stays silent for this long. This is what stops '
    + 'one incident becoming hundreds of notifications.',
  tolerance: 'The condition must stay true for this long before the alert fires. '
    + 'Zero fires on the first evaluation that breaches; anything higher rides out '
    + 'a momentary spike.',
  destinations: 'Where the notification is sent. An alert may notify several — page '
    + 'the on-call webhook AND post to the team channel.',
  incident: 'Also open an incident in OpenObserve when this alert fires, rather than '
    + 'only sending the notification.',
};

const Help = ({ text }) => (
  <span className="aw-cond-help" title={text} aria-hidden="true">ⓘ</span>
);
Help.propTypes = { text: PropTypes.string.isRequired };

export default function SettingsCard({ form, set, errors, showErr }) {
  const scheduled = form.alertType === 'scheduled';
  const composite = form.alertType === 'composite';

  /* ── destinations ──────────────────────────────────────────────────────── */

  const [destinations, setDestinations] = useState([]);
  const [destLoading, setDestLoading] = useState(false);
  const [destError, setDestError] = useState('');
  const [showDestDialog, setShowDestDialog] = useState(false);

  const loadDestinations = useCallback((signal) => {
    setDestLoading(true);
    setDestError('');
    return fetchAlertDestinations({ signal })
      .then((res) => setDestinations(res.items || []))
      .catch((err) => {
        if (err.name !== 'AbortError') setDestError(err.message || 'Could not list destinations.');
      })
      .finally(() => setDestLoading(false));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadDestinations(controller.signal);
    return () => controller.abort();
  }, [loadDestinations]);

  /* A destination that has since been renamed or deleted stays selectable.
     CheckboxSelect can only render a selection it has an option for, so without
     this the alert would read as "notifies nobody" — which is a claim about the
     alert, not about the list. */
  const destOptions = useMemo(() => [
    ...destinations.map((d) => ({
      value: d.name, label: d.type ? `${d.name} — ${d.type}` : d.name,
    })),
    ...(form.destinations || [])
      .filter((name) => !destinations.some((d) => d.name === name))
      .map((name) => ({ value: name, label: `${name} (missing)` })),
  ], [destinations, form.destinations]);

  /* ── hold for ──────────────────────────────────────────────────────────── */

  /* Seconds on the wire, edited in whichever unit reads better. The unit is form
     state rather than local state so paging back to step 1 and returning does
     not silently re-render "5 Minutes" as "300 Seconds". */
  const unit = form.toleranceUnit === 'minutes' ? 'minutes' : 'seconds';
  const perUnit = unit === 'minutes' ? 60 : 1;
  const holdAmount = (() => {
    const secs = Number(form.toleranceSecs);
    if (!Number.isFinite(secs)) return form.toleranceSecs ?? '';
    return String(unit === 'minutes' ? secs / 60 : secs);
  })();

  const setHoldAmount = (raw) => {
    const n = Number(raw);
    set({ toleranceSecs: Number.isFinite(n) ? String(n * perUnit) : raw });
  };

  /* Switching the unit must not change how long the alert holds for — only how
     the number is written. The stored seconds are kept and the box re-reads
     them, the same contract the Check every row keeps for Hours. */
  const setHoldUnit = (next) => set({ toleranceUnit: next });

  return (
    <>
      <div className="aw-card-head">
        <span className="aw-card-bar" aria-hidden="true" />{' '}
        Settings
      </div>

      <div className="aw-card-body">
        {/* A realtime alert is evaluated per ingested row: there is no window to
            look back over and nothing to hold a condition true across. Both rows
            disappear rather than greying out, for the same reason the threshold
            does on that alert type — a disabled control invites the question of
            why it cannot be set. */}
        {scheduled && (
          <>
            <div className="aw-cond-row">
              <span className="aw-cond-label">
                Look back window <span className="ae-req">*</span>
                <Help text={HELP.period} />
              </span>
              <span className="aw-unit-group">
                <input
                  type="number" min="1"
                  className="ae-input aw-cond-num"
                  value={form.period}
                  aria-label="Look back window"
                  onChange={(e) => set({ period: e.target.value })}
                />
                <span className="aw-unit">Minutes</span>
              </span>
            </div>
            {showErr('period') && <div className="ae-error">{errors.period}</div>}
          </>
        )}

        <div className="aw-cond-row">
          <span className="aw-cond-label">
            Cooldown period <span className="ae-req">*</span>
            <Help text={HELP.silence} />
          </span>
          <span className="aw-unit-group">
            <input
              type="number" min="0"
              className="ae-input aw-cond-num"
              value={form.silence}
              aria-label="Cooldown period"
              onChange={(e) => set({ silence: e.target.value })}
            />
            <span className="aw-unit">Minutes</span>
          </span>
        </div>
        {showErr('silence') && <div className="ae-error">{errors.silence}</div>}

        {scheduled && (
          <>
            <div className="aw-cond-row">
              <span className="aw-cond-label">
                Hold for
                <Help text={HELP.tolerance} />
              </span>
              <input
                type="number" min="0"
                className="ae-input aw-cond-num"
                value={holdAmount}
                aria-label="Hold the condition for"
                onChange={(e) => setHoldAmount(e.target.value)}
              />
              <select
                className="ae-select aw-cond-unit"
                value={unit}
                aria-label="Hold for unit"
                onChange={(e) => setHoldUnit(e.target.value)}
              >
                {HOLD_FOR_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
              <span className="ae-hint aw-cond-tail">
                {Number(form.toleranceSecs) > 0
                  ? 'the condition must stay true this long before it fires'
                  : 'fires on the first evaluation that breaches'}
              </span>
            </div>
            {showErr('toleranceSecs') && <div className="ae-error">{errors.toleranceSecs}</div>}
          </>
        )}

        <div className="aw-cond-row aw-cond-row--wrap">
          <span className="aw-cond-label">
            Destination <span className="ae-req">*</span>
            <Help text={HELP.destinations} />
          </span>
          {/* `destinations` is an ARRAY in the document and several channels for
              one alert is the normal case, so this is a multi-select rather than
              a single pick that would drop the rest on an alert authored
              elsewhere. */}
          <CheckboxSelect
            options={destOptions}
            value={form.destinations}
            onChange={(next) => set({ destinations: next })}
            allLabel="Select…"
            noun="destinations"
            ariaLabel="Destinations"
            disabled={destLoading && !destOptions.length}
          />
          {/* Read once on arrival, so one created in another tab is not in this
              list. The reference offers the same refresh in the same place. */}
          <button
            type="button" className="ae-icon-btn"
            onClick={() => loadDestinations()}
            disabled={destLoading}
            title="Refresh the destination list"
            aria-label="Refresh destinations"
          ><IconRefresh /></button>
          <button
            type="button" className="alerts-btn-ghost aw-cond-dest-add"
            onClick={() => setShowDestDialog(true)}
          >Add Destination</button>
        </div>
        {showErr('destinations') && <div className="ae-error">{errors.destinations}</div>}
        {/* Not a validation failure — the list could not be READ, which is worth
            saying separately because the select then simply looks empty and the
            user is being told to pick from nothing. */}
        {destError && (
          <div className="ae-error">Destinations could not be listed — {destError}</div>
        )}

        <div className="aw-cond-row">
          <span className="aw-cond-label">
            Creates Incident
            <Help text={HELP.incident} />
          </span>
          <button
            type="button"
            className={`tb-switch ${form.createsIncident ? 'is-on' : ''}`}
            onClick={() => set({ createsIncident: !form.createsIncident })}
            aria-pressed={!!form.createsIncident}
            aria-label="Creates incident"
          >
            <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
          </button>
          {/* OpenObserve rejects the combination rather than ignoring it, and
              the rule is not guessable from either control on its own. */}
          {form.createsIncident && form.multiAlert && !composite && (
            <span className="ae-hint aw-cond-tail">
              not available with per-group alerting
            </span>
          )}
        </div>
      </div>

      {showDestDialog && (
        <DestinationDialog
          onCancel={() => setShowDestDialog(false)}
          onCreated={(name) => {
            setShowDestDialog(false);
            // ADDED to the selection rather than replacing it: someone adding a
            // second channel to an alert that already pages one has not asked
            // for the first to be removed.
            set({
              destinations: (form.destinations || []).includes(name)
                ? form.destinations
                : [...(form.destinations || []), name],
            });
            // The name is already selected, so a failed refresh only means the
            // label lags — not that the alert lost its destination.
            loadDestinations();
          }}
        />
      )}
    </>
  );
}

SettingsCard.propTypes = {
  /** The editor's form state — see alertModel.docToForm. */
  form: PropTypes.object.isRequired,
  /** Patch one or more form fields. */
  set: PropTypes.func.isRequired,
  /** Every validation error for the form, keyed by field. */
  errors: PropTypes.object.isRequired,
  /** Returns an error only once the field is worth complaining about. */
  showErr: PropTypes.func.isRequired,
};
