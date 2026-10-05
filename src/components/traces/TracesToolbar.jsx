import React from 'react';
import PropTypes from 'prop-types';
import TimeRangePicker from '../logs/TimeRangePicker';
import RefreshIntervalPicker from '../logs/RefreshIntervalPicker';

/**
 * Toolbar above the Traces query editor: the tab strip on the left, the time
 * range and Run query on the right.
 *
 * The time-range and refresh controls are the same components the Logs screen
 * uses. Reusing them is not just DRY — a range picker that behaved differently
 * between two tabs of the same product would be a bug in its own right.
 */

export const TABS = [
  { key: 'spans',   label: 'Spans' },
  { key: 'traces',  label: 'Traces' },
  { key: 'catalog', label: 'Service Catalog' },
];

/** Tooltip for Run query: why it's disabled, that it has unrun edits, or neither. */
const runButtonTitle = (runDisabled, isDirty) => {
  if (runDisabled) return "The query doesn't parse — see the message under the editor";
  if (isDirty) return 'Unrun changes — click to apply';
  return 'Re-run the query';
};

export default function TracesToolbar({
  tab, onTabChange,
  chartsVisible, onToggleCharts,
  fieldsCollapsed, onToggleFields,
  editorCollapsed, onToggleEditor,
  errorsOnly, onToggleErrorsOnly,
  sqlMode, onToggleSqlMode,
  timeRange, onTimeRangeChange,
  refreshSecs, onRefreshSecsChange,
  onRun, isRunning, isDirty, runDisabled,
  onDownload,
}) {
  // The Service Catalog is a single aggregation with no chart row, no query
  // editor and no per-span field list, so the controls that only make sense
  // for the two listing tabs are hidden rather than left inert.
  const isCatalog = tab === 'catalog';

  return (
    <header className="traces-toolbar">
      <div className="tv-tabs" role="tablist" aria-label="Traces view">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tv-tab ${tab === t.key ? 'is-active' : ''}`}
            onClick={() => onTabChange(t.key)}
          >{t.label}</button>
        ))}
      </div>

      {!isCatalog && (
        <div className="tb-group">
          <button
            type="button"
            className={`tb-btn ${chartsVisible ? 'is-active' : ''}`}
            onClick={onToggleCharts}
            aria-pressed={chartsVisible}
            title={chartsVisible ? 'Hide the Rate / Errors / Duration charts' : 'Show the charts'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 20V10M10 20V4M16 20v-7M22 20v-11" />
            </svg>
          </button>

          <button
            type="button"
            className={`tb-btn ${!fieldsCollapsed ? 'is-active' : ''}`}
            onClick={onToggleFields}
            aria-pressed={!fieldsCollapsed}
            title={fieldsCollapsed ? 'Show the field list' : 'Hide the field list'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 5h18M3 12h7M3 19h7M14 12h7M14 19h7" />
            </svg>
          </button>

          <button
            type="button"
            className={`tb-btn ${!editorCollapsed ? 'is-active' : ''}`}
            onClick={onToggleEditor}
            aria-pressed={!editorCollapsed}
            title={editorCollapsed ? 'Show the query editor' : 'Hide the query editor'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m8 8-4 4 4 4M16 8l4 4-4 4" />
            </svg>
          </button>
        </div>
      )}

      {!isCatalog && (
        <button
          type="button"
          className={`tb-switch ${sqlMode ? 'is-on' : ''}`}
          onClick={onToggleSqlMode}
          role="switch"
          aria-checked={sqlMode}
          title={sqlMode
            ? 'SQL mode on — WHERE clauses are applied; projection and aggregation are not'
            : 'Filter mode — plain field=value expressions'}
        >
          <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
          {' '}SQL
        </button>
      )}

      {!isCatalog && (
        <button
          type="button"
          className={`tb-switch tv-errors-switch ${errorsOnly ? 'is-on' : ''}`}
          onClick={onToggleErrorsOnly}
          role="switch"
          aria-checked={errorsOnly}
          title={errorsOnly ? 'Showing errors only — click to show everything' : 'Show only errors'}
        >
          <span className="tb-switch-track"><span className="tb-switch-thumb" /></span>
          <span className="tv-errors-dot" aria-hidden="true" />
        </button>
      )}

      <div className="tb-spacer" />

      <TimeRangePicker value={timeRange} onChange={onTimeRangeChange} />

      <button
        type="button"
        className={`tb-run ${isDirty && !runDisabled ? 'is-dirty' : ''}`}
        onClick={onRun}
        disabled={isRunning || runDisabled}
        title={runButtonTitle(runDisabled, isDirty)}
      >
        {isRunning ? 'Running…' : 'Run query'}
      </button>

      <RefreshIntervalPicker value={refreshSecs} onChange={onRefreshSecsChange} />

      <button
        type="button"
        className="tb-btn"
        onClick={onDownload}
        title="Download this page as JSON"
        aria-label="Download this page as JSON"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12M7 12l5 5 5-5M5 21h14" />
        </svg>
      </button>
    </header>
  );
}

TracesToolbar.propTypes = {
  tab: PropTypes.oneOf(['spans', 'traces', 'catalog']).isRequired,
  onTabChange: PropTypes.func.isRequired,
  chartsVisible: PropTypes.bool.isRequired,
  onToggleCharts: PropTypes.func.isRequired,
  fieldsCollapsed: PropTypes.bool.isRequired,
  onToggleFields: PropTypes.func.isRequired,
  editorCollapsed: PropTypes.bool.isRequired,
  onToggleEditor: PropTypes.func.isRequired,
  errorsOnly: PropTypes.bool.isRequired,
  onToggleErrorsOnly: PropTypes.func.isRequired,
  sqlMode: PropTypes.bool.isRequired,
  onToggleSqlMode: PropTypes.func.isRequired,
  timeRange: PropTypes.object.isRequired,
  onTimeRangeChange: PropTypes.func.isRequired,
  refreshSecs: PropTypes.number.isRequired,
  onRefreshSecsChange: PropTypes.func.isRequired,
  onRun: PropTypes.func.isRequired,
  isRunning: PropTypes.bool,
  isDirty: PropTypes.bool,
  runDisabled: PropTypes.bool,
  onDownload: PropTypes.func.isRequired,
};
