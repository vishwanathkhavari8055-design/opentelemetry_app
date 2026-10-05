import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * The enterprise alert table.
 *
 * ─── The columns are the operator's triage order ────────────────────────────
 *
 * First Seen · Alert · Service · Severity · Current Usage · Limit · Actions ·
 * Last Seen. It reads as a sentence: this started then, it is this thing on this
 * service, it is this bad, here is the number and what the number is measured
 * against, here is what you can do, and it was last seen then.
 *
 * Current Usage and Limit are ADJACENT on purpose, and both carry their unit: the
 * row reads "4040 MB" against "5120 MB" rather than "78.9" against nothing. The
 * percentage sits under the used figure because it answers a different question —
 * how close to the edge — and neither number replaces the other.
 *
 * Units are the template's own, NOT rescaled. 5120 MB is not shown as "5 GB",
 * because the alert's `display_value` says MB and a table that disagrees with the
 * alert's own text is worse than one that repeats it.
 *
 * Source, Stream, Rule, Duration and Updated are gone. Source and Stream were the
 * same two values on every row here, Rule was a column of em-dashes because these
 * alerts are authored in OpenObserve rather than through this service, and
 * Duration/Updated are derivable from the two timestamps that now bracket the row.
 * Dropping five columns is what buys First Seen and Last Seen the room to show a
 * real timestamp instead of a truncated one.
 *
 * ─── The Actions cell IS the status ─────────────────────────────────────────
 *
 * There is no status pill beside the alert name. The Actions control carries the
 * state instead: an open alert reads "Actions", and acknowledging it turns that
 * button into "Acknowledged". A resolved one reads "Resolved" and stops being a
 * control at all.
 *
 * Folding the two together is what keeps them honest. As separate cells they could
 * disagree — a pill saying Acknowledged beside a menu still offering Acknowledge —
 * and the row-level question is not "what state is this in" so much as "is there
 * anything for me to do with it", which is one answer, in one place.
 *
 * The acknowledger's name is in that control's tooltip rather than on the row: it
 * matters when you are deciding whether to touch an alert somebody else has taken,
 * and not while scanning for the next thing to look at.
 *
 * ─── Sorting is a server round trip, not a local re-order ───────────────────
 *
 * Clicking a header asks the backend to sort the whole table and return page 0.
 * Sorting the rows already on screen would sort one page of a paged result —
 * "sort by severity" would surface the worst alert *on this page*, which on page
 * three is meaningless and looks like the sort is broken.
 *
 * ─── Severity gets a word, never colour alone ───────────────────────────────
 *
 * Colour-only encoding fails for anyone who cannot distinguish them, and fails
 * completely in a screenshot pasted into a ticket.
 */

/** Columns, in order. `sort` is the backend field; absent means not sortable. */
const COLUMNS = [
  { key: 'select', label: '', width: 34 },
  { key: 'triggeredAt', label: 'First Seen', sort: 'firstFiredAt' },
  { key: 'alertName', label: 'Alert', sort: 'alertName' },
  { key: 'serviceName', label: 'Service', sort: 'serviceName' },
  { key: 'severity', label: 'Severity', sort: 'severity' },
  { key: 'aggValue', label: 'Current Usage' },
  { key: 'actions', label: 'Actions' },
  { key: 'lastFiredAt', label: 'Last Seen', sort: 'lastFiredAt' },
];

/**
 * The transitions the row menu offers, in menu order — Acknowledge, then Resolve.
 *
 * <p>FIXED, not derived from the row's status. The cell used to render whatever the
 * server's `actions` array happened to contain, so the control changed shape as an
 * alert moved through its lifecycle: two buttons while firing, one once acknowledged,
 * a bare text label once resolved. An operator scanning the table could not learn
 * where to click, because where to click depended on the row.</p>
 *
 * <p>Close and Reopen stay out of it and remain in the details panel: Close is rare
 * enough not to earn the width, and Reopen puts work back on somebody's queue, which
 * should not sit a pixel away from Resolve.</p>
 */
const ROW_ACTIONS = ['acknowledge', 'resolve'];

const ACTION_LABEL = {
  acknowledge: 'Acknowledge',
  resolve: 'Resolve',
  close: 'Close',
};

/**
 * Why a menu line is not clickable, or null when it is.
 *
 * <p>Mirrors the backend's {@code applyAction} guards rather than its
 * {@code availableActions} list. The menu always shows both lines, so the check that
 * used to decide whether to RENDER a control now decides whether to ENABLE it — a
 * line that would come back 400 is greyed with the reason on it instead of silently
 * missing. A resolved alert accepts neither, which is what its two disabled lines
 * say.</p>
 */
function refusalFor(action, status) {
  const terminal = status === 'RESOLVED' || status === 'CLOSED';
  if (action === 'acknowledge' && terminal) {
    return `This alert is ${status.toLowerCase()} — reopen it from the details panel first.`;
  }
  if (action === 'resolve' && terminal) {
    return status === 'RESOLVED'
      ? 'This alert is already resolved.'
      : 'This alert is closed — reopen it from the details panel first.';
  }
  return null;
}

/**
 * What the cell reads as when it is NOT a control, and the marker an acknowledged
 * row carries beside its Resolve button.
 *
 * <p>"Firing" rather than "Actions": this text renders for a resolved alert, for a
 * live-stream row and for a viewer without permission, and naming a control that is
 * not there would be worse than naming the state.</p>
 */
const STATE_LABEL = {
  FIRING: 'Firing',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export default function AlertsTable({
  items, loading, refreshing, sortBy, sortDir, onSort,
  selected, onToggleSelect, onToggleSelectAll,
  onOpen, onAction, pendingId, hasFilters, canAct = true,
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  /* Rows read live from the stream have no id — they were never ingested, so there
     is nothing for a transition route to address. They are excluded from selection
     rather than special-cased downstream: a bulk action over `undefined` ids would
     be a request the backend can only reject one row at a time. */
  const visibleIds = useMemo(
    () => items.map((a) => a.id).filter((id) => id !== null && id !== undefined),
    [items],
  );
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const someSelected = visibleIds.some((id) => selectedSet.has(id)) && !allSelected;

  return (
    <div className={`alerts-table2 ${refreshing ? 'is-refreshing' : ''}`}>
      <div className="alerts-row2 alerts-row2--head">
        {COLUMNS.map((col) => {
          if (col.key === 'select') {
            return (
              <span key={col.key}>
                <input
                  type="checkbox"
                  className="pt-check"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  disabled={visibleIds.length === 0 || !canAct}
                  onChange={() => onToggleSelectAll(visibleIds, !allSelected)}
                  aria-label={allSelected ? 'Clear selection' : 'Select all rows on this page'}
                />
              </span>
            );
          }
          if (!col.sort) {
            return <span key={col.key}>{col.label}</span>;
          }
          const active = sortBy === col.sort;
          
          let caret = '↕';
          let ariaSort = 'none';
          if (active) {
            caret = sortDir === 'asc' ? '↑' : '↓';
            ariaSort = sortDir === 'asc' ? 'ascending' : 'descending';
          }
          const sortAttr = { 'aria-sort': ariaSort };

          return (
            <span key={col.key}>
              <button
                type="button"
                {...sortAttr}
                className={`alerts-sort2 ${active ? 'is-active' : ''}`}
                onClick={() => onSort(col.sort)}
                title={`Sort by ${col.label.toLowerCase()}`}
              >
                {col.label}
                <span className="alerts-sort2-caret" aria-hidden="true">
                  {caret}
                </span>
              </button>
            </span>
          );
        })}
      </div>

      <div className="alerts-body2">
        {/* Skeleton rows, not a spinner: the table's shape is already known, and a
            spinner makes the layout jump when the rows land. */}
        {loading && items.length === 0 && Array.from({ length: 8 }).map((_, i) => (
          <div className="alerts-row2 alerts-row2--skeleton" key={`skel-${i}`} aria-hidden="true">
            {COLUMNS.map((col) => (
              <span key={col.key}><span className="alerts-skel" /></span>
            ))}
          </div>
        ))}

        {!loading && items.length === 0 && (
          <div className="iam-state">
            {hasFilters
              ? 'No alerts match these filters. Widen the time range or clear a filter.'
              : 'No alerts recorded yet. When a rule fires, OpenObserve writes it to the '
                + 'alert_events stream and it appears here within one poll.'}
          </div>
        )}

        {items.map((alert) => {
          const status = alert.status || 'FIRING';
          /* No permission to change state → no transitions offered, whatever the
             status. This deliberately reuses the path a RESOLVED row already takes:
             an empty allowed-list renders the cell as the state label alone, which
             is exactly the read-only presentation wanted here. No new branch, and
             the cell still reports what state the row is in. */
          /* A live-stream row has no id, but it does carry a fingerprint, and the
             notification routes acknowledge and resolve by fingerprint — so it is
             still actionable. Only a row with neither has nothing to address, which
             takes the same read-only presentation as a row the user has no
             permission for. See FiredAlertsPage.applyTransition. */
          const hasId = alert.id !== null && alert.id !== undefined;
          const actionable = hasId || !!alert.fingerprint;
          /* The menu itself is fixed — see ROW_ACTIONS. What is still conditional is
             whether the row has a menu AT ALL, and that turns only on permission and
             on the row having a lifecycle to act on, never on its status. */
          const allowed = canAct && actionable ? ROW_ACTIONS : [];
          /* pendingId is the id when there is one and the fingerprint otherwise —
             see FiredAlertsPage.runAction — so the spinner lands on the right row
             whichever route the transition took. */
          const busy = pendingId != null && pendingId === (hasId ? alert.id : alert.fingerprint);
          /* Selection stays id-ONLY: it feeds the bulk bar, which posts a list of
             ids. A fingerprint row can be acknowledged on its own but cannot join a
             bulk request, so it must not look selectable. */
          const isSelected = hasId && selectedSet.has(alert.id);

          return (
            <div
              className={`alerts-row2 ${isSelected ? 'is-selected' : ''} ${
                status === 'FIRING' ? 'is-open' : ''}`}
              key={hasId ? alert.id : `live-${alert.fingerprint}-${alert.lastFiredAt}`}
            >
              <span>
                {/* Selection exists ONLY to feed the bulk action bar, so it is
                    disabled — not removed — when there are no bulk actions to reach.
                    Removing it would shift every column left of the header's, and a
                    disabled checkbox states "not available to you" more plainly than
                    a missing one. */}
                <input
                  type="checkbox"
                  className="pt-check"
                  checked={isSelected}
                  disabled={!canAct || !hasId}
                  onChange={() => onToggleSelect(alert.id)}
                  aria-label={`Select ${alert.alertName}`}
                  title={selectTitle(canAct, hasId)}
                />
              </span>

              {/* FIRST SEEN — when this incident started. */}
              <span className="alerts-time2" title={absoluteTime(alert.triggeredAt)}>
                {stamp(alert.triggeredAt)}
              </span>

              <span className="alerts-name2">
                <button
                  type="button"
                  className="alerts-name2-btn"
                  onClick={() => onOpen(alert)}
                  // The HEADLINE, never the full description. The description is a
                  // block per affected entity — up to 2,400 characters — and a
                  // tooltip that long is a wall of text nobody reads.
                  title={alert.descriptionHeadline || alert.summary || alert.alertName}
                >{alert.alertName}</button>

                {/* THE INCIDENT TYPE, shown only when it differs from the rule name.
                    They differ exactly when a rule set expresses severity as separate
                    rules and this condition has escalated — the row is named for the
                    rule that fired most recently, while the type is what groups every
                    level of it into this one incident. Showing the type then is what
                    explains why a row named "…-disaster" has a history that starts
                    with warnings. When they are equal it would just be the same text
                    twice, so it is omitted. */}
                {alert.incidentType && alert.incidentType !== alert.alertName && (
                  <span className="alerts-badge2 alerts-badge2--type"
                    title={`Incident type "${alert.incidentType}" — every severity level of `
                      + 'this condition aggregates into one incident, so the rule that fired '
                      + `most recently (${alert.alertName}) can differ from the type.`}>
                    {alert.incidentType}
                  </span>
                )}

                {/* No status pill here. The Actions cell carries the state now —
                    "Acknowledged" is both what the row IS and what you can still do
                    to it, so there is one place to read rather than two that can look
                    like they disagree.

                    The badges below are NOT status: each one changes what the row
                    means (how many entities, how many firings since it was
                    acknowledged, whether it has been reopened, whether it arrived
                    malformed) and none of them is derivable from the state. */}
                {/* IT CAME BACK. An alert that is resolved and fires again is a NEW
                    episode — a new row with the actions available again — which is
                    what makes the Actions cell go from "Resolved" back to
                    actionable. Without this badge that new row is indistinguishable
                    from a first-time alert, so a condition that has been resolved
                    eight times and keeps returning reads as eight unrelated
                    incidents. The number is the episode: 9th means it has come back
                    eight times. */}
                {alert.episode > 1 && (
                  <span className="alerts-badge2 alerts-badge2--recurring"
                    title={`Recurrence: this is episode ${alert.episode}. It has been `
                      + `resolved and fired again ${alert.episode - 1} time(s). Each return is a `
                      + 'fresh episode, so it needs acknowledging again — the earlier '
                      + "episodes' history is in Details."}>
                    {ordinal(alert.episode)}
                  </span>
                )}
                {alert.affectedCount > 1 && (
                  <span className="alerts-badge2 alerts-badge2--affected"
                    title={`${alert.affectedCount} affected entities`}>
                    ×{alert.affectedCount}
                  </span>
                )}
                {alert.newSinceAck > 0 && (
                  <span className="alerts-badge2 alerts-badge2--new"
                    title={`${alert.newSinceAck} more firings since it was acknowledged`}>
                    +{alert.newSinceAck}
                  </span>
                )}
                {alert.reopenCount > 0 && (
                  <span className="alerts-badge2 alerts-badge2--reopen"
                    title={`Reopened ${alert.reopenCount} time(s)`}>
                    ↻{alert.reopenCount}
                  </span>
                )}
                {alert.parseError && (
                  <span className="alerts-badge2 alerts-badge2--warn"
                    title={`This alert arrived malformed: ${alert.parseError}`}>!</span>
                )}
              </span>

              <span title={alert.serviceName || ''}>{alert.serviceName || '—'}</span>

              <span>
                <span className={`alerts-sev2 alerts-sev2--${alert.severity || 'info'}`}>
                  {alert.severity || 'info'}
                </span>
              </span>

              {/* CURRENT USAGE — the absolute amount in use, with the percentage
                  under it. "4040 MB" answers what is happening; "78.9%" answers how
                  close to the edge it is, and neither replaces the other. Where the
                  template carries no absolute figure (a restart count, a pod phase)
                  the raw measure is shown on its own, because for those it IS the
                  whole measurement.

                  The Limit column that used to sit beside this one is gone: no rule
                  on this deployment emits a ceiling, so it was a dash on every row.
                  The ceiling still reaches the operator when one IS present — it is
                  in this cell's tooltip, via measurementTitle. */}
              <span className="alerts-usage2" title={measurementTitle(alert)}>
                {alert.usedLabel ? (
                  <>
                    <span className="alerts-usage2-main">{alert.usedLabel}</span>
                    {percentOf(alert) !== null && (
                      <span className="alerts-usage2-pct">{percentOf(alert)}%</span>
                    )}
                  </>
                ) : formatUsage(alert.aggValue)}
              </span>

              <span className="alerts-actions2">
                <RowActions
                  alert={alert}
                  status={status}
                  allowed={allowed}
                  busy={busy}
                  onAction={onAction}
                  readOnlyReason={readOnlyReason(canAct, actionable)}
                />
              </span>

              {/* LAST SEEN — the most recent firing, which is what says whether this
                  is still happening. */}
              <span className="alerts-time2" title={absoluteTime(alert.lastFiredAt)}>
                {stamp(alert.lastFiredAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The Actions cell: one trigger that opens a fixed two-line menu.
 *
 * <p>Acknowledge on top, Resolve under it, on every row that has a lifecycle — the
 * same two lines in the same order whatever state the alert is in. That fixedness is
 * the point. The cell previously rendered the server's per-status `actions` array
 * directly, so it was two buttons on a firing row, one on an acknowledged row and
 * plain text on a resolved one; the control moved and changed as you read down the
 * table.</p>
 *
 * <p>A menu rather than two adjacent buttons for the older reason this cell has gone
 * back and forth over: two controls with opposite meanings a few pixels apart is how
 * somebody resolves an alert they meant to acknowledge. Each line is now named and
 * chosen deliberately.</p>
 *
 * <p>The trigger still reports state — it reads "Acknowledged" or "Resolved" rather
 * than "Actions" once the alert is in one of those — so the merged status/actions
 * cell keeps answering "what state is this in" as well as "what can I do".</p>
 */
function RowActions({ alert, status, allowed, busy, onAction, readOnlyReason }) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);

  // Close on an outside click or Escape. Bound only while open, so a table of 500
  // rows does not carry 500 idle document listeners.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const stateClass = `alerts-actstate--${status.toLowerCase()}`;

  // No permission, or a live-stream row with no id and so nothing to address: reads
  // as its state and stops being a control, exactly as before.
  //
  // The TOOLTIP says which of those it is. On a firing row the label alone reads as
  // a status column and invites exactly one question — "why is there no Acknowledge
  // here?" — which the state word cannot answer.
  if (allowed.length === 0) {
    return (
      <span
        className={`alerts-actstate ${stateClass}`}
        title={readOnlyReason || statusTitle(alert, status)}
      >
        {STATE_LABEL[status] || status}
      </span>
    );
  }

  const toggle = () => {
    // The table body scrolls and clips to its own box, so a row near the bottom
    // opens upward instead of having its menu cut in half. Measured at click time
    // rather than on mount — the row's position changes as the body scrolls.
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropUp(window.innerHeight - rect.bottom < 120);
    }
    setOpen((v) => !v);
  };

  const choose = (action) => {
    setOpen(false);
    onAction(alert, action);
  };

  return (
    <span className="alerts-menu" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`iam-switch-btn alerts-menu-btn ${
          status === 'ACKNOWLEDGED' ? stateClass : ''}`}
        disabled={busy}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title={statusTitle(alert, status)}
      >
        {/* Firing reads "Actions" — the state is already carried by the row's own
            highlight, and the cell's job on a live alert is to invite the click. */}
        {(() => {
          if (busy) return '…';
          if (status === 'FIRING') return 'Actions';
          return STATE_LABEL[status] || 'Actions';
        })()}
        <span className="alerts-menu-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <span className={`alerts-menu-pop ${dropUp ? 'is-up' : ''}`} role="menu">
          {ROW_ACTIONS.map((action) => {
            const refusal = refusalFor(action, status);
            return (
              <button
                key={action}
                type="button"
                role="menuitem"
                className={`alerts-menu-item alerts-menu-item--${action}`}
                disabled={!!refusal}
                onClick={() => choose(action)}
                title={refusal || titleFor(action, alert)}
              >
                {ACTION_LABEL[action]}
              </button>
            );
          })}
        </span>
      )}
    </span>
  );
}

RowActions.propTypes = {
  alert: PropTypes.object.isRequired,
  /** Drives the trigger's label and which menu lines are enabled — never which exist. */
  status: PropTypes.string.isRequired,
  /** Empty when the viewer cannot act, or the row has no id: the cell is then read-only. */
  allowed: PropTypes.array.isRequired,
  busy: PropTypes.bool,
  onAction: PropTypes.func.isRequired,
  /** Why the menu is absent, for the read-only cell's tooltip. */
  readOnlyReason: PropTypes.string,
};

/** Explains what a transition will do, rather than restating the menu text. */
function titleFor(action, alert) {
  switch (action) {
    case 'acknowledge':
      return 'Take ownership. Asks for your name, then stops it shouting on the next '
        + 'evaluation while it keeps counting firings.';
    case 'resolve':
      return 'Mark the condition as over.';
    case 'close':
      return 'Finish with it. Distinct from resolve — closure is never inferred by the sweep.';
    case 'reopen':
      return alert.autoResolved
        ? 'This was resolved automatically after it went quiet. Reopen it if it is not actually over.'
        : 'Put it back on the active list. The previous acknowledgement is cleared.';
    default:
      return undefined;
  }
}

/** Who holds this alert, and how it reached its current state. */
function statusTitle(alert, status) {
  if (status === 'ACKNOWLEDGED' && alert.acknowledgedBy) {
    const atStr = alert.acknowledgedAt ? ` at ${absoluteTime(alert.acknowledgedAt)}` : '';
    return `Acknowledged by ${alert.acknowledgedBy}${atStr}`;
  }
  if (status === 'RESOLVED') {
    if (alert.autoResolved) {
      return 'Resolved by the staleness sweep after it stopped firing, not by a person';
    }
    const byStr = alert.resolvedBy ? ` by ${alert.resolvedBy}` : '';
    return `Resolved${byStr}`;
  }
  if (status === 'CLOSED') {
    const byStr = alert.closedBy ? ` by ${alert.closedBy}` : '';
    return `Closed${byStr}`;
  }
  return 'Open — nobody has taken this on yet';
}

/**
 * The observed value that tripped the rule — OpenObserve's `current_usage`.
 *
 * NO UNIT is appended, deliberately. The field carries whatever the alert template
 * put in it: these rules report a percentage, but a restart-count rule reports a
 * count and a state rule reports 1. Printing "%" would be a fabricated unit on two
 * of those three, and a wrong unit on a number somebody pastes into a ticket is
 * worse than no unit. The Limit column beside it, and the tooltip on both, carry
 * the units the template actually declared.
 */
function formatUsage(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  // One decimal keeps the column narrow. Whole numbers stay whole rather than
  // gaining a ".0" that suggests precision the source did not report.
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** "9th", "2nd" — the episode number, read as a recurrence count. */
function ordinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  switch (v % 10) {
    case 1: return `${v}st`;
    case 2: return `${v}nd`;
    case 3: return `${v}rd`;
    default: return `${v}th`;
  }
}

/**
 * The percentage, shown only alongside an absolute figure.
 *
 * <p>`aggValue` is the template's `current_usage`, which is a percentage for exactly
 * the alerts that also report a used amount — memory and disk. For the others it is
 * a count or a 1, and calling that "%" would be a fabricated unit, so the caller
 * only reaches this when `usedLabel` is set.</p>
 */
function percentOf(alert) {
  const n = Number(alert.aggValue);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? n : n.toFixed(1);
}

/**
 * The tooltip shared by Current Usage and Limit.
 *
 * Leads with the template's own rendering (`display_value`) because that is the
 * one measurement field every alert shape here carries, and it is what explains a
 * row whose Limit is legitimately blank — "state: Pending" has no ceiling.
 */
function measurementTitle(alert) {
  const parts = [];
  if (alert.displayValue) parts.push(alert.displayValue);
  if (alert.usedLabel && alert.limitLabel) {
    parts.push(`${alert.usedLabel} of ${alert.limitLabel}`);
  } else if (alert.limitLabel) {
    parts.push(`Limit ${alert.limitLabel}`);
  }
  if (alert.aggValue !== null && alert.aggValue !== undefined) {
    parts.push(`Observed ${alert.aggValue}`);
  }
  if (alert.operator && alert.threshold !== null && alert.threshold !== undefined) {
    parts.push(`threshold ${alert.operator} ${alert.threshold}`);
  }
  if (alert.observedCount !== null && alert.observedCount !== undefined) {
    parts.push(`${alert.observedCount} matching record(s)`);
  }
  return parts.length ? parts.join(' · ') : 'This alert reported no observed value';
}

/**
 * A real timestamp, because these two columns are the ones people cite.
 *
 * "14:32" was fine for a column called Updated and is not fine for First Seen: an
 * alert that started three days ago and one that started this morning rendered
 * identically. Date and time always, seconds included — the burst behaviour of
 * these rules means two firings a minute apart are common and a minute-precision
 * stamp makes them look simultaneous.
 */
function stamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/**
 * Why a row's checkbox is disabled, in the row's own terms.
 *
 * <p>The two reasons are not interchangeable and a shared "unavailable" tooltip
 * would hide the difference: one is about the person, one is about the row. Someone
 * told they lack permission will ask for permission; someone told the row was read
 * live from the stream will go and fix the ingest.</p>
 */
/**
 * Why the Actions cell is a label instead of a menu.
 *
 * <p>Same two causes as {@link selectTitle}, worded for the cell that lost its
 * control rather than for the checkbox. Returns undefined when the menu is present,
 * so the cell falls back to its ordinary status tooltip.</p>
 */
function readOnlyReason(canAct, actionable) {
  if (!canAct) {
    return 'You do not have permission to acknowledge or resolve alerts';
  }
  if (!actionable) {
    return 'This row carries neither an alert id nor a fingerprint, so there is '
      + 'nothing for a transition to address';
  }
  return undefined;
}

function selectTitle(canAct, actionable) {
  if (!canAct) {
    return 'Selection is used for bulk actions, which you do not have permission to run';
  }
  if (!actionable) {
    return 'Read live from the alert_events stream — this firing was never ingested, '
      + 'so there is no incident to acknowledge or resolve';
  }
  return undefined;
}

/** Full local time plus the raw ISO, for pasting into a ticket. */
export function absoluteTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString()} · ${iso}`;
}

AlertsTable.propTypes = {
  items: PropTypes.array.isRequired,
  loading: PropTypes.bool,
  /** True during a background refresh — the rows stay, dimmed. */
  refreshing: PropTypes.bool,
  sortBy: PropTypes.string.isRequired,
  sortDir: PropTypes.string.isRequired,
  onSort: PropTypes.func.isRequired,
  selected: PropTypes.array.isRequired,
  onToggleSelect: PropTypes.func.isRequired,
  onToggleSelectAll: PropTypes.func.isRequired,
  /** May this user change a firing's state? False renders the table read-only:
   *  no transitions offered, selection disabled. Defaults true so the component
   *  behaves exactly as before for any caller that does not pass it. */
  canAct: PropTypes.bool,
  onOpen: PropTypes.func.isRequired,
  /** (alert, action) — acknowledge | resolve | close | reopen. */
  onAction: PropTypes.func.isRequired,
  /** Id currently mid-request, so its menu disables without freezing the table. */
  pendingId: PropTypes.number,
  hasFilters: PropTypes.bool,
};
