import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { sourceRecord } from './sourceRecord';
import { hasTraceId } from '../../services/api';

/**
 * "Source Details" — the full record, opened by clicking a log row.
 *
 * A modal rather than the inline expander because the whole point is to read
 * ONE record properly: a k8s-annotated log carries 25+ fields and a body that
 * runs to several lines, which an inline panel can only show by pushing the
 * rest of the table off screen.
 *
 * The inline caret expander is untouched and still there — this is additive.
 *
 * Previous/Next walk the rows currently on screen, so you can read down a page
 * without closing and reopening. "Search Around" hands the record's timestamp
 * back to the container, which re-points the query at a window centred on it.
 */

/** Choices for how many surrounding events "Search Around" pulls in. */
const AROUND_COUNTS = [10, 20, 50, 100];

/** Keys hidden from the record — aliases api.js adds on top of the wire shape,
 *  which would otherwise appear twice (once dotted, once camelCase). */
const isScalar = (v) => v === null || typeof v !== 'object';

/** JSON scalar → display text, quoted the way JSON.stringify would. */
const scalarText = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  return String(v);
};

const valueClass = (v) => {
  if (v === null) return 'oo-json-null';
  if (typeof v === 'number') return 'oo-json-num';
  if (typeof v === 'boolean') return 'oo-json-bool';
  return 'oo-json-str';
};

/** A value long enough that collapsing it is worth offering. */
const LONG_VALUE = 160;

function CopyButton({ text, label = 'Copy to clipboard' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`ld-copy ${copied ? 'is-copied' : ''}`}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch(() => { /* clipboard blocked on an insecure origin */ });
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      {copied ? 'Copied' : label}
    </button>
  );
}
CopyButton.propTypes = { text: PropTypes.string, label: PropTypes.string };

/** One `▾ key: value,` line in the JSON view. */
function caretLabel(collapsible, open, name) {
  if (!collapsible) return undefined;
  return open ? `Collapse ${name}` : `Expand ${name}`;
}

function JsonLine({ name, value, last, highlight }) {
  const text = scalarText(value);
  const collapsible = text.length > LONG_VALUE || text.includes('\n');
  const [open, setOpen] = useState(true);

  const shown = collapsible && !open
    ? `${text.slice(0, LONG_VALUE).replaceAll('\n', ' ')}…`
    : text;

  const isMatch = highlight
    && (name.toLowerCase().includes(highlight) || text.toLowerCase().includes(highlight));

  return (
    <div className={`ld-json-line ${isMatch ? 'is-match' : ''}`}>
      <button
        type="button"
        className={`ld-json-caret ${collapsible ? '' : 'is-static'}`}
        onClick={() => collapsible && setOpen((o) => !o)}
        aria-label={caretLabel(collapsible, open, name)}
        aria-expanded={collapsible ? open : undefined}
        tabIndex={collapsible ? 0 : -1}
      >{collapsible && !open ? '▸' : '▾'}</button>
      <span className="oo-json-key">{name}</span>
      <span className="oo-json-punct">:&nbsp;</span>
      <span className={`ld-json-value ${valueClass(value)}`}>{shown}</span>
      {!last && <span className="oo-json-punct">,</span>}
    </div>
  );
}
JsonLine.propTypes = {
  name: PropTypes.string.isRequired,
  value: PropTypes.any,
  last: PropTypes.bool,
  highlight: PropTypes.string,
};

export default function LogDetailsModal({
  log, index, total, onPrev, onNext, onClose, onSearchAround, onTraceClick,
}) {
  const [tab, setTab] = useState('json');
  const [search, setSearch] = useState('');
  const [aroundCount, setAroundCount] = useState(10);
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);

  const record = useMemo(() => sourceRecord(log || {}), [log]);
  const entries = useMemo(
    () => Object.entries(record).filter(([, v]) => isScalar(v)).sort(([a], [b]) => a.localeCompare(b)),
    [record],
  );
  const pretty = useMemo(() => JSON.stringify(record, null, 2), [record]);

  const q = search.trim().toLowerCase();
  const tableRows = useMemo(() => (q
    ? entries.filter(([k, v]) => k.toLowerCase().includes(q)
      || String(v ?? '').toLowerCase().includes(q))
    : entries), [entries, q]);

  // Esc closes; ←/→ walk the page. Bound on the dialog, not the document, so
  // the arrow keys don't hijack navigation for the rest of the app.
  const onKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    // Don't steal arrows while the user is in the search box.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); onPrev(); }
    if (e.key === 'ArrowRight' && index < total - 1) { e.preventDefault(); onNext(); }
  }, [onClose, onPrev, onNext, index, total]);

  // Bound natively rather than through JSX props: neither the backdrop nor the
  // dialog is itself a control, the listeners only route keys and outside clicks.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    dialog.addEventListener('keydown', onKeyDown);
    return () => dialog.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown, log]);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return undefined;
    const onMouseDown = (e) => { if (e.target === backdrop) onClose(); };
    backdrop.addEventListener('mousedown', onMouseDown);
    return () => backdrop.removeEventListener('mousedown', onMouseDown);
  }, [onClose, log]);

  // Focus the dialog on open so the keyboard bindings above are live without a
  // click, and so screen readers announce it.
  useEffect(() => { closeRef.current?.focus(); }, []);

  if (!log) return null;

  return (
    <div className="ld-backdrop" ref={backdropRef}>
      <dialog
        open
        className="ld-dialog native-el"
        aria-modal="true"
        aria-label="Source Details"
        ref={dialogRef}
      >
        <header className="ld-head">
          <h2 className="ld-title">Source Details</h2>
          <button
            type="button"
            className="ld-close"
            onClick={onClose}
            ref={closeRef}
            aria-label="Close"
            title="Close (Esc)"
          >×</button>
        </header>

        <div className="ld-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'json'}
            className={`ld-tab ${tab === 'json' ? 'is-active' : ''}`}
            onClick={() => setTab('json')}
          >JSON</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'table'}
            className={`ld-tab ${tab === 'table' ? 'is-active' : ''}`}
            onClick={() => setTab('table')}
          >Table</button>
        </div>

        <div className="ld-toolbar">
          <CopyButton text={pretty} />
          <div className="ld-find">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />
            </svg>
            <input
              type="text"
              value={search}
              placeholder="Find in record…"
              aria-label="Find in record"
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" className="ld-find-x" onClick={() => setSearch('')}
                aria-label="Clear">×</button>
            )}
          </div>
          <span className="ld-pos">{index + 1} of {total}</span>

          {/* The drill-down to this record's trace. It lives here as well as on
              the inline expanded row because clicking a log opens THIS panel —
              without it the only route to the trace was the caret, which is a
              different gesture and easy to miss.

              Rendered only when the record actually carries a trace id, so the
              button never leads to an empty trace view; `hasTraceId` is shared
              with the inline row so the two cannot disagree about which logs
              have one. Placed after `.ld-pos` because that element owns the
              toolbar's `margin-left: auto` — sitting after it means the layout is
              identical for a log that has no trace and shows no button.

              Closing before navigating stops the modal being left over the trace
              it just opened. */}
          {onTraceClick && hasTraceId(log) && (
            <button
              type="button"
              className="oo-detail-action ld-opentrace"
              onClick={() => { onClose(); onTraceClick(log.traceId); }}
              title={`Open trace ${log.traceId} in the trace view`}
            >Open trace →</button>
          )}
        </div>

        <div className="ld-body">
          {tab === 'json' ? (
            <div className="ld-json">
              <span className="oo-json-punct">{'{'}</span>
              {entries.map(([k, v], i) => (
                <JsonLine
                  key={k}
                  name={k}
                  value={v}
                  last={i === entries.length - 1}
                  highlight={q}
                />
              ))}
              <span className="oo-json-punct">{'}'}</span>
            </div>
          ) : (
            <div className="ld-table">
              {tableRows.length === 0 ? (
                <div className="ld-empty">Nothing in this record matches “{search}”.</div>
              ) : tableRows.map(([k, v]) => (
                <div className="ld-tr" key={k}>
                  <span className="ld-td-key" title={k}>{k}</span>
                  <span className="ld-td-val">{scalarText(v)}</span>
                  <CopyButton text={String(v ?? '')} label="" />
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="ld-foot">
          <button
            type="button"
            className="ld-nav"
            onClick={onPrev}
            disabled={index <= 0}
            title="Previous record (←)"
          >‹ Previous</button>

          <div className="ld-around">
            <label className="ld-around-label">
              {'Number of events:'}
              <select
                value={aroundCount}
                onChange={(e) => setAroundCount(Number(e.target.value))}
                aria-label="Number of surrounding events"
              >
                {AROUND_COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button
              type="button"
              className="ld-around-btn"
              onClick={() => onSearchAround(log, aroundCount)}
              title="Re-point the query at a window centred on this record, ignoring the current filters"
            >Search Around</button>
          </div>

          <button
            type="button"
            className="ld-nav"
            onClick={onNext}
            disabled={index >= total - 1}
            title="Next record (→)"
          >Next ›</button>
        </footer>
      </dialog>
    </div>
  );
}

LogDetailsModal.propTypes = {
  /** The normalized row; its untouched wire record is what gets displayed. */
  log: PropTypes.object,
  /** Position within the rows currently on screen, for Previous/Next. */
  index: PropTypes.number.isRequired,
  total: PropTypes.number.isRequired,
  onPrev: PropTypes.func.isRequired,
  onNext: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  /** (log, count) — container re-points the query around this record. */
  onSearchAround: PropTypes.func.isRequired,
  /** (traceId) — container switches to the trace view. Optional: a host that
   *  embeds the logs screen without a trace view simply omits it and the
   *  button is not rendered. */
  onTraceClick: PropTypes.func,
};
