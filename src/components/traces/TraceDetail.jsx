import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchSpans } from '../../services/api';
import { formatDurationUs, formatExact } from '../../utils/format';
import { formatIsoDateTime } from '../../utils/dateUtils';
import { colorForService } from './ServiceIcon';
import {
  buildTraceTree, spanGeometry, serviceGraph, spanKindLetter, spanKindName, parseJsonArray,
  formatSpanClock, formatSpanTimestamp,
} from './traceTree';

/**
 * Full trace view: Waterfall, Flame Graph and Trace Graph over one trace,
 * with a per-span detail panel.
 *
 * Data comes from GET /api/traces/spans?traceId=… in ONE call. That endpoint
 * already returns each span's whole source document (it selects *), which is
 * what makes the Attributes tab possible without a second request or a new
 * endpoint — the assembled-tree endpoint (/api/traces) returns a projection
 * and would have lost the attributes.
 *
 * Timing note: the stream stores start_time/end_time in NANOSECONDS while
 * `duration` is MICROSECONDS. All geometry lives in traceTree.js and works in
 * ns, converting only at the edges. Getting that wrong scales the whole
 * waterfall by 1000 in a way that still looks plausible.
 */

const TABS = [
  { key: 'waterfall', label: 'Waterfall' },
  { key: 'flame', label: 'Flame Graph' },
  { key: 'graph', label: 'Trace Graph' },
];

const SPAN_TABS = ['Attributes', 'Events', 'Exceptions', 'Links'];

/** Five evenly spaced ticks across the trace, as in the reference. */
const axisTicks = (totalUs) => [0, 0.25, 0.5, 0.75, 1]
  .map((f) => ({ f, label: formatDurationUs(totalUs * f) }));

const scalarText = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
};

const valueClass = (v) => {
  if (v === null || v === undefined) return 'oo-json-null';
  if (typeof v === 'number') return 'oo-json-num';
  if (typeof v === 'boolean') return 'oo-json-bool';
  return 'oo-json-str';
};

function CopyBtn({ text, label }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`td-copy ${done ? 'is-copied' : ''}`}
      title={label || 'Copy'}
      aria-label={label || 'Copy'}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(String(text ?? '')).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        }).catch(() => { /* clipboard blocked on an insecure origin */ });
      }}
    >{done ? '✓' : '⧉'}</button>
  );
}
CopyBtn.propTypes = { text: PropTypes.string, label: PropTypes.string };

/** Key/value body shared by the four span tabs, in JSON or Table form. */
function KeyValueBody({ record, mode, emptyLabel }) {
  const entries = useMemo(
    () => Object.entries(record || {})
      .filter(([, v]) => v === null || typeof v !== 'object')
      .sort(([a], [b]) => a.localeCompare(b)),
    [record],
  );

  if (!entries.length) return <div className="td-empty">{emptyLabel}</div>;

  if (mode === 'table') {
    return (
      <div className="td-kv-table">
        {entries.map(([k, v]) => (
          <div className="td-kv-row" key={k}>
            <span className="td-kv-key">{k}</span>
            <span className="td-kv-val">{scalarText(v)}</span>
            <CopyBtn text={scalarText(v)} label={`Copy ${k}`} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="td-json">
      <span className="oo-json-punct">{'{'}</span>
      {entries.map(([k, v], i) => (
        <div className="td-json-line" key={k}>
          <span className="td-json-caret" aria-hidden="true">▾</span>
          <span className="oo-json-key">{k}</span>
          <span className="oo-json-punct">:&nbsp;</span>
          <span className={`td-json-val ${valueClass(v)}`}>{scalarText(v)}</span>
          {i < entries.length - 1 && <span className="oo-json-punct">,</span>}
        </div>
      ))}
      <span className="oo-json-punct">{'}'}</span>
    </div>
  );
}
KeyValueBody.propTypes = {
  record: PropTypes.object,
  mode: PropTypes.oneOf(['json', 'table']),
  emptyLabel: PropTypes.string,
};

/** The right-hand panel once a span is selected. */
function SpanPanel({ node, traceStartNs, onClose, onViewLogs }) {
  const [tab, setTab] = useState('Attributes');
  const [mode, setMode] = useState('json');

  const events = useMemo(() => parseJsonArray(node.raw.events), [node.raw.events]);
  const links = useMemo(() => parseJsonArray(node.raw.links), [node.raw.links]);
  // Exceptions are OTel events named "exception" — not a separate field.
  const exceptions = useMemo(
    () => events.filter((e) => String(e?.name || '').toLowerCase().includes('exception')),
    [events],
  );

  const startUs = (node.startNs - traceStartNs) / 1000;

  return (
    <div className="td-span">
      <div className="td-span-head">
        <span className="td-span-title" title={node.name}>{node.name}</span>
        <button type="button" className="td-span-x" onClick={onClose} aria-label="Close span">✕</button>
      </div>

      <div className="td-chips">
        <span className="td-chip">
          <span className="td-chip-k">Service</span>
          <span className="td-chip-v" style={{ color: colorForService(node.service) }}>
            {node.service}
          </span>
        </span>
        <span className="td-chip">
          <span className="td-chip-k">Duration</span>
          <span className="td-chip-v">{formatDurationUs(node.durationUs)}</span>
        </span>
        <span className="td-chip">
          <span className="td-chip-k">Start</span>
          <span className="td-chip-v">{formatDurationUs(startUs)}</span>
        </span>
        <span className="td-chip">
          <span className="td-chip-k">Kind</span>
          <span className="td-chip-v">{spanKindName(node.raw.span_kind)}</span>
        </span>
        <span className="td-chip" title="When the request started (span start_time)">
          <span className="td-chip-k">Request</span>
          <span className="td-chip-v">{formatSpanTimestamp(node.startNs)}</span>
        </span>
        <span className="td-chip" title="When the response completed (span end_time)">
          <span className="td-chip-k">Response</span>
          <span className="td-chip-v">{formatSpanTimestamp(node.endNs)}</span>
        </span>

        <span className="td-span-id">
          <span aria-hidden="true">#</span> {node.id}
          <CopyBtn text={node.id} label="Copy span id" />
        </span>
        {onViewLogs && (
          <button
            type="button"
            className="td-viewlogs"
            onClick={() => onViewLogs(node.raw.trace_id || node.span?.traceId)}
            title="Open the Logs screen filtered to this trace"
          >View Logs</button>
        )}
      </div>

      <div className="td-span-tabs" role="tablist">
        {SPAN_TABS.map((t) => {
          let n = null;
          if (t === 'Events') n = events.length;
          else if (t === 'Exceptions') n = exceptions.length;
          else if (t === 'Links') n = links.length;
          return (
            <button
              type="button"
              role="tab"
              key={t}
              aria-selected={tab === t}
              className={`td-span-tab ${tab === t ? 'is-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t}{n != null && n > 0 && <span className="td-tab-n">{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="td-mode">
        <button
          type="button"
          className={`td-mode-btn ${mode === 'json' ? 'is-active' : ''}`}
          onClick={() => setMode('json')}
        >JSON</button>
        <button
          type="button"
          className={`td-mode-btn ${mode === 'table' ? 'is-active' : ''}`}
          onClick={() => setMode('table')}
        >Table</button>
        <span className="td-mode-spacer" />
        <CopyBtn text={JSON.stringify(node.raw, null, 2)} label="Copy the whole span" />
      </div>

      <div className="td-span-body">
        {tab === 'Attributes' && (
          <KeyValueBody record={node.raw} mode={mode} emptyLabel="No attributes." />
        )}
        {tab === 'Events' && (events.length
          ? events.map((e, i) => (
            <div className="td-sub" key={JSON.stringify(e)}>
              <div className="td-sub-head">{e?.name || `event ${i + 1}`}</div>
              <KeyValueBody record={e} mode={mode} emptyLabel="No fields." />
            </div>
          ))
          : <div className="td-empty">No events on this span.</div>)}
        {tab === 'Exceptions' && (exceptions.length
          ? exceptions.map((e) => (
            <div className="td-sub" key={JSON.stringify(e)}>
              <div className="td-sub-head td-sub-head--error">{e?.name || 'exception'}</div>
              <KeyValueBody record={e} mode={mode} emptyLabel="No fields." />
            </div>
          ))
          : <div className="td-empty">No exceptions on this span.</div>)}
        {tab === 'Links' && (links.length
          ? links.map((l, i) => (
            <div className="td-sub" key={JSON.stringify(l)}>
              <div className="td-sub-head">link {i + 1}</div>
              <KeyValueBody record={l} mode={mode} emptyLabel="No fields." />
            </div>
          ))
          : <div className="td-empty">No links on this span.</div>)}
      </div>
    </div>
  );
}
SpanPanel.propTypes = {
  node: PropTypes.object.isRequired,
  traceStartNs: PropTypes.number.isRequired,
  onClose: PropTypes.func.isRequired,
  onViewLogs: PropTypes.func,
};

export default function TraceDetail({ traceId, onBack, onViewLogs }) {
  const [spans, setSpans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('waterfall');
  const [selectedId, setSelectedId] = useState(null);
  const [search, setSearch] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const rowRefs = useRef({});

  useEffect(() => {
    if (!traceId) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');

    // No time filter: a trace is identified by its id, and constraining to a
    // window would silently drop spans that started just outside it.
    fetchSpans({ traceId, size: 1000, signal: controller.signal })
      .then((res) => {
        if (cancelled) return;
        setSpans(res?.items || []);
        if (res?.supported === false) setError('Traces require the OpenObserve backend.');
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Failed to load the trace.');
        setLoading(false);
      });

    return () => { cancelled = true; controller.abort(); };
  }, [traceId]);

  const tree = useMemo(() => buildTraceTree(spans), [spans]);
  const { nodes, startNs, endNs, totalUs, maxDepth, errorCount } = tree;
  const root = nodes[0];

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return nodes.filter((n) => n.name.toLowerCase().includes(q)
      || n.service.toLowerCase().includes(q)
      || n.id.toLowerCase().includes(q)).map((n) => n.id);
  }, [nodes, search]);

  useEffect(() => { setMatchIndex(0); }, [search]);

  const gotoMatch = useCallback((delta) => {
    if (!matches.length) return;
    const next = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    setSelectedId(matches[next]);
    rowRefs.current[matches[next]]?.scrollIntoView({ block: 'center' });
  }, [matches, matchIndex]);

  const selected = nodes.find((n) => n.id === selectedId) || null;
  const ticks = axisTicks(totalUs);
  const graph = useMemo(() => serviceGraph(nodes), [nodes]);

  if (loading) {
    return <div className="td-loading">Loading trace…</div>;
  }
  if (error || !nodes.length) {
    return (
      <div className="td-loading">
        <p>{error || 'No spans found for this trace.'}</p>
        <button type="button" className="td-nav-back" onClick={onBack}>← Back</button>
      </div>
    );
  }

  return (
    <div className="td">
      <header className="td-head">
        <button type="button" className="td-back" onClick={onBack} aria-label="Back" title="Back">←</button>
        <h1 className="td-title" title={root.name}>{root.name}</h1>
        <span className="td-when" title={root.raw.start_time}>
          {formatIsoDateTime(new Date(startNs / 1e6).toISOString())}
        </span>
        <span className="td-tid">
          Trace ID: <code>{traceId}</code>
          <CopyBtn text={traceId} label="Copy trace id" />
        </span>
        <span className="td-pill">{nodes.length} span{nodes.length === 1 ? '' : 's'}</span>
        <span className={`td-pill ${errorCount ? 'td-pill--error' : 'td-pill--ok'}`}>
          {errorCount} error{errorCount === 1 ? '' : 's'}
        </span>
        <span className="td-head-spacer" />
        <button type="button" className="td-close" onClick={onBack} aria-label="Close">✕</button>
      </header>

      <div className="td-tabs">
        <div className="td-tabstrip" role="tablist">
          {TABS.map((t) => (
            <button
              type="button"
              role="tab"
              key={t.key}
              aria-selected={tab === t.key}
              className={`td-tab ${tab === t.key ? 'is-active' : ''}`}
              onClick={() => setTab(t.key)}
            >{t.label}</button>
          ))}
        </div>

        {tab === 'waterfall' && (
          <div className="td-find">
            <input
              type="text"
              value={search}
              placeholder="Search in spans"
              aria-label="Search in spans"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') gotoMatch(e.shiftKey ? -1 : 1); }}
            />
            <span className="td-find-n">
              {matches.length ? `${matchIndex + 1} / ${matches.length}` : '0 / 0'}
            </span>
            <button type="button" onClick={() => gotoMatch(-1)} disabled={!matches.length}
              aria-label="Previous match">˄</button>
            <button type="button" onClick={() => gotoMatch(1)} disabled={!matches.length}
              aria-label="Next match">˅</button>
          </div>
        )}

        {onViewLogs && (
          <button
            type="button"
            className="td-viewlogs td-viewlogs--head"
            onClick={() => onViewLogs(traceId)}
            title="Open the Logs screen filtered to this trace"
          >View Logs</button>
        )}
      </div>

      {tab === 'waterfall' && (
        <div className="td-wf">
          <div className="td-wf-main">
            <div className="td-wf-header">
              <span className="td-wf-oplabel">Operation Name</span>
              <span className="td-wf-timelabel" title="When the request started (span start_time)">
                Request
              </span>
              <span className="td-wf-timelabel" title="When the response completed (span end_time)">
                Response
              </span>
              <div className="td-axis">
                {ticks.map((t) => (
                  <span className="td-axis-tick" key={t.f} style={{ left: `${t.f * 100}%` }}>
                    {t.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="td-wf-rows">
              {nodes.map((n) => {
                const g = spanGeometry(n, startNs, endNs);
                const isMatch = matches.includes(n.id);
                return (
                  <button
                    type="button"
                    className={`td-row ${selectedId === n.id ? 'is-selected' : ''} ${
                      isMatch ? 'is-match' : ''} ${n.status === 'ERROR' ? 'is-error' : ''}`}
                    key={n.id}
                    ref={(el) => { rowRefs.current[n.id] = el; }}
                    onClick={() => setSelectedId(selectedId === n.id ? null : n.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(selectedId === n.id ? null : n.id);
                      }
                    }}
                  >
                    <div className="td-row-op" style={{ paddingLeft: `${n.depth * 16 + 8}px` }}>
                      {n.children.length > 0 && (
                        <span className="td-row-kids" title={`${n.children.length} child spans`}>
                          {n.children.length}
                        </span>
                      )}
                      <span className="td-row-dot" style={{ background: colorForService(n.service) }} />
                      <span className="td-row-svc" title={n.service}>{n.service}</span>
                      <span className={`td-kind td-kind--${n.kind.toLowerCase()}`}
                        title={`${n.kind} span`}>{spanKindLetter(n.raw.span_kind)}</span>
                      <span className="td-row-name" title={n.name}>{n.name}</span>
                      {n.httpStatus != null && (
                        <span className={`td-http ${Number(n.httpStatus) >= 400 ? 'is-bad' : ''}`}>
                          {n.httpStatus}
                        </span>
                      )}
                    </div>

                    <span className="td-row-time" title={`Request: ${formatSpanTimestamp(n.startNs)}`}>
                      {formatSpanClock(n.startNs)}
                    </span>
                    <span className="td-row-time" title={`Response: ${formatSpanTimestamp(n.endNs)}`}>
                      {formatSpanClock(n.endNs)}
                    </span>

                    <div className="td-row-track">
                      <span
                        className="td-bar"
                        style={{
                          left: `${g.left}%`,
                          width: `${g.width}%`,
                          background: colorForService(n.service),
                        }}
                      />
                      {/* Label outside the bar when the bar is too narrow to
                          hold it, which is most spans on a long trace. */}
                      <span
                        className="td-bar-label"
                        style={{ left: `${Math.min(92, g.left + g.width + 0.4)}%` }}
                      >{formatDurationUs(n.durationUs)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {selected && (
            <SpanPanel
              node={selected}
              traceStartNs={startNs}
              onClose={() => setSelectedId(null)}
              onViewLogs={onViewLogs}
            />
          )}
        </div>
      )}

      {tab === 'flame' && (
        <div className="td-flame">
          <div className="td-flame-meta">
            <strong>{nodes.length} spans</strong>
            <span>•</span>
            <strong>{maxDepth + 1} depth</strong>
          </div>
          <div className="td-axis td-axis--flame">
            {ticks.map((t) => (
              <span className="td-axis-tick" key={t.f} style={{ left: `${t.f * 100}%` }}>{t.label}</span>
            ))}
          </div>
          <div className="td-flame-rows">
            {Array.from({ length: maxDepth + 1 }, (_, depth) => (
              <div className="td-flame-row" key={depth}>
                {nodes.filter((n) => n.depth === depth).map((n) => {
                  const g = spanGeometry(n, startNs, endNs);
                  return (
                    <button
                      type="button"
                      className={`td-flame-bar ${selectedId === n.id ? 'is-selected' : ''}`}
                      key={n.id}
                      style={{
                        left: `${g.left}%`,
                        width: `${g.width}%`,
                        background: colorForService(n.service),
                      }}
                      title={`${n.service} · ${n.name} — ${formatDurationUs(n.durationUs)}`}
                      onClick={() => { setSelectedId(n.id); setTab('waterfall'); }}
                    >
                      <span className="td-flame-label">{n.name}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'graph' && (
        <div className="td-graph">
          <div className="td-graph-services">
            {graph.services
              .toSorted((a, b) => b.totalUs - a.totalUs)
              .map((s) => (
                <div className="td-node" key={s.name} style={{ borderColor: colorForService(s.name) }}>
                  <span className="td-node-name" style={{ color: colorForService(s.name) }}>
                    {s.name}
                  </span>
                  <span className="td-node-meta">
                    {s.spans} span{s.spans === 1 ? '' : 's'} · {formatDurationUs(s.totalUs)}
                    {s.errors > 0 && <span className="td-node-err"> · {s.errors} error</span>}
                  </span>
                </div>
              ))}
          </div>

          <div className="td-graph-edges">
            <h3>Calls between services</h3>
            {graph.edges.length === 0 ? (
              <p className="td-empty">
                Every span in this trace belongs to one service — there are no
                cross-service calls to draw.
              </p>
            ) : graph.edges
              .toSorted((a, b) => b.calls - a.calls)
              .map((e) => (
                <div className="td-edge" key={`${e.from}->${e.to}`}>
                  <span style={{ color: colorForService(e.from) }}>{e.from}</span>
                  <span className="td-edge-arrow">→</span>
                  <span style={{ color: colorForService(e.to) }}>{e.to}</span>
                  <span className="td-edge-n">{formatExact(e.calls)} call{e.calls === 1 ? '' : 's'}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

TraceDetail.propTypes = {
  traceId: PropTypes.string.isRequired,
  onBack: PropTypes.func.isRequired,
  /** Optional — renders the "View Logs" buttons when provided. */
  onViewLogs: PropTypes.func,
};
