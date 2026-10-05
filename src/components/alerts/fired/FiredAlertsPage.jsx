import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import AlertFilters from './AlertFilters';
import AlertSummaryCards from './AlertSummaryCards';
import AlertsTable from './AlertsTable';
import AlertDetailsDrawer from './AlertDetailsDrawer';
import Toast from '../../common/Toast';
import { PAGE_SIZES, useAlerts } from './useAlerts';
import { acknowledgeAlertNotification, resolveAlertNotification } from '../../../services/api';
import { usePermissions } from '../../../auth/usePermissions';
import { PERMISSIONS } from '../../../auth/constants';
import useBackdropClose from '../useBackdropClose';

/**
 * The Alerts screen.
 *
 * Orchestration only — the data lives in {@link useAlerts}, the presentation in the
 * four components below. This file owns the three things that genuinely span them:
 * which rows are selected, which alert is open, and the toast/confirm queue.
 *
 * ─── Destructive actions confirm; reversible ones do not ────────────────────
 *
 * Acknowledge and resolve apply immediately: both are reversible (reopen), both
 * are done dozens of times a shift, and a dialog on each would train people to
 * dismiss dialogs. Bulk actions confirm — they are the ones where a mis-click
 * costs forty rows — and so does Reopen, because reopening puts an alert back on
 * somebody's queue.
 */

export default function FiredAlertsPage({ activeOrg, onNavigate }) {
  const alerts = useAlerts();

  /**
   * May this user change a firing's state?
   *
   * <p>The list, the filters, the summary cards and the details drawer are all
   * READS and stay available to everyone who can reach this screen — the point of
   * the screen is answering "what is wrong right now". Acknowledge and resolve are
   * the only writes on it, and they are gated separately so a role can watch alerts
   * without being able to clear them.</p>
   */
  const { can } = usePermissions();
  const canAct = can(PERMISSIONS.MANAGE_ALERT_STATE);

  const [selected, setSelected] = useState([]);
  const [openAlert, setOpenAlert] = useState(null);
  const [pendingId, setPendingId] = useState(null);
  const [toast, setToast] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [askName, setAskName] = useState(null);
  const [busy, setBusy] = useState(false);

  /**
   * The outcome of the last action, as the shared bottom-right toast — the same
   * component Settings raises after Update User and the Rules tab raises after
   * Enable. One section should not report a write three different ways
   * depending on which tab you were on and whether it worked.
   *
   * `ok` is renamed to `success` at the boundary rather than through the
   * codebase: this screen's callers say `notify('ok', …)` in six places, and
   * Toast's tones are named for what they look like.
   *
   * `warn` is kept as its own tone rather than folded into either neighbour. It
   * means the write did what it could — a partial bulk result, "3 of 5
   * acknowledged, 2 skipped" — and neither "Success" in green nor "Error" in red
   * is a true summary of that.
   *
   * Errors stay on screen until dismissed; the other two clear themselves. That
   * behaviour lives in Toast, not here — see the note at the top of it.
   */
  const notify = useCallback((tone, message) => {
    setToast({ tone: tone === 'ok' ? 'success' : tone, message });
  }, []);

  // Selection is reconciled against what is on screen. Auto-refresh replaces the
  // rows, and acting on an id that has scrolled out of the current filter is how
  // somebody resolves an alert they cannot see.
  const visibleIds = useMemo(() => new Set(alerts.items.map((a) => a.id)), [alerts.items]);
  const liveSelection = useMemo(
    () => selected.filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );

  const toggleSelect = useCallback((id) => {
    setSelected((s) => (s.includes(id) ? s.filter((v) => v !== id) : [...s, id]));
  }, []);

  const toggleSelectAll = useCallback((ids, select) => {
    setSelected((s) => (select
      ? Array.from(new Set([...s, ...ids]))
      : s.filter((id) => !ids.includes(id))));
  }, []);

  /**
   * Applies one transition, by id when there is one and by fingerprint when there
   * is not.
   *
   * <p>A row read live from the stream has no id, because the stream holds firings
   * and ids belong to stored episodes. That used to mean no Acknowledge and no
   * Resolve on any live row — and the live view is exactly what an operator is
   * looking at when the ingest is wedged, i.e. precisely when they most need to take
   * ownership of something.</p>
   *
   * <p>The fingerprint routes close that gap. They are not the ambiguous call the
   * id-only comment in the API layer warns about: {@code findOpenEpisode} resolves a
   * fingerprint to the ONE open episode it has, which for a row that is firing right
   * now is the episode being looked at. Bulk selection stays id-only — that path
   * addresses many rows at once and has no equivalent guarantee.</p>
   */
  const applyTransition = useCallback(async (alert, action, actor) => {
    if (alert.id !== null && alert.id !== undefined) {
      // Reloads on its own — see useAlerts.transition.
      return alerts.transition(alert.id, action, { actor });
    }
    let result;
    if (action === 'acknowledge') {
      result = await acknowledgeAlertNotification(alert.fingerprint, { actor });
    } else if (action === 'resolve') {
      result = await resolveAlertNotification(alert.fingerprint, { actor });
    } else {
      // Close and Reopen have no fingerprint route; they are details-panel actions
      // on a stored alert, which always has an id.
      throw new Error(
        `${action} needs an ingested alert — this row was read live from the stream.`);
    }
    // The id path reloads inside useAlerts; this one has to ask, for the same reason
    // — the transition can move the row out of the current filter.
    alerts.reload();
    return result;
  }, [alerts]);

  const runAction = useCallback(async (alert, action, actor) => {
    setPendingId(alert.id ?? alert.fingerprint);
    try {
      const result = await applyTransition(alert, action, actor || currentActor());
      notify('ok', result?.message || `${alert.alertName} ${action}d.`);
      // Keep the panel open but refresh what it shows — the operator usually acts
      // and then keeps reading.
      setOpenAlert((open) => (open?.id === alert.id
        ? { ...open, status: result?.status || open.status }
        : open));
    } catch (err) {
      notify('error', err.message || `Could not ${action} this alert.`);
    } finally {
      setPendingId(null);
    }
  }, [applyTransition, notify]);

  const handleAction = useCallback((alert, action) => {
    // Acknowledging asks WHO. It is the one transition whose whole purpose is to
    // record ownership, and it was recording "unknown" — the fallback below fires
    // whenever no session is stored, which is most of the time in an embedded
    // deployment. The backend now rejects that string outright, so the name is
    // asked for rather than invented.
    if (action === 'acknowledge') {
      setAskName({
        alert,
        onSubmit: (name) => { rememberActor(name); runAction(alert, action, name); },
      });
      return;
    }
    if (action === 'reopen') {
      setConfirm({
        title: `Reopen ${alert.alertName}?`,
        body: 'It goes back to Open and the previous acknowledgement is cleared, so it will '
          + 'demand attention again rather than looking already handled.',
        confirmLabel: 'Reopen',
        onConfirm: () => runAction(alert, action),
      });
      return;
    }
    runAction(alert, action);
  }, [runAction]);

  const runBulk = useCallback(async (action, actor) => {
    setBusy(true);
    try {
      const result = await alerts.bulk(liveSelection, action, { actor: actor || currentActor() });
      // Partial success is the normal case and is reported as such: some of the
      // selected alerts will often be in a state the action cannot apply to.
      notify(result?.skipped > 0 ? 'warn' : 'ok',
        result?.message || `${action} applied.`);
      setSelected([]);
    } catch (err) {
      notify('error', err.message || `Could not ${action} the selected alerts.`);
    } finally {
      setBusy(false);
    }
  }, [alerts, liveSelection, notify]);

  const handleBulk = useCallback((action) => {
    // Same rule in bulk: acknowledging forty alerts still has to say who took them.
    if (action === 'acknowledge') {
      setAskName({
        count: liveSelection.length,
        onSubmit: (name) => { rememberActor(name); runBulk(action, name); },
      });
      return;
    }
    setConfirm({
      title: `${action[0].toUpperCase()}${action.slice(1)} ${liveSelection.length} alert(s)?`,
      body: 'Alerts already in a state this action cannot apply to are skipped, not failed — '
        + 'the result will say how many of each.',
      confirmLabel: action[0].toUpperCase() + action.slice(1),
      onConfirm: () => runBulk(action),
    });
  }, [liveSelection.length, runBulk]);

  const copyId = useCallback(async (alert) => {
    try {
      await navigator.clipboard.writeText(String(alert.id));
      notify('ok', `Alert id ${alert.id} copied.`);
    } catch {
      // Clipboard is permission-gated and fails in some embeds; showing the id is
      // strictly better than a silent no-op.
      notify('warn', `Could not access the clipboard. Alert id is ${alert.id}.`);
    }
  }, [notify]);

  /** Telemetry drill-through from the details panel.
   *
   *  `drill` is the scoping the panel built for that signal — the services, the
   *  trace id, the metric candidates and the window around this firing. Passed
   *  straight through: this page routes the jump, it does not decide what the
   *  target screen should show. See components/alerts/alertDrill.js. */
  const navigateToTelemetry = useCallback((tab, alert, drill) => {
    if (!onNavigate) return;
    onNavigate(tab, alert, drill);
    setOpenAlert(null);
  }, [onNavigate]);

  const ingestUnhealthy = alerts.ingest?.healthy === false;

  /* Which rows the table is actually showing.
   *
   * The stored path stays in charge while it can answer. The stream is used only
   * when the ingest is down or wedged AND it returned something — falling back to an
   * empty live read would replace one empty table with another while claiming a
   * different source for it.
   *
   * ─── And only when the stored path has nothing ────────────────────────────
   *
   * `degraded` alone is not enough to hand the table over. A stream that simply goes
   * quiet for longer than alerts.ingest.max-window-minutes leaves the watermark older
   * than the stall boundary, so `stalled` goes true while the poller is fine and the
   * stored rows are current. Swapping in live rows there is a strict downgrade:
   * stream rows carry no id, so every Actions cell loses its menu and reads as the
   * bare status, and the bulk bar empties — an operator watching 35 live FIRING
   * alerts could not acknowledge any of them, because the rows that COULD be
   * acknowledged had just been thrown away.
   *
   * So the fallback now answers only the question it was built for: "ingest is
   * broken AND that has left me with nothing to show". */
  const liveRows = alerts.degraded && alerts.live && !alerts.live.unavailable
    && alerts.items.length === 0
    ? alerts.live : null;
  const showingLive = (liveRows?.items.length > 0);
  const rows = showingLive ? liveRows.items : alerts.items;
  const rowTotal = showingLive ? liveRows.total : alerts.total;

  return (
    <div className="alerts-page2" key={activeOrg || 'default'}>
      {/* The card's header: title on the left, the filter bar filling the rest of
          the same band.

          Reuses `.alerts-head` / `.alerts-title` — the same pair the Rules tab
          uses — so both tabs get one header with one inset rule under it rather
          than two nearly-identical ones. `--fired` is the variant that lets this
          one hold a two-row control block beside the title.

          "Fired Alerts" rather than "Alerts": the shell's title bar above already
          says that, and this tab is specifically the ones that have fired. */}
      <header className="alerts-head alerts-head--fired">
        <h2 className="alerts-title">Fired Alerts</h2>

        {/* The filter bar shares the title's row rather than owning one below it.
            It was three stacked bands — title, cards, filters — above a table that
            is the whole point of the screen; the title's band was carrying one
            word and ~56px. Nothing about AlertFilters changed: it is the same
            element with the same props, re-parented, and it keeps its own two-row
            layout (controls, then the count and Rows) inside the header. */}
        <AlertFilters
          filters={alerts.filters}
          setFilter={alerts.setFilter}
          clearFilters={alerts.clearFilters}
          activeFilterCount={alerts.activeFilterCount}
          refreshMs={alerts.refreshMs}
          setRefreshMs={alerts.setRefreshMs}
          paused={alerts.paused}
          setPaused={alerts.setPaused}
          onRefresh={alerts.refreshNow}
          refreshing={alerts.refreshing}
        />
      </header>

      {/* An unhealthy poller is stated explicitly. This is the whole reason the
          ingest exposes a watermark: without it, "no alerts" and "the pipeline is
          broken" look identical, and that is the most dangerous ambiguity an
          alerting screen can have. */}
      {ingestUnhealthy && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">
            Alert ingest is not healthy — new alerts may not be arriving.
            {alerts.ingest.cursors?.[0]?.lastError
              ? ` Last error: ${alerts.ingest.cursors[0].lastError}`
              : ' No successful poll recently.'}
          </span>
        </div>
      )}

      {/* The stalled-poller and reading-from-the-stream banners used to sit here.
          Removed on request: they were correct but they occupied two full-width bars
          above every other thing on the screen, on a screen whose job is the table.

          Neither state is now silent. The stall still surfaces as `stalled` on
          /ingest-status, and the source of the rows is still stated in the footer
          ("N alerts · live from stream") and per row: a live row's Actions cell reads
          the state alone rather than offering a menu, and its checkbox tooltip says
          why. See AlertsTable.selectTitle. */}

      {/* The fallback was tried and could not answer either. Worth its own line: it
          means OpenObserve itself is unreachable, not merely the poller. */}
      {alerts.degraded && alerts.live?.unavailable && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">
            The alert_events stream could not be read either — OpenObserve is
            unreachable, so this screen cannot show current alerts at all.
            {alerts.live.error ? ` ${alerts.live.error}` : ''}
          </span>
        </div>
      )}

      {alerts.error && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">{alerts.error}</span>
          <button
            type="button" className="alerts-banner-x"
            onClick={alerts.reload} aria-label="Retry"
          >↻</button>
        </div>
      )}

      <AlertSummaryCards
        summary={alerts.summary}
        loading={alerts.loading}
        filters={alerts.filters}
        onApply={(patch) => {
          Object.entries(patch).forEach(([k, v]) => alerts.setFilter(k, v));
        }}
      />

      {/* Selection is disabled without the grant, so this bar can never appear —
          the check is here anyway because "no write controls" should not depend on
          another component's disabled state remaining correct. */}
      {canAct && liveSelection.length > 0 && (
        <section className="alerts-bulkbar2" aria-label="Bulk actions">
          <span className="alerts-bulkbar2-count">
            {liveSelection.length} selected
          </span>
          <button type="button" className="alerts-btn-ghost" disabled={busy}
            onClick={() => handleBulk('acknowledge')}>Acknowledge</button>
          <button type="button" className="alerts-btn-ghost" disabled={busy}
            onClick={() => handleBulk('resolve')}>Resolve</button>
          <button type="button" className="alerts-btn-ghost" disabled={busy}
            onClick={() => handleBulk('close')}>Close</button>
          <button type="button" className="alerts-btn-ghost" disabled={busy}
            onClick={() => handleBulk('reopen')}>Reopen</button>
          <span className="alerts-toolbar2-spacer" />
          <button type="button" className="alerts-btn-ghost" onClick={() => setSelected([])}>
            Clear selection
          </button>
        </section>
      )}

      <AlertsTable
        items={rows}
        loading={alerts.loading}
        refreshing={alerts.refreshing}
        sortBy={alerts.sortBy}
        sortDir={alerts.sortDir}
        onSort={alerts.toggleSort}
        selected={liveSelection}
        onToggleSelect={toggleSelect}
        onToggleSelectAll={toggleSelectAll}
        onOpen={setOpenAlert}
        onAction={handleAction}
        canAct={canAct}
        pendingId={pendingId}
        hasFilters={alerts.activeFilterCount > 0}
      />

      {/* The Rules footer, verbatim in shape: total on the left, then the showing
          range, Records per page, and the two pagers.

          "Showing a - b of c" replaces the "Page 1 of 10" that was here. Same
          information, and it is the one the other tab already prints — a section
          should not count its own rows two different ways.

          `to` is derived from `rows.length`, not from `(page + 1) * size`: the last
          page is short, and the arithmetic would claim rows the table is not
          showing. */}
      <footer className="iam-foot">
        <span className="iam-foot-total">
          {rowTotal.toLocaleString()} alert{rowTotal === 1 ? '' : 's'}
          {showingLive && ' · live from stream'}
          {alerts.lastFetched && (
            <span className="pc-dim"> · updated {alerts.lastFetched.toLocaleTimeString()}</span>
          )}
        </span>
        <span className="iam-foot-right">
          <span className="iam-foot-range">
            Showing <strong>{rows.length === 0 ? 0 : alerts.page * alerts.size + 1}</strong>
            {' - '}
            <strong>{Math.min(rowTotal, alerts.page * alerts.size + rows.length)}</strong>
            {' of '}
            <strong>{rowTotal.toLocaleString()}</strong>
          </span>
          {/* Moved down from the toolbar, beside the pagers it governs and under
              the same label the Rules tab uses. `PAGE_SIZES` and `alerts.size`
              are unchanged — this is the same control in a new place. */}
          <label className="iam-foot-size">
            Records per page{' '}
            <select
              value={alerts.size}
              aria-label="Records per page"
              onChange={(e) => {
                alerts.setSize(Number(e.target.value));
                alerts.setPage(0);
              }}
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button
            type="button" className="iam-pager"
            onClick={() => alerts.setPage((p) => Math.max(0, p - 1))}
            disabled={alerts.page === 0} aria-label="Previous page"
          >‹</button>
          <button
            type="button" className="iam-pager"
            onClick={() => alerts.setPage((p) => p + 1)}
            disabled={!(showingLive ? liveRows.hasMore : alerts.hasMore)} aria-label="Next page"
          >›</button>
        </span>
      </footer>

      {openAlert && (
        <AlertDetailsDrawer
          alert={openAlert}
          onClose={() => setOpenAlert(null)}
          onAction={handleAction}
          canAct={canAct}
          onCopyId={copyId}
          onNavigate={onNavigate ? navigateToTelemetry : undefined}
        />
      )}

      {askName && (
        <AcknowledgeDialog
          alert={askName.alert}
          count={askName.count}
          busy={busy}
          defaultName={rememberedActor()}
          onCancel={() => setAskName(null)}
          onSubmit={(name) => { const fn = askName.onSubmit; setAskName(null); fn(name); }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          {...confirm}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const fn = confirm.onConfirm; setConfirm(null); fn(); }}
        />
      )}

      {/* All three outcomes, one toast, same corner as Settings and the Rules
          tab. The `.alerts-toast2` card this replaces was bottom-right too, but
          it was a dark panel with a coloured left edge rather than the solid
          fill the rest of the app confirms with — which is the whole reason the
          two tabs looked like two different products. */}
      <Toast
        tone={toast?.tone}
        message={toast?.message || ''}
        onDismiss={() => setToast(null)}
      />
    </div>
  );
}

/**
 * Asks who is taking the alert on.
 *
 * ─── Why this dialog exists at all ─────────────────────────────────────────
 *
 * The Acked-by column read "unknown". Not a display bug: `currentActor()` below
 * falls back to that literal string whenever no session is stored, which in an
 * embedded deployment is the normal case — so the one field people consult to find
 * out who owns an incident recorded nothing useful, and did it silently.
 *
 * ─── The name is remembered, and still shown ───────────────────────────────
 *
 * Pre-filled from the last acknowledgement so a shift is not spent retyping, but
 * always visible and editable, because a shared console is exactly where the last
 * person's name must not be attributed to this one by default. The field is
 * selected on open, so overwriting it is one keystroke.
 *
 * ─── Blank cannot be submitted ─────────────────────────────────────────────
 *
 * Enforced here AND by the backend, deliberately. A UI-only check leaves the next
 * caller free to write "unknown" again, which is how this happened the first time.
 */
function AcknowledgeDialog({ alert, count, busy, defaultName, onCancel, onSubmit }) {
  const [name, setName] = useState(defaultName || '');
  const inputRef = useRef(null);
  const handleBackdrop = useCallback(() => { if (!busy) onCancel(); }, [busy, onCancel]);
  const backdropRef = useBackdropClose(handleBackdrop);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  useEffect(() => {
    // Select rather than just focus: the remembered name is usually right, and when
    // it is not, the first keystroke should replace it rather than append to it.
    if (inputRef.current) inputRef.current.select();
  }, []);

  const trimmed = name.trim();
  const valid = trimmed.length > 0;
  const countSuffix = count === 1 ? '' : 's';
  const target = count
    ? `${count} alert${countSuffix}`
    : `“${alert?.alertName ?? 'this alert'}”`;

  const submit = (e) => {
    e.preventDefault();
    if (valid && !busy) onSubmit(trimmed);
  };

  return (
    <dialog
      open
      ref={backdropRef}
      className="alerts-modal-backdrop native-el"
      aria-modal="true"
      aria-label="Acknowledge alert"
    >
      <form className="alerts-modal" onSubmit={submit}>
        <div className="alerts-modal-head">
          <h2 className="alerts-modal-title">Acknowledge {target}</h2>
          <button type="button" className="alerts-modal-x" onClick={onCancel}
            disabled={busy} aria-label="Close">×</button>
        </div>
        <div className="alerts-modal-body">
          <p className="pc-confirm-text">
            Acknowledging records that you own this and stops it demanding attention on the
            next evaluation. It keeps counting firings, and it can still be resolved or
            reopened afterwards.
          </p>
          <label className="alerts-ack-field">
            <span className="alerts-ack-label">Your name</span>
            <input
              ref={inputRef}
              type="text"
              className="ae-input"
              value={name}
              maxLength={128}
              placeholder="Enter your name"
              aria-label="Your name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="pc-dim alerts-ack-hint">
            Stored against the alert as its acknowledger, and shown in the table and the
            audit trail.
          </p>
        </div>
        <div className="alerts-modal-foot">
          <button type="button" className="alerts-btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="alerts-btn-primary" disabled={!valid || busy}>
            {busy ? 'Working…' : 'Acknowledge'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

AcknowledgeDialog.propTypes = {
  /** Single-alert acknowledge. Omitted for a bulk one, which passes `count`. */
  alert: PropTypes.object,
  count: PropTypes.number,
  busy: PropTypes.bool,
  defaultName: PropTypes.string,
  onCancel: PropTypes.func.isRequired,
  onSubmit: PropTypes.func.isRequired,
};

/** Local confirmation dialog — states the consequence rather than asking "sure?". */
function ConfirmDialog({ title, body, confirmLabel, busy, onCancel, onConfirm }) {
  const handleBackdrop = useCallback(() => { if (!busy) onCancel(); }, [busy, onCancel]);
  const backdropRef = useBackdropClose(handleBackdrop);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  return (
    <dialog
      open
      ref={backdropRef}
      className="alerts-modal-backdrop native-el"
      aria-modal="true"
      aria-label={title}
    >
      <div className="alerts-modal">
        <div className="alerts-modal-head">
          <h2 className="alerts-modal-title">{title}</h2>
          <button type="button" className="alerts-modal-x" onClick={onCancel}
            disabled={busy} aria-label="Close">×</button>
        </div>
        <div className="alerts-modal-body">
          <p className="pc-confirm-text">{body}</p>
        </div>
        <div className="alerts-modal-foot">
          <button type="button" className="alerts-btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="alerts-btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

ConfirmDialog.propTypes = {
  title: PropTypes.string.isRequired,
  body: PropTypes.string.isRequired,
  confirmLabel: PropTypes.string.isRequired,
  busy: PropTypes.bool,
  onCancel: PropTypes.func.isRequired,
  onConfirm: PropTypes.func.isRequired,
};

/**
 * Who to attribute an action to.
 *
 * <p>Read from the app's stored session rather than asked for. The backend records
 * whatever it is told, so an empty actor produces an audit trail of "unknown" —
 * which is worse than useless on the one record people go to when apportioning
 * responsibility.</p>
 */
function currentActor() {
  try {
    const raw = localStorage.getItem('lnm_user');
    if (raw) {
      const parsed = JSON.parse(raw);
      const fromSession = parsed?.username || parsed?.email;
      if (fromSession) return fromSession;
    }
  } catch {
    // Private mode, or a shape this code does not know. Fall through.
  }
  // The name last typed into the acknowledge dialog, so resolve and close are
  // attributed to the person actually working rather than to "unknown".
  return rememberedActor() || 'unknown';
}

/** Where the acknowledge dialog's name is kept between actions. */
const ACTOR_KEY = 'lnm_alert_actor';

function rememberedActor() {
  try {
    return localStorage.getItem(ACTOR_KEY) || '';
  } catch {
    return '';
  }
}

function rememberActor(name) {
  try {
    const trimmed = (name || '').trim();
    if (trimmed) localStorage.setItem(ACTOR_KEY, trimmed);
  } catch {
    // Storage unavailable. The name still applies to this action; it just will not
    // pre-fill next time, which is a smaller loss than failing the acknowledge.
  }
}

FiredAlertsPage.propTypes = {
  /** Remounts the screen on tenant change — alerts are per-organization. */
  activeOrg: PropTypes.string,
  /** (tab, alert) — jump to Logs/Traces/Metrics for this alert. */
  /** (tab, alert, drill) — see navigateToTelemetry. */
  onNavigate: PropTypes.func,
};
