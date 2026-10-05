import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { fetchTrace } from '../services/api';
import { parseTimestampMs } from '../utils/parseTimestamp';
import { getTypeColor } from '../utils/typeColors';
import TraceTreeNode from './TraceTreeNode';
import TraceWaterfall from './TraceWaterfall';
import TraceDetailPane from './TraceDetailPane';

// ── Helpers ───────────────────────────────────────────────────────────────────
const isErrorStatus = (s) => {
  const v = String(s || '').toUpperCase();
  return v.includes('ERROR') || v.includes('FAIL') || v.includes('FATAL');
};

// Issue #7: span-level severity filter for the trace view.
// Mirrors the OTel ordering (TRACE < DEBUG < INFO < WARN < ERROR < FATAL).
// Non-LOG spans don't carry a severity, so we fall back to their status
// (HTTP/SQL outcome) — ERROR/FAIL/FATAL → ERROR rank, WARN/SLOW → WARN rank,
// SUCCESS/INFO/UNKNOWN → INFO rank. This way picking "≥ WARN" hides the
// noise of successful spans without requiring per-status custom logic.
const SEVERITY_LEVELS = ['ALL', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const SEVERITY_RANK = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4, FATAL: 5 };

const inferSpanRank = (node) => {
  const sev = String(node?.severity || '').toUpperCase();
  if (sev && SEVERITY_RANK[sev] != null) return SEVERITY_RANK[sev];
  const status = String(node?.status || '').toUpperCase();
  if (status.includes('FATAL')) return SEVERITY_RANK.FATAL;
  if (status.includes('ERROR') || status.includes('FAIL')) return SEVERITY_RANK.ERROR;
  if (status.includes('WARN') || status.includes('SLOW')) return SEVERITY_RANK.WARN;
  if (status.includes('DEBUG')) return SEVERITY_RANK.DEBUG;
  if (status.includes('TRACE')) return SEVERITY_RANK.TRACE;
  return SEVERITY_RANK.INFO;
};

const matchesLevelFilter = (node, level) => {
  if (!level || level === 'ALL') return true;
  const min = SEVERITY_RANK[level];
  if (min == null) return true;
  return inferSpanRank(node) >= min;
};

// Find the uid path from root to a target. Closure-free — kept at module
// scope so the two useEffects that call it don't need it in their deps
// arrays (it never changes identity across renders).
const findUidPath = (node, target, acc) => {
  if (!node) return null;
  const next = [...acc, node.uid];
  if (node.uid === target) return next;
  for (const c of (node.children || [])) {
    const r = findUidPath(c, target, next);
    if (r) return r;
  }
  return null;
};

// TYPE_COLORS / getTypeColor moved to src/utils/typeColors.js (imported above).

const matchesSearch = (node, term) => {
  if (!term) return true;
  const t = term.toLowerCase();
  const fields = [
    node.name, node.operation, node.actualOperation, node.serviceName,
    node.dbStatement, node.endpoint, node.url, node.target, node.message,
    node.command, node.methodName, node.className, node.spanId, node.fullMessage,
    node.statement, node.query,
  ];
  return fields.some((v) => v && String(v).toLowerCase().includes(t));
};

// The lib (TraceTreeBuilder.java) populates start time as either `timestamp`
// or `startTime`; on logs sometimes only `time`. Earlier this helper read just
// `timestamp`, which silently broke chronological sort for spans coming via
// `startTime` — they sank to the bottom and the waterfall looked jumbled.
const getStartMs = (node) => {
  if (!node) return null;
  return parseTimestampMs(node.timestamp)
    ?? parseTimestampMs(node.startTime)
    ?? parseTimestampMs(node.time);
};

const compareByStart = (a, b) => {
  const ta = getStartMs(a);
  const tb = getStartMs(b);
  if (ta == null && tb == null) return 0;
  if (ta == null) return 1;
  if (tb == null) return -1;
  return ta - tb;
};

// The Java lib's TraceTreeBuilder injects virtual category wrappers — nodes
// named "SQL Queries", "MongoDB Queries", "Internal Processing", "External
// API Calls", etc. (TraceTreeBuilder.java:142,164,185). They have no spanId
// (because they don't represent any actual span) and carry a `count` field.
// In List mode the user wants a real flat list, so we unwrap these.
const isVirtualLibGroup = (node) => {
  if (!node) return false;
  const hasSpanId = node.spanId != null && String(node.spanId).length > 0;
  return !hasSpanId && node.count != null;
};

// Recursively replace virtual-group children with their own children, but stop
// at real spans (whose own children are processed normally during recursion).
const flattenVirtualGroups = (nodes) => {
  const out = [];
  for (const c of nodes) {
    if (isVirtualLibGroup(c) && c.children?.length > 0) {
      out.push(...flattenVirtualGroups(c.children));
    } else {
      out.push(c);
    }
  }
  return out;
};

// Collect all node UIDs that are expandable (have children or are group wrappers)
const collectAllExpandableUids = (node) => {
  if (!node) return [];
  const uids = [];
  const hasChildren = node.children?.length > 0;
  const isGroup = node.isGroup;
  if (hasChildren || isGroup) {
    uids.push(node.uid);
  }
  if (node.children) {
    node.children.forEach((child) => {
      uids.push(...collectAllExpandableUids(child));
    });
  }
  return uids;
};


// ── Name-based DB classifiers ────────────────────────────────────────────────
// The lib sometimes types DB-related spans as INTERNAL (when the OTel agent
// doesn't emit db.system, normalizeType falls back). Without these heuristics,
// "SELECT device.indexGatewayStatus" and "find iotops_cim.Resource" both end
// up under "Internal Processing" — even though by name they're clearly SQL
// and Mongo respectively.
//
// SQL: leading uppercase keyword (case-sensitive — lowercase versions are
//      Mongo idioms, see below).
// Mongo: leading lowercase verb followed by an argument (collection name).
//        Both `insert`/`update`/etc. and the camelCase variants
//        (`insertOne`, `findOneAndUpdate`) match.
// HTTP: leading uppercase HTTP verb, EITHER alone (e.g. just "POST" — common
//        when the OTel agent couldn't extract url.full from a manual client
//        call) OR followed by a URL-like path (`/`, `http://`, scheme://`).
//        The path requirement disambiguates from SQL "DELETE FROM users".
const SQL_NAME_RE = /^(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|EXEC|CALL|WITH|GRANT|REVOKE)\b/;
// Mongo: the leading word, ended by whitespace, `.`, `:` or the end of the name.
const MONGO_VERB_PREFIX_RE = /^(?:find|insert|update|delete|replace|count|drop)\w*$/;
const MONGO_VERBS = new Set(['aggregate', 'distinct', 'listCollections', 'listDatabases', 'bulkWrite', 'createIndex']);
const looksLikeMongoName = (name) => {
  const m = /^(\w+)(?:[\s.:]|$)/.exec(name);
  return !!m && (MONGO_VERBS.has(m[1]) || MONGO_VERB_PREFIX_RE.test(m[1]));
};
// HTTP: the verb, then nothing but whitespace or a URL-like path.
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);
const HTTP_AFTER_VERB_RE = /^(?:\s*$|\s+(?:\/|https?:|[a-z][a-z0-9+\-.]*:\/\/))/;
const looksLikeHttpName = (name) => {
  const match = /^(\S+)/.exec(name);
  if (!match) return false;
  const verb = match[1];
  const rest = name.slice(verb.length);
  return HTTP_VERBS.has(verb) && HTTP_AFTER_VERB_RE.test(rest);
};
// Neo4j: db.system="neo4j" OR Cypher leading keyword in stmt/name. CREATE/MERGE
// also exist in SQL, so the Cypher regex requires they're followed by a node
// pattern `(` or `MATCH`/`RETURN`/`UNWIND`/`WITH` (Cypher-specific in context).
const NEO4J_NAME_RE = /^(MATCH|RETURN|UNWIND|DETACH|FOREACH|LOAD\s+CSV)\b/;
const CYPHER_STMT_RE = /^\s*(MATCH|MERGE|CREATE\s*\(|RETURN|UNWIND|WITH\s|DETACH|FOREACH|LOAD\s+CSV)/;

// Redis: common commands as leading keywords.
const REDIS_COMMANDS = new Set([
  'GET', 'SET', 'DEL', 'EXISTS', 'EXPIRE', 'KEYS', 'SCAN', 'AUTH', 'PING', 'QUIT',
  'FLUSHDB', 'FLUSHALL', 'CLIENT', 'CONFIG', 'HGET', 'HSET', 'HGETALL', 'HDEL',
  'HEXISTS', 'HLEN', 'HKEYS', 'HVALS', 'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LLEN',
  'LRANGE', 'SADD', 'SREM', 'SMEMBERS', 'SISMEMBER', 'SINTER', 'SUNION', 'SDIFF',
  'ZADD', 'ZREM', 'ZRANGE', 'ZRANGEBYSCORE', 'ZRANK', 'ZSCORE', 'ZREVRANGE',
  'ZREVRANK', 'PUBLISH', 'SUBSCRIBE', 'UNSUBSCRIBE', 'MULTI', 'DISCARD', 'WATCH',
  'UNWATCH', 'EVAL', 'EVALSHA', 'SCRIPT', 'INFO', 'CLUSTER', 'SENTINEL', 'TTL', 'PTTL',
  'TYPE',
]);
// The leading word must be a whole command: `GET key` matches, `GETRANGE` does not.
const looksLikeRedisName = (name) => REDIS_COMMANDS.has(/^\w+/.exec(name)?.[0]);
const looksLikeNeo4j = (node) => {
  const db = String(node?.databaseType || '').toLowerCase();
  if (db === 'neo4j') return true;
  const name = String(node?.name || node?.operation || '');
  if (NEO4J_NAME_RE.test(name)) return true;
  const stmt = String(node?.dbStatement || node?.query || node?.statement || '');
  return CYPHER_STMT_RE.test(stmt);
};

// Mongo statements are usually JSON-like; SQL statements are flat text.
const looksLikeMongoStatement = (stmt) => {
  const s = String(stmt || '').trim();
  return s.startsWith('{') || s.startsWith('[');
};

// Returns the type the UI should treat the span as, correcting for cases
// where the lib mis-types DB spans as INTERNAL (the agent didn't emit
// db.system). Centralizing this means waterfall colors, summary chips, type
// filter, and group bucketing all agree on what kind of work this span is.
// Library types that are trusted as they are.
const TRUSTED_LIB_TYPES = new Set(['REDIS', 'MSSQL', 'SQL', 'DATABASE', 'EXTERNAL', 'LOG']);

// The lib's own type, when it's clearly a primary category. Neo4j check
// runs before generic DATABASE because the lib's normalizeDbType collapses
// neo4j → DATABASE, losing the specialization.
const primaryLibType = (t, node) => {
  if (t.includes('HTTP'))                     return 'HTTP';
  if (t === 'NEO4J' || looksLikeNeo4j(node))  return 'NEO4J';
  if (t.includes('MONGO'))                    return 'MONGODB';
  if (TRUSTED_LIB_TYPES.has(t))               return t;
  return null;
};

const inferEffectiveType = (node) => {
  if (!node) return null;
  const t = String(node.type || '').toUpperCase();

  const primary = primaryLibType(t, node);
  if (primary) return primary;

  // INTERNAL or untyped — fall back to name-shape detection.
  const rawName = String(node.name || node.operation || '');
  const stmt = String(node.dbStatement || node.query || node.statement || '');

  // HTTP detection runs first because:
  //   1. The lib's TraceInterpreter populates httpMethod/httpStatus/endpoint
  //      only when the agent emitted http.* attrs — when those exist, this
  //      span is unambiguously HTTP regardless of the lib's normalizeType.
  //   2. The HTTP name regex requires a URL-like path or end-of-string,
  //      so it doesn't collide with SQL "DELETE FROM users" (DELETE+space+
  //      identifier rather than DELETE+space+/path).
  if (node.httpMethod || node.httpStatus != null || node.endpoint || node.url) return 'HTTP';
  if (looksLikeHttpName(rawName))                                   return 'HTTP';

  if (looksLikeMongoName(rawName) || looksLikeMongoStatement(stmt)) return 'MONGODB';
  if (SQL_NAME_RE.test(rawName))                                    return 'SQL';
  if (looksLikeRedisName(rawName))                                  return 'REDIS';

  return t || null;
};

// ── StatusBadge ───────────────────────────────────────────────────────────────
const StatusBadge = React.memo(function StatusBadge({ status }) {
  if (!status || status === '-') return <span className="tv-badge tv-badge-unknown">-</span>;
  const s = String(status).toUpperCase();
  let cls = 'tv-badge-success';
  if (s.includes('ERROR') || s.includes('FAIL') || s.includes('FATAL')) cls = 'tv-badge-error';
  else if (s.includes('WARN')) cls = 'tv-badge-warn';
  else if (s.includes('DEBUG')) cls = 'tv-badge-debug';
  else if (s.includes('INFO')) cls = 'tv-badge-info';
  return <span className={`tv-badge ${cls}`}>{s}</span>;
});
StatusBadge.propTypes = { status: PropTypes.string };

// ── Summary type chip ─────────────────────────────────────────────────────────
const TypeChip = React.memo(function TypeChip({ type, count, isActive, onClick }) {
  const color = getTypeColor(type);
  return (
    <button
      className={`tv-summary-chip ${isActive ? 'tv-chip-active' : ''}`}
      style={{ '--chip-color': color }}
      onClick={onClick}
    >
      <span className="tv-chip-dot" style={{ background: color }} />
      {type} ({count})
    </button>
  );
});
TypeChip.propTypes = {
  type: PropTypes.string.isRequired,
  count: PropTypes.number.isRequired,
  isActive: PropTypes.bool,
  onClick: PropTypes.func.isRequired,
};

// ── Error-first banner (operates on processedTree so uid is available) ────────
const ErrorBanner = React.memo(function ErrorBanner({ tree, onJump }) {
  // Issue #15: surface the *deepest* error span, not the first one a DFS
  // happens to hit. The previous `find` did pre-order traversal and returned
  // the surrounding HTTP request whenever it was tagged ERROR — but that
  // request is typically failing *because* a downstream SQL/Mongo/internal
  // span errored. Jump-to-span should land on the originator, not the
  // wrapper. Tie-break by pre-order so the result is stable.
  const errorNode = useMemo(() => {
    let best = null;
    let bestDepth = -1;
    const walk = (node, depth) => {
      if (!node) return;
      if (!node.isGroup && isErrorStatus(node.status || node.severity) && depth > bestDepth) {
        best = node;
        bestDepth = depth;
      }
      (node.children || []).forEach((c) => walk(c, depth + 1));
    };
    walk(tree, 0);
    return best;
  }, [tree]);

  if (!errorNode) return null;

  const cause = errorNode.fullMessage || errorNode.message || errorNode.name || 'Unknown error';
  const failedIn = [errorNode.className, errorNode.methodName].filter(Boolean).join('.');
  const failedAt = errorNode.relativeTimeMs != null
    ? `+${Number(errorNode.relativeTimeMs).toFixed(3)} ms`
    : (errorNode.timestamp || '-');

  return (
    <div className="tv-error-banner">
      <div className="tv-error-banner-title">
        <span className="tv-error-x">✕</span>{'Root Cause Detected'}
        <button
          className="tv-error-jump"
          onClick={() => onJump(errorNode.uid)}
          title="Reveal this span in the tree and timeline"
        >
          Jump to span →
        </button>
      </div>
      <div className="tv-error-fields">
        <div className="tv-error-field">
          <span className="tv-error-label">ROOT CAUSE</span>
          <span className="tv-error-val">{cause}</span>
        </div>
        {failedIn && (
          <div className="tv-error-field">
            <span className="tv-error-label">FAILED IN</span>
            <span className="tv-error-val tv-mono">{failedIn}()</span>
          </div>
        )}
        <div className="tv-error-field">
          <span className="tv-error-label">FAILED AT</span>
          <span className="tv-error-val tv-mono">{failedAt}</span>
        </div>
      </div>
    </div>
  );
});
ErrorBanner.propTypes = {
  tree: PropTypes.object,
  onJump: PropTypes.func.isRequired,
};

// ── Logs-by-span tree ─────────────────────────────────────────────────────────
// Rebuilds the real span tree from parentId, one wrapper per thread, with each
// log nested under the span its spanId names. See the logs-tree branch of
// TraceView's processedTree for the reasoning.
const buildLogsTree = (listTree, expandedNodes, openDetailIds) => {
  const rootSpanId = listTree.spanId;
  const stableId = (s) => String(s || 'x').replace(/[^a-zA-Z0-9_-]/g, '_');

  // 1. Collect real spans + logs from the lib's tree.
  const realSpans = [];
  const allLogs = [];
  const walk = (n) => {
    if (!n) return;
    const t = String(n.type || '').toUpperCase();
    if (t === 'LOG') { allLogs.push(n); return; }
    if (!isVirtualLibGroup(n) && n.spanId) realSpans.push(n);
    (n.children || []).forEach(walk);
  };
  walk(listTree);
  if (realSpans.length === 0 && allLogs.length === 0) return listTree;

  // 2. Index spans by ID.
  const spanById = new Map();
  realSpans.forEach(s => {
    if (s.spanId) spanById.set(s.spanId, s);
  });

  // 3. Resolve thread name for every span.
  const threadOfSpan = new Map();
  const resolveSpanThread = (id, seen = new Set()) => {
    if (!id || seen.has(id)) return '(unknown thread)';
    if (threadOfSpan.has(id)) return threadOfSpan.get(id);
    seen.add(id);
    const s = spanById.get(id);
    if (!s) return '(unknown thread)';
    const tn = s.threadName || resolveSpanThread(s.parentId, seen);
    threadOfSpan.set(id, tn);
    return tn;
  };
  realSpans.forEach(s => resolveSpanThread(s.spanId));

  const resolveLogThread = (lg) =>
    lg.threadName
      || (lg.spanId && threadOfSpan.get(lg.spanId))
      || '(unknown thread)';

  // 4. Group spans and logs by thread.
  const spansByThread = new Map();
  const logsByThread = new Map();

  realSpans.forEach(s => {
    if (s.spanId === rootSpanId) return; // root span is the L1 top-level node
    const tn = resolveSpanThread(s.spanId);
    if (!spansByThread.has(tn)) spansByThread.set(tn, []);
    spansByThread.get(tn).push(s);
  });

  allLogs.forEach(lg => {
    const tn = resolveLogThread(lg);
    if (!logsByThread.has(tn)) logsByThread.set(tn, []);
    logsByThread.get(tn).push(lg);
  });

  const allThreadNames = new Set([
    ...spansByThread.keys(),
    ...logsByThread.keys()
  ]);

  const pushTo = (map, key, item) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };

  const toLogNode = (cl, idx, parentUid) => {
    const logUid = `${parentUid}-log-${idx}-${stableId(cl.timestamp || cl.time || cl.id)}`;
    return {
      ...cl,
      uid: logUid,
      id: logUid,
      isExpanded: expandedNodes.has(logUid),
      isDetailOpen: openDetailIds.has(logUid),
    };
  };

  // A span or log belongs under a span on thread `tn` only when that span is
  // a real, non-root span that itself runs on `tn`.
  const isNestableUnder = (id, tn) =>
    !!id && id !== rootSpanId && spanById.has(id) && resolveSpanThread(id) === tn;

  // Partition logs for a thread: route to their specific span if it exists on
  // the thread (and is not the root span), otherwise they are orphan logs on
  // this thread.
  const partitionLogs = (logsOnThread, tn) => {
    const logsBySpanId = new Map();
    const orphanLogs = [];
    logsOnThread.forEach(lg => {
      if (isNestableUnder(lg.spanId, tn)) pushTo(logsBySpanId, lg.spanId, lg);
      else orphanLogs.push(lg);
    });
    return { logsBySpanId, orphanLogs };
  };

  // Group a thread's spans by parentId. A span is top-level on this thread if:
  // - its parent is the root span
  // - its parent is missing/unknown in the trace
  // - its parent is on a different thread
  const partitionSpans = (spansOnThread, tn) => {
    const spansByParentId = new Map();
    const topSpans = [];
    spansOnThread.forEach(s => {
      if (isNestableUnder(s.parentId, tn)) pushTo(spansByParentId, s.parentId, s);
      else topSpans.push(s);
    });
    return { spansByParentId, topSpans };
  };

  // 5. Build thread wrappers containing naturally nested spans and logs
  const threadWrappers = Array.from(allThreadNames).map(tn => {
    const threadUid = `${listTree.uid}-thread-${stableId(tn)}`;
    const spansOnThread = spansByThread.get(tn) || [];
    const logsOnThread = logsByThread.get(tn) || [];

    const { logsBySpanId, orphanLogs } = partitionLogs(logsOnThread, tn);
    const { spansByParentId, topSpans } = partitionSpans(spansOnThread, tn);

    // Recursive nested span and log tree builder
    const buildSpanNode = (span, parentUid, parentName = null) => {
      const spanUid = `${parentUid}-span-${stableId(span.spanId)}`;
      const childSpans = spansByParentId.get(span.spanId) || [];
      const childLogs = logsBySpanId.get(span.spanId) || [];

      const recursiveChildren = childSpans.map(cs => buildSpanNode(cs, spanUid, span.name || span.operation || null));
      const logChildren = childLogs.map((cl, idx) => toLogNode(cl, idx, spanUid));

      // Interleave child spans and logs chronologically
      const children = [...recursiveChildren, ...logChildren].sort(compareByStart);

      return {
        ...span,
        uid: spanUid,
        id: spanUid,
        // _parentName is used by TraceTreeNode to render a parent-context
        // chip in logs-tree mode so sibling spans with different OTel
        // parents are visually distinguishable.
        _parentName: parentName,
        children,
        isExpanded: expandedNodes.has(spanUid),
        isDetailOpen: openDetailIds.has(spanUid),
      };
    };

    // Resolve a display parent-name for spans that are top-level on this
    // thread. They have no in-tree parent rendered above them, so without
    // this hint they look like flat siblings — even when each one is
    // actually a child of a different OTel parent (root, or a span on
    // another thread). Surfacing the parent name on the row makes those
    // relationships visible.
    const resolveTopSpanParentName = (span) => {
      const pId = span.parentId;
      if (!pId) return null;
      if (pId === rootSpanId) return listTree.name || listTree.operation || 'root';
      const parent = spanById.get(pId);
      if (!parent) return null;
      const parentName = parent.name || parent.operation || null;
      const parentThread = threadOfSpan.get(pId);
      // Parent lives on a different thread — annotate so the user sees the
      // cross-thread link rather than a bare name that looks local.
      if (parentName && parentThread && parentThread !== tn) {
        return `${parentName} (on ${parentThread})`;
      }
      return parentName;
    };
    const topSpanNodes = topSpans.map(ts => buildSpanNode(ts, threadUid, resolveTopSpanParentName(ts)));
    // Sort orphan logs chronologically before assigning stable UIDs so
    // two logs at the exact same millisecond always appear in the order
    // they actually fired, not insertion order.
    orphanLogs.sort(compareByStart);
    const orphanLogNodes = orphanLogs.map((cl, idx) => toLogNode(cl, idx, threadUid));

    const threadChildren = [...topSpanNodes, ...orphanLogNodes].sort(compareByStart);
    const firstStart = threadChildren.length > 0 ? getStartMs(threadChildren[0]) : null;
    const threadService = threadChildren.find(c => c.serviceName)?.serviceName || '';

    return {
      uid: threadUid,
      id: threadUid,
      isGroup: true,
      type: 'THREAD',
      name: `thread: ${tn}`,
      serviceName: threadService,
      count: threadChildren.length,
      timestamp: threadChildren[0]?.timestamp,
      startTime: threadChildren[0]?.startTime,
      _firstStart: firstStart,
      children: threadChildren,
      isExpanded: expandedNodes.has(threadUid),
    };
  });

  threadWrappers.sort((a, b) => {
    if (a._firstStart == null && b._firstStart == null) return 0;
    if (a._firstStart == null) return 1;
    if (b._firstStart == null) return -1;
    return a._firstStart - b._firstStart;
  });

  return {
    ...listTree,
    children: threadWrappers,
    isExpanded: expandedNodes.has(listTree.uid),
  };
};

// ── Group-by-type tree ────────────────────────────────────────────────────────
// 1. Strong type signals — trust the lib when it tells us a definitive type.
const strongTypeBucket = (t, child, rawName) => {
  if (t.includes('HTTP'))                            return 'HTTP';
  if (t === 'NEO4J' || looksLikeNeo4j(child))        return 'NEO4J';
  if (t === 'REDIS' || looksLikeRedisName(rawName) || rawName.toUpperCase().includes('REDIS')) return 'REDIS';
  if (t.includes('MONGO'))                           return 'MONGODB';
  if (t === 'SQL' || t === 'MSSQL')                  return 'SQL';
  return null;
};

// 2. Name/statement heuristics — rescues spans the lib mis-typed as
//    INTERNAL because the agent didn't emit db.system. Runs BEFORE the
//    INTERNAL fallback so SELECT/find queries get to their real bucket.
const nameShapeBucket = (rawName, stmt) => {
  if (looksLikeMongoName(rawName) || looksLikeMongoStatement(stmt)) return 'MONGODB';
  if (SQL_NAME_RE.test(rawName))                     return 'SQL';
  return null;
};

// 3. Remaining type-driven categories.
const weakTypeBucket = (t) => {
  if (t === 'DATABASE')                              return 'DATABASE';
  if (t.includes('EXTERNAL'))                        return 'EXTERNAL';
  if (t.includes('INTERNAL'))                        return 'INTERNAL';
  if (t.includes('LOG'))                             return 'LOG';
  return 'OTHER';
};

// Which Group-mode bucket a span lands in.
const groupBucketOf = (child) => {
  const t = String(child.type || '').toUpperCase();
  const rawName = String(child.name || child.operation || '');
  const stmt = String(child.dbStatement || child.query || child.statement || '');
  return strongTypeBucket(t, child, rawName)
    || nameShapeBucket(rawName, stmt)
    || weakTypeBucket(t);
};

// A bucket's status is its worst member's: any error, else any warning.
const worstStatusOf = (nodes) => {
  if (nodes.some(nd => isErrorStatus(nd.status || nd.severity))) return 'ERROR';
  if (nodes.some(nd => String(nd.status || '').toUpperCase().includes('WARN'))) return 'WARN';
  return 'SUCCESS';
};

const buildGroupTree = (listTree, expandedNodes, term) => {
  // Flatten every descendant of the root into one sorted list, then bucket
  // by type. Each leaf shows without its own children — descendants appear
  // separately in their type-appropriate bucket. The root itself stays as
  // the top entry; its children become the type buckets.
  const allDescendants = [];
  const collect = (n) => {
    if (!n) return;
    // Strip children: in group view each span is shown as a leaf, since
    // its descendants belong to whichever type buckets they classify into.
    allDescendants.push({ ...n, children: [] });
    (n.children || []).forEach(collect);
  };
  (listTree.children || []).forEach(collect);
  allDescendants.sort(compareByStart);

  const groups = {
    HTTP:     { title: 'HTTP Requests',       type: 'HTTP',     nodes: [] },
    SQL:      { title: 'SQL Queries',         type: 'DATABASE', nodes: [] },
    MONGODB:  { title: 'MongoDB Queries',     type: 'MONGODB',  nodes: [] },
    NEO4J:    { title: 'Neo4j (Cypher)',      type: 'NEO4J',    nodes: [] },
    REDIS:    { title: 'Redis Operations',    type: 'DATABASE', nodes: [] },
    DATABASE: { title: 'Database Queries',    type: 'DATABASE', nodes: [] },
    EXTERNAL: { title: 'External API Calls',  type: 'EXTERNAL', nodes: [] },
    INTERNAL: { title: 'Internal Processing', type: 'INTERNAL', nodes: [] },
    LOG:      { title: 'Direct Logs',         type: 'LOG',      nodes: [] },
    OTHER:    { title: 'Other Operations',    type: 'OTHER',    nodes: [] },
  };

  allDescendants.forEach((child) => {
    groups[groupBucketOf(child)].nodes.push(child);
  });

  const groupRows = Object.values(groups)
    .filter(g => g.nodes.length > 0)
    .map((g, gIdx) => {
      const gUid = `${listTree.uid}-bucket-${g.title.replace(/\s+/g, '-')}-${gIdx}`;
      const totalMs = g.nodes.reduce((s, nd) => s + (nd.durationMs || 0), 0);
      const firstNodeTs = g.nodes[0]?.timestamp;
      const worstStatus = worstStatusOf(g.nodes);
      const groupExpanded = expandedNodes.has(gUid)
        || (term.length > 0 && g.nodes.length > 0);

      return {
        id: gUid,
        uid: gUid,
        name: g.title,
        isGroup: true,
        type: g.type,
        durationMs: totalMs,
        timestamp: firstNodeTs,
        count: g.nodes.length,
        status: worstStatus,
        children: g.nodes,
        isExpanded: groupExpanded,
        isDetailOpen: false,
      };
    });

  groupRows.sort(compareByStart);

  return { ...listTree, children: groupRows };
};

// ── Main TraceView ────────────────────────────────────────────────────────────
const TraceView = ({ traceId, onBack }) => {
  const [traceData, setTraceData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [selectedTypes, setSelectedTypes] = useState(new Set());
  const [openDetailIds, setOpenDetailIds] = useState(new Set());
  const [groupingMode, setGroupingMode] = useState('list');     // 'list' | 'group' | 'logs-tree'
  const [levelFilter, setLevelFilter] = useState('ALL');        // issue #7
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedNodeUid, setSelectedNodeUid] = useState(null);
  // Increments only when an explicit "reveal this row" action occurs (e.g.
  // the error banner's Jump button). Plain selection (tree/waterfall click)
  // never triggers viewport scrolling — the user's scroll position is sticky.
  const [scrollRequestId, setScrollRequestId] = useState(0);
  // Waterfall collapsed/expanded — persisted across traces and reloads via
  // localStorage. Lazy initializer reads ONCE; the trace-fetch effect below
  // intentionally does NOT reset this (it's a UI preference, not trace state).
  const [waterfallExpanded, setWaterfallExpanded] = useState(() => {
    try {
      return localStorage.getItem('tv-waterfall-expanded') === '1';
    } catch { return false; }
  });
  const treeContainerRef = useRef(null);
  // Tracks the uid the auto-expand effect has already handled. Without this,
  // the effect re-fires on every processedTree change (which itself reflects
  // the user's manual expand/collapse) and undoes manual collapses by
  // re-expanding all ancestors of the still-selected node.
  const lastAutoExpandedRef = useRef(null);
  // Same idea for the scroll-on-jump effect — the side-effect of expanding
  // ancestors mutates processedTree; without a ref the effect would re-run
  // and re-trigger scroll.
  const lastScrollReqRef = useRef(0);
  // Track the traceId and mode when we auto-expanded the logs-tree view,
  // to avoid re-expanding every time the user collapses/expands manually.
  const lastAutoExpandedModeRef = useRef({ traceId: null, mode: null });

  useEffect(() => {
    if (!traceId) return;
    setLoading(true);
    setExpandedNodes(new Set());
    setOpenDetailIds(new Set());
    setSelectedNodeUid(null);
    setSearchTerm('');
    setLevelFilter('ALL');
    lastAutoExpandedRef.current = null;
    lastScrollReqRef.current = 0;
    lastAutoExpandedModeRef.current = { traceId: null, mode: null };
    fetchTrace(traceId)
      .then(data => {
        const trace = Array.isArray(data) ? data[0] : data;
        setTraceData(trace);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [traceId]);

  const onToggleExpanded = useCallback((uid) => {
    setExpandedNodes(prev => {
      const n = new Set(prev);
      n.has(uid) ? n.delete(uid) : n.add(uid);
      return n;
    });
  }, []);
  const onToggleDetail = useCallback((uid) => {
    setOpenDetailIds(prev => {
      const n = new Set(prev);
      n.has(uid) ? n.delete(uid) : n.add(uid);
      return n;
    });
  }, []);

  // Multi-select: clicking a chip toggles only that type, leaves others alone.
  // Active set = union of selected types (empty set means "show all").
  const toggleTypeFilter = useCallback((type) => {
    setSelectedTypes(prev => {
      const n = new Set(prev);
      if (n.has(type)) n.delete(type);
      else n.add(type);
      return n;
    });
  }, []);

  const clearTypeFilters = useCallback(() => {
    setSelectedTypes(new Set());
  }, []);

  // Selecting from waterfall or tree row — does NOT scroll the viewport.
  // Highlighting alone is enough; auto-scrolling on every click was disruptive
  // when the trace is long enough to scroll the page.
  const onSelectNode = useCallback((uid) => {
    setSelectedNodeUid(uid);
  }, []);

  // Explicit "reveal" action — the only path that scrolls the row into view.
  // Used by the error banner's Jump button. Bumping the nonce re-fires the
  // scroll effect even if the same uid is "jumped to" twice in a row.
  const onJumpToNode = useCallback((uid) => {
    setSelectedNodeUid(uid);
    setScrollRequestId(n => n + 1);
  }, []);

  const toggleWaterfallExpanded = useCallback(() => {
    setWaterfallExpanded(prev => {
      const next = !prev;
      try { localStorage.setItem('tv-waterfall-expanded', next ? '1' : '0'); }
      catch { /* private mode / disabled storage — silently ignore */ }
      return next;
    });
  }, []);

  // Summary counts (from raw tree — independent of filters). Uses the
  // effective type so SELECT/find spans mistyped as INTERNAL by the lib still
  // count under the correct chip ("MongoDB Queries", "SQL Queries").
  //
  // Skip virtual lib wrappers ("SQL Queries", "Database Queries", etc.) —
  // they're flattened before transformNode runs, so counting them inflates
  // the chip and creates a "filter matches nothing" mismatch where the chip
  // says DATABASE (1) but selecting it shows zero spans.
  const typeCounts = useMemo(() => {
    if (!traceData?.rootOperation) return {};
    const acc = {};
    const traverse = (node) => {
      if (!node) return;
      if (!isVirtualLibGroup(node)) {
        const t = inferEffectiveType(node);
        if (t) acc[t] = (acc[t] || 0) + 1;
      }
      (node.children || []).forEach(traverse);
    };
    traverse(traceData.rootOperation);
    return acc;
  }, [traceData]);

  // Tree processing (stable unique IDs) — honors search filter, then either
  // preserves hierarchy (List mode) or flattens into per-type buckets at the
  // root (Group mode). Group mode used to bucket only direct siblings, which
  // hid SQL/Mongo/Neo4j calls under a deep INTERNAL parent — they never
  // reached the top-level grouping. Now we flatten every descendant once and
  // bucket by type globally, matching the user mental model of "show me all
  // X-type spans together regardless of where they sit in the tree."
  const processedTree = useMemo(() => {
    if (!traceData?.rootOperation) return null;
    const term = searchTerm.trim();

    // Transformed children that survive the filters. Virtual lib category
    // wrappers are unwrapped first, then siblings are sorted by start.
    const visibleChildrenOf = (node, uid) => {
      if (!node.children?.length) return [];
      const orderedRawChildren = flattenVirtualGroups(node.children).sort(compareByStart);
      return orderedRawChildren
        .map((c, idx) => transformNode(c, idx, uid))
        .filter(Boolean);
    };

    // List-mode transform: hierarchy preserved, search/type filters applied.
    const transformNode = (node, index = 0, path = 'root') => {
      if (!node) return null;

      const spanId = node.spanId || node.id || 'no-id';
      const opName = node.name || node.operation || 'no-op';
      const uid = `${traceId}-${spanId}-${opName}-${path}-${index}`;

      const filterTypes = Array.from(selectedTypes).map(t => t.toUpperCase());
      const effectiveType = inferEffectiveType(node) || String(node.type || '').toUpperCase();
      const isTypeMatch = !filterTypes.length || filterTypes.includes(effectiveType);
      const isLevelMatch = matchesLevelFilter(node, levelFilter);
      const selfMatchesSearch = matchesSearch(node, term);

      const children = visibleChildrenOf(node, uid);

      const hasVisibleChildren = children.length > 0;
      const selfPasses = isTypeMatch && isLevelMatch && (!term || selfMatchesSearch);
      if (!selfPasses && !hasVisibleChildren) return null;

      const effectiveExpanded = expandedNodes.has(uid)
        || (term.length > 0 && hasVisibleChildren);

      const finalTs = node.timestamp || node.startTime || node.time;

      // The lib populates `durationMs` on LOG nodes with the log's offset
      // since trace start, NOT an actual duration (logs are point events).
      // See TraceTreeBuilder.java line 300: ln.setDurationMs(e.getRelativeDurationMs()).
      // Reading that as a real duration inflated the waterfall's totalMs
      // (start + offset = double the real end) and rendered 100s-of-seconds
      // bars for logs that fired ~15s into the trace. Zero it here so the
      // waterfall treats logs as zero-width events anchored at their
      // timestamp; the offset is still surfaced via `relativeTimeMs` in the
      // log row's meta line, so no information is lost.
      const isLogNode = (effectiveType || '').toUpperCase() === 'LOG';
      const correctedDurationMs = isLogNode ? 0 : node.durationMs;

      return {
        ...node,
        // Override `type` with the inferred effective type so waterfall
        // colors, type badges, filter chips, and group buckets all agree
        // on what kind of work this span is — even when the lib typed it
        // as INTERNAL because the OTel agent didn't emit db.system.
        type: effectiveType || node.type,
        durationMs: correctedDurationMs,
        uid,
        id: uid,
        timestamp: finalTs,
        children,
        isExpanded: effectiveExpanded,
        isDetailOpen: openDetailIds.has(uid),
      };
    };

    const listTree = transformNode(traceData.rootOperation);
    if (!listTree) return null;

    // ── Logs-by-span mode ─────────────────────────────────────────────────
    // The lib (TraceTreeBuilder.groupSpans) buckets every child span into
    // category wrappers — "SQL Queries", "MongoDB Queries", "Internal
    // Processing" — and in doing so throws away the natural parent→child
    // relationships between spans. In this mode we rebuild the real span
    // tree using each span's `parentId` (wired end-to-end: OpenObserve
    // `reference_parent_span_id` → TraceResponseDTO → TraceTreeNode.parentId
    // → here), then segregate parallel/async work by threadName, then
    // attach each log to the span its `spanId` points to.
    //
    // Why thread segregation? A Spring Boot service that fans out work to
    // an executor pool produces many spans that are siblings under root by
    // parentId and ALSO overlap in wall-clock time. Sorting them purely by
    // start timestamp interleaves spans from different threads, hiding the
    // sequential structure within each thread. Grouping by threadName gives
    // each thread its own lane.
    //
    // Logs use spanId directly. Every log carries the spanId of whatever
    // span was active when it fired (set by the OTel agent at log-emission
    // time). We trust that value — placing the log under the span with
    // matching spanId — instead of overriding with a time-containment
    // guess. In services where logs fire during the root request (no
    // intermediate spans are themselves instrumented), all logs will
    // legitimately land under root; that's what the data says.
    if (groupingMode === 'logs-tree') {
      // Logs-by-span: rebuild the real nested span tree using parentId, segregate
      // by thread, and nest logs under the span they belong to (via spanId).
      // All child nodes (spans and logs) under any thread or span are sorted
      // chronologically to follow the execution timeline.
      return buildLogsTree(listTree, expandedNodes, openDetailIds);
    }

    if (groupingMode !== 'group') return listTree;

    return buildGroupTree(listTree, expandedNodes, term);
  }, [traceData, expandedNodes, openDetailIds, selectedTypes, traceId, groupingMode, levelFilter, searchTerm]);

  // Flat list of real spans (skipping group wrappers) — feeds the waterfall.
  // Walked DFS to capture each span's depth (for indentation), then sorted
  // by absolute start time so the visual row order matches the bar order.
  // Without the sort, a long parent's late descendants would render above a
  // sibling that started earlier — bars looked "jumping" because list order
  // came from tree pre-order while bar position came from timestamps.
  const flatWaterfallNodes = useMemo(() => {
    if (!processedTree) return [];
    const out = [];
    const walk = (node, depth) => {
      if (!node) return;
      const isGroup = !!node.isGroup;
      if (!isGroup) {
        out.push({ ...node, depth });
      }
      const childDepth = isGroup ? depth : depth + 1;
      (node.children || []).forEach(c => walk(c, childDepth));
    };
    walk(processedTree, 0);
    return out.sort(compareByStart);
  }, [processedTree]);

  // Resolve the currently-selected uid to its node in processedTree so the
  // inspector pane can render it. Walks the tree once per selection change.
  const selectedNode = useMemo(() => {
    if (!selectedNodeUid || !processedTree) return null;
    const find = (n) => {
      if (!n) return null;
      if (n.uid === selectedNodeUid) return n;
      for (const c of (n.children || [])) {
        const r = find(c);
        if (r) return r;
      }
      return null;
    };
    return find(processedTree);
  }, [selectedNodeUid, processedTree]);

  const handleExpandAll = useCallback(() => {
    if (!processedTree) return;
    const uids = collectAllExpandableUids(processedTree);
    setExpandedNodes(new Set(uids));
  }, [processedTree]);

  const handleCollapseAll = useCallback(() => {
    setExpandedNodes(new Set());
  }, []);

  // When SELECTION changes, ensure all ancestors are expanded so the row is
  // present in the DOM. The ref guard prevents the effect from re-firing on
  // processedTree changes (e.g. user manually collapsing a group) — without
  // it, manual collapses got immediately undone because the effect re-found
  // the path and re-expanded everything along it.
  useEffect(() => {
    if (!selectedNodeUid || !processedTree) return;
    if (lastAutoExpandedRef.current === selectedNodeUid) return;

    const path = findUidPath(processedTree, selectedNodeUid, []);
    if (!path) return;

    lastAutoExpandedRef.current = selectedNodeUid;

    // Exclude the target node itself, only expand true ancestors
    const ancestorsPath = path.slice(0, -1);
    if (ancestorsPath.length === 0) return;

    setExpandedNodes(prev => {
      if (ancestorsPath.every(u => prev.has(u))) return prev;
      const n = new Set(prev);
      ancestorsPath.forEach(u => n.add(u));
      return n;
    });
  }, [selectedNodeUid, processedTree]);

  // Scroll-into-view + force-expand on explicit reveal (Jump button). Also
  // re-expands ancestors in case the user manually collapsed them since the
  // last selection — the Jump action's whole purpose is to reveal the row.
  // 'block: nearest' is a no-op when the row is already on screen.
  useEffect(() => {
    if (scrollRequestId === 0 || !selectedNodeUid || !processedTree) return;
    if (lastScrollReqRef.current === scrollRequestId) return;

    const path = findUidPath(processedTree, selectedNodeUid, []);
    if (!path) return;

    // Phase 1: Ensure all ancestors are expanded. If some aren't, trigger
    // expansion and return — the effect will re-fire once the expansion
    // commits and processedTree updates.
    const ancestorsPath = path.slice(0, -1);
    const allExpanded = ancestorsPath.every(u => expandedNodes.has(u));
    if (!allExpanded) {
      setExpandedNodes(prev => {
        const n = new Set(prev);
        ancestorsPath.forEach(u => n.add(u));
        return n;
      });
      return;
    }

    // Phase 2: Path is fully expanded. Mark handled and schedule the scroll.
    lastScrollReqRef.current = scrollRequestId;

    requestAnimationFrame(() => {
      const root = treeContainerRef.current;
      if (!root) return;
      const el = root.querySelector(`[data-uid="${CSS.escape(selectedNodeUid)}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [scrollRequestId, selectedNodeUid, processedTree, expandedNodes]);

  // Auto-expand all nodes when switching to 'logs-tree' mode, or when a new trace loads under 'logs-tree' mode.
  useEffect(() => {
    if (!traceData || !processedTree) return;
    const currentTraceId = traceId;
    const currentMode = groupingMode;
    const lastExpanded = lastAutoExpandedModeRef.current;

    if (currentMode === 'logs-tree' && (lastExpanded.traceId !== currentTraceId || lastExpanded.mode !== currentMode)) {
      lastAutoExpandedModeRef.current = { traceId: currentTraceId, mode: currentMode };
      const uids = collectAllExpandableUids(processedTree);
      setExpandedNodes(new Set(uids));
    }
  }, [traceId, groupingMode, traceData, processedTree]);

  // Esc key dismisses the inspector pane (matches the close button).
  useEffect(() => {
    if (!selectedNodeUid) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setSelectedNodeUid(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNodeUid]);

  const root = traceData?.rootOperation;
  const rootStatus = root?.status || '';

  if (loading) return (
    <div className="tv-loading">
      <div className="tv-loading-spinner" />
      <span>Loading trace data…</span>
    </div>
  );

  if (!traceData) return <div className="tv-empty">No trace data found.</div>;

  return (
    <div className="tv-container">
      {/* Back */}
      <button className="tv-back-btn" onClick={onBack}>← Back to Discovery</button>

      {/* Header card */}
      <div className="tv-header-card">
        <div className="tv-header-top">
          <div className="tv-header-left">
            <h1 className="tv-operation-title">{root?.name || root?.operation || 'Trace Details'}</h1>
            <span className="tv-trace-id-sub">Trace ID: {traceId}</span>
          </div>
          <div className="tv-header-badges">
            <div className="tv-meta-badge">
              <span className="tv-meta-badge-label">STATUS</span>
              <StatusBadge status={rootStatus || 'UNKNOWN'} />
            </div>
            <div className="tv-meta-badge">
              <span className="tv-meta-badge-label">DURATION</span>
              <span className="tv-meta-badge-value">{root?.durationMs != null ? `${root.durationMs} ms` : '-'}</span>
            </div>
          </div>
        </div>
        <div className="tv-summary-row">
          <span className="tv-summary-label">SUMMARY:</span>
          {Object.entries(typeCounts).map(([type, count]) => (
            <TypeChip
              key={type}
              type={type}
              count={count}
              isActive={selectedTypes.has(type)}
              onClick={() => toggleTypeFilter(type)}
            />
          ))}
          {selectedTypes.size > 0 && (
            <button
              className="tv-summary-clear"
              onClick={clearTypeFilters}
              title="Clear all type filters"
            >
              Clear ({selectedTypes.size})
            </button>
          )}
        </div>
      </div>

      {/* Error banner — now linked to processedTree so it can jump to a span */}
      {isErrorStatus(rootStatus) && processedTree && (
        <ErrorBanner tree={processedTree} onJump={onJumpToNode} />
      )}

      {/* Toolbar: search + view toggle */}
      <div className="tv-toolbar">
        <div className="tv-toolbar-search">
          <span className="tv-search-icon">⌕</span>
          <input
            className="tv-search-input"
            type="search"
            placeholder="Search spans, log messages, queries, services…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button
              className="tv-search-clear"
              onClick={() => setSearchTerm('')}
              title="Clear search"
            >×</button>
          )}
        </div>

        <div className="tv-level-filter">
          <label htmlFor="tv-level-select" className="tv-view-toggle-label">SEVERITY:</label>
          <select
            id="tv-level-select"
            className="tv-level-select"
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            title="Show spans at or above this severity (status maps to severity for non-log spans)"
          >
            {SEVERITY_LEVELS.map(l => (
              <option key={l} value={l}>{l === 'ALL' ? 'All levels' : `≥ ${l}`}</option>
            ))}
          </select>
        </div>

        <div className="tv-view-toggle" role="radiogroup" aria-label="Tree layout">
          <span className="tv-view-toggle-label">VIEW:</span>
          <label className={`tv-radio ${groupingMode === 'list' ? 'tv-radio-active' : ''}`}>
            <input
              type="radio"
              name="grouping-mode"
              value="list"
              checked={groupingMode === 'list'}
              onChange={() => setGroupingMode('list')}
            />
            <span>List</span>
          </label>
          <label className={`tv-radio ${groupingMode === 'group' ? 'tv-radio-active' : ''}`}>
            <input
              type="radio"
              name="grouping-mode"
              value="group"
              checked={groupingMode === 'group'}
              onChange={() => setGroupingMode('group')}
            />
            <span>Group by type</span>
          </label>
          <label
            className={`tv-radio ${groupingMode === 'logs-tree' ? 'tv-radio-active' : ''}`}
            title="Show only logs, organized under their owning span hierarchy (by spanId)"
          >
            <input
              type="radio"
              name="grouping-mode"
              value="logs-tree"
              checked={groupingMode === 'logs-tree'}
              onChange={() => setGroupingMode('logs-tree')}
            />
            <span>Logs by span</span>
          </label>
        </div>

        {/* Divider */}
        <div className="tv-toolbar-divider" />

        {/* Expand/Collapse Icons */}
        <div className="tv-expand-collapse-group">
          <button
            className="tv-icon-btn"
            onClick={handleExpandAll}
            title="Expand all tree nodes"
            aria-label="Expand all"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="7 13 12 18 17 13"></polyline>
              <polyline points="7 6 12 11 17 6"></polyline>
            </svg>
          </button>
          <button
            className="tv-icon-btn"
            onClick={handleCollapseAll}
            title="Collapse all tree nodes"
            aria-label="Collapse all"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 11 12 6 7 11"></polyline>
              <polyline points="17 18 12 13 7 18"></polyline>
            </svg>
          </button>
        </div>
      </div>

      {/* Waterfall (timeline) — synced with tree selection. Uses the reveal
          path (onJumpToNode) so a click on a bar both highlights the row and
          scrolls it into view; the corresponding tree row is often below the
          fold and needs to be brought into the viewport. Tree-row clicks
          stay on the plain onSelectNode path so they never move the page. */}
      <TraceWaterfall
        nodes={flatWaterfallNodes}
        selectedUid={selectedNodeUid}
        onSelectNode={onJumpToNode}
        // Small traces (≤8 spans) always expand — collapsing offers nothing
        // when there's barely anything to collapse. Larger traces honour the
        // localStorage preference (default collapsed).
        expanded={waterfallExpanded || flatWaterfallNodes.length <= 8}
        onToggleExpanded={toggleWaterfallExpanded}
        onTypeFilterClick={toggleTypeFilter}
        activeTypeFilter={selectedTypes}
      />

      {/* Two-pane body: tree on the left (scanning surface), sticky
          inspector on the right (reading surface for the selected span).
          The inspector is rendered ONLY when something is selected — the
          tree gets full width by default and the pane appears on demand.
          Falls back to single-column at <1280px via media query. */}
      <div className={`tv-body ${selectedNode ? 'tv-body--with-pane' : ''}`}>
        <div
          className={`tv-tree-card ${groupingMode === 'logs-tree' ? 'tv-tree-card--with-span' : ''}`}
          ref={treeContainerRef}
        >
          <div className="tv-tree-header">
            <div className="tv-th-time">TIMESTAMP</div>
            {/* SPAN ID column only in Logs-by-span mode — it's the only mode
                where individual span identity is the primary grouping signal.
                List / Group-by-type keep the tighter 6-column layout. */}
            {groupingMode === 'logs-tree' && (
              <div className="tv-th-span">SPAN ID</div>
            )}
            <div className="tv-th-op">OPERATION</div>
            <div className="tv-th-type">TYPE</div>
            <div className="tv-th-service">SERVICE NAME</div>
            <div className="tv-th-status">STATUS</div>
            <div className="tv-th-dur">DURATION</div>
          </div>
          {processedTree ? (
            <TraceTreeNode
              node={processedTree}
              level={0}
              isExpanded={processedTree.isExpanded}
              isDetailOpen={processedTree.isDetailOpen}
              onToggleExpanded={onToggleExpanded}
              onToggleDetail={onToggleDetail}
              onSelectNode={onSelectNode}
              selectedNodeUid={selectedNodeUid}
              openDetailIds={openDetailIds}
              showSpanId={groupingMode === 'logs-tree'}
              index={0}
            />
          ) : (
            <div className="tv-empty-tree">
              No spans match the current filters.
            </div>
          )}
        </div>

        {selectedNode && (
          <TraceDetailPane
            node={selectedNode}
            onDismiss={() => setSelectedNodeUid(null)}
          />
        )}
      </div>
    </div>
  );
};

TraceView.propTypes = {
  traceId: PropTypes.string,
  onBack: PropTypes.func.isRequired,
};

export default TraceView;
