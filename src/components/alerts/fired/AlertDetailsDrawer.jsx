import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchAlertDetail } from '../../../services/api';
import {
  alertDrillWindow, buildLogsDrill, buildMetricsDrill, buildTracesDrill, canDrill, drillHint,
} from '../alertDrill';
import useBackdropClose from '../useBackdropClose';

/**
 * The alert details panel.
 *
 * ─── Fetched fresh, not handed the table row ────────────────────────────────
 *
 * The row is enough for the table but not for this: the audit trail, the rule
 * behind the alert and the raw event are only loaded on demand, because
 * attaching them to every row of a 250-row page would be most of the response
 * body for data almost none of it needs.
 *
 * ─── The trail spans EPISODES, not this row ─────────────────────────────────
 *
 * The backend queries it by fingerprint, so "this alert has fired four times
 * before and someone resolved it each time" is visible. Scoping it to the current
 * row would cut the history at the last resolution — usually the exact thing
 * somebody opening this panel wants to know.
 */

const SECTIONS = ['General', 'Resource', 'Timing', 'Rule', 'Telemetry', 'Raw'];

/** The three signals, in the order the rail lists them. */
const TELEMETRY_TARGETS = [
  { key: 'logs', label: 'View logs' },
  { key: 'traces', label: 'View traces' },
  { key: 'metrics', label: 'View metrics' },
];

/**
 * The drill payload for one signal.
 *
 * Built at click time, not on render: it embeds the current clock (the window is
 * anchored on the firing, and a drawer left open for an hour would otherwise send
 * an hour-old window), and building three of them on every re-render is work for a
 * button that is usually not pressed.
 */
const buildDrill = (target, alert, rule) => {
  if (target === 'logs') return buildLogsDrill(alert);
  if (target === 'traces') return buildTracesDrill(alert);
  return buildMetricsDrill(alert, rule);
};

/** "3 entities" / "1 entity", or null when nothing is affected. */
const affectedLabel = (count) => {
  if (count <= 0) return null;
  return `${count} entit${count === 1 ? 'y' : 'ies'}`;
};

const hasId = (a) => a.id !== null && a.id !== undefined;

/** The alert's full record — detail, rule, audit trail, raw event — by id. */
function useAlertDetail(alert) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    // A row read live from the stream has no id, so there is no detail to fetch —
    // the audit trail, the rule link and the raw event all live in PostgreSQL and
    // this firing never reached it. The panel shows the row it was given, which is
    // everything that exists for it, rather than requesting /query/undefined.
    if (alert.id === null || alert.id === undefined) {
      setDetail(null);
      setLoading(false);
      setError('');
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchAlertDetail(alert.id, { signal: controller.signal })
      .then((d) => { if (!cancelled) { setDetail(d); setLoading(false); } })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Could not load this alert.');
        setLoading(false);
      });
    return () => { cancelled = true; controller.abort(); };
  }, [alert.id]);

  return { detail, loading, error };
}

export default function AlertDetailsDrawer({
  alert, onClose, onAction, onNavigate, onCopyId, canAct = true,
}) {
  const { detail, loading, error } = useAlertDetail(alert);
  const [section, setSection] = useState('General');
  const backdropRef = useBackdropClose(onClose);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The freshly-fetched row wins where available; the table's copy is the
  // fallback so the panel has a title and a status immediately rather than
  // flashing empty while the request is in flight.
  const a = detail?.alert || alert;
  const rule = detail?.rule;

  /* The Rule tab exists only when there IS a rule behind it. Alerts here are
     authored in OpenObserve rather than through this service, so nothing links back
     to a stored rule and the tab was a permanent dead end — clicking it taught an
     operator only that it had nothing to teach them.

     Filtered, not deleted: an alert that DOES link a stored rule still gets the tab,
     with the rule's condition and trigger in it. See resolveRule in
     AlertQueryServiceImpl for how that link is made. */
  const sections = useMemo(() => SECTIONS.filter((s) => s !== 'Rule' || !!rule), [rule]);

  /* A tab that no longer exists cannot stay selected. DERIVED rather than corrected
     in an effect: Rule can be open on one alert and gone on the next, and an effect
     would repair that only after a frame had already painted the empty tab. */
  const active = sections.includes(section) ? section : 'General';

  // Only for DISPLAY in the fact list. The buttons rebuild their own window at
  // click time — see buildDrill — so what is shown here can go a few minutes stale
  // on a drawer left open without the drill itself ever being stale.
  const drillWindow = useMemo(() => alertDrillWindow(a), [a]);

  // Numbered once, so two events of the same type at the same instant still
  // get distinct keys.
  const trail = useMemo(
    () => (detail?.events || []).map((e, seq) => ({ ...e, seq })),
    [detail],
  );

  return (
    <dialog
      open
      ref={backdropRef}
      className="alerts-drawer-backdrop native-el"
      aria-modal="true"
      aria-label={`Alert ${a.alertName}`}
    >
      <div className="alerts-drawer alerts-drawer--wide">
        <div className="alerts-modal-head">
          <div className="alerts-drawer-title2">
            <h2 className="alerts-modal-title">{a.alertName}</h2>
            <span className={`alerts-sev2 alerts-sev2--${a.severity || 'info'}`}>
              {a.severity || 'info'}
            </span>
            <span className={`alerts-status2 alerts-status2--${(a.status || '').toLowerCase()}`}>
              <span className="alerts-status2-dot" aria-hidden="true" />
              {a.status || '—'}
            </span>
          </div>
          {/* Copy ID moved here from the table's row menu, which now offers only
              Acknowledge and Resolve. The panel is where an alert's identity
              belongs anyway — this is the view somebody has open when they are
              writing a ticket about it. */}
          {onCopyId && hasId(a) && (
            <button
              type="button" className="alerts-btn-ghost alerts-drawer-copy"
              onClick={() => onCopyId(a)}
              title={`Copy alert id ${a.id}`}
            >Copy ID</button>
          )}
          <button type="button" className="alerts-modal-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <nav className="alerts-drawer-tabs" aria-label="Detail sections">
          {sections.map((s) => (
            <button
              key={s}
              type="button"
              className={`alerts-drawer-tab ${active === s ? 'is-active' : ''}`}
              onClick={() => setSection(s)}
              aria-current={active === s ? 'true' : undefined}
            >{s}</button>
          ))}
        </nav>

        <div className="alerts-drawer-body">
          {error && <div className="ae-error">{error}</div>}
          {loading && !detail && <div className="iam-state">Loading…</div>}

          {active === 'General' && (
            <>
              <Facts rows={[
                ['Alert name', a.alertName],
                // The grouping identity. Shown always rather than only when it differs
                // from the name, because this is the panel where somebody is working out
                // why these firings are one incident.
                ['Incident type', a.incidentType],
                ['Severity', a.severity],
                ['Status', a.status],
                ['Rule', a.ruleName],
                ['Occurrences', `${a.occurrences} (episode ${a.episode})`],
                ['Affected', affectedLabel(a.affectedCount)],
                ['Alert id', a.id],
                ['Fingerprint', a.fingerprint],
              ]} />

              {/* Out of the fact list and into its own block. The description is
                  one paragraph per affected entity, so squeezing it into a
                  single-line <dd> next to "Severity" turned a 2,400-character
                  multi-entity report into an unreadable smear. */}
              {(a.description || a.summary) && (
                <>
                  <h3 className="pc-section-title">
                    Description
                    {a.affectedCount > 1 && (
                      <span className="pc-dim"> · {a.affectedCount} entities</span>
                    )}
                  </h3>
                  {a.description
                    ? <div className="alerts-desc2">{a.description}</div>
                    : <p className="pc-confirm-text">{a.summary}</p>}
                </>
              )}
              {/* Every NUMBER the latest firing carried, straight from the payload.
                  Rendered by iterating the map — there is no list of known metrics here
                  and no `if (key === 'cpu')` — so a rule on a metric this UI has never
                  seen shows up correctly with no change to this file. */}
              <DynamicFacts
                title="Current values"
                map={a.currentValues}
                hint="Read from the latest firing. Current Usage and Limit in the table are the
                      specific pair the rule tested; this is everything the payload reported."
              />

              {a.severitySource && (
                <p className="ae-hint">
                  Severity was decided by <code>{a.severitySource}</code>. That is recorded
                  because a grade nobody can explain is the first thing disputed after a page.
                </p>
              )}
              {a.parseError && (
                <p className="pc-confirm-warn">
                  This alert arrived malformed and is shown anyway rather than dropped:
                  {' '}{a.parseError}
                </p>
              )}
            </>
          )}

          {active === 'Resource' && (
            <>
              <Facts rows={[
                ['Service', a.serviceName],
                ['Host', a.hostName],
                ['Namespace', a.namespace],
                ['Environment', a.environment],
                ['Stream', a.streamName],
                ['Stream type', a.streamType],
                ['Source', a.source],
              ]} />
              {a.entities && (
                <>
                  <h3 className="pc-section-title">Affected</h3>
                  {/* Verbatim from the notification template — a rendered string,
                      not a list this UI can meaningfully split. */}
                  <pre className="alerts-pre2">{a.entities}</pre>
                </>
              )}

              {/* Everything non-numeric the payload carried. The fixed rows above are
                  the fields this application models; these are whatever else the
                  deployment's template chose to emit, shown without needing to be
                  modelled first. */}
              <DynamicFacts
                title="Dimensions & labels"
                map={a.labels}
                hint="Emitted by this deployment's own notification template. Shown as sent —
                      nothing here has to be known to this application to appear."
              />
            </>
          )}

          {active === 'Timing' && (
            <>
              <Facts rows={[
                ['Triggered', when(a.triggeredAt)],
                ['Last fired', when(a.lastFiredAt)],
                ['Last updated', when(a.lastUpdatedAt)],
                ['Duration', a.duration],
                ['Acknowledged', a.acknowledgedBy ? `${a.acknowledgedBy} · ${when(a.acknowledgedAt)}` : null],
                ['Resolved', a.resolvedBy ? `${a.resolvedBy} · ${when(a.resolvedAt)}` : null],
                ['Closed', a.closedBy ? `${a.closedBy} · ${when(a.closedAt)}` : null],
                ['Reopened', a.reopenCount ? `${a.reopenCount} time(s)` : null],
              ]} />
              {a.autoResolved && (
                <p className="ae-hint">
                  Resolved by the staleness sweep, not by a person. OpenObserve emits no
                  “recovered” event, so silence is the only available signal — reopen it if
                  the condition has not actually cleared.
                </p>
              )}

              <h3 className="pc-section-title">History</h3>
              {trail.length ? (
                <ol className="alerts-trail2">
                  {trail.map((e) => (
                    <li key={`${e.type}-${e.occurredAt}-${e.seq}`} className={`alerts-trail2-${(e.type || '').toLowerCase()}`}>
                      <span className="alerts-trail2-type">{e.type}</span>
                      <span className="alerts-trail2-when">{when(e.occurredAt)}</span>
                      <span className="alerts-trail2-actor">{e.actor || '—'}</span>
                      {e.note && <span className="alerts-trail2-note">{e.note}</span>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="ae-hint">No recorded events yet.</p>
              )}
            </>
          )}

          {/* Reachable only when a rule IS linked — the tab is filtered out otherwise,
              see `sections` above. No empty-state branch here for that reason: the way
              a rule-less alert says so is by not offering the tab at all. */}
          {active === 'Rule' && (
            <>
              <Facts rows={[
                ['Rule name', rule.name],
                ['Description', rule.description],
                ['Enabled', rule.enabled ? 'Yes' : 'No'],
                ['Configured severity', rule.severity],
                ['Stream', `${rule.streamType || '?'} / ${rule.streamName || '?'}`],
                ['Sync status', rule.syncStatus],
                ['Threshold', a.threshold],
                ['Operator', a.operator],
                ['Evaluation window', a.periodMinutes ? `${a.periodMinutes} min` : null],
                ['Observed', a.observedCount],
                ['Value', a.aggValue],
              ]} />
              {rule.syncStatus && rule.syncStatus !== 'SYNCED' && (
                <p className="pc-confirm-warn">
                  This rule is <strong>{rule.syncStatus}</strong> — the definition stored here is
                  not what OpenObserve is currently evaluating. The retry sweep will push it.
                </p>
              )}
              <h3 className="pc-section-title">Condition</h3>
              <pre className="alerts-pre2">{pretty(rule.queryCondition)}</pre>
              <h3 className="pc-section-title">Trigger</h3>
              <pre className="alerts-pre2">{pretty(rule.triggerCondition)}</pre>
            </>
          )}

          {active === 'Telemetry' && (
            <>
              <p className="ae-hint">
                Jump to the telemetry this alert came from — scoped to what it identifies
                (its service, and its pod or container where the signal carries one) and to
                the window around this firing, not to the whole screen.
              </p>
              {/* Each button says what it will do BEFORE it is pressed. The three
                  signals can be scoped to different degrees by the same alert — a
                  trace id pins one trace exactly, while logs can only be narrowed to
                  a service — and a drill that silently does less than the operator
                  expects is how a link stops being trusted. */}
              <div className="alerts-telemetry3">
                {TELEMETRY_TARGETS.map(({ key, label }) => (
                  <div className="alerts-telemetry3-row" key={key}>
                    <button
                      type="button" className="alerts-btn-ghost"
                      disabled={!onNavigate || !canDrill(key, a)}
                      onClick={() => onNavigate?.(key, a, buildDrill(key, a, rule))}
                    >{label}</button>
                    <span className="alerts-telemetry3-hint">{drillHint(key, a, rule)}</span>
                  </div>
                ))}
                {a.alertUrl && (
                  <div className="alerts-telemetry3-row">
                    <a
                      className="alerts-btn-ghost" href={a.alertUrl}
                      target="_blank" rel="noreferrer noopener"
                    >Open in OpenObserve</a>
                    <span className="alerts-telemetry3-hint">
                      The alert as OpenObserve itself shows it.
                    </span>
                  </div>
                )}
              </div>

              {/* The window the buttons will actually open on, spelled out. It is
                  derived (see alertDrill.js) rather than copied from the payload,
                  so showing only the raw fields below would describe a different
                  range than the one you land on. */}
              <Facts rows={[
                ['Drill window', `${drillWindow.from.replace('T', ' ')} → ${drillWindow.to.replace('T', ' ')}`],
                ['Trace id', a.traceId],
                ['Window start', when(a.windowStart)],
                ['Window end', when(a.windowEnd)],
              ]} />
              {!a.serviceName && (
                <p className="ae-hint">
                  This alert names no service, so the telemetry links fall back to the whole
                  window. Infrastructure alerts often identify a host rather than a service.
                </p>
              )}
            </>
          )}

          {active === 'Raw' && (
            <>
              <p className="ae-hint">
                The notification exactly as it arrived in the stream. Kept so a template
                this application does not model is still forensically useful.
              </p>
              <pre className="alerts-pre2 alerts-pre2--raw">
                {pretty(detail?.rawPayload) || 'No raw payload retained for this alert.'}
              </pre>
            </>
          )}
        </div>

        <div className="alerts-modal-foot">
          <button type="button" className="alerts-btn-ghost" onClick={onClose}>Close</button>
          {/* Everything the drawer shows above this footer is a read: the alert, its
              rule, its labels. Only the transitions are writes, so without the grant
              the drawer stays fully useful and loses just this row of buttons.

              An id-less row loses them for a different reason — it was read live from
              the stream and was never ingested, so there is no incident to transition.
              Same empty list, so the drawer needs no second branch. */}
          {(canAct && hasId(a) ? transitionsFor(a) : []).map((action) => (
            <button
              key={action}
              type="button"
              className={action === 'reopen' ? 'alerts-btn-ghost' : 'alerts-btn-primary'}
              onClick={() => onAction(a, action)}
            >{LABEL[action]}</button>
          ))}
        </div>
      </div>
    </dialog>
  );
}

/**
 * The buttons this alert should offer.
 *
 * <p>Unlike the row menu, the drawer offers the full set including Reopen — it is
 * the screen where a transition is made deliberately rather than in passing, which
 * is exactly why Reopen was kept out of the menu and put here.</p>
 *
 * <p>Takes the server's `actions` when the row carries one. It comes from
 * {@code AlertState.availableActions}, the same rule the write path enforces, so a
 * button rendered from it cannot come back 400 — and unlike {@link ALLOWED} it
 * cannot fall out of step when the backend's rules change.</p>
 */
function transitionsFor(alert) {
  return Array.isArray(alert.actions) ? alert.actions : (ALLOWED[alert.status] || []);
}

/**
 * Fallback transitions for a row the server did not annotate — an older backend, or
 * a row read live from the stream. Mirrors the backend's rules as they stand.
 */
const ALLOWED = {
  FIRING: ['acknowledge', 'resolve', 'close'],
  ACKNOWLEDGED: ['resolve', 'close'],
  RESOLVED: ['reopen', 'close'],
  CLOSED: ['reopen'],
};

const LABEL = {
  acknowledge: 'Acknowledge',
  resolve: 'Resolve',
  close: 'Close',
  reopen: 'Reopen',
};

/** A definition list that drops rows with nothing in them. */
function Facts({ rows }) {
  const present = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!present.length) {
    return <p className="ae-hint">Nothing recorded for this section.</p>;
  }
  return (
    <dl className="pc-facts">
      {present.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt>{label}</dt>
          <dd>{String(value)}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

Facts.propTypes = { rows: PropTypes.array.isRequired };

/**
 * A backend-supplied map, rendered without knowing what is in it.
 *
 * <p>This is the component that keeps the promise that a new metric needs no UI change.
 * It iterates whatever keys arrived; there is no vocabulary of known field names here,
 * and adding one — {@code if (key === 'cpu') …} — would break the guarantee for every
 * metric not in the list.</p>
 *
 * <p>Renders nothing at all when the map is empty, rather than an empty panel with a
 * heading. A section title over "nothing recorded" reads as a feature that is broken
 * rather than a payload that simply did not carry those fields.</p>
 */
function DynamicFacts({ title, map, hint }) {
  const entries = map && typeof map === 'object' ? Object.entries(map) : [];
  if (!entries.length) return null;

  return (
    <>
      <h3 className="pc-section-title">
        {title}
        <span className="pc-dim"> · {entries.length}</span>
      </h3>
      <dl className="pc-facts alerts-dynfacts">
        {entries.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt title={key}>{key}</dt>
            <dd>{formatDynamic(value)}</dd>
          </React.Fragment>
        ))}
      </dl>
      {hint && <p className="ae-hint">{hint}</p>}
    </>
  );
}

DynamicFacts.propTypes = {
  title: PropTypes.string.isRequired,
  /** Whatever the backend sent — keys are the payload's own field names. */
  map: PropTypes.object,
  hint: PropTypes.string,
};

/**
 * Print a dynamic value without asserting a unit.
 *
 * <p>No "%" or "MB" is appended. The key names the field and the payload did not say
 * what it measures, so a fabricated unit on a number somebody pastes into a ticket is
 * worse than no unit. Long decimals are trimmed because a float that arrived as
 * 0.8500000000000001 is noise, not precision.</p>
 */
function formatDynamic(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }
  return String(value);
}

/** Pretty-print JSON, falling back to the raw text when it is not JSON. */
function pretty(text) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // A template can render anything, including something that is not JSON at
    // all. Showing it raw beats showing nothing.
    return text;
  }
}

function when(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

AlertDetailsDrawer.propTypes = {
  /** The table row. Used for the title until the full detail arrives. */
  alert: PropTypes.shape({
    id: PropTypes.number.isRequired,
    alertName: PropTypes.string,
    severity: PropTypes.string,
    status: PropTypes.string,
  }).isRequired,
  onClose: PropTypes.func.isRequired,
  /** (alert, action) — acknowledge | resolve | close | reopen. */
  onAction: PropTypes.func.isRequired,
  /** May this user change the alert's state? False hides the transition buttons and
   *  leaves everything else. Defaults true so existing callers are unaffected. */
  canAct: PropTypes.bool,
  /** Copies the alert id. Optional — the header button is omitted without it. */
  onCopyId: PropTypes.func,
  /** (tab, alert) — jump to Logs/Traces/Metrics scoped to this alert. */
  onNavigate: PropTypes.func,
};
