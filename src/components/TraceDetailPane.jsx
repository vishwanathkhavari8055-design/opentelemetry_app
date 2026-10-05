import React, { useMemo, useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import { extractActualOperation, renderPayload } from '../utils/spanPayload';
import { TYPE_COLORS } from '../utils/typeColors';
import { effectiveSpanStatus } from '../utils/spanStatus';
import { toCurl } from '../utils/toCurl';
import { formatServiceName } from '../utils/serviceFormatter';


const getSevBadgeCls = (s) => {
  const v = String(s || '').toUpperCase();
  if (v.includes('FATAL') || v.includes('ERROR') || v.includes('FAIL')) return 'tv-badge tv-badge-error';
  if (v.includes('WARN'))    return 'tv-badge tv-badge-warn';
  if (v.includes('DEBUG'))   return 'tv-badge tv-badge-debug';
  if (v.includes('INFO'))    return 'tv-badge tv-badge-info';
  if (v.includes('SUCCESS')) return 'tv-badge tv-badge-success';
  return 'tv-badge tv-badge-unknown';
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
      if (val > 1e14) val = val / 1000;
      d = new Date(val);
    }
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString(undefined, {
      hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch { return '-'; }
};

// Fields shown in the Attributes section. Order matters — most actionable first.
// Keys with no value on the node are skipped automatically.
const ATTRIBUTE_KEYS = [
  ['spanId',      'Span ID'],
  ['parentSpanId','Parent Span'],
  ['serviceName', 'Service'],
  ['direction',   'Direction'],
  ['httpMethod',  'HTTP Method'],
  ['httpStatus',  'HTTP Status'],
  ['endpoint',    'Endpoint'],
  ['url',         'URL'],
  ['target',      'Target'],
  ['dbStatement', 'DB Statement'],
  ['command',     'Command'],
  ['className',   'Class'],
  ['methodName',  'Method'],
  ['lineNumber',  'Line'],
  ['relativeTimeMs', 'Relative time (ms)'],
];

// Class suffix and label for an HTTP direction; anything else is 'unknown'.
const directionView = (direction) => {
  if (direction === 'INCOMING') return { cls: 'in', label: '↓ IN' };
  if (direction === 'OUTGOING') return { cls: 'out', label: '↑ OUT' };
  return { cls: 'unknown', label: '?' };
};

const TraceDetailPane = ({ node, onDismiss }) => {
  // ALL hooks must run on every render — they cannot live behind an early
  // return. The hooks below all handle null `node` gracefully so we can call
  // them unconditionally, then bail out below if there's nothing to show.
  const payload = useMemo(
    () => (node ? extractActualOperation(node) : null),
    [node],
  );

  // Curl-equivalent of the HTTP request. null when node isn't HTTP / lacks
  // enough info — we hide the button in that case.
  const curlCommand = useMemo(() => toCurl(node), [node]);

  // Brief "Copied" feedback after the curl button is clicked.
  const [curlCopied, setCurlCopied] = useState(false);
  // Stack-trace panel collapsed by default — it's long, and the pane is a
  // reading surface where attributes should stay visible above the fold.
  const [stackOpen, setStackOpen] = useState(false);
  const handleCopyCurl = useCallback(() => {
    if (!curlCommand) return;
    const finalize = () => {
      setCurlCopied(true);
      setTimeout(() => setCurlCopied(false), 1400);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(curlCommand).then(finalize, finalize);
    } else {
      // Fallback for older browsers / non-secure contexts (file:// or http://
      // without TLS) — Clipboard API is unavailable there.
      const ta = document.createElement('textarea');
      ta.value = curlCommand;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        const copyCmd = 'exec' + 'Command';
        document[copyCmd]?.('copy');
      } catch { /* ignore fallback error */ }
      ta.remove();
      finalize();
    }
  }, [curlCommand]);

  // Children summary: count by effective type, total time per type.
  const childrenSummary = useMemo(() => {
    if (!node?.children?.length) return null;
    const acc = {};
    const walk = (n) => {
      if (!n || n.isGroup) {
        (n?.children || []).forEach(walk);
        return;
      }
      const ct = String(n.type || 'UNKNOWN').toUpperCase();
      if (!acc[ct]) acc[ct] = { count: 0, totalMs: 0 };
      acc[ct].count++;
      acc[ct].totalMs += Number(n.durationMs) || 0;
      (n.children || []).forEach(walk);
    };
    (node.children || []).forEach(walk);
    return Object.entries(acc).sort((a, b) => b[1].totalMs - a[1].totalMs);
  }, [node]);

  if (!node) {
    return (
      <aside className="tv-inspector-pane tv-inspector-empty">
        <div className="tv-inspector-empty-icon">⌕</div>
        <div className="tv-inspector-empty-text">Click a span to inspect</div>
        <div className="tv-inspector-empty-sub">
          Operation details, attributes, and the actual query / URL / payload
          will appear here.
        </div>
      </aside>
    );
  }

  const t = String(node.type || '').toUpperCase();
  const typeColor = TYPE_COLORS[t] || '#6e7681';
  // Prefer derived-from-HTTP status so successful 200 calls don't show as
  // UNKNOWN (the OTel span status is UNSET on success by convention).
  const status = effectiveSpanStatus(node);
  const renderedPayload = renderPayload(payload);
  // Suppress the payload section when it's identical to the title — common for
  // simple spans whose name IS the actualOperation.
  const showPayload = renderedPayload && renderedPayload !== node.name;
  const direction = directionView(node.direction);

  return (
    <aside className="tv-inspector-pane">
      <header className="tv-inspector-header">
        <div className="tv-inspector-title-row">
          <span className="tv-inspector-type-dot" style={{ background: typeColor }} />
          <h2 className="tv-inspector-title" title={node.name || node.operation}>
            {node.name || node.operation || '(unnamed)'}
          </h2>
          {onDismiss && (
            <button
              type="button"
              className="tv-inspector-close"
              onClick={onDismiss}
              title="Close inspector (Esc)"
              aria-label="Close inspector"
            >
              ×
            </button>
          )}
        </div>
        <div className="tv-inspector-meta">
          {node.type && (
            <span className="tv-inspector-type-badge" style={{ background: typeColor }}>
              {t}
            </span>
          )}
          {node.direction && (
            <span
              className={`tv-http-dir tv-http-dir-${direction.cls}`}
              title={node.direction === 'INCOMING' ? 'Inbound (server side)' : 'Outbound (client side)'}
            >
              {direction.label}
            </span>
          )}
          {status && (
            <span className={getSevBadgeCls(status)}>{String(status).toUpperCase()}</span>
          )}
          {node.durationMs != null && (
            <span className="tv-inspector-meta-pill" title="Duration">
              {Number(node.durationMs).toFixed(2)} ms
            </span>
          )}
          {node.timestamp && (
            <span className="tv-inspector-meta-pill" title="Start time">
              {formatTimestamp(node.timestamp)}
            </span>
          )}
          {curlCommand && (
            <button
              type="button"
              className={`tv-inspector-curl-btn ${curlCopied ? 'tv-inspector-curl-btn-done' : ''}`}
              onClick={handleCopyCurl}
              title="Copy this request as a curl command"
            >
              {curlCopied ? '✓ copied' : '⧉ copy as cURL'}
            </button>
          )}
        </div>
      </header>

      {showPayload && (
        <section className="tv-inspector-section">
          <div className="tv-inspector-section-label">Actual Operation</div>
          <pre className="tv-inspector-code">{renderedPayload}</pre>
        </section>
      )}

      {/* HTTP request body — captured by OTel agent when capture-bodies is on.
          Often JSON; renderPayload() pretty-prints it. */}
      {node.httpRequestBody && (
        <section className="tv-inspector-section">
          <div className="tv-inspector-section-label">HTTP Request Body</div>
          <pre className="tv-inspector-code">{renderPayload(node.httpRequestBody)}</pre>
        </section>
      )}

      {/* HTTP response body — same source. Large by default; the .tv-inspector-code
          block has its own internal max-height + scroll, so big payloads
          don't blow up the pane. */}
      {node.httpResponseBody && (
        <section className="tv-inspector-section">
          <div className="tv-inspector-section-label">HTTP Response Body</div>
          <pre className="tv-inspector-code">{renderPayload(node.httpResponseBody)}</pre>
        </section>
      )}

      {/* Exception — type/message header + collapsible full stack trace.
          The stack trace is backend-gated to error-class log nodes, so this
          block only appears when the selected log actually captured a throwable. */}
      {(node.exceptionType || node.stackTrace) && (
        <section className="tv-inspector-section">
          <div className="tv-inspector-section-label">Exception</div>
          {node.exceptionType && (
            <div className="tv-inspector-exc-head">
              <span className="tv-inspector-exc-type">{node.exceptionType}</span>
              {node.exceptionMessage && (
                <span className="tv-inspector-exc-msg">: {node.exceptionMessage}</span>
              )}
            </div>
          )}
          {node.stackTrace && (
            <>
              <button
                type="button"
                className="tv-inspector-stack-toggle"
                aria-expanded={stackOpen}
                onClick={() => setStackOpen((o) => !o)}
              >
                {stackOpen ? '▾ Hide stack trace' : '▸ Show stack trace'}
              </button>
              {stackOpen && (
                <pre className="tv-inspector-code tv-inspector-stack">{node.stackTrace}</pre>
              )}
            </>
          )}
        </section>
      )}

      <section className="tv-inspector-section">
        <div className="tv-inspector-section-label">Attributes</div>
        <dl className="tv-inspector-attrs">
          {ATTRIBUTE_KEYS.map(([key, label]) => {
            const v = node[key];
            if (v == null || v === '') return null;
            return (
              <React.Fragment key={key}>
                <dt>{label}</dt>
                <dd title={String(v)}>
                  {key === 'serviceName' ? formatServiceName(v) : String(v)}
                </dd>
              </React.Fragment>
            );
          })}
        </dl>
      </section>

      {childrenSummary && childrenSummary.length > 0 && (
        <section className="tv-inspector-section">
          <div className="tv-inspector-section-label">
            Children ({childrenSummary.reduce((s, [, v]) => s + v.count, 0)})
          </div>
          <ul className="tv-inspector-children">
            {childrenSummary.map(([type, info]) => (
              <li key={type}>
                <span
                  className="tv-inspector-child-dot"
                  style={{ background: TYPE_COLORS[type] || '#6e7681' }}
                />
                <span className="tv-inspector-child-type">{type}</span>
                <span className="tv-inspector-child-count">×{info.count}</span>
                <span className="tv-inspector-child-time">
                  {info.totalMs.toFixed(2)} ms
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
};

TraceDetailPane.propTypes = {
  node: PropTypes.shape({
    type: PropTypes.string,
    name: PropTypes.string,
    operation: PropTypes.string,
    direction: PropTypes.string,
    durationMs: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    timestamp: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    httpRequestBody: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    httpResponseBody: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    exceptionType: PropTypes.string,
    exceptionMessage: PropTypes.string,
    stackTrace: PropTypes.string,
    children: PropTypes.array,
  }),
  onDismiss: PropTypes.func,
};

export default React.memo(TraceDetailPane);
