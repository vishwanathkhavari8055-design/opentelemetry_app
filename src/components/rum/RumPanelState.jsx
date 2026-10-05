import React from 'react';
import PropTypes from 'prop-types';

/**
 * The loading / error / unsupported / empty states every RUM panel shares.
 *
 * ─── The four states are NOT interchangeable ────────────────────────────────
 *
 * They are separated because each demands a different response, and collapsing them
 * into one "no data" message is how a broken integration gets mistaken for a quiet
 * one:
 *
 *   unsupported — OpenObserve is off for this deployment. Nothing to widen, nothing
 *                 to retry; the fix is configuration.
 *   error       — the query failed. Retrying may work.
 *   empty       — the query succeeded and matched nothing. The window or the filters
 *                 are wrong, not the system.
 *   partial     — NOT one of these, and deliberately rendered ALONGSIDE the data by
 *                 {@link RumPartialNotice}. This deployment answers a window it
 *                 cannot scan with HTTP 200 and an empty result set, so a count from
 *                 a partial scan is a floor. Hiding that would present "0 errors" as
 *                 a clean bill of health when the truth is "we could not look".
 *
 * ─── Why the decision is a STRING and not an element ────────────────────────
 *
 * {@link panelStateKind} exists so a caller can ask "is there a state to show?"
 * without building anything. The first version of this module only exported the
 * component, and every panel guarded on it like this:
 *
 *     const state = <RumPanelState ... />;
 *     if (state) return <div className="rum-panel">{state}</div>;
 *
 * That is always true. `state` is a React ELEMENT — a plain object describing what
 * to render — and it is truthy whether the component goes on to return a banner or
 * `null`. So every panel took the guarded branch forever and rendered an empty div:
 * the error states appeared correctly, and the real content was unreachable. The
 * bug was invisible in review because the line reads exactly like a null check.
 *
 * Returning a discriminant string removes the trap rather than documenting it. There
 * is no truthy-empty value to get wrong, and the component and the predicate share
 * one decision so they cannot disagree about which state is active.
 */

/**
 * Which state a panel should show, or null to render its real content.
 *
 * @returns 'unsupported' | 'loading' | 'error' | 'empty' | null
 */
export function panelStateKind({ loading, error, meta, empty }) {
  if (meta?.supported === false) return 'unsupported';
  if (loading) return 'loading';
  if (error) return 'error';
  if (empty) return 'empty';
  return null;
}

export default function RumPanelState({
  loading, error, meta, empty, emptyTitle, emptyBody,
}) {
  const kind = panelStateKind({ loading, error, meta, empty });

  if (kind === 'unsupported') {
    return (
      <div className="rum-empty">
        <h3 className="rum-empty-title">Real User Monitoring is not available</h3>
        <p>{meta.message || 'This deployment has the OpenObserve reader disabled.'}</p>
      </div>
    );
  }

  if (kind === 'loading') {
    return (
      <output className="rum-loading" aria-live="polite">
        <span className="rum-spinner" aria-hidden="true" />
        <span>Reading RUM events…</span>
      </output>
    );
  }

  if (kind === 'error') {
    return (
      <div className="rum-banner rum-banner--error" role="alert">
        <strong>Could not read RUM data.</strong> {error}
      </div>
    );
  }

  if (kind === 'empty') {
    return (
      <div className="rum-empty">
        <h3 className="rum-empty-title">{emptyTitle}</h3>
        <p>{emptyBody}</p>
      </div>
    );
  }

  return null;
}

RumPanelState.propTypes = {
  loading: PropTypes.bool,
  error: PropTypes.string,
  /** The response `meta`; only `supported`/`message` are read here. */
  meta: PropTypes.object,
  empty: PropTypes.bool,
  emptyTitle: PropTypes.string,
  emptyBody: PropTypes.node,
};

/**
 * The partial-scan warning, rendered above a panel's real content.
 *
 * <p>Separate from the states above because it does not replace the data — it
 * qualifies it. Every number on the panel is a lower bound when this shows.</p>
 */
export function RumPartialNotice({ meta }) {
  if (!meta?.partial) return null;
  return (
    <output className="rum-banner rum-banner--warn">
      <strong>Partial scan.</strong> OpenObserve could not read the whole window, so
      every figure below is a lower bound rather than a total. Narrow the period to get
      a complete answer.
    </output>
  );
}
RumPartialNotice.propTypes = { meta: PropTypes.object };
