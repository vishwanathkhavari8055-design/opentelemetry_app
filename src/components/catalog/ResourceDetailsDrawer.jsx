import React, { useEffect } from 'react';
import PropTypes from 'prop-types';
import { SignalChecklist } from './RegisterResourceDialog';
import useBackdropDismiss from '../common/useBackdropDismiss';

/** "3m ago" from a second count, or null when there is nothing to say. */
const agoLabel = (seconds) => {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

const timestamp = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * View Details — what the catalog actually knows about one resource.
 *
 * The bindings table is the point of this drawer. Everywhere else a resource is
 * just a name, but what governs its telemetry is the set of (signal, stream,
 * column, value) matches discovered at registration — and when someone asks "why
 * is this row still showing logs after I disabled it", or "why did disabling
 * this hide more than I expected", the answer is here and nowhere else. A
 * resource matched on `k8s_namespace_name` filters an entire namespace; one
 * matched on `service_name` filters one service. That difference is invisible
 * from the table.
 */
export default function ResourceDetailsDrawer({ resource, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const enabled = resource.status === 'ENABLED';
  const available = resource.signals?.available || [];
  const backdropRef = useBackdropDismiss(onClose);

  return (
    <dialog
      open
      ref={backdropRef}
      className="alerts-drawer-backdrop native-el"
      aria-modal="true"
      aria-label={`Details for ${resource.resourceName}`}
    >
      <div className="alerts-drawer">
        <div className="alerts-modal-head">
          <h2 className="alerts-modal-title">{resource.resourceName}</h2>
          <button
            type="button" className="alerts-modal-x" onClick={onClose} aria-label="Close"
          >×</button>
        </div>

        <div className="alerts-drawer-body">
          <dl className="pc-facts">
            <dt>Category</dt>
            <dd>{resource.categoryLabel || resource.category || '—'}</dd>

            <dt>Status</dt>
            <dd>
              <span className={`pc-status pc-status--${enabled ? 'on' : 'off'}`}>
                <span className="pc-status-dot" aria-hidden="true" />
                {enabled ? 'Enabled' : 'Disabled'}
              </span>
            </dd>

            <dt>Telemetry identifier</dt>
            <dd>
              {resource.resolvedName
                ? <code>{resource.resolvedName}</code>
                : <span className="pc-dim">not resolved yet</span>}
            </dd>

            <dt>Last seen</dt>
            <dd>
              {timestamp(resource.lastSeen)}
              {resource.lastSeenAgoSec != null && (
                <span className="pc-dim"> ({agoLabel(resource.lastSeenAgoSec)})</span>
              )}
            </dd>

            <dt>Registered</dt>
            <dd>
              {timestamp(resource.registeredAt)}
              {resource.source === 'CONFIG' && (
                <span className="pc-dim"> · from configuration</span>
              )}
            </dd>

            <dt>Last changed</dt>
            <dd>{timestamp(resource.updatedAt)}</dd>

            <dt>Registry id</dt>
            <dd><code className="pc-id">{resource.id}</code></dd>
          </dl>

          <h3 className="pc-section-title">Visibility</h3>
          <SignalChecklist signals={resource.signals} />
          {!enabled && available.length > 0 && (
            // Two different facts, and conflating them is a real support cost:
            // a disabled resource shows three crosses even though its telemetry
            // is fine, and "it has no metrics" would be the wrong conclusion.
            <p className="ae-hint">
              This resource is disabled, so nothing is shown for it anywhere. Its
              telemetry does exist in OpenObserve — {available.join(', ')} — and
              re-enabling restores it immediately, with no re-validation.
            </p>
          )}
          {enabled && available.length === 0 && (
            <p className="ae-hint">
              No telemetry has been matched to this resource yet. It was registered
              without validation, and the catalog re-checks periodically.
            </p>
          )}

          <h3 className="pc-section-title">Matched identifiers</h3>
          {resource.bindings?.length ? (
            <div className="pc-bindings">
              <div className="pc-binding pc-binding--head">
                <span>Signal</span><span>Stream</span><span>Column</span><span>Value</span>
              </div>
              {resource.bindings.map((b) => (
                <div className="pc-binding" key={`${b.signal}-${b.stream}-${b.column}`}>
                  <span className={`pc-signal-tag pc-signal-tag--${b.signal}`}>{b.signal}</span>
                  <span className="pc-mono" title={b.stream}>{b.stream}</span>
                  <span className="pc-mono" title={b.column}>{b.column}</span>
                  <span className="pc-mono" title={b.value}>{b.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="ae-hint">
              None. While a resource has no matched identifier it is filtered by its
              name against <code>service_name</code>, which is the one column present
              on every stream in all three signals.
            </p>
          )}

          <p className="ae-hint" style={{ marginTop: '1rem' }}>
            These are the exact comparisons the backend adds to every Logs, Traces
            and Metrics query while this resource is disabled. A match on a broad
            identifier such as <code>k8s_namespace_name</code> covers everything in
            that namespace, not just this resource.
          </p>
        </div>
      </div>
    </dialog>
  );
}

ResourceDetailsDrawer.propTypes = {
  resource: PropTypes.shape({
    id: PropTypes.string.isRequired,
    resourceName: PropTypes.string.isRequired,
    resolvedName: PropTypes.string,
    category: PropTypes.string,
    categoryLabel: PropTypes.string,
    status: PropTypes.string,
    source: PropTypes.string,
    lastSeen: PropTypes.string,
    lastSeenAgoSec: PropTypes.number,
    registeredAt: PropTypes.string,
    updatedAt: PropTypes.string,
    signals: PropTypes.object,
    bindings: PropTypes.array,
  }).isRequired,
  onClose: PropTypes.func.isRequired,
};

export { agoLabel };
