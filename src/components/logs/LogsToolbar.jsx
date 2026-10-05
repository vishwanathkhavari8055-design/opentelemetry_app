import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import TimeRangePicker from './TimeRangePicker';
import RefreshIntervalPicker from './RefreshIntervalPicker';

/**
 * The toolbar above the Query Editor.
 *
 * Left: view toggles (chart, field list, editor) and the SQL-mode switch.
 * Right: saved views, the time range, "Run query", auto-refresh, and a menu
 * holding share and export.
 *
 * Every control here does something against this backend. Where the reference
 * UI has a control this deployment can't serve — server-side functions,
 * pipelines, enterprise sign-up — it is left out rather than rendered as a
 * button that does nothing.
 */

/** Small popover that closes on outside click and Escape. */
/** Hover text for Run: why it is disabled, or whether it would change anything. */
function runTitle(runDisabled, isDirty) {
  if (runDisabled) return "The query doesn't parse — see the message under the editor";
  return isDirty ? 'Unrun changes — click to apply' : 'Re-run the query';
}

function useDismissable(open, setOpen) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);
  return ref;
}

function SavedViews({ views, onSave, onLoad, onDelete }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useDismissable(open, setOpen);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName('');
    setOpen(false);
  };

  return (
    <div className="tb-pop" ref={ref}>
      <button
        type="button"
        className={`tb-btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Saved views"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <path d="M17 21v-8H7v8M7 3v5h8" />
        </svg>
      </button>

      {open && (
        <div className="tb-menu tb-menu--wide" role="menu">
          <div className="tb-menu-head">Save current query</div>
          <div className="tb-menu-row">
            <input
              type="text"
              value={name}
              placeholder="View name"
              aria-label="Saved view name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            />
            <button type="button" className="tb-menu-primary" onClick={save} disabled={!name.trim()}>
              Save
            </button>
          </div>

          <div className="tb-menu-head">Saved</div>
          {views.length === 0 ? (
            <div className="tb-menu-empty">Nothing saved yet.</div>
          ) : views.map((v) => (
            <div className="tb-menu-row tb-menu-row--saved" key={v.name}>
              <button
                type="button"
                className="tb-menu-item"
                onClick={() => { onLoad(v); setOpen(false); }}
                title={v.query || '(empty query)'}
              >{v.name}</button>
              <button
                type="button"
                className="tb-menu-del"
                onClick={() => onDelete(v.name)}
                aria-label={`Delete saved view ${v.name}`}
                title="Delete"
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
SavedViews.propTypes = {
  views: PropTypes.array.isRequired,
  onSave: PropTypes.func.isRequired,
  onLoad: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};

function OverflowMenu({ onShare, onDownload, shareState }) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, setOpen);

  return (
    <div className="tb-pop" ref={ref}>
      <button
        type="button"
        className={`tb-btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        aria-label="More actions"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {open && (
        <div className="tb-menu" role="menu">
          <button type="button" className="tb-menu-item" role="menuitem" onClick={onShare}>
            {shareState === 'copied' ? 'Link copied ✓' : 'Copy share link'}
          </button>
          {/* Exports the rows currently on screen. Naming it "this page" is
              not pedantry: with no server-side total there is no way to fetch
              "all results", so a plain "Download results" would promise a
              complete export it can't deliver. */}
          <button
            type="button"
            className="tb-menu-item"
            role="menuitem"
            onClick={() => { onDownload('json'); setOpen(false); }}
          >Download this page (JSON)</button>
          <button
            type="button"
            className="tb-menu-item"
            role="menuitem"
            onClick={() => { onDownload('csv'); setOpen(false); }}
          >Download this page (CSV)</button>
        </div>
      )}
    </div>
  );
}
OverflowMenu.propTypes = {
  onShare: PropTypes.func.isRequired,
  onDownload: PropTypes.func.isRequired,
  shareState: PropTypes.string,
};

export default function LogsToolbar({
  sqlMode, onToggleSqlMode,
  histogramVisible, onToggleHistogram,
  fieldsCollapsed, onToggleFields,
  editorCollapsed, onToggleEditor,
  timeRange, onTimeRangeChange,
  refreshSecs, onRefreshSecsChange, refreshPausedReason,
  onRun, isRunning, isDirty, runDisabled,
  savedViews, onSaveView, onLoadView, onDeleteView,
  onShare, shareState, onDownload,
}) {
  return (
    <header className="logs-toolbar">
      <div className="tb-group">
        <button
          type="button"
          className={`tb-btn ${histogramVisible ? 'is-active' : ''}`}
          onClick={onToggleHistogram}
          aria-pressed={histogramVisible}
          title={histogramVisible ? 'Hide the event-volume chart' : 'Show the event-volume chart'}
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

      {/* SQL mode. Flipping it rewrites the editor's contents into the other
          dialect rather than clearing them — see toSql / fromSql. */}
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
        {'SQL'}
      </button>

      <div className="tb-spacer" />

      <SavedViews
        views={savedViews}
        onSave={onSaveView}
        onLoad={onLoadView}
        onDelete={onDeleteView}
      />

      <TimeRangePicker value={timeRange} onChange={onTimeRangeChange} />

      <button
        type="button"
        className={`tb-run ${isDirty && !runDisabled ? 'is-dirty' : ''}`}
        onClick={onRun}
        disabled={isRunning || runDisabled}
        title={runTitle(runDisabled, isDirty)}
      >
        {isRunning ? 'Running…' : 'Run query'}
      </button>

      <RefreshIntervalPicker
        value={refreshSecs}
        onChange={onRefreshSecsChange}
        pausedReason={refreshPausedReason}
      />

      <OverflowMenu onShare={onShare} shareState={shareState} onDownload={onDownload} />
    </header>
  );
}

LogsToolbar.propTypes = {
  sqlMode: PropTypes.bool.isRequired,
  onToggleSqlMode: PropTypes.func.isRequired,
  histogramVisible: PropTypes.bool.isRequired,
  onToggleHistogram: PropTypes.func.isRequired,
  fieldsCollapsed: PropTypes.bool.isRequired,
  onToggleFields: PropTypes.func.isRequired,
  editorCollapsed: PropTypes.bool.isRequired,
  onToggleEditor: PropTypes.func.isRequired,
  timeRange: PropTypes.object.isRequired,
  onTimeRangeChange: PropTypes.func.isRequired,
  refreshSecs: PropTypes.number.isRequired,
  onRefreshSecsChange: PropTypes.func.isRequired,
  /** Why auto-refresh is switched on but asleep; '' when it is running. */
  refreshPausedReason: PropTypes.string,
  onRun: PropTypes.func.isRequired,
  isRunning: PropTypes.bool,
  /** Editor contents differ from what produced the results on screen. */
  isDirty: PropTypes.bool,
  /** The draft query doesn't parse, so there is nothing runnable. */
  runDisabled: PropTypes.bool,
  savedViews: PropTypes.array.isRequired,
  onSaveView: PropTypes.func.isRequired,
  onLoadView: PropTypes.func.isRequired,
  onDeleteView: PropTypes.func.isRequired,
  onShare: PropTypes.func.isRequired,
  shareState: PropTypes.string,
  onDownload: PropTypes.func.isRequired,
};
