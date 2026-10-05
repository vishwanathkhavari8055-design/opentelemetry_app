import React from 'react';
import PropTypes from 'prop-types';
import { EMPTY_FILTERS } from './useAlerts';

/**
 * The summary cards.
 *
 * ─── Each card is a filter, not just a number ──────────────────────────────
 *
 * Clicking one applies its filter to the table beneath. A card that shows "13
 * critical" and does nothing when clicked is a dead end — the number is only
 * useful as a way into the rows behind it.
 *
 * ─── Severity cards count every status ─────────────────────────────────────
 *
 * "Critical" answers "how many critical alerts in this window", including ones
 * already resolved. That is what makes it agree with the table when the table is
 * filtered to the same window, and the backend counts it the same way. The three
 * lifecycle cards on the left are the ones that partition the set.
 *
 * ─── Skeletons, not zeros, while loading ───────────────────────────────────
 *
 * Showing "0 critical" before the data arrives is a lie that happens to look
 * calm, which is the worst possible failure mode for an alert summary.
 */

/** Card definitions. `filter` is what clicking applies. */
const CARDS = [
  {
    key: 'open',
    label: 'Open',
    tone: 'open',
    hint: 'Firing and nobody has picked it up',
    filter: { status: ['FIRING'] },
  },
  {
    key: 'acknowledged',
    label: 'Acknowledged',
    tone: 'ack',
    hint: 'Somebody is working on it',
    filter: { status: ['ACKNOWLEDGED'] },
  },
  {
    // `['critical']`, NOT `['critical','disaster']`. The count is
    // `summary.critical`, which excludes disaster — so filtering on both made the
    // table show more rows than the number the operator had just clicked. The
    // severity dropdown made that mismatch visible; it was wrong beforehand too.
    key: 'critical',
    label: 'Critical',
    tone: 'critical',
    hint: 'Critical severity in this window, any status',
    filter: { severity: ['critical'] },
  },
  {
    key: 'warning',
    label: 'Warning',
    tone: 'warning',
    hint: 'Warning severity in this window, any status',
    filter: { severity: ['warning'] },
  },
  {
    key: 'error',
    label: 'Error',
    tone: 'error',
    hint: 'Error severity in this window, any status',
    filter: { severity: ['error'] },
  },
  {
    // `['RESOLVED']` only, for the same reason as Critical: the count is
    // `summary.resolved`, which does not include closed alerts.
    key: 'resolved',
    label: 'Resolved',
    tone: 'resolved',
    hint: 'The condition cleared, or the sweep inferred it did',
    filter: { status: ['RESOLVED'] },
  },
];

export default function AlertSummaryCards({ summary, loading, filters, onApply }) {
  return (
    <fieldset className="alerts-cards native-el" aria-label="Alert summary">
      {CARDS.map((card) => {
        const value = summary ? summary[card.key] : null;

        // "Active" means the table is currently filtered to exactly this card, so
        // the highlight tells the truth rather than merely reacting to the click.
        const active = isActive(card, filters);

        return (
          <button
            key={card.key}
            type="button"
            className={`alerts-card alerts-card--${card.tone} ${active ? 'is-active' : ''}`}
            onClick={() => onApply(active ? clearOf(card) : card.filter)}
            title={active ? `${card.hint} — click to clear this filter` : card.hint}
            aria-pressed={active}
          >
            <span className="alerts-card-label">{card.label}</span>
            {loading && summary == null ? (
              <span className="alerts-card-skeleton" aria-hidden="true" />
            ) : (
              <span className="alerts-card-value">{formatCount(value)}</span>
            )}
          </button>
        );
      })}
    </fieldset>
  );
}

/** Whether the table's current filters are exactly this card's. */
function isActive(card, filters) {
  const wanted = card.filter;
  if (wanted.status) {
    return sameSet(filters.status, wanted.status) && !filters.severity.length;
  }
  if (wanted.severity) {
    return sameSet(filters.severity, wanted.severity) && sameSet(filters.status, EMPTY_FILTERS.status);
  }
  return false;
}

/** The patch that clears a card's own filter, leaving the others alone. */
function clearOf(card) {
  return card.filter.status ? { status: EMPTY_FILTERS.status } : { severity: [] };
}

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

/** 1.2K rather than 1200 — the cards are glanced at, not read. */
function formatCount(value) {
  if (value == null) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

AlertSummaryCards.propTypes = {
  /** From GET /api/alerts/query/summary. Null until the first load returns. */
  summary: PropTypes.object,
  loading: PropTypes.bool,
  /** The table's current filters, so a card can show itself as applied. */
  filters: PropTypes.shape({
    severity: PropTypes.array,
    status: PropTypes.array,
  }).isRequired,
  /** (patch) — merge these filter keys into the table's filters. */
  onApply: PropTypes.func.isRequired,
};
