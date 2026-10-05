import React, { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import LogSourceRow from './LogSourceRow';

/**
 * Body of the logs view: the two-column header (timestamp / source) and either
 * the rows or a contextual empty/error message.
 *
 * There used to be three row layouts here — a columnar grid, a console-style
 * stream, and this one — selected by a toolbar toggle. The screen now has a
 * single layout, so the switch and the other two row components are gone.
 */

/** IANA zone the browser is in — shown in the timestamp header the way
 *  OpenObserve labels it, so nobody has to guess which clock the rows are on. */
const LOCAL_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
})();

/**
 * A React key per row. Two records can share a trace id and a timestamp, so the
 * nth repeat of the same pair gets its occurrence number appended.
 */
const rowKeys = (rows) => {
  const seen = new Map();
  return rows.map((log) => {
    const base = `${log.traceId}-${log.timestamp}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  });
};

function EmptyState({ isLoading, isError, errorMessage, hasQuery }) {
  if (isLoading) return <>Running query…</>;
  if (isError) {
    return (
      <div className="log-empty-error">
        <p><strong>Query failed</strong></p>
        <p>{errorMessage || 'The backend did not return results. Check that it is reachable.'}</p>
      </div>
    );
  }
  return hasQuery
    ? <>No events matched this query in the selected time range.</>
    : <>No events in the selected time range.</>;
}

EmptyState.propTypes = {
  isLoading: PropTypes.bool.isRequired,
  isError: PropTypes.bool.isRequired,
  errorMessage: PropTypes.string,
  hasQuery: PropTypes.bool,
};

export default function LogTable({
  rows, hoveredTraceId, setHoveredTraceId, onTraceClick,
  highlight, onFieldFilter, expandedAll, onOpenDetails,
  isLoading, isError, errorMessage, hasQuery,
}) {
  // Hover highlighting only, so it is bound natively rather than as a JSX prop
  // on a container that is not itself a control.
  const listRef = useRef(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const onMouseLeave = () => setHoveredTraceId(null);
    list.addEventListener('mouseleave', onMouseLeave);
    return () => list.removeEventListener('mouseleave', onMouseLeave);
  }, [setHoveredTraceId]);
  const keys = rowKeys(rows);

  return (
    <>
      <div className="log-header oo-header">
        <span className="oo-header-caret" aria-hidden="true" />
        <span className="oo-header-ts">timestamp ({LOCAL_TZ})</span>
        <span className="oo-header-src">source</span>
      </div>

      {isLoading && (
        <>
          <div className="log-loading-bar" aria-hidden="true" />
          <progress className="sr-only" aria-label="Running query" />
        </>
      )}

      <div className="log-list log-list--source" ref={listRef}>
        {rows.length > 0 ? (
          rows.map((log, index) => (
            <LogSourceRow
              key={keys[index]}
              log={log}
              hoveredTraceId={hoveredTraceId}
              setHoveredTraceId={setHoveredTraceId}
              onTraceClick={onTraceClick}
              debouncedSearch={highlight}
              onFieldFilter={onFieldFilter}
              expandedAll={expandedAll}
              onOpenDetails={onOpenDetails}
            />
          ))
        ) : (
          <div className="log-empty">
            <EmptyState
              isLoading={isLoading}
              isError={isError}
              errorMessage={errorMessage}
              hasQuery={hasQuery}
            />
          </div>
        )}
      </div>
    </>
  );
}

LogTable.propTypes = {
  rows: PropTypes.array.isRequired,
  hoveredTraceId: PropTypes.string,
  setHoveredTraceId: PropTypes.func.isRequired,
  onTraceClick: PropTypes.func.isRequired,
  /** Free-text term from the active query, marked up in the rendered values. */
  highlight: PropTypes.string,
  /** (field, value) — container appends it to the query and re-runs. */
  onFieldFilter: PropTypes.func,
  expandedAll: PropTypes.bool,
  /** Row click — opens the Source Details modal. */
  onOpenDetails: PropTypes.func,
  isLoading: PropTypes.bool.isRequired,
  isError: PropTypes.bool.isRequired,
  errorMessage: PropTypes.string,
  /** Whether the active query has any clauses — picks the empty-state wording. */
  hasQuery: PropTypes.bool,
};
