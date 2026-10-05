import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatIsoDateTime } from '../../utils/dateUtils';
import { HighlightedText } from './HighlightedText';
import { hasTraceId } from '../../services/api';
import { sourceRecord } from './sourceRecord';

/**
 * A log row: an expand caret, a timestamp column, and a single-line `source`
 * column holding the whole record rendered as coloured JSON. Expanding the row
 * swaps in a field/value detail panel with per-field query actions and a
 * raw-JSON tab.
 *
 * The JSON is built from the record's own entries rather than
 * JSON.stringify + a regex pass: tokenising the string back into keys and
 * values is guesswork the moment a value itself contains a quote or a colon,
 * which log bodies do constantly.
 */

/** Longest value we'll offer an `=` filter button for. Past this the value is
 *  a message body or a stack trace, where an equality clause matches nothing
 *  useful — the copy button is still there for those. */
const MAX_FILTERABLE_LEN = 120;

const isFilterable = (value) =>
  value != null && value !== '' && String(value).length <= MAX_FILTERABLE_LEN
  && !String(value).includes('\n');

/** JSON scalar → display text, quoted for strings the way JSON.stringify would. */
const scalarText = (v) => {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
};

const valueClass = (v) => {
  if (v === null) return 'oo-json-null';
  if (typeof v === 'number') return 'oo-json-num';
  if (typeof v === 'boolean') return 'oo-json-bool';
  return 'oo-json-str';
};

/** Single-line coloured JSON for the source column. */
const SourceJson = React.memo(function SourceJson({ record, highlight }) {
  const entries = Object.entries(record);
  return (
    <span className="oo-json">
      <span className="oo-json-punct">{'{'}</span>
      {entries.map(([key, value], i) => (
        <span className="oo-json-pair" key={key}>
          {i > 0 && <span className="oo-json-punct">,</span>}
          <span className="oo-json-key">&quot;{key}&quot;</span>
          <span className="oo-json-punct">:</span>
          <span className={`oo-json-val ${valueClass(value)}`}>
            {typeof value === 'string'
              ? <>&quot;<HighlightedText text={value} highlight={highlight} />&quot;</>
              : scalarText(value)}
          </span>
        </span>
      ))}
      <span className="oo-json-punct">{'}'}</span>
    </span>
  );
});
SourceJson.propTypes = {
  record: PropTypes.object.isRequired,
  highlight: PropTypes.string,
};

/** Copy-to-clipboard button that flips to a tick for two seconds. */
function CopyButton({ text, title }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`oo-mini-btn ${copied ? 'is-copied' : ''}`}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        if (!text) return;
        navigator.clipboard.writeText(String(text)).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch(() => { /* clipboard blocked (insecure origin) — no-op */ });
      }}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}
CopyButton.propTypes = { text: PropTypes.string, title: PropTypes.string };

export default function LogSourceRow({
  log, hoveredTraceId, setHoveredTraceId, onTraceClick,
  debouncedSearch, onFieldFilter, expandedAll, onOpenDetails,
}) {
  // `expandedAll` is the results bar's "expand every record" switch. It SETS
  // this row's state rather than overriding it, so flipping it opens (or
  // closes) everything and the per-row caret still works normally afterwards —
  // an override would leave the caret dead while the switch was on.
  const [open, setOpen] = useState(!!expandedAll);
  useEffect(() => { setOpen(!!expandedAll); }, [expandedAll]);

  const [detailTab, setDetailTab] = useState('table');

  const record = useMemo(() => sourceRecord(log), [log]);
  const isSameTrace = log.traceId === hoveredTraceId;
  const isDimmed = hoveredTraceId && !isSameTrace;
  const isOpen = open;

  const entries = useMemo(
    () => Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
    [record],
  );

  return (
    <div
      className={`oo-row-wrap sev-${log.severity} ${isDimmed ? 'dimmed' : ''} ${
        isSameTrace ? 'highlighted' : ''} ${isOpen ? 'is-open' : ''}`}
    >
      {/* Clicking the row opens the Source Details modal. The caret keeps its
          own inline-expand behaviour and stops propagation, so the two
          gestures don't fight: caret = peek in place, row = read it properly. */}
      <button
        type="button"
        className="oo-row"
        title="Open source details"
        onClick={() => onOpenDetails?.(log)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenDetails?.(log);
          }
        }}
      >
        <button
          type="button"
          className="oo-row-caret"
          aria-expanded={isOpen}
          aria-label={isOpen ? 'Collapse record' : 'Expand record'}
          title={isOpen ? 'Collapse record' : 'Expand record'}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        >
          {isOpen ? '⌄' : '›'}
        </button>
        <span className="oo-row-ts" title={log.timestamp}>
          <HighlightedText text={formatIsoDateTime(log.timestamp)} highlight={debouncedSearch} />
        </span>
        <span className="oo-row-src">
          <SourceJson record={record} highlight={debouncedSearch} />
        </span>
      </button>

      {isOpen && (
        <div className="oo-detail">
          <div className="oo-detail-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === 'table'}
              className={`oo-detail-tab ${detailTab === 'table' ? 'is-active' : ''}`}
              onClick={() => setDetailTab('table')}
            >Table</button>
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === 'json'}
              className={`oo-detail-tab ${detailTab === 'json' ? 'is-active' : ''}`}
              onClick={() => setDetailTab('json')}
            >JSON</button>

            <span className="oo-detail-spacer" />

            {hasTraceId(log) && (
              <button
                type="button"
                className="oo-detail-action"
                onClick={() => onTraceClick(log.traceId)}
                // Hovering here — not the whole row — is what lights up the
                // trace's other rows. On the row itself, moving the mouse down
                // the page would dim everything on every single row, which
                // makes the list unreadable rather than correlated.
                onMouseEnter={() => setHoveredTraceId(log.traceId)}
                title="Open this trace in the trace view — hover to highlight its other rows"
              >Open trace →</button>
            )}
            <CopyButton text={JSON.stringify(record, null, 2)} title="Copy the whole record as JSON" />
          </div>

          {detailTab === 'table' ? (
            <div className="oo-detail-table">
              {entries.map(([key, value]) => (
                <div className="oo-detail-row" key={key}>
                  <span className="oo-detail-actions">
                    {isFilterable(value) && (
                      <button
                        type="button"
                        className="oo-mini-btn"
                        title={`Add ${key}='${value}' to the query`}
                        aria-label={`Add ${key} equals ${value} to the query`}
                        onClick={() => onFieldFilter?.(key, value)}
                      >=</button>
                    )}
                    <CopyButton text={String(value)} title={`Copy ${key}`} />
                  </span>
                  <span className="oo-detail-key" title={key}>{key}</span>
                  <span className="oo-detail-val">
                    {/* Stack traces and long bodies keep their newlines here —
                        the single-line constraint only applies to the collapsed
                        source column. */}
                    <HighlightedText text={String(value)} highlight={debouncedSearch} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <pre className="oo-detail-json">
              <HighlightedText
                text={JSON.stringify(record, null, 2)}
                highlight={debouncedSearch}
              />
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

LogSourceRow.propTypes = {
  log: PropTypes.object.isRequired,
  hoveredTraceId: PropTypes.string,
  setHoveredTraceId: PropTypes.func.isRequired,
  onTraceClick: PropTypes.func.isRequired,
  debouncedSearch: PropTypes.string,
  /** (field, value) — container routes it onto whichever backend filter fits. */
  onFieldFilter: PropTypes.func,
  /** Toolbar switch that opens every row at once. */
  expandedAll: PropTypes.bool,
  /** Row click — container opens the Source Details modal. */
  onOpenDetails: PropTypes.func,
};
