import React from 'react';
import PropTypes from 'prop-types';
import CheckboxSelect from './CheckboxSelect';
import { REFRESH_OPTIONS } from './useAlerts';

/**
 * The alerts toolbar: search, time, severity.
 *
 * ─── One row, laid out like the Rules header ───────────────────────────────
 *
 * Everything sits in `.alerts-head-right` — the Rules header's own right-hand
 * cluster — which leaves the card title alone on the left, exactly as that tab
 * does. Order within it: Clear (only when there is something to clear), then the
 * three filters as one adjacent group — time, severity, free text — then
 * auto-refresh, pause and refresh.
 *
 * The filters are adjacent on purpose. They are one question asked three ways
 * ("which alerts do I want to see"), and having the dropdowns at the far left of
 * the band with the search box at the far right made them read as unrelated
 * controls that happened to share a row. Search keeps the plain `.iam-search`
 * width so it is the same box as the Rules search rather than a wider one that
 * shifts when you switch tabs.
 *
 * The second row this used to have — the result count, the freshness stamp and
 * Rows-per-page — is gone. The count and the stamp were saying in the header
 * what the footer already says, and Rows-per-page belongs beside the pagers it
 * governs. All three now live in the footer in FiredAlertsPage, which is also
 * where the Rules tab keeps them.
 *
 * ─── Three controls, down from seven ───────────────────────────────────────
 *
 * Status, Service, Rule, Stream and Source were dropdowns too. The reasoning for
 * dropping each is at the point where they used to be rendered; the short version
 * is that three of them could not partition this table at all, Service is covered
 * by the search box, and Status belongs on the summary cards where the count is
 * visible before you commit to the filter.
 *
 * Severity stays a CHECKBOX dropdown rather than a plain select, because "show me
 * critical AND warning" is a real question — where "show me service A AND service
 * B" never was.
 *
 * The wire format never changed through any of this: severity and status are held
 * as arrays and sent as repeatable parameters, which is what the backend has always
 * bound into a `List<String>`. Removing a control did not remove its filter.
 *
 * ─── Every control is sent to the server ───────────────────────────────────
 *
 * There is no client-side filtering here at all. The table is paged server-side,
 * so a filter applied locally would narrow one page and report a total for the
 * whole set — numbers that contradict the rows above them.
 */

/**
 * The time windows this screen offers, shortest first.
 *
 * <p>Every value is sent to the server verbatim and both the row query and the
 * summary cards resolve it with the same grammar, so the cards above the table
 * always count the window the table is showing.</p>
 *
 * <p>"All time" is kept at the top deliberately. The default window is a day, and
 * without an unbounded option the thousands of already-resolved episodes older than
 * the longest window would be unreachable from this screen at all. It is also the one
 * option that clears the status filter — see the select's onChange for why.</p>
 */
const WINDOWS = [
  { value: '', label: 'All time' },
  { value: 'now-15m', label: 'Last 15 minutes' },
  { value: 'now-30m', label: 'Last 30 minutes' },
  { value: 'now-2h', label: 'Last 2 hours' },
  { value: 'now-1d', label: 'Last 1 day' },
  { value: 'now-7d', label: 'Last 7 days' },
];

/**
 * Ordered worst-first, matching the backend's severity rank.
 *
 * The order is the meaning, so CheckboxSelect renders it verbatim and does not
 * sort — alphabetical would give critical, disaster, error, info, warning, which
 * tells the reader nothing.
 *
 * `tone` colours each option's dot to match the severity pill in the table, so
 * the filter and the rows do not have to be cross-referenced.
 */
const SEVERITY_OPTIONS = [
  { value: 'disaster', label: 'Disaster', tone: 'disaster' },
  { value: 'critical', label: 'Critical', tone: 'critical' },
  { value: 'error', label: 'Error', tone: 'error' },
  { value: 'warning', label: 'Warning', tone: 'warning' },
  { value: 'info', label: 'Info', tone: 'info' },
];

export default function AlertFilters({
  filters, setFilter, clearFilters, activeFilterCount,
  refreshMs, setRefreshMs, paused, setPaused,
  onRefresh, refreshing,
}) {
  return (
    <div className="alerts-toolbar2">
      <div className="alerts-toolbar2-row">
        {/* `.alerts-head-right` rather than a spacer: it is the Rules header's
            right-hand cluster, `margin-left: auto` and all, so the controls land in
            the same slot on both tabs.

            EVERY control lives in here — the two filter dropdowns included, so time,
            severity and free text sit as one adjacent group beside the search box
            rather than with the dropdowns marooned on the far left of the band. It
            leaves the title alone on the left, which is what the Rules header does
            too. */}
        <div className="alerts-head-right">
          {/* First, so it never wedges itself between the dropdowns and the search
              box they belong with. Absent when there is nothing to clear — a
              permanently-visible "Clear 0 filters" is a control that spends its life
              lying. */}
          {activeFilterCount > 0 && (
            <button type="button" className="alerts-btn-ghost alerts-clear2" onClick={clearFilters}>
              Clear {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'}
            </button>
          )}

          {/* Status, Service, Rule, Stream and Source dropdowns used to sit here too.

              Three of the five could not narrow anything on this deployment: every
              alert arrives from the same stream via the same ingest path, and none
              is attached to a rule authored through this service, so "All rules"
              opened onto an empty list. A filter that cannot partition its table
              still costs a control to read and a wrong guess to recover from.

              Service had real values, but the search box beside this already matches
              on service name — as well as host, stream and trace id — so scoping to
              one service is typing its name rather than hunting through a dropdown.

              STATUS is the one that did not simply go away: it moved to the summary
              cards below, which were already status filters and are the more direct
              control, since they show the count before you commit to the filter.
              `filters.status` is untouched underneath, so the cards, the Clear button
              and the URL contract all keep working exactly as they did.

              What remains is the three controls that genuinely partition this table,
              and they are now adjacent: time, severity, free text. */}
          <select
            className="ae-select alerts-filter2"
            value={filters.window}
            aria-label="Time range"
            onChange={(e) => {
              const next = e.target.value;
              setFilter('window', next);
              /* "All time" means ALL alerts, not "every open alert ever".
               *
               * The status filter is pinned to FIRING + ACKNOWLEDGED underneath and
               * has no control of its own — it moved to the summary cards. So
               * unbounding the TIME alone still hid every resolved episode, and the
               * option read as a lie: it answered 34 where the table holds 3,581.
               * Clearing status here is what makes the label true.
               *
               * Only this option touches status. Every bounded window leaves the
               * filter exactly as the cards left it, so card → time → card still
               * composes. */
              if (next === '') setFilter('status', []);
            }}
          >
            {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>

          <CheckboxSelect
            options={SEVERITY_OPTIONS}
            value={filters.severity}
            onChange={(next) => setFilter('severity', next)}
            allLabel="All severities"
            noun="severities"
            ariaLabel="Filter by severity"
          />

          {/* Plain `.iam-search`, the width the Rules search is, which is the
              alignment being asked for. The placeholder is short enough to read at
              that width; what it actually matches on moved to the tooltip rather
              than being ellipsised into nonsense. */}
          <div className="iam-search alerts-search2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
            <input
              type="text"
              value={filters.search}
              placeholder="Search Alerts"
              aria-label="Search alerts by name, service, host, stream or trace id"
              title="Matches alert name, service, host, stream or trace id"
              onChange={(e) => setFilter('search', e.target.value)}
            />
            {filters.search && (
              <button
                type="button" className="alerts-search2-x" aria-label="Clear search"
                onClick={() => setFilter('search', '')}
              >×</button>
            )}
          </div>

          {/* Auto-refresh, and a pause. A table that reshuffles while somebody is
              clicking a row is the fastest way to make them act on the wrong one. */}
          <label className="alerts-refresh2">
            <span className="alerts-refresh2-label">Auto</span>
            <select
              className="ae-select alerts-filter2 alerts-filter2--narrow"
              value={refreshMs}
              aria-label="Auto-refresh interval"
              onChange={(e) => setRefreshMs(Number(e.target.value))}
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className={`results-bar-btn ${paused ? 'is-on' : ''}`}
            onClick={() => setPaused(!paused)}
            title={paused ? 'Resume auto-refresh' : 'Pause auto-refresh while you read'}
            aria-pressed={paused}
          >
            {paused ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5l11 7-11 7z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="results-bar-btn"
            onClick={onRefresh}
            disabled={refreshing}
            title="Poll OpenObserve now, then reload"
            aria-label="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className={refreshing ? 'alerts-spin' : undefined}>
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

AlertFilters.propTypes = {
  filters: PropTypes.object.isRequired,
  setFilter: PropTypes.func.isRequired,
  clearFilters: PropTypes.func.isRequired,
  activeFilterCount: PropTypes.number.isRequired,
  refreshMs: PropTypes.number.isRequired,
  setRefreshMs: PropTypes.func.isRequired,
  paused: PropTypes.bool.isRequired,
  setPaused: PropTypes.func.isRequired,
  onRefresh: PropTypes.func.isRequired,
  refreshing: PropTypes.bool,
};
