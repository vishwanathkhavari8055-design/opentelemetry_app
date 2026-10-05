import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * The Query Editor strip under the toolbar: a line-numbered text area that
 * holds the current filter expression (or SELECT statement in SQL mode), with
 * a collapse header and a full-screen toggle.
 *
 * Deliberately a plain <textarea> and not a code-editor package. CodeMirror or
 * Monaco would be the single largest thing in this bundle — several times the
 * whole app — to buy syntax colouring for a grammar with four operators. The
 * gutter is a sibling element scrolled in lockstep with the textarea, which is
 * the standard way to get line numbers without owning the text rendering.
 *
 * Running the query is NOT this component's job: it raises `onRun` and the
 * container decides. That's what makes the toolbar's "Run query" button and
 * Ctrl/Cmd+Enter the same action rather than two code paths.
 */
export default function QueryEditor({
  value, onChange, onRun, sqlMode, collapsed, onToggleCollapsed,
  warnings = [], error, placeholder,
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const textRef = useRef(null);
  const gutterRef = useRef(null);

  const lineCount = useMemo(
    () => Math.max(1, (value || '').split('\n').length),
    [value],
  );

  // Escape leaves full screen. Bound on the document because focus may be on
  // the textarea, the toolbar, or nothing at all when the user reaches for it.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const handleKeyDown = (e) => {
    // Ctrl/Cmd+Enter runs, matching the toolbar button. Plain Enter inserts a
    // newline — the editor is multi-line and a query can legitimately span
    // several, so submitting on Enter would fight the user.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun();
      return;
    }
    // Tab indents instead of leaving the field. Shift+Tab still escapes, so
    // the editor never becomes a keyboard trap.
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: t } = el;
      const next = `${value.slice(0, s)}  ${value.slice(t)}`;
      onChange(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
    }
  };

  if (collapsed) {
    return (
      <div className="qe qe--collapsed">
        <button
          type="button"
          className="qe-title"
          onClick={onToggleCollapsed}
          aria-expanded={false}
          title="Show the query editor"
        >
          <span className="qe-chevron" aria-hidden="true">›</span>
          Query Editor
          {value.trim() && <span className="qe-collapsed-preview">{value.trim()}</span>}
        </button>
      </div>
    );
  }

  return (
    <div className={`qe ${fullscreen ? 'qe--fullscreen' : ''}`}>
      <div className="qe-head">
        <button
          type="button"
          className="qe-title"
          onClick={onToggleCollapsed}
          aria-expanded
          title="Hide the query editor"
        >
          <span className="qe-chevron qe-chevron--open" aria-hidden="true">›</span>
          {'Query Editor'}
        </button>

        <span className={`qe-mode ${sqlMode ? 'is-sql' : ''}`}>
          {sqlMode ? 'SQL' : 'filter'}
        </span>

        <span className="qe-hint">Ctrl+Enter to run</span>

        <button
          type="button"
          className="qe-expand"
          onClick={() => setFullscreen((f) => !f)}
          aria-pressed={fullscreen}
          title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {fullscreen
              ? <path d="M9 3v6H3M15 21v-6h6M3 15h6v6M21 9h-6V3" />
              : <path d="M3 9V3h6M21 15v6h-6M3 15v6h6M21 9V3h-6" />}
          </svg>
        </button>
      </div>

      <div className="qe-body">
        <div className="qe-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        <textarea
          ref={textRef}
          className="qe-input"
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={placeholder}
          aria-label="Query editor"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          // Keep the gutter aligned when the text area scrolls past its height.
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>

      {error && (
        <div className="qe-msg qe-msg--error" role="alert">{error}</div>
      )}
      {!error && warnings.length > 0 && (
        <ul className="qe-msg qe-msg--warn">
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}

QueryEditor.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  /** Raised by Ctrl/Cmd+Enter; the toolbar button calls the same handler. */
  onRun: PropTypes.func.isRequired,
  sqlMode: PropTypes.bool,
  collapsed: PropTypes.bool,
  onToggleCollapsed: PropTypes.func.isRequired,
  /** Clauses that parsed but can't be honoured by this backend. */
  warnings: PropTypes.arrayOf(PropTypes.string),
  /** Set when the query didn't parse at all — suppresses the warning list. */
  error: PropTypes.string,
  placeholder: PropTypes.string,
};
