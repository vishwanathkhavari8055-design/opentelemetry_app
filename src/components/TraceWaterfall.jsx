import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { parseTimestampMs } from '../utils/parseTimestamp';
import { TYPE_COLORS } from '../utils/typeColors';
import { smartTruncate, detectTruncateKind } from '../utils/truncate';

// Enter / Space on a focused waterfall row selects it, as a click does.
const onActivateKey = (activate) => (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  activate();
};

const isErrorStatus = (s) => {
  const v = String(s || '').toUpperCase();
  return v.includes('ERROR') || v.includes('FAIL') || v.includes('FATAL');
};

// Thresholds for the auto-zoom decision. Chosen conservatively — most traces
// where one span dominates and children cluster late will trigger zoom; mixed
// or uniformly-distributed traces won't.
const DOMINANT_ROOT_THRESHOLD = 0.95; // root must be ≥ 95% of trace duration
const CRAMPED_CHILDREN_THRESHOLD = 0.5; // children must occupy < 50% of trace

// Folds one node into the running extents: overall range, the longest root,
// and the range covered by non-root spans.
const foldExtent = (ext, n) => {
  const start = parseTimestampMs(n.timestamp);
  if (start == null) return;
  const dur = Math.max(0, Number(n.durationMs) || 0);
  const end = start + dur;

  if (start < ext.minStart) ext.minStart = start;
  if (end > ext.maxEnd) ext.maxEnd = end;

  if ((n.depth || 0) === 0) {
    if (!ext.root || dur > (ext.root.dur || 0)) ext.root = { start, end, dur };
    return;
  }
  if (start < ext.childMinStart) ext.childMinStart = start;
  if (end > ext.childMaxEnd) ext.childMaxEnd = end;
  ext.childCount++;
};

const computeTimebase = (nodes) => {
  const ext = {
    minStart: Infinity, maxEnd: 0, root: null,
    childMinStart: Infinity, childMaxEnd: 0, childCount: 0,
  };
  for (const n of nodes) foldExtent(ext, n);
  const { minStart, maxEnd, root, childMinStart, childMaxEnd, childCount } = ext;

  if (!Number.isFinite(minStart) || maxEnd <= minStart) {
    return { traceStartMs: 0, totalMs: 0, zoomActive: false, contextStrip: null };
  }

  const traceTotal = maxEnd - minStart;
  const haveEnoughChildren = childCount >= 2 && Number.isFinite(childMinStart) && childMaxEnd > childMinStart;
  const rootCoversAll = root && (root.dur / traceTotal) >= DOMINANT_ROOT_THRESHOLD;
  const childRange = haveEnoughChildren ? (childMaxEnd - childMinStart) : 0;
  const childrenAreCramped = haveEnoughChildren && (childRange / traceTotal) < CRAMPED_CHILDREN_THRESHOLD;

  if (rootCoversAll && childrenAreCramped) {
    const contextLeftPct = ((childMinStart - minStart) / traceTotal) * 100;
    const contextWidthPct = (childRange / traceTotal) * 100;
    return {
      traceStartMs: childMinStart,
      totalMs: childRange,
      zoomActive: true,
      contextStrip: {
        rootDur: root.dur,
        fullTraceMs: traceTotal,
        focusLeftPct: Math.max(0, Math.min(100, contextLeftPct)),
        focusWidthPct: Math.max(1, Math.min(100 - contextLeftPct, contextWidthPct)),
      },
    };
  }

  return { traceStartMs: minStart, totalMs: traceTotal, zoomActive: false, contextStrip: null };
};

const TraceWaterfall = ({
  nodes,
  selectedUid,
  onSelectNode,
  expanded = false,
  onToggleExpanded,
  onTypeFilterClick,
  activeTypeFilter,
}) => {
  // Compute the timebase. When one root span dominates (≥95% of duration) and
  // its descendants cluster in <50% of the trace, re-base the bar track to
  // the children's actual range so they spread across the full width. The
  // root's full extent is shown as a thin "context strip" above the bars
  // so its absolute scope isn't lost.
  const timebase = useMemo(() => computeTimebase(nodes), [nodes]);

  // Per-type aggregate durations for the collapsed strip's segments. We sum
  // total ms per effective type and emit ordered segments by descending time
  // so the user sees the biggest contributors first.
  const typeBreakdown = useMemo(() => {
    const acc = {};
    let totalMs = 0;
    for (const n of nodes) {
      const dur = Math.max(0, Number(n.durationMs) || 0);
      if (dur <= 0) continue;
      const t = String(n.type || 'UNKNOWN').toUpperCase();
      if (!acc[t]) acc[t] = { totalMs: 0, count: 0 };
      acc[t].totalMs += dur;
      acc[t].count++;
      totalMs += dur;
    }
    const segments = Object.entries(acc)
      .map(([type, info]) => ({ type, ...info }))
      .sort((a, b) => b.totalMs - a.totalMs);
    return { segments, totalMs };
  }, [nodes]);

  const { traceStartMs, totalMs, zoomActive, contextStrip } = timebase;

  if (!nodes.length || totalMs <= 0) return null;

  // ── Header (used in both modes) ──────────────────────────────────────────
  const header = (
    <div className="tv-waterfall-header">
      <span className="tv-waterfall-title">TIMELINE</span>
      <span className="tv-waterfall-total">
        {zoomActive ? (
          <>
            <span className="tv-waterfall-zoom-tag">ZOOMED</span>
            {' '}
            {totalMs.toFixed(1)} ms shown · {contextStrip.fullTraceMs.toFixed(1)} ms total · {nodes.length} spans
          </>
        ) : (
          <>{totalMs.toFixed(1)} ms total · {nodes.length} spans</>
        )}
      </span>
      {onToggleExpanded && (
        <button
          type="button"
          className="tv-waterfall-toggle"
          onClick={onToggleExpanded}
          title={expanded ? 'Collapse timeline' : 'Expand timeline'}
        >
          {expanded ? '▴ collapse' : '▾ expand'}
        </button>
      )}
    </div>
  );

  // ── Collapsed mode: 40px proportional type-segment strip ─────────────────
  // Saves ~280px of vertical space vs the full waterfall while still showing
  // where time was spent. Click a segment → applies that type as a filter
  // (chip-equivalent). Hover → tooltip with type / total ms / span count.
  if (!expanded) {
    return (
      <div className="tv-waterfall-card tv-waterfall-collapsed">
        {header}
        <div className="tv-waterfall-strip" role="toolbar" aria-label="Type duration breakdown">
          {typeBreakdown.segments.map(({ type, totalMs: segMs, count }) => {
            const pct = (segMs / typeBreakdown.totalMs) * 100;
            const color = TYPE_COLORS[type] || '#6e7681';
            const isFiltered = activeTypeFilter?.has?.(type);
            return (
              <button
                type="button"
                key={type}
                className={`tv-waterfall-strip-seg ${isFiltered ? 'tv-waterfall-strip-seg-active' : ''}`}
                style={{ width: `${pct}%`, background: color }}
                onClick={() => onTypeFilterClick?.(type)}
                title={`${type} · ${segMs.toFixed(1)} ms · ${count} span${count === 1 ? '' : 's'} · ${pct.toFixed(1)}%`}
              >
                {/* Inline label only when the segment is wide enough to fit text */}
                {pct >= 8 && (
                  <span className="tv-waterfall-strip-seg-label">
                    {type} · {segMs.toFixed(0)}ms
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Expanded mode: full per-span bar list (today's behaviour) ────────────
  return (
    <div className="tv-waterfall-card">
      {header}

      {zoomActive && contextStrip && (
        <div className="tv-waterfall-context-strip" title="Full trace span (highlighted = zoomed window)">
          <div
            className="tv-waterfall-context-window"
            style={{
              left: `${contextStrip.focusLeftPct}%`,
              width: `${contextStrip.focusWidthPct}%`,
            }}
          />
        </div>
      )}

      <div className="tv-waterfall-rows">
        {nodes.map((n) => {
          const start = parseTimestampMs(n.timestamp);
          if (start == null) return null;
          const dur = Math.max(0, Number(n.durationMs) || 0);
          const offsetMs = start - traceStartMs;
          const leftPct = Math.max(0, Math.min(100, (offsetMs / totalMs) * 100));
          const rawWidthPct = (dur / totalMs) * 100;
          const widthPct = Math.max(0.6, Math.min(100 - leftPct, rawWidthPct));
          const t = String(n.type || '').toUpperCase();
          const isErr = isErrorStatus(n.status || n.severity);
          const color = isErr ? '#f85149' : (TYPE_COLORS[t] || '#6e7681');
          const selected = n.uid === selectedUid;
          const label = n.name || n.operation || '-';
          // Waterfall label column is fixed-width and narrow (~240px);
          // 36 chars sits just under what fits at the default font size,
          // and CSS ellipsis still applies as a safety net for any edge
          // case the smart-truncate doesn't shrink enough.
          const truncatedLabel = smartTruncate(label, detectTruncateKind(label, n.type), 36);
          const select = () => onSelectNode?.(n.uid);
          return (
            <div
              key={n.uid}
              data-wf-uid={n.uid}
              className={`tv-wf-row ${selected ? 'tv-wf-row-selected' : ''}`}
              role="treeitem"
              tabIndex={0}
              aria-level={(n.depth || 0) + 1}
              aria-selected={selected}
              onClick={select}
              onKeyDown={onActivateKey(select)}
              title={`${label} · ${dur.toFixed(2)} ms · +${offsetMs.toFixed(2)} ms`}
            >
              <div
                className="tv-wf-label"
                style={{ paddingLeft: `${(n.depth || 0) * 12 + 8}px` }}
              >
                <span className="tv-wf-dot" style={{ background: color }} />
                <span className="tv-wf-label-text">{truncatedLabel}</span>
              </div>
              <div className="tv-wf-track">
                <div
                  className="tv-wf-bar"
                  style={{
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    background: color,
                  }}
                >
                  <span className="tv-wf-bar-label">
                    {dur > 0 ? `${dur.toFixed(1)} ms` : '·'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

TraceWaterfall.propTypes = {
  nodes: PropTypes.arrayOf(PropTypes.object).isRequired,
  selectedUid: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onSelectNode: PropTypes.func,
  expanded: PropTypes.bool,
  onToggleExpanded: PropTypes.func,
  onTypeFilterClick: PropTypes.func,
  activeTypeFilter: PropTypes.shape({ has: PropTypes.func }),
};

export default React.memo(TraceWaterfall);
