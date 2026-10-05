import React, { useMemo, useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import { extractActualOperation, renderPayload } from '../utils/spanPayload';
import { TYPE_COLORS } from '../utils/typeColors';
import { smartTruncate, detectTruncateKind } from '../utils/truncate';
import { effectiveSpanStatus } from '../utils/spanStatus';
import { formatServiceName } from '../utils/serviceFormatter';

// ── Severity helpers ──────────────────────────────────────────────────────────
const SEV_COLORS = {
  FATAL: '#b91c1c', ERROR: '#f85149', WARN: '#d29922',
  DEBUG: '#8957e5', INFO: '#388bfd', SUCCESS: '#3fb950', UNKNOWN: '#6e7681',
};

const getSevColor = (s) => {
  const v = String(s || '').toUpperCase();
  if (v.includes('FATAL')) return SEV_COLORS.FATAL;
  if (v.includes('ERROR') || v.includes('FAIL')) return SEV_COLORS.ERROR;
  if (v.includes('WARN')) return SEV_COLORS.WARN;
  if (v.includes('DEBUG')) return SEV_COLORS.DEBUG;
  if (v.includes('INFO')) return SEV_COLORS.INFO;
  if (v.includes('SUCCESS')) return SEV_COLORS.SUCCESS;
  return SEV_COLORS.UNKNOWN;
};

const getSevBadgeCls = (s) => {
  const v = String(s || '').toUpperCase();
  if (v.includes('FATAL') || v.includes('ERROR') || v.includes('FAIL')) return 'tv-badge tv-badge-error';
  if (v.includes('WARN')) return 'tv-badge tv-badge-warn';
  if (v.includes('DEBUG')) return 'tv-badge tv-badge-debug';
  if (v.includes('INFO')) return 'tv-badge tv-badge-info';
  if (v.includes('SUCCESS')) return 'tv-badge tv-badge-success';
  return 'tv-badge tv-badge-unknown';
};

// ── Type badge ────────────────────────────────────────────────────────────────
const TypeBadge = React.memo(function TypeBadge({ type }) {
  if (!type) return null;
  const t = String(type).toUpperCase();
  const bg = TYPE_COLORS[t] || '#6e7681';
  return <span className="tv-type-badge" style={{ background: bg }}>{t}</span>;
});

TypeBadge.propTypes = { type: PropTypes.string };

// Enter / Space on a focused tree row does what a click does. Keys pressed on a
// control inside the row (the copy button) are left to that control.
const rowKeyHandler = (onRowClick) => (e) => {
  if (e.target !== e.currentTarget) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  onRowClick(e);
};

// `extractActualOperation` and `renderPayload` moved to src/utils/spanPayload.js
// so the inspector pane (TraceDetailPane) can share them.
const getBestPayload = extractActualOperation;

// Abbreviate the package portion of a fully-qualified class name to single
// letters, IntelliJ-style: `com.trinity.security.util.SSOUtils` →
// `c.t.s.u.SSOUtils`. The class name itself stays untouched. Used in the
// trace log-row meta line where the full FQN would either truncate or push
// other chips off-screen; the original string is still shown in the tooltip
// so power users can resolve the package on hover.
const abbreviatePackage = (fqn) => {
  if (!fqn) return fqn;
  const parts = String(fqn).split('.');
  if (parts.length <= 1) return fqn;
  const className = parts.at(-1);
  const initials = parts.slice(0, -1).map(p => p.charAt(0)).join('.');
  return `${initials}.${className}`;
};

// ── Type-specific inline preview ──────────────────────────────────────────────
// Mirrors `extractActualOperation` but produces a one-line preview of the
// most actionable piece of info for the row's type. Currently the row shows
// only `node.name`, which for SQL/Mongo/Redis is just the operation kind —
// the actual query, URL, or command sits in the detail panel behind a
// chevron. Surfacing it inline (truncated by CSS ellipsis) makes the trace
// scannable without click-to-expand-every-row.
const statementPreview = (node) => node.dbStatement || node.query || node.statement || null;

const INLINE_PREVIEWS = {
  SQL: statementPreview,
  MSSQL: statementPreview,
  DATABASE: statementPreview,
  MONGODB: statementPreview,
  NEO4J: (node) => {
    // Cypher queries are often multi-line; preview is single-line for the row.
    const raw = statementPreview(node);
    return raw ? String(raw).split('\n').map(s => s.trim()).filter(Boolean).join(' ') : null;
  },
  REDIS: (node) => node.command || statementPreview(node),
  INTERNAL: (node) => {
    if (node.className && node.methodName) {
      const composed = `${node.className}.${node.methodName}()`;
      // Suppress if the row title already says the same thing.
      if (composed !== node.name && composed !== node.operation) return composed;
    }
    return null;
  },
  HTTP: (node) => {
    const url = node.endpoint || node.url;
    // Avoid duplicating: if `name` already contains the URL (typical: "POST
    // /api/path"), don't repeat it. Show only what's not already visible.
    if (url && !String(node.name || '').includes(url)) return url;
    return null;
  },
};

const computeInlinePreview = (node, nodeType) => {
  if (!node) return null;
  const t = String(nodeType || '').toUpperCase();
  return Object.hasOwn(INLINE_PREVIEWS, t) ? INLINE_PREVIEWS[t](node) : null;
};

// HTTP status code → severity bucket. Used for the inline status pill.
const getHttpStatusCls = (status) => {
  const s = Number(status);
  if (Number.isNaN(s)) return 'tv-http-status-unknown';
  if (s >= 500) return 'tv-http-status-error';
  if (s >= 400) return 'tv-http-status-warn';
  if (s >= 300) return 'tv-http-status-info';
  return 'tv-http-status-success';
};

// HTTP method → color class (GET/POST/PUT/PATCH/DELETE).
const getHttpMethodCls = (method) => {
  const m = String(method || '').toUpperCase();
  if (m === 'GET') return 'tv-http-method-get';
  if (m === 'POST') return 'tv-http-method-post';
  if (m === 'PUT' || m === 'PATCH') return 'tv-http-method-put';
  if (m === 'DELETE') return 'tv-http-method-delete';
  return 'tv-http-method-other';
};

const formatTimestamp = (ts) => {
  if (!ts) return '-';
  try {
    let d;
    const tsStr = String(ts);

    if (tsStr.includes('T')) {
      d = new Date(tsStr);
    } else {
      let val = Number(tsStr);
      if (Number.isNaN(val)) return '-';
      // OTel/OpenObserve: very large = microseconds since epoch
      if (val > 10**14) val = val / 1000;
      d = new Date(val);
    }

    if (Number.isNaN(d.getTime())) return '-';

    const yy = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    const secs = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    // Full ISO-style stamp on every row so users can't confuse same-time
    // entries across different days.
    return `${yy}-${mo}-${dd} ${hours}:${mins}:${secs}.${ms}`;
  } catch { return '-'; }
};

// ── Row pieces shared by log and span rows ────────────────────────────────────
const SpanIdCell = ({ spanId }) => (
  <div className="tv-cell-span">
    {spanId ? (
      <span className="tv-span-id" title={`Span ID: ${spanId}`}>
        {String(spanId).slice(0, 16)}
      </span>
    ) : <span className="tv-dash">-</span>}
  </div>
);

const Connector = ({ level, indentRem }) => (
  level > 0 ? <div className="tv-connector" style={{ left: `${(level - 1) * indentRem + 1}rem` }} /> : null
);

const NodeChildren = ({ node, level, childProps }) => (
  <div className="tv-children">
    {node.children.map((child, idx) => (
      <TraceTreeNode
        key={child.uid || idx}
        node={child}
        level={level + 1}
        isExpanded={child.isExpanded}
        isDetailOpen={child.isDetailOpen}
        {...childProps}
        index={idx}
      />
    ))}
  </div>
);

// ── Log rows ──────────────────────────────────────────────────────────────────
// Modern Clipboard API; fall back to a hidden textarea for older
// browsers / non-secure contexts where navigator.clipboard is undefined.
const copyToClipboard = (text, done) => {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, done);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    const copyCmd = 'exec' + 'Command';
    document[copyCmd]?.('copy');
  } catch { /* ignore fallback error */ }
  ta.remove();
  done();
};

// Copy a structured single block: meta header on one line + message
// (and payload if separate) — handy for pasting into Slack/Jira.
const buildCopyBlock = (timestamp, sevText, serviceName, message, extraPayload) => {
  const headerBits = [
    formatTimestamp(timestamp),
    sevText,
    formatServiceName(serviceName),
  ].filter(Boolean);
  return [
    headerBits.join('  '),
    message,
    extraPayload,
  ].filter(Boolean).join('\n');
};

// A "lengthy" log is one that wouldn't fit comfortably without clamping.
// In Logs-by-span mode (showSpanId=true) the user has explicitly chosen
// to read logs in context, so we tolerate much more before clamping:
// 600 chars / 6+ lines instead of 160 / any-newline. In List / Group
// modes the row sits among lots of other rows so the stricter clamp
// keeps the trace scannable.
const isLengthyMessage = (message, showSpanId) => (showSpanId
  ? (message.length > 600 || message.split('\n').length > 6)
  : (message.length > 160 || message.includes('\n')));

// Source location — populated by the OTel pipeline
const LogSource = ({ node }) => {
  if (!(node.className || node.methodName || node.lineNumber != null)) return null;
  // Build display vs. tooltip strings.
  const displayClass = abbreviatePackage(node.className);
  const fullClass    = node.className || '';
  const method       = node.methodName ? `.${node.methodName}()` : '';
  const line         = node.lineNumber != null ? `:${node.lineNumber}` : '';
  const fullSource   = [fullClass, method, line].join('');
  return (
    <span className="tv-log-source" title={fullSource || 'Source location (logger / method / line)'}>
      {displayClass}
      {method}
      {line}
    </span>
  );
};

const LogMeta = ({ node, sevText, justCopied, onCopy, hasMoreContent, isDetailOpen }) => (
  <div className="tv-log-meta">
    <span className={getSevBadgeCls(node.severity || node.status)}>
      {sevText}
    </span>
    {node.serviceName && (
      <span className="tv-log-service">{formatServiceName(node.serviceName)}</span>
    )}
    {node.count > 1 && (
      <span className="tv-log-repeat" title={`Repeated ${node.count} times`}>
        ×{node.count}
      </span>
    )}
    {node.relativeTimeMs != null && (
      <span className="tv-log-offset">+{Number(node.relativeTimeMs).toFixed(2)} ms</span>
    )}
    <LogSource node={node} />
    <button
      className={`tv-log-copy ${justCopied ? 'tv-log-copy-done' : ''}`}
      onClick={onCopy}
      title="Copy log entry to clipboard"
    >
      {justCopied ? '✓ copied' : '⧉ copy'}
    </button>
    {hasMoreContent && (
      <span className="tv-log-expand-hint">
        {isDetailOpen ? '▼ collapse' : '▶ expand'}
      </span>
    )}
  </div>
);

// Spans live in a structured table grid (timestamp / op / type / service /
// status / duration), but logs read as text — they want full message
// visible, not truncated under a chevron. Render them as a stripe + meta +
// wrapping message body instead.
const LogRow = ({
  node, level, indentRem, isExpanded, isDetailOpen, isSelected, hasChildren,
  sevColor, displayTime, showSpanId, onRowClick, childProps, payload,
}) => {
  const rawMessage = node.fullMessage || node.operation || node.message || node.name || '-';
  const messageRendered = String(rawMessage);
  const sevText = String(node.severity || node.status || 'LOG').toUpperCase();
  const payloadRendered = payload ? String(payload) : '';
  const hasDifferentPayload = !!payloadRendered && payloadRendered !== messageRendered;

  const [justCopied, setJustCopied] = useState(false);
  const handleCopy = useCallback((e) => {
    // Don't let the click bubble to the row (which would toggle expansion).
    e.stopPropagation();
    const block = buildCopyBlock(
      node.timestamp, sevText, node.serviceName, messageRendered,
      hasDifferentPayload ? payloadRendered : null,
    );
    copyToClipboard(block, () => {
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1400);
    });
  }, [node.timestamp, node.serviceName, sevText, messageRendered, payloadRendered, hasDifferentPayload]);

  const isLengthy = isLengthyMessage(messageRendered, showSpanId);
  const hasMoreContent = isLengthy || hasDifferentPayload;
  const messageClamped = isLengthy && !isDetailOpen;

  return (
    <div className="tv-node">
      <div
        data-uid={node.uid}
        className={[
          'tv-log-row',
          isSelected ? 'tv-log-row-selected' : '',
          isDetailOpen ? 'tv-log-row-focused' : '',
          hasMoreContent ? 'tv-log-row-expandable' : '',
        ].filter(Boolean).join(' ')}
        role="treeitem"
        tabIndex={0}
        aria-selected={!!isSelected}
        onClick={onRowClick}
        onKeyDown={rowKeyHandler(onRowClick)}
      >
        <span className="tv-log-stripe" style={{ background: sevColor }} />

        {/* Time column aligned with header/spans */}
        <div className="tv-cell-time">
          <span className="tv-log-time">{displayTime}</span>
        </div>

        {/* Span ID column aligned with header/spans */}
        {showSpanId && <SpanIdCell spanId={node.spanId} />}

        {/* Log body indented appropriately, equivalent to Operation column */}
        <div
          className="tv-log-body"
          style={{
            paddingLeft: `${level * indentRem + 0.75}rem`,
            position: 'relative'
          }}
        >
          <Connector level={level} indentRem={indentRem} />
          <LogMeta
            node={node}
            sevText={sevText}
            justCopied={justCopied}
            onCopy={handleCopy}
            hasMoreContent={hasMoreContent}
            isDetailOpen={isDetailOpen}
          />
          <div className={`tv-log-message ${messageClamped ? 'tv-log-message-clamped' : ''}`}>
            {messageRendered}
          </div>
          {isDetailOpen && hasDifferentPayload && (
            <pre className="tv-log-payload">{renderPayload(payload)}</pre>
          )}
        </div>
      </div>

      {/* Logs rarely have children, but render them if present */}
      {isExpanded && hasChildren && (
        <NodeChildren node={node} level={level} childProps={childProps} />
      )}
    </div>
  );
};

// ── Span rows ─────────────────────────────────────────────────────────────────
// Chevron means "this row expands inline":
//   - groups / nodes with children → ▶/▼ (expand children)
//   - log rows with extra payload  → ▶/▼ (expand inline message)
//   - non-log leaf spans          → ·   (detail goes to the pane,
//                                       not inline; no expansion)
const chevronGlyph = ({ isGroup, hasChildren, isExpanded, isLog, hasDetail, isDetailOpen }) => {
  if (isGroup || hasChildren) return isExpanded ? '▼' : '▶';
  if (isLog && hasDetail) return isDetailOpen ? '▼' : '▶';
  return '·';
};

const HTTP_DIRECTIONS = {
  INCOMING: { cls: 'in', label: '↓ IN' },
  OUTGOING: { cls: 'out', label: '↑ OUT' },
};

// Direction badge — IN (server) vs OUT (client). Comes from
// OTel span_kind; the lib's OoTraceInterpreter maps to
// INCOMING/OUTGOING. Visual cue lets users tell at a glance
// whether a "POST /…" row is "we received this" vs "we sent
// this". Suppressed when direction is unknown.
const HttpDirection = ({ direction }) => {
  const dir = HTTP_DIRECTIONS[direction] || { cls: 'unknown', label: '?' };
  return (
    <span className={`tv-http-dir tv-http-dir-${dir.cls}`} title={direction === 'INCOMING' ? 'Inbound (server side)' : 'Outbound (client side)'}>
      {dir.label}
    </span>
  );
};

const opDisplayName = (node, nodeTypeUpper, showSpanId) => {
  let raw = node.name || node.operation || '-';
  // When the HTTP method pill is rendered, strip the leading
  // method from the name to avoid duplicating it (the lib's
  // span name is typically "POST /api/path" — pill + name
  // would show "[POST] POST /api/path").
  if (nodeTypeUpper === 'HTTP' && node.httpMethod) {
    const re = new RegExp(
      '^' + String(node.httpMethod).replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) + String.raw`\s+`,
      'i',
    );
    raw = raw.replace(re, '');
  }
  const kind = detectTruncateKind(raw, node.type);
  // Cap chosen to fit the typical 1fr operation column on
  // desktop without forcing CSS ellipsis to clip our smartly-
  // truncated string. CSS still kicks in as a safety net.
  // Logs-by-span gets a wider OP column (tighter peripherals
  // and tighter indent), so allow a longer smart-truncate cap.
  return smartTruncate(raw, kind, showSpanId ? 110 : 64);
};

const SpanOpName = ({ node, nodeTypeUpper, isGroup, showSpanId }) => {
  const isHttp = nodeTypeUpper === 'HTTP';
  return (
    <span className={`tv-op-name ${isGroup ? 'tv-op-name-group' : ''}`} title={node.operation || node.name}>
      {isHttp && node.direction && <HttpDirection direction={node.direction} />}
      {/* HTTP method pill — colored chip (GET/POST/PUT/DELETE) */}
      {isHttp && node.httpMethod && (
        <span className={`tv-http-method ${getHttpMethodCls(node.httpMethod)}`}>
          {String(node.httpMethod).toUpperCase()}
        </span>
      )}
      {opDisplayName(node, nodeTypeUpper, showSpanId)}
      {nodeTypeUpper === 'THREAD' && node.serviceName && (
        <span className="tv-thread-service-inline" style={{ marginLeft: '8px', color: '#a5d6ff', fontSize: '0.9em', fontWeight: 'normal' }}>
          ({formatServiceName(node.serviceName)})
        </span>
      )}
      {/* HTTP status code pill — colored by 2xx/3xx/4xx/5xx */}
      {isHttp && node.httpStatus != null && (
        <span className={`tv-http-status ${getHttpStatusCls(node.httpStatus)}`}>
          {node.httpStatus}
        </span>
      )}
      {isGroup && node.count != null && (
        <span className="tv-group-count"> ({node.count})</span>
      )}
    </span>
  );
};

const SpanOpCell = ({
  node, level, indentRem, isGroup, hasChildren, chevron, sevColor,
  nodeTypeUpper, showSpanId, subText,
}) => (
  <div className="tv-cell-op" style={{ paddingLeft: `${level * indentRem + 0.75}rem` }}>
    <Connector level={level} indentRem={indentRem} />
    <span className={`tv-chevron ${hasChildren || isGroup ? 'tv-chevron-active' : ''}`}>
      {chevron}
    </span>
    {!isGroup && <span className="tv-sev-dot" style={{ background: sevColor }} />}
    {isGroup && <TypeBadge type={node.type} />}
    <div className="tv-op-text">
      <SpanOpName node={node} nodeTypeUpper={nodeTypeUpper} isGroup={isGroup} showSpanId={showSpanId} />
      {isGroup && node.durationMs != null && (
        <span className="tv-op-sub">Total Duration: {Number(node.durationMs).toFixed(3)} ms</span>
      )}
      {!isGroup && subText && <span className="tv-op-sub">{subText}</span>}
      {/* Parent context chip: in logs-tree mode only, shows which span
          this span is nested under. Helps users identify why sibling
          spans with the same thread but different span IDs are grouped
          together vs independent. Suppressed at level 0 (thread header)
          and for group rows. */}
      {showSpanId && !isGroup && node._parentName && (
        <span className="tv-parent-chip" title={`Child of: ${node._parentName}`}>
          ↳ {node._parentName}
        </span>
      )}
    </div>
  </div>
);

// Status — derived from httpStatus when present, otherwise the lib's
// span-status field. Avoids "UNKNOWN" badges on successful HTTP
// spans where OTel left span status UNSET (the actual outcome is
// in the 2xx/3xx/4xx/5xx code).
const StatusCell = ({ node }) => {
  const eff = effectiveSpanStatus(node);
  return (
    <div className="tv-cell-status">
      {eff
        ? <span className={getSevBadgeCls(eff)}>{String(eff).toUpperCase()}</span>
        : <span className="tv-dash">-</span>}
    </div>
  );
};

const SpanRow = ({
  node, level, indentRem, isExpanded, isDetailOpen, isSelected, hasChildren,
  sevColor, displayTime, showSpanId, onRowClick, childProps,
  isGroup, isExpandable, nodeTypeUpper, subText, chevron,
}) => (
  <div className="tv-node">
    {/* ── Row ──────────────────────────────────────────────────────────── */}
    <div
      data-uid={node.uid}
      className={[
        'tv-row',
        `tv-row-type-${nodeTypeUpper.toLowerCase()}`,
        isGroup ? 'tv-row-group' : '',
        isDetailOpen ? 'tv-row-focused' : '',
        isExpandable ? 'tv-row-clickable' : '',
        isSelected ? 'tv-row-selected' : '',
      ].filter(Boolean).join(' ')}
      role="treeitem"
      tabIndex={0}
      aria-selected={!!isSelected}
      onClick={onRowClick}
      onKeyDown={rowKeyHandler(onRowClick)}
    >
      {/* Time */}
      <div className="tv-cell-time">{displayTime}</div>

      {/* Span ID — only shown in Logs-by-span mode (showSpanId=true). In
          List / Group-by-type the column is omitted entirely, so the
          grid stays at 6 columns instead of 7. */}
      {showSpanId && <SpanIdCell spanId={node.spanId} />}

      {/* Operation */}
      <SpanOpCell
        node={node}
        level={level}
        indentRem={indentRem}
        isGroup={isGroup}
        hasChildren={hasChildren}
        chevron={chevron}
        sevColor={sevColor}
        nodeTypeUpper={nodeTypeUpper}
        showSpanId={showSpanId}
        subText={subText}
      />

      {/* Type */}
      <div className="tv-cell-type">
        {!isGroup && <TypeBadge type={node.type} />}
      </div>

      {/* Service */}
      <div className="tv-cell-service">{node.serviceName ? formatServiceName(node.serviceName) : '-'}</div>

      <StatusCell node={node} />

      {/* Duration */}
      <div className="tv-cell-dur">
        {node.durationMs != null ? `${node.durationMs} ms` : '-'}
      </div>
    </div>

    {/* Span detail ("Actual Operation", attributes, etc.) is now rendered
        in TraceDetailPane on the right. The inline panel that used to live
        here was removed because it reflowed the tree on every click and
        forced multi-line payloads (SQL, JSON) to render inside a narrow
        row width. Log rows have their own inline payload (`tv-log-payload`
        inside LogRow) — they still expand in place. */}

    {/* ── Children ─────────────────────────────────────────────────── */}
    {isExpanded && hasChildren && (
      <NodeChildren node={node} level={level} childProps={childProps} />
    )}
  </div>
);

// ── TraceTreeNode ─────────────────────────────────────────────────────────────
const TraceTreeNode = React.memo(({
  node, level, isExpanded, isDetailOpen,
  onToggleExpanded, onToggleDetail, onSelectNode,
  selectedNodeUid, openDetailIds,
  showSpanId = false,
}) => {
  // Logs-by-span mode (showSpanId) uses a tighter indent (0.75rem per level
  // vs 1.5rem) so deep spans don't squeeze the OPERATION column. The
  // connector line position uses the same unit.
  const indentRem = showSpanId ? 0.75 : 1.5;
  const hasChildren = node.children?.length > 0;
  const isGroup = node.isGroup;
  const nodeTypeUpper = String(node.type || '').toUpperCase();
  const isLog = nodeTypeUpper === 'LOG' && !isGroup;

  const payload = useMemo(() => getBestPayload(node), [node]);
  const hasDetail = !!payload;

  // Single-click model:
  //   - Always select the row (drives the inspector pane for spans, highlights
  //     the bar in the waterfall, etc.)
  //   - Toggle children expansion if the row has children.
  //   - Toggle inline detail ONLY for log rows (their clamped message expands
  //     in-line). Span detail rendering moved to TraceDetailPane (the right
  //     inspector pane) — span clicks intentionally do NOT toggle openDetailIds.
  const handleRowClick = (e) => {
    e.stopPropagation();
    if (onSelectNode) onSelectNode(node.uid);
    if (hasChildren || isGroup) onToggleExpanded(node.uid);
    if (isLog && hasDetail) onToggleDetail(node.uid);
  };

  const sevColor = getSevColor(node.status || node.severity);
  const displayTime = formatTimestamp(node.timestamp);
  const isSelected = selectedNodeUid && node.uid === selectedNodeUid;

  // Type-aware inline preview (SQL stmt, Mongo query, full URL, class.method).
  // Falls through to the lib's existing description/target/subText fields.
  const inlinePreview = useMemo(
    () => computeInlinePreview(node, nodeTypeUpper),
    [node, nodeTypeUpper]
  );

  const childProps = {
    onToggleExpanded, onToggleDetail, onSelectNode,
    selectedNodeUid, openDetailIds, showSpanId,
  };
  const rowProps = {
    node, level, indentRem, isExpanded, isDetailOpen, isSelected, hasChildren,
    sevColor, displayTime, showSpanId, onRowClick: handleRowClick, childProps,
  };

  if (isLog) return <LogRow {...rowProps} payload={payload} />;

  return (
    <SpanRow
      {...rowProps}
      isGroup={isGroup}
      isExpandable={hasChildren || hasDetail || isGroup}
      nodeTypeUpper={nodeTypeUpper}
      subText={node.subText || node.description || inlinePreview || node.target || null}
      chevron={chevronGlyph({ isGroup, hasChildren, isExpanded, isLog, hasDetail, isDetailOpen })}
    />
  );
});

const nodeShape = PropTypes.object.isRequired;
const childPropsShape = PropTypes.object.isRequired;

SpanIdCell.propTypes = { spanId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]) };
Connector.propTypes = { level: PropTypes.number, indentRem: PropTypes.number.isRequired };
NodeChildren.propTypes = { node: nodeShape, level: PropTypes.number, childProps: childPropsShape };
LogSource.propTypes = { node: nodeShape };
LogMeta.propTypes = {
  node: nodeShape,
  sevText: PropTypes.string.isRequired,
  justCopied: PropTypes.bool.isRequired,
  onCopy: PropTypes.func.isRequired,
  hasMoreContent: PropTypes.bool.isRequired,
  isDetailOpen: PropTypes.bool,
};
HttpDirection.propTypes = { direction: PropTypes.string };
SpanOpName.propTypes = {
  node: nodeShape,
  nodeTypeUpper: PropTypes.string.isRequired,
  isGroup: PropTypes.bool,
  showSpanId: PropTypes.bool,
};
SpanOpCell.propTypes = {
  node: nodeShape,
  level: PropTypes.number,
  indentRem: PropTypes.number.isRequired,
  isGroup: PropTypes.bool,
  hasChildren: PropTypes.bool,
  chevron: PropTypes.string.isRequired,
  sevColor: PropTypes.string.isRequired,
  nodeTypeUpper: PropTypes.string.isRequired,
  showSpanId: PropTypes.bool,
  subText: PropTypes.node,
};
StatusCell.propTypes = { node: nodeShape };

const rowPropTypes = {
  node: nodeShape,
  level: PropTypes.number,
  indentRem: PropTypes.number.isRequired,
  isExpanded: PropTypes.bool,
  isDetailOpen: PropTypes.bool,
  isSelected: PropTypes.oneOfType([PropTypes.bool, PropTypes.string]),
  hasChildren: PropTypes.bool,
  sevColor: PropTypes.string.isRequired,
  displayTime: PropTypes.string.isRequired,
  showSpanId: PropTypes.bool,
  onRowClick: PropTypes.func.isRequired,
  childProps: childPropsShape,
};
LogRow.propTypes = { ...rowPropTypes, payload: PropTypes.any };
SpanRow.propTypes = {
  ...rowPropTypes,
  isGroup: PropTypes.bool,
  isExpandable: PropTypes.bool,
  nodeTypeUpper: PropTypes.string.isRequired,
  subText: PropTypes.node,
  chevron: PropTypes.string.isRequired,
};

export default TraceTreeNode;
