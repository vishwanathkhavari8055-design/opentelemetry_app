import React from 'react';
import PropTypes from 'prop-types';

/**
 * Strip between the toolbar and the chart: what the current query returned, how
 * long it took, when it ran, and the controls for re-running it / paging /
 * showing-hiding the chart.
 *
 * `total` is the server's count when the backend supplies one; when it doesn't
 * (LogPageResponseDTO leaves `total` null unless a caller asks for the extra
 * COUNT query) the range is shown without a denominator rather than
 * substituting a guess — "1 to 50 of 50" would read as "that's everything" when
 * it isn't. Page numbers degrade the same way: with no total there is no last
 * page to jump to, so the numbered window walks forward off `hasMore` instead
 * of pretending to know how many pages exist.
 *
 * Units switch between events and traces because the grouped view paginates by
 * trace, not by log row.
 */

/** Page-size options. 10 and 20 were dropped: on a log screen they are small
 *  enough that you page instead of read, and every real choice starts at 50. */
const PAGE_SIZES = [50, 100, 250, 500];

/** How many numbered page buttons to show at once. */
const PAGE_WINDOW = 5;

const relativeTime = (ts) => {
  if (!ts) return null;
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
};

/**
 * The window of page numbers to render, 0-indexed, kept centred on the current
 * page and clamped to `lastPage` — the highest page we can actually assert
 * exists. Never renders a number past it: a button that lands on an empty page
 * looks like data loss rather than the end of the results.
 */
const pageWindow = (page, lastPage) => {
  let start = Math.max(0, page - Math.floor(PAGE_WINDOW / 2));
  start = Math.min(start, Math.max(0, lastPage - PAGE_WINDOW + 1));
  const end = Math.min(lastPage, start + PAGE_WINDOW - 1);
  const out = [];
  for (let p = start; p <= end; p += 1) out.push(p);
  return out;
};

/** Row range shown and the pager's extent for the current page. */
const pageBounds = ({ page, pageSize, rowCount, total, hasMore }) => {
  // pageSize -1 is the legacy "show all" mode — there is no window to describe.
  const size = pageSize === -1 ? rowCount : pageSize;
  const from = rowCount === 0 ? 0 : page * size + 1;
  const to = rowCount === 0 ? 0 : from + rowCount - 1;

  // Last page index, when the server told us how many rows match. It usually
  // doesn't (LogPageResponseDTO's `total` is null unless someone pays for the
  // extra COUNT query), in which case `hasMore` is the only forward knowledge
  // we have: the current page plus one more, growing as the user walks
  // forward. That's why the numbered strip fills out as you page rather than
  // showing 1–5 up front.
  const knownLastPage = (total != null && size > 0)
    ? Math.max(0, Math.ceil(total / size) - 1)
    : null;
  let lastPage = knownLastPage;
  if (lastPage == null) {
    lastPage = page + (hasMore ? 1 : 0);
  }
  const pages = pageSize === -1 ? [] : pageWindow(page, lastPage);
  const canNext = page < lastPage;
  return { from, to, knownLastPage, lastPage, pages, canNext };
};

const emptyText = (loading, unit) => (loading ? 'Running query…' : `No ${unit} matched`);

export default function LogResultsBar({
  page, setPage, pageSize, setPageSize, rowCount, total, tookMs, fetchedAt,
  unit, loading, onRefresh,
  histogramVisible, onToggleHistogram,
  hasMore,
  expandedAll, onToggleExpandedAll, showExpandAll,
}) {
  const { from, to, knownLastPage, lastPage, pages, canNext } =
    pageBounds({ page, pageSize, rowCount, total, hasMore });
  const ago = relativeTime(fetchedAt);

  return (
    <div className="results-bar">
      <span className="results-bar-count">
        {rowCount === 0 ? (
          emptyText(loading, unit)
        ) : (
          <>
            Showing <strong>{from.toLocaleString()}</strong> to <strong>{to.toLocaleString()}</strong>
            {total != null && <> out of <strong>{total.toLocaleString()}</strong></>} {unit}
            {tookMs != null && <span className="results-bar-took"> in {tookMs} ms</span>}
          </>
        )}
      </span>

      <button
        type="button"
        className={`results-bar-btn ${histogramVisible ? 'is-active' : ''}`}
        onClick={onToggleHistogram}
        title={histogramVisible ? 'Hide the event-volume chart' : 'Show the event-volume chart'}
        aria-pressed={histogramVisible}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 20V10M10 20V4M16 20v-7M22 20v-11" />
        </svg>
      </button>

      {ago && (
        <span className={`results-bar-when ${loading ? 'is-loading' : ''}`}>
          <span className="results-bar-dot" aria-hidden="true" />
          {loading ? 'refreshing…' : ago}
        </span>
      )}

      <button
        type="button"
        className="results-bar-btn"
        onClick={onRefresh}
        title="Re-run the query"
        aria-label="Re-run the query"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.3 5.7" />
          <path d="M20 4v7h-7" />
        </svg>
      </button>

      <div className="results-bar-actions">
        {showExpandAll && (
          <button
            type="button"
            className={`results-bar-btn ${expandedAll ? 'is-active' : ''}`}
            onClick={onToggleExpandedAll}
            aria-pressed={expandedAll}
            title={expandedAll ? 'Collapse every record' : 'Expand every record'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h16M4 12h10M4 18h16" />
            </svg>
          </button>
        )}

        <label className="results-bar-size" title={`${unit} per page`}>
          <span className="sr-only">Rows per page</span>
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
            aria-label="Rows per page"
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <div className="results-bar-pager">
          <button
            type="button"
            className="results-bar-btn"
            onClick={() => setPage(0)}
            disabled={page === 0}
            title="First page"
            aria-label="First page"
          >«</button>

          {pages.map((p) => (
            <button
              type="button"
              key={p}
              className={`results-bar-page-btn ${p === page ? 'is-current' : ''}`}
              onClick={() => setPage(p)}
              aria-current={p === page ? 'page' : undefined}
            >{p + 1}</button>
          ))}

          <button
            type="button"
            className="results-bar-btn"
            onClick={() => setPage(lastPage)}
            disabled={!canNext}
            title={knownLastPage != null ? 'Last page' : 'Next page'}
            aria-label={knownLastPage != null ? 'Last page' : 'Next page'}
          >»</button>
        </div>
      </div>
    </div>
  );
}

LogResultsBar.propTypes = {
  page: PropTypes.number.isRequired,
  setPage: PropTypes.func.isRequired,
  pageSize: PropTypes.number.isRequired,
  setPageSize: PropTypes.func.isRequired,
  rowCount: PropTypes.number.isRequired,
  /** Server-reported match count; null when the backend didn't supply one. */
  total: PropTypes.number,
  /** Round-trip time of the last query, in ms. */
  tookMs: PropTypes.number,
  /** epoch ms the last response landed. */
  fetchedAt: PropTypes.number,
  /** 'events' in flat mode, 'traces' in grouped mode. */
  unit: PropTypes.string.isRequired,
  loading: PropTypes.bool,
  onRefresh: PropTypes.func.isRequired,
  histogramVisible: PropTypes.bool.isRequired,
  onToggleHistogram: PropTypes.func.isRequired,
  hasMore: PropTypes.bool,
  expandedAll: PropTypes.bool,
  onToggleExpandedAll: PropTypes.func,
  /** Source view only — the expand-all switch is meaningless elsewhere. */
  showExpandAll: PropTypes.bool,
};
