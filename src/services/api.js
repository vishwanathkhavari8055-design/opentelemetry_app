/**
 * API Service for Observability UI.
 *
 * Contract: the UI talks ONLY to the observability-lib REST API
 * (GET /api/logs, GET /api/traces, GET /api/metrics). It does not query
 * Elasticsearch, OpenObserve, or any other backend directly.
 *
 * The lib's response shape is the only shape this client recognises:
 *  - dotted keys via @JsonProperty: log["service.name"], log["@timestamp"], etc.
 *  - camelCase aliases: log.serviceName, log.traceId, log.spanId, ...
 *  - snake_case (raw column names if the backend ever exposes them): service_name, ...
 *
 * Earlier versions of this file walked nested OTLP/ES doc shapes
 * (log.resource.attributes.service.name, etc.) — those branches have been
 * removed. If your embedded host points api-base-url at a raw ES/OTLP source
 * instead of the lib, fields will appear as "unknown-service" — that is the
 * intended signal that the deployment is misconfigured.
 */

let apiBase = import.meta.env?.VITE_API_BASE_URL || '/OpentelemetryService/api';

export const setApiBase = (url) => {
  apiBase = url || import.meta.env?.VITE_API_BASE_URL || '/OpentelemetryService/api';
};

/**
 * Placeholder written into `row.traceId` when a log carries no trace id at all.
 *
 * Exported because it is a sentinel, not a trace: anything offering to open a
 * trace has to be able to tell it apart from a real id, and a second copy of the
 * literal in a component is how those two drift apart. Use {@link hasTraceId}
 * rather than comparing against this directly.
 */
export const NO_TRACE = 'no-trace';

/**
 * Whether a normalized log row can actually be opened as a trace.
 *
 * The single place that question is answered, so the row's "Open trace" button
 * and the details modal's cannot disagree about which logs have one — a log with
 * no trace showing a button that leads to an empty view is worse than no button.
 */
export const hasTraceId = (log) => {
  const id = log?.traceId;
  return typeof id === 'string' && id.trim() !== '' && id !== NO_TRACE;
};

const getBaseUrl = () => apiBase;

/**
 * The active API base, for callers OUTSIDE this module.
 *
 * Exported so a module that owns its own fetches does not carry a second copy of
 * the base URL — a duplicate would ignore setApiBase() and silently break the
 * embedded web-component build, where the host sets the base at runtime.
 *
 * Trailing slash stripped, matching how every caller in this file uses it.
 */
export const getApiBase = () => getBaseUrl().replace(/\/$/, '');

// ─────────────────────────────────────────────────────────────────────────────
// Active OpenObserve organization.
//
// Every request carries it as `?org=`, which the backend's OrgContextFilter
// turns into a per-request scope. The difference is not cosmetic: on this
// instance `default` has 638 streams and `DLH` has 12,655, so a request that
// forgets the org silently answers about the wrong tenant.
//
// It lives here, as one module-level value applied by apiFetch below, rather
// than being passed by each caller — a single missed call site would be an
// invisible cross-org data leak, and there are 14 request sites in this file
// alone.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_LS_KEY = 'observability-ui:org:v1';

let currentOrg = (() => {
  try { return localStorage.getItem(ORG_LS_KEY) || ''; }
  catch { return ''; }
})();

/** @returns {string} the active org identifier, or '' for the backend default. */
export const getOrg = () => currentOrg;

/**
 * Switch the organization every subsequent request is scoped to.
 * Callers are responsible for refetching; the app remounts its content on
 * change, which achieves that without every view needing to subscribe.
 */
export const setOrg = (org) => {
  currentOrg = org || '';
  try {
    if (currentOrg) localStorage.setItem(ORG_LS_KEY, currentOrg);
    else localStorage.removeItem(ORG_LS_KEY);
  } catch { /* private mode — the org just won't persist across reloads */ }
};

/**
 * fetch() with the active org appended. Every request in this module goes
 * through it.
 *
 * An existing `org` in the URL wins, so a caller that deliberately asks about
 * a specific organization (the IAM screen comparing two, say) is not silently
 * rewritten to the globally selected one.
 */
const apiFetch = (url, options) => {
  if (!currentOrg) return fetch(url, options);
  const hasQuery = url.includes('?');
  if (hasQuery && /[?&]org=/.test(url)) return fetch(url, options);
  return fetch(`${url}${hasQuery ? '&' : '?'}org=${encodeURIComponent(currentOrg)}`, options);
};

/**
 * GET /api/streams?type=logs|traces|metrics — what this tenant actually has.
 *
 * Replaces the hardcoded `['default']` the stream pickers used to offer. An empty
 * result means the lookup could not be made (OpenObserve unreachable), NOT that the
 * tenant has no streams — so callers keep the configured default selectable rather
 * than rendering an empty dropdown that cannot be escaped.
 */
export const fetchStreams = async ({ type = 'logs', signal } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const response = await apiFetch(`${baseUrl}/streams?type=${encodeURIComponent(type)}`,
    { signal });
  if (!response.ok) throw await alertsError(response);
  const data = await response.json();
  return Array.isArray(data?.items) ? data.items : [];
};

/**
 * Service, severity and time-range filters shared by the flat and grouped logs
 * reads, appended in the order both have always sent them.
 */
const appendLogFilters = (params, { serviceName, severity, severityMode, startDate, endDate }) => {
  // Service filter accepts either a single string (legacy) or an array. An
  // array sends `serviceNames=A&serviceNames=B` — the lib binds the repeated
  // param into List<String> on LogRequestDTO and applies AND-at-trace-grain
  // semantics (logs from traces touching every selected service).
  if (Array.isArray(serviceName)) {
    serviceName
      .map(s => (s || '').toString().trim())
      .filter(s => Boolean(s) && s.toUpperCase() !== 'ALL')
      .forEach(s => params.append('serviceNames', s));
  } else if (Boolean(serviceName) && serviceName.toUpperCase() !== "ALL") {
    params.append('serviceName', serviceName);
  }
  const normalizedSeverity = (severity || "").toString().trim().toUpperCase();
  if (normalizedSeverity && normalizedSeverity !== "ALL") {
    params.append('severity', normalizedSeverity);
  }
  // severityMode (issue #14): "AT_LEAST" expands the filter to include all
  // severities ≥ the requested level; the backend default is exact match.
  const normalizedMode = (severityMode || "").toString().trim().toUpperCase();
  if (normalizedMode === "AT_LEAST") {
    params.append('severityMode', 'AT_LEAST');
  }
  if (startDate) params.append('startTime', startDate);
  if (endDate) params.append('endTime', endDate);
};

/**
 * Search routing for the flat logs read:
 *   - Raw 32-hex or `trace:HEX` → traceId param (exact match)
 *   - `class:`, `method:`, `msg:` legacy prefixes → strip and send the
 *     remaining term as `search`. The lib (Phase 3 / issue #10) now ORs
 *     `search` across body, service_name, trace_id, severity, scope, and
 *     code attributes — so the bare term hits the right columns without
 *     needing the prefix to gate scope. Prefix scoping was lost; precision
 *     drops slightly but results are no longer empty (the literal "class:"
 *     never matched any backend column under the old behaviour).
 */
const appendLogSearch = (params, search) => {
  const searchTrimmed = search.trim();
  const tracePrefixMatch = /^trace:([a-f0-9]{16,32})$/i.exec(searchTrimmed);
  if (tracePrefixMatch) {
    params.append('traceId', tracePrefixMatch[1]);
  } else if (/^[a-f0-9]{16,32}$/i.test(searchTrimmed)) {
    params.append('traceId', searchTrimmed);
  } else {
    params.append('search', searchTrimmed.replace(/^(class|method|msg):\s*/i, ''));
  }
};

/**
 * Phase 2 (issue #8): the lib returns `{ items, hasMore, total }`. Older
 * builds returned a bare array; tolerate that shape so a stale API server
 * doesn't break the UI during rollout.
 */
const unwrapLogPage = (data) => {
  const isWrapped = typeof data === 'object' && Array.isArray(data?.items);
  if (isWrapped) return { rawItems: data.items, hasMore: !!data.hasMore, total: data.total ?? null };
  return { rawItems: Array.isArray(data) ? data : [], hasMore: false, total: null };
};

/**
 * Normalize the lib's wire shape ONLY.
 * Removed: log.attributes?.[...], log.resource?.attributes?.[...] — raw OTLP/ES shapes
 * the lib never emits. If you see "unknown-service" everywhere, your api-base-url is
 * pointing somewhere other than the lib (see HealthCheck in wc-entry.jsx).
 */
const normalizeLogRow = (log) => ({
  ...log,
  // Untouched wire record, kept alongside the normalized aliases so the
  // source view can render exactly what the backend sent (dotted keys and
  // all) instead of a shape this client invented. Consumers that iterate
  // row entries skip it — it's the only object-valued key on the row.
  _raw: log,
  id: log.id,
  timestamp: log["@timestamp"] || log.timestamp,
  serviceName: log["service.name"] || log.serviceName || log.service_name || "unknown-service",
  severity: (log["severity_text"] || log.severity || "INFO").toString().toUpperCase().trim(),
  traceId: log.traceId || log["trace.id"] || NO_TRACE,
  message: log.message || "No message provided"
});

export const fetchLogs = async ({
  stream = "",
  serviceName = "",
  severity = "",
  severityMode = "",
  search = "",
  traceId = "",
  startDate = "",
  endDate = "",
  page = 0,
  size = 50,
  sort = "timestamp,desc",
  signal = undefined
} = {}) => {
  const params = new URLSearchParams({ page, size, sort });

  // Which stream to read. Omitted when blank so the request is byte-identical to
  // what every caller sent before the picker became real — the backend then reads
  // its configured logs stream, exactly as it always did.
  if (stream) {
    params.append('stream', stream);
  }

  // Explicit traceId pins the result to a single trace. Used by the grouped
  // logs view to lazy-fetch a trace's logs on expand. The `search` path below
  // also auto-promotes a bare hex string to a traceId, but callers that know
  // they want a single trace should pass it here — the regex auto-detect was
  // a silent no-op for callers that passed `traceId` as an unknown prop.
  if (traceId) {
    params.append('traceId', traceId);
  }

  appendLogFilters(params, { serviceName, severity, severityMode, startDate, endDate });

  if (search) appendLogSearch(params, search);

  try {
    const baseUrl = getBaseUrl().replace(/\/$/, ""); // Ensure no trailing slash
    const response = await apiFetch(`${baseUrl}/logs?${params.toString()}`, { signal });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    const { rawItems, hasMore, total } = unwrapLogPage(data);
    return { items: rawItems.map(normalizeLogRow), hasMore, total };
  } catch (error) {
    if (error.name !== 'AbortError') console.error("Failed to fetch logs:", error);
    throw error;
  }
};

/**
 * Fetch logs grouped by trace ID (issue #2). The backend computes counts
 * and worst-case severity over the full filter window via GROUP BY, so the
 * counts here reflect every matching log — not just whatever the flat-list
 * pagination happens to have on the current page (which was the bug).
 *
 * Returns `{ items: [{ traceId, logCount, latestTimestamp, topSeverity, ... }], hasMore, total }`.
 */
export const fetchLogGroups = async ({
  serviceName = "",
  severity = "",
  severityMode = "",
  search = "",
  startDate = "",
  endDate = "",
  page = 0,
  size = 50,
  signal = undefined
} = {}) => {
  const params = new URLSearchParams({ page, size });
  appendLogFilters(params, { serviceName, severity, severityMode, startDate, endDate });
  if (search) {
    const stripped = search.trim().replace(/^(class|method|msg):\s*/i, '');
    params.append('search', stripped);
  }
  try {
    const baseUrl = getBaseUrl().replace(/\/$/, "");
    const response = await apiFetch(`${baseUrl}/logs/groups?${params.toString()}`, { signal });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items,
      hasMore: !!data?.hasMore,
      total: data?.total ?? null,
    };
  } catch (error) {
    if (error.name !== 'AbortError') console.error("Failed to fetch log groups:", error);
    throw error;
  }
};

/**
 * Distinct service names that produced logs in the window. The dropdown in
 * LogsView is driven by this, not by scanning a paginated row fetch —
 * otherwise low-volume services get starved out of the dropdown by chatty
 * neighbours whose logs fill the row window.
 *
 * Backend returns `supported=false` on the ES path; callers should treat that
 * as "no list available" and fall back to whatever they had before.
 */
export const fetchLogServices = async ({
  window = 'now-24h', startTime = '', endTime = '', signal,
} = {}) => {
  // An explicit range wins, so the caller can ask about exactly the window its
  // table is showing.
  const params = new URLSearchParams();
  if (startTime) params.append('startTime', startTime);
  if (endTime) params.append('endTime', endTime);
  if (!startTime) params.append('window', window);
  try {
    const baseUrl = getBaseUrl().replace(/\/$/, '');
    const response = await apiFetch(`${baseUrl}/logs/services?${params.toString()}`, { signal });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return {
      // [{ name, count }] — the dropdown renders "OrderService (18.2K)".
      services: Array.isArray(data?.services) ? data.services : [],
      items: Array.isArray(data?.items) ? data.items : [],
      supported: !!data?.supported,
      backend: data?.backend ?? null,
    };
  } catch (error) {
    if (error.name !== 'AbortError') console.error('Failed to fetch logs services:', error);
    throw error;
  }
};

/**
 * Services that produced LOGS in the window, with per-service counts.
 *
 * Single source: GET /api/logs/services, which is one `GROUP BY service_name`
 * over the logs stream. It is not unioned with anything.
 *
 * It used to be merged with the /services/uptime heartbeat inventory, from the
 * era when /logs/services silently returned nothing (it defaulted to a 7d
 * window OpenObserve can't scan). That union is what produced duplicate and
 * phantom entries: uptime lists services by their heartbeat name, which is not
 * always the name they log under, and it includes services that emit no logs
 * at all. With the discovery query fixed there is nothing left for the union
 * to add — only noise.
 *
 * Names are compared EXACTLY. This deployment genuinely runs both
 * "IoTOpsApiSvc" and "iotopsapisvc" as separate services; case-folding them
 * would hide one behind the other.
 *
 * Scoped to the SAME time range as the table. A fixed 24h window made the two
 * disagree badly: discovery offered 111 services while a "Past 15 Minutes"
 * table only had 35 with any data, so three quarters of the list returned
 * nothing when selected and read as phantom or duplicate entries. (Checked
 * against OpenObserve: there are no duplicates at any window — 35 services in
 * 15m, 39 in 1h, 111 in 24h. They were all real, just outside the range.)
 *
 * @returns {Promise<Array<{name: string, count: number}>>} sorted A→Z
 */
export const fetchLogServiceCounts = async ({
  window = 'now-24h', startTime = '', endTime = '', signal,
} = {}) => {
  const res = await fetchLogServices({ window, startTime, endTime, signal });

  // Prefer the counted shape; fall back to bare names so an older backend
  // still populates the dropdown (without counts) instead of emptying it.
  const rows = res.services.length
    ? res.services
    : res.items.map((name) => ({ name, count: null }));

  const seen = new Set();
  return rows
    .filter((r) => {
      const name = (r?.name ?? '').toString().trim();
      if (!name || name === 'unknown-service' || name === '-' || seen.has(name)) return false;
      seen.add(name);
      return true;
    })
    .map((r) => ({ name: r.name.trim(), count: r.count == null ? null : Number(r.count) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
};

export const fetchTrace = async (traceId, page = 0, size = 100) => {
  const params = new URLSearchParams({ traceId, page, size });

  try {
    const baseUrl = getBaseUrl().replace(/\/$/, "");
    const response = await apiFetch(`${baseUrl}/traces?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) {
      console.warn(`Expected array for trace ${traceId}, got:`, data);
      return [];
    }

    // Normalize the lib's wire shape ONLY (TraceTreeResponse with .rootOperation +
    // .spans, OR a flat TraceResponseDTO). Removed nested-attribute fallbacks.
    return data.map(item => {
      if (item.rootOperation && Array.isArray(item.spans)) {
        return {
          ...item,
          spans: item.spans.map(span => ({
            ...span,
            timestamp: span["@timestamp"] || span.timestamp,
            serviceName: span["service.name"] || span.serviceName || span.service_name || "unknown-service",
            spanName: span["span.name"] || span.spanName || "unnamed-span",
            actualOperation: span.actualOperation,
            traceId: span["trace.id"] || span.traceId,
            spanId: span["span.id"] || span.spanId,
            duration: span.duration
          }))
        };
      }

      return {
        ...item,
        timestamp: item["@timestamp"] || item.timestamp,
        serviceName: item["service.name"] || item.serviceName || item.service_name || "unknown-service",
        spanName: item["span.name"] || item.spanName || "unnamed-span",
        actualOperation: item.actualOperation,
        traceId: item["trace.id"] || item.traceId,
        spanId: item["span.id"] || item.spanId,
        duration: item.duration
      };
    });
  } catch (error) {
    console.error(`Failed to fetch trace ${traceId}:`, error);
    throw error;
  }
};


/** Query string for GET /api/traces; blank and 'ALL' filters are omitted. */
const tracesParams = ({
  serviceName, traceId, transactionName, outcome, dbName, search, startTime, endTime, type, page, size,
}) => {
  const params = new URLSearchParams({ page, size });
  if (type && type !== 'ALL')                      params.append('type',            type);

  if (traceId)                                     params.append('traceId',         traceId.trim());
  if (serviceName && serviceName !== 'ALL')        params.append('serviceName',      serviceName);
  if (transactionName)                             params.append('transactionName',  transactionName.trim());
  if (outcome && outcome !== 'ALL') {
    params.append('outcome', outcome.toLowerCase());
  }
  if (dbName)                                      params.append('dbName',           dbName.trim());
  if (search)                                      params.append('search',           search.trim());
  if (startTime)                                   params.append('startTime',        startTime);
  if (endTime)                                     params.append('endTime',          endTime);
  return params;
};

/**
 * Fetch a page of traces from GET /api/traces.
 * Returns { items: TraceTreeResponse[], hasMore: bool }.
 */
export const fetchTraces = async ({
  serviceName = '',
  traceId = '',
  transactionName = '',
  outcome = '',        // 'ALL' | 'SUCCESS' | 'ERROR'
  dbName = '',
  search = '',
  startTime = '',
  endTime = '',
  type = '',
  page = 0,
  size = 20,
  signal = undefined,
} = {}) => {
  const params = tracesParams({
    serviceName, traceId, transactionName, outcome, dbName, search, startTime, endTime, type, page, size,
  });

  try {
    const baseUrl = getBaseUrl().replace(/\/$/, '');
    const response = await apiFetch(`${baseUrl}/traces?${params.toString()}`, { signal });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    const items = Array.isArray(data) ? data : [];
    return { items, hasMore: items.length === size };
  } catch (error) {
    if (error.name !== 'AbortError') console.error('Failed to fetch traces:', error);
    throw error;
  }
};


// ─────────────────────────────────────────────────────────────────────────────
// Traces analytics — the three tabs on the Traces screen.
//
// These are aggregate endpoints answered by GROUP BY inside OpenObserve, as
// opposed to GET /api/traces which assembles full span trees for the
// drill-down. All four share one query-parameter shape, so they share one
// builder below.
//
// Latencies come back in MICROSECONDS on `…Us` fields — see formatDurationUs
// in utils/format.js for why that unit is worth being explicit about.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared query string for the traces analytics endpoints. */
const traceAnalyticsParams = ({
  serviceName = '', serviceNames = [], traceId = '', spanName = '', outcome = '',
  search = '', startTime = '', endTime = '', page = 0, size = 25,
} = {}) => {
  const usp = new URLSearchParams({ page: String(page), size: String(size) });
  // Repeated `serviceNames` binds into TraceRequestDTO's List<String>, which
  // the backend turns into `service_name IN (...)`. The scalar `serviceName`
  // is kept for single-value callers.
  const many = (serviceNames || [])
    .map((s) => (s || '').toString().trim())
    .filter((s) => Boolean(s) && s.toUpperCase() !== 'ALL');
  many.forEach((s) => usp.append('serviceNames', s));
  if (!many.length && serviceName && serviceName !== 'ALL') usp.append('serviceName', serviceName);
  if (traceId) usp.append('traceId', traceId.trim());
  if (spanName) usp.append('spanName', spanName.trim());
  if (outcome && outcome !== 'ALL') usp.append('outcome', outcome);
  if (search) usp.append('search', search.trim());
  if (startTime) usp.append('startTime', startTime);
  if (endTime) usp.append('endTime', endTime);
  return usp;
};

const getTraceAnalytics = async (path, opts = {}) => {
  const { signal, ...rest } = opts;
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const url = `${baseUrl}/traces/${path}?${traceAnalyticsParams(rest).toString()}`;
  try {
    const response = await apiFetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name !== 'AbortError') console.error(`Failed to fetch traces/${path}:`, error);
    throw error;
  }
};

/**
 * GET /api/traces/spans — flat, span-grain page.
 * `{ items, total, errorTotal, hasMore, supported, backend }`, where the two
 * totals describe the whole window rather than the page.
 */
export const fetchSpans = (opts) => getTraceAnalytics('spans', opts);

/**
 * GET /api/traces/list — trace-grain page.
 * Each item carries the root operation, span count, status and a `services`
 * breakdown used to draw the Service Latency bar.
 */
export const fetchTraceList = (opts) => getTraceAnalytics('list', opts);

/**
 * GET /api/traces/catalog — per-service volume, error rate and latency
 * percentiles. Percentiles are computed server-side over every matching span.
 */
export const fetchServiceCatalog = (opts) => getTraceAnalytics('catalog', opts);

/**
 * GET /api/traces/histogram — `{ buckets, scatter, interval }` for the
 * Rate / Errors / Duration panels.
 */
export const fetchTraceHistogram = (opts) => getTraceAnalytics('histogram', opts);

/**
 * Fetch metric data points from the lib's GET /api/metrics endpoint.
 *
 * On the OpenObserve backend, each metric is its own stream and metricName
 * is REQUIRED — call fetchMetricStreams() first to populate a dropdown,
 * then pass the chosen name here. On the Elasticsearch backend, metricName
 * is optional.
 */
export const fetchMetrics = async ({
  metricName = "",
  serviceName = "",
  hostName = "",
  startTime = "",
  endTime = "",
  page = 0,
  size = 100
} = {}) => {
  const params = new URLSearchParams({ page, size });
  if (metricName) params.append('metricName', metricName);
  if (Boolean(serviceName) && serviceName.toUpperCase() !== "ALL") params.append('serviceName', serviceName);
  if (hostName) params.append('hostName', hostName);
  if (startTime) params.append('startTime', startTime);
  if (endTime) params.append('endTime', endTime);

  try {
    const baseUrl = getBaseUrl().replace(/\/$/, "");
    const response = await apiFetch(`${baseUrl}/metrics?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) {
      console.warn(`Expected array for metrics, got:`, data);
      return [];
    }
    // Normalize the lib's wire shape (MetricResponseDTO).
    // The lib emits dotted keys via @JsonProperty: "metric.name", "@timestamp",
    // "service.name", "host.name". camelCase aliases are also accepted.
    return data.map(point => ({
      ...point,
      name: point["metric.name"] || point.name || "unknown-metric",
      timestamp: point["@timestamp"] || point.timestamp,
      value: point.value,
      serviceName: point["service.name"] || point.serviceName || point.service_name || "unknown-service",
      hostName: point["host.name"] || point.hostName || point.host_name || null
    }));
  } catch (error) {
    console.error("Failed to fetch metrics:", error);
    throw error;
  }
};

/**
 * Enumerate metric stream names from GET /api/metrics/streams.
 *
 * Returns an empty list when the backend is Elasticsearch (no per-metric
 * stream concept). Used to populate the metric-name dropdown so the user
 * can pick before requesting fetchMetrics() data points.
 */
export const fetchMetricStreams = async () => {
  try {
    const baseUrl = getBaseUrl().replace(/\/$/, "");
    const response = await apiFetch(`${baseUrl}/metrics/streams`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Failed to fetch metric streams:", error);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Summary endpoints — feed the four cards on the Summary tab.
//
// All four return `{ ..., supported: bool, backend: "openobserve"|"elasticsearch" }`.
// When `supported` is false the UI renders an informative empty state rather
// than a network error — that's the agreed shape from the design plan.
// ─────────────────────────────────────────────────────────────────────────────

const buildSummaryUrl = (path, params) => {
  const usp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") usp.append(k, String(v));
  });
  const baseUrl = getBaseUrl().replace(/\/$/, "");
  const qs = usp.toString();
  const queryString = qs ? `?${qs}` : "";
  return `${baseUrl}${path}${queryString}`;
};

/**
 * GET /api/services/uptime — per-service heartbeat + optional process uptime.
 * `window` is a relative expression (`now-1h`) or ISO-8601 start; `livenessSec`
 * controls the UP/DOWN threshold.
 */
export const fetchServicesUptime = async ({ window = "", livenessSec = "", signal } = {}) => {
  try {
    const url = buildSummaryUrl("/services/uptime", { window, livenessSec });
    const response = await apiFetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name !== "AbortError") console.error("Failed to fetch services uptime:", error);
    throw error;
  }
};

/**
 * Distinct service names for filter dropdowns, as RAW backend names (never
 * display-formatted — these go straight back as the `serviceName` query param).
 *
 * Unions two independent sources instead of trusting one:
 *
 *   /logs/services   the purpose-built discovery endpoint, but it only sees
 *                    services that produced LOGS in the window. On the
 *                    OpenObserve backend it answers `supported:true` with an
 *                    empty `items` — a silent empty list, not an error, so a
 *                    caller that reads it alone ends up with an empty dropdown.
 *   /services/uptime the heartbeat inventory — every service currently
 *                    reporting, keyed by the dotted `service.name`.
 *
 * Promise.allSettled, so one endpoint being unsupported, empty or down never
 * costs us the other's results; the list is only empty if BOTH come back empty.
 *
 * `window` applies to log discovery ONLY. The two endpoints do not share window
 * semantics: /services/uptime answers "who is heartbeating", and a wide range
 * returns ZERO rows (measured against OpenObserve: no window → 15 services,
 * now-1h → 15, now-24h → 15, but now-7d → 0). Forwarding a discovery-sized
 * window to it therefore empties the very list we're trying to build, so it is
 * deliberately left to its own default. Override via `uptimeWindow` if needed.
 */
// NOTE ON THE DEFAULT WINDOW — do not widen this back to 7d.
//
// It used to be "now-7d". OpenObserve cannot scan this stream over 7 days: it
// answers HTTP 200 with `hits: []` and a function_error of
// {"code":20006,"message":"Search parquet file not found"}. No error surfaced,
// so /logs/services returned an empty list with supported=true, this function
// fell through to the /services/uptime heartbeat inventory, and the service
// dropdown offered 18 services when 106 were actually producing logs.
//
// 24h is what the backend's own discoverServices() has always used, and it
// returns the full set.
export const fetchServiceNames = async ({ window = "now-24h", uptimeWindow = "", signal } = {}) => {
  const [logsRes, uptimeRes] = await Promise.allSettled([
    fetchLogServices({ window, signal }),
    fetchServicesUptime({ window: uptimeWindow, signal }),
  ]);

  // Case-insensitive de-dupe that keeps the first spelling seen, so a service
  // reported as both "kafkaconnector" and "Kafkaconnector" yields one option.
  const byKey = new Map();
  const add = (name) => {
    const trimmed = (name ?? "").toString().trim();
    if (!trimmed || trimmed === "unknown-service" || trimmed === "-") return;
    const key = trimmed.toUpperCase();
    if (!byKey.has(key)) byKey.set(key, trimmed);
  };

  if (logsRes.status === "fulfilled") (logsRes.value?.items || []).forEach(add);
  if (uptimeRes.status === "fulfilled") {
    (uptimeRes.value?.items || []).forEach((row) =>
      add(row?.["service.name"] ?? row?.serviceName ?? row?.service_name),
    );
  }

  return Array.from(byKey.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Org summary — the Home screen's panels.
//
// STATUS: this endpoint does not exist in the lib yet. It is the agreed contract
// for a new one; until it ships, fetchOrgSummary throws and HomeView renders a
// "not available yet" state naming the path and status. Nothing here queries
// OpenObserve directly — the UI's single-backend contract (see the file header)
// still holds.
//
// Expected: GET /api/org/summary
//
//   {
//     "supported": true,
//     "backend": "openobserve",
//     "org": "default",
//     "streams": {
//       "count":           632,            // number of streams
//       "events":          47800000,       // Σ doc_num
//       "ingestedBytes":   113500000000,   // Σ storage_size (raw bytes)
//       "compressedBytes": 412000000,      // Σ compressed_size
//       "indexBytes":      347000000       // Σ index_size
//     },
//     "functions":  { "count": 0 },
//     "alerts":     { "scheduled": 0, "realTime": 0, "items": [],
//                     "health": { "healthy": 0, "failed": 0, "warning": 0 } },
//     "pipelines":  { "scheduled": 0, "realTime": 0, "items": [],
//                     "health": { "healthy": 0, "failed": 0, "warning": 0 } }
//   }
//
// All five stream figures are derivable from ONE OpenObserve call server-side —
// GET {oo}/api/{org}/streams returns per-stream `stats` carrying doc_num,
// storage_size, compressed_size and index_size — so the backend needs a count
// plus four sums, not five queries.
//
// Sizes are RAW BYTES, never pre-formatted strings: the display unit is a
// presentation choice and belongs on this side.
//
// `items` on alerts/pipelines is optional; absent or empty renders as
// "No data available", matching the reference UI.
// ─────────────────────────────────────────────────────────────────────────────

/** First finite number among the candidates, else null. */
const firstNum = (...candidates) => {
  for (const c of candidates) {
    const n = typeof c === 'string' && c.trim() !== '' ? Number(c) : c;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
};

/**
 * GET /api/org/summary — the figures behind the Home screen's panels.
 *
 * Field reading is deliberately tolerant: the endpoint is not written yet, and
 * whoever writes it may well pass OpenObserve's own snake_case stat names
 * (doc_num / storage_size / compressed_size / index_size) straight through. Both
 * spellings are accepted, and a flat top-level shape is accepted alongside the
 * nested one, so the UI works on the first deploy either way.
 *
 * Throws on a non-OK response with `.status` attached, so the caller can tell
 * "endpoint isn't deployed" from "the query failed".
 */
export const fetchOrgSummary = async ({ signal } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const url = `${baseUrl}/org/summary`;

  let response;
  try {
    response = await apiFetch(url, { signal });
  } catch (error) {
    if (error.name !== 'AbortError') console.error('Failed to fetch org summary:', error);
    throw error;
  }
  if (!response.ok) {
    const err = new Error(`GET /org/summary returned HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const s = data?.streams || {};
  const f = data?.functions || {};
  const a = data?.alerts || {};
  const p = data?.pipelines || {};

  const splitCounts = (node, flatScheduled, flatRealTime) => ({
    scheduled: firstNum(node.scheduled, node.scheduledCount, node.scheduled_count, flatScheduled),
    realTime: firstNum(
      node.realTime, node.real_time, node.realtime,
      node.realTimeCount, node.real_time_count, flatRealTime,
    ),
    items: Array.isArray(node.items) ? node.items : [],
    // Trigger outcomes (healthy / failed / warning) behind the card's bar chart.
    // Null — not three zeros — when the backend could not read them.
    health: typeof node.health === 'object' && node.health !== null
      ? {
        healthy: firstNum(node.health.healthy),
        failed: firstNum(node.health.failed),
        warning: firstNum(node.health.warning),
      }
      : null,
  });

  return {
    supported: data?.supported !== false,
    backend: data?.backend ?? null,
    org: data?.org ?? data?.orgId ?? data?.org_id ?? null,
    streams: {
      count: firstNum(s.count, s.streamCount, data?.streamCount, data?.stream_count),
      events: firstNum(s.events, s.eventCount, s.docNum, s.doc_num, data?.events),
      ingestedBytes: firstNum(
        s.ingestedBytes, s.ingested_bytes, s.ingestedSize, s.ingested_size,
        s.storageSize, s.storage_size, data?.ingestedBytes,
      ),
      compressedBytes: firstNum(
        s.compressedBytes, s.compressed_bytes, s.compressedSize, s.compressed_size,
        data?.compressedBytes,
      ),
      indexBytes: firstNum(
        s.indexBytes, s.index_bytes, s.indexSize, s.index_size, data?.indexBytes,
      ),
    },
    functions:  { count: firstNum(f.count, data?.functionCount, data?.function_count) },
    alerts:     splitCounts(a, data?.alertsScheduled, data?.alertsRealTime),
    pipelines:  splitCounts(p, data?.pipelinesScheduled, data?.pipelinesRealTime),
  };
};

/** GET /api/logs/summary — severity counts + top error services for a window. */
export const fetchLogsSummary = async ({ window = "" } = {}) => {
  try {
    const url = buildSummaryUrl("/logs/summary", { window });
    const response = await apiFetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Failed to fetch logs summary:", error);
    throw error;
  }
};

/** GET /api/traces/summary — trace count, error rate, latency stats, slowest ops. */
export const fetchTracesSummary = async ({ window = "" } = {}) => {
  try {
    const url = buildSummaryUrl("/traces/summary", { window });
    const response = await apiFetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Failed to fetch traces summary:", error);
    throw error;
  }
};

/**
 * GET /api/metrics/summary — sparkline data for jvmHeap / cpuUsage / threadsLive / httpReqsCount.
 *
 * {@code serviceName} is required by the backend; if it's omitted the response
 * comes back with supported=true but empty sparklines (no fleet-wide averaging
 * — that would be operationally meaningless). The Summary screen's Metrics
 * card holds the picker that drives this value.
 */
export const fetchMetricsSummary = async ({ window = "", bucketSec = "", serviceName = "" } = {}) => {
  try {
    const url = buildSummaryUrl("/metrics/summary", { window, bucketSec, serviceName });
    const response = await apiFetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Failed to fetch metrics summary:", error);
    throw error;
  }
};

/**
 * GET /api/services/{name}/vitals — per-service vital signs roll-up.
 *
 * Returns { serviceName, windowStart, windowEnd, bucketSec, backend, supported,
 *           tiles: { reqRate, errorRate, latencyMs, poolActive, heapUsedMb, errorLogRate }
 *                  -- each { latest, sparkline: [{timestamp, value}], unit, label } --,
 *           downstream: [{ clientName, reqRate, errorRatePct, maxLatencyMs }],
 *           notes: [string] }.
 *
 * Tiles whose underlying metric stream isn't available are absent from the
 * `tiles` map entirely (not present-with-null) — the drawer iterates a fixed
 * tile order and shows "—" for absent ones.
 */
export const fetchServiceVitals = async (serviceName, { window = "", bucketSec = "" } = {}) => {
  if (!serviceName) throw new Error("fetchServiceVitals: serviceName is required");
  try {
    const baseUrl = getBaseUrl().replace(/\/$/, "");
    const encoded = encodeURIComponent(serviceName);
    const usp = new URLSearchParams();
    if (window) usp.append("window", window);
    if (bucketSec) usp.append("bucketSec", String(bucketSec));
    const qs = usp.toString();
    const queryString = qs ? `?${qs}` : "";
    const url = `${baseUrl}/services/${encoded}/vitals${queryString}`;
    const response = await apiFetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error("Failed to fetch service vitals:", error);
    throw error;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// IAM — organizations, org members, service accounts.
//
// Read-only. Creating users and minting service-account tokens stays in
// OpenObserve's own UI: this service authenticates with one shared service
// account, so any write would be attributed to that account rather than to the
// person who asked for it.
// ─────────────────────────────────────────────────────────────────────────────

const getIam = async (path, { signal, org } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  // An explicit `org` wins over the globally selected one — the Organizations
  // tab needs to ask about a specific org regardless of what's active.
  const qs = org ? `?org=${encodeURIComponent(org)}` : '';
  try {
    const response = await apiFetch(`${baseUrl}/iam/${path}${qs}`, { signal });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error.name !== 'AbortError') console.error(`Failed to fetch iam/${path}:`, error);
    throw error;
  }
};

/**
 * GET /api/iam/organizations — every organization on the instance.
 * Global by definition: it's the list the org switcher chooses from.
 */
export const fetchOrganizations = (opts) => getIam('organizations', opts);

/** GET /api/iam/users — members of the active (or given) organization. */
export const fetchIamUsers = (opts) => getIam('users', opts);

/** GET /api/iam/service-accounts — service accounts in the active organization. */
export const fetchServiceAccounts = (opts) => getIam('service-accounts', opts);

// ─────────────────────────────────────────────────────────────────────────────
// Metrics — PromQL, via the backend's Prometheus passthrough.
//
// Separate from fetchMetrics/fetchMetricsSummary above, which hit the
// SQL-backed endpoints behind the summary cards. These four speak to
// /api/metrics/{catalog,labels,label-values,query-range} and return series.
//
// Time is sent in the SAME relative form as everywhere else ("now-1h"). The
// backend converts to the epoch SECONDS Prometheus wants, deliberately: the
// browser clock is not the server clock, and a client-computed instant bakes
// in whatever skew the user's machine has.
// ─────────────────────────────────────────────────────────────────────────────

const getMetricsJson = async (path, params, signal) => {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  });
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const queryString = qs.toString() ? `?${qs}` : '';
  const url = `${baseUrl}/metrics/${path}${queryString}`;
  const res = await apiFetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
  return res.json();
};

/**
 * GET /api/metrics/catalog — every metric name with type/help/unit, plus the
 * group it was sorted into.
 *
 * `group`/`technology`/`shared` come from the backend's MetricClassifier, not
 * from here: which exporters this deployment runs is a server-side fact, and
 * operators can extend the rules via `metrics.classification.extra-rules`
 * without a UI release. `groups` is the facet list, already ordered and
 * counted, so the sidebar never recomputes it over 3,000 items.
 *
 * @returns {Promise<{items: Array<{name,type,help,unit,group,technology,shared}>,
 *                    groups: Array<{key,label,count,technologies:Array<{name,count}>}>,
 *                    total: number, supported: boolean, error: ?string}>}
 */
export const fetchMetricCatalog = async ({ signal } = {}) => {
  try {
    const data = await getMetricsJson('catalog', {}, signal);
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      groups: Array.isArray(data?.groups) ? data.groups : [],
      total: Number(data?.total) || 0,
      supported: data?.supported !== false,
      error: data?.error || null,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Metric catalog failed:', err);
    return {
      items: [], groups: [], total: 0, supported: false, error: err.message,
    };
  }
};

/**
 * GET /api/metrics/producers — the catalogue inverted: which service exposes
 * which metrics.
 *
 * The backend cannot answer this with one query (OpenObserve refuses every
 * reverse-index shape), so it sweeps all ~3,200 metric names in the background
 * — about 90 seconds cold. This call therefore never blocks: while
 * `building` is true, `progressDone`/`progressTotal` advance and `services` is
 * whatever was last built (empty on a cold start). Poll until `building` clears.
 *
 * A running sweep republishes as it goes, so `services` fills in during the
 * build rather than appearing all at once at the end; `partial` is true for
 * those intermediate answers and their counts are lower bounds.
 *
 * `ageSeconds` is not decoration either: a stale index keeps being served while
 * a refresh runs, and the screen is expected to say how old it is.
 */
export const fetchMetricProducers = async ({ signal } = {}) => {
  try {
    const data = await getMetricsJson('producers', {}, signal);
    return {
      services: Array.isArray(data?.services) ? data.services : [],
      building: data?.building === true,
      partial: data?.partial === true,
      progressDone: Number(data?.progressDone) || 0,
      progressTotal: Number(data?.progressTotal) || 0,
      builtAt: data?.builtAt || null,
      ageSeconds: Number(data?.ageSeconds) || 0,
      buildMillis: Number(data?.buildMillis) || 0,
      windowSeconds: Number(data?.windowSeconds) || 0,
      metricsProbed: Number(data?.metricsProbed) || 0,
      metricsWithNoData: Number(data?.metricsWithNoData) || 0,
      metricsUnscoped: Number(data?.metricsUnscoped) || 0,
      probeFailures: Number(data?.probeFailures) || 0,
      supported: data?.supported !== false,
      error: data?.error || null,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Metric producers failed:', err);
    return {
      services: [], building: false, partial: false, progressDone: 0, progressTotal: 0,
      builtAt: null, ageSeconds: 0, buildMillis: 0, windowSeconds: 0,
      metricsProbed: 0, metricsWithNoData: 0, metricsUnscoped: 0, probeFailures: 0,
      supported: false, error: err.message,
    };
  }
};

/**
 * POST /api/metrics/producers/refresh — rebuild the index now.
 *
 * Returns the same shape as the GET, with `building` set. The previous answer
 * keeps being served meanwhile, so the caller can leave the table on screen.
 */
export const refreshMetricProducers = async () => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  try {
    const res = await apiFetch(`${baseUrl}/metrics/producers/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    return res.json();
  } catch (err) {
    console.error('Metric producers refresh failed:', err);
    return null;
  }
};

/** GET /api/metrics/labels — label names, optionally scoped to one metric. */
export const fetchMetricLabels = async ({ metric = '', signal } = {}) => {
  try {
    const data = await getMetricsJson('labels', { metric }, signal);
    return Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Metric labels failed:', err);
    return [];
  }
};

/** GET /api/metrics/label-values — the distinct values of one label. */
export const fetchMetricLabelValues = async ({ label, metric = '', signal } = {}) => {
  if (!label) return [];
  try {
    const data = await getMetricsJson('label-values', { label, metric }, signal);
    return Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Metric label values failed:', err);
    return [];
  }
};

/**
 * GET /api/metrics/query-range — PromQL over a window.
 *
 * Points arrive as [epochSeconds, "value"] with the value a STRING, which is
 * how Prometheus preserves int64 precision. They are converted to numbers here,
 * once, so no component downstream has to remember to. A value that does not
 * parse (NaN, +Inf, the gaps Prometheus emits) becomes null rather than NaN —
 * null is a hole the chart can skip, NaN poisons every min/max it touches.
 *
 * @returns {Promise<{resultType: ?string, series: Array<{labels, points}>,
 *                    supported: boolean, error: ?string}>}
 */
export const fetchMetricRange = async ({
  query, startTime = '', endTime = '', step = 0, signal,
} = {}) => {
  if (!query?.trim()) {
    return { resultType: null, series: [], supported: true, error: null };
  }
  try {
    const data = await getMetricsJson('query-range', {
      query, startTime, endTime, step: step > 0 ? step : '',
    }, signal);
    return normalizePromResult(data);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Metric range query failed:', err);
    return { resultType: null, series: [], supported: false, error: err.message };
  }
};

/** GET /api/metrics/query — PromQL at a single instant. */
export const fetchMetricInstant = async ({ query, time = '', signal } = {}) => {
  if (!query?.trim()) {
    return { resultType: null, series: [], supported: true, error: null };
  }
  try {
    return normalizePromResult(await getMetricsJson('query', { query, time }, signal));
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Metric instant query failed:', err);
    return { resultType: null, series: [], supported: false, error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure utilization — the four Settings → Resource tiles.
//
// ONE request for CPU, Memory, Disk and NFS Storage, replacing the nine PromQL
// range queries this screen used to issue plus the two discovery queries needed
// to work out what to put in them. That chain is why the screen went blank: the
// pod-discovery query read `zo_node_disk_usage`, an OpenObserve self-monitoring
// metric that has stopped being written (13 rows in seven days, newest ~2.8 days
// old). An empty discovery result produced an empty pod selector, and an empty
// selector made the CPU and Memory queries match nothing — so one dead stream
// took out three of the four cards even though `k8s_pod_cpu_usage` and
// `k8s_pod_memory_usage` were both a minute fresh.
//
// The backend now owns stream selection, the window and the arithmetic
// (InfrastructureMetricsServiceImpl), so a stream that moves or dies becomes a
// server-side configuration change rather than a UI release.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/infrastructure/utilization — live CPU, Memory, Disk, NFS Storage.
 *
 * Resolves with a `supported:false` envelope rather than throwing, matching every
 * other read in this file: the screen renders its four tiles with the reason on
 * whichever ones are unavailable, which is more useful than an error page.
 *
 * @param {object}  opts
 * @param {string}  [opts.node]     restrict to one Kubernetes node; '' for all
 * @param {boolean} [opts.refresh]  bypass the backend's short cache
 * @returns {Promise<{items: Array, nodes: Array, org: ?string,
 *                    capturedAt: ?string, cached: boolean,
 *                    supported: boolean, error: ?string}>}
 */
export const fetchInfrastructureUtilization = async ({
  node = '', refresh = false, signal,
} = {}) => {
  const params = new URLSearchParams();
  if (node) params.set('node', node);
  if (refresh) params.set('refresh', 'true');

  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const qs = params.toString();
  const queryString = qs ? `?${qs}` : '';
  const url = `${baseUrl}/infrastructure/utilization${queryString}`;

  try {
    const res = await apiFetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      nodes: Array.isArray(data?.nodes) ? data.nodes : [],
      org: data?.org ?? null,
      capturedAt: data?.capturedAt ?? null,
      cached: data?.cached === true,
      // `supported:false` is the backend saying OpenObserve is switched off. It
      // still returns all four tiles, each carrying its own message.
      supported: data?.supported !== false,
      error: null,
    };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Infrastructure utilization failed:', err);
    return {
      items: [], nodes: [], org: null, capturedAt: null, cached: false,
      supported: false, error: err.message,
    };
  }
};

/** Shared shape for both query endpoints. See the note on fetchMetricRange. */
const normalizePromResult = (data) => ({
  resultType: data?.resultType || null,
  supported: data?.supported !== false,
  error: data?.error || null,
  series: (Array.isArray(data?.series) ? data.series : []).map((s) => ({
    labels: typeof s?.labels === 'object' && s.labels !== null ? s.labels : {},
    points: (Array.isArray(s?.values) ? s.values : [])
      .map((p) => {
        const t = Number(p?.[0]);
        const v = Number(p?.[1]);
        return { t: t * 1000, v: Number.isFinite(v) ? v : null };
      })
      .filter((p) => Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t),
  })),
});

// ─────────────────────────────────────────────────────────────────────────────
// Alerts — definitions, folders and notification targets.
//
// The ONLY writing section in this client. Alerts live in exactly one place,
// OpenObserve, and are authored both here and in OpenObserve's own UI; the
// backend is a conduit rather than a second store, so an alert saved here shows
// up there immediately and vice versa.
//
// Two conventions differ from the read-only sections above and both are
// deliberate:
//
//  1. A failed write REJECTS instead of resolving to a `supported:false`
//     envelope. A list that quietly comes back empty is a degraded screen; a
//     SAVE that quietly does nothing is a missing alert nobody knows about. The
//     caller has to see it.
//
//  2. Errors carry the backend's own message. The reason a save was rejected
//     ("Alert with this name already exists", a bad cron expression) comes from
//     OpenObserve and is the only thing that tells the user what to fix, so it
//     is parsed out of the error body rather than replaced with a status code.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a non-2xx response into an Error carrying the server's explanation.
 *
 * The backend answers failures as `{"error": "..."}` (GlobalExceptionHandler);
 * OpenObserve's own message is threaded through that, so it is usually the
 * actionable part. Falls back to the status when the body is unreadable.
 */
const alertsError = async (response) => {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error || body?.message || '';
  } catch {
    // Non-JSON body (a proxy error page, say) — the status is all we have.
  }
  if (detail) return new Error(detail);

  // A bodyless 403 from this API is almost always Spring's CORS filter
  // rejecting the METHOD, not a permissions problem — it answers
  // "Invalid CORS request" as plain text with no JSON. It bit the enable /
  // trigger / move routes once already (CorsConfig listed every verb except
  // PATCH), and the bare status gave no hint where to look: GET worked, so the
  // backend looked fine, and curl reproduced nothing because it sends no Origin
  // header. Naming the likely cause here is what makes it findable next time.
  if (response.status === 403) {
    return new Error(
      'Request failed (HTTP 403). A 403 with no message from this API usually means '
      + "the backend's CORS configuration does not allow this request's HTTP method "
      + '— check allowedMethods in CorsConfig includes PATCH.',
    );
  }
  return new Error(`Request failed (HTTP ${response.status})`);
};

/** GET under /api/alerts, returning parsed JSON. */
const getAlertsJson = async (path, params, signal) => {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  });
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const queryString = qs.toString() ? `?${qs}` : '';
  const url = `${baseUrl}/alerts${path}${queryString}`;
  const res = await apiFetch(url, { signal });
  if (!res.ok) throw await alertsError(res);
  return res.json();
};

/** POST/PUT/PATCH/DELETE under /api/alerts, returning parsed JSON. */
const sendAlertsJson = async (method, path, body, params) => {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  });
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const queryString = qs.toString() ? `?${qs}` : '';
  const url = `${baseUrl}/alerts${path}${queryString}`;
  const res = await apiFetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await alertsError(res);
  // 204 and empty 200s are legitimate here (DELETE), so an unparseable body is
  // treated as success-with-no-content rather than as a failure.
  const text = await res.text();
  if (!text) return { ok: true };
  try { return JSON.parse(text); } catch { return { ok: true }; }
};

/*
 * There is deliberately no fetchIncidents / GET /api/incidents.
 *
 * It served a separate correlation engine that grouped alerts by fuzzy dimension
 * similarity — a second, disagreeing answer to "what is currently wrong". Incidents
 * are now the alert episodes themselves, keyed deterministically by
 * org + service + type, so fetchAlerts2 IS the incident list: one row per grouping
 * key, carrying its current severity, occurrence count and latest values.
 *
 * fetchOpenObserveIncidents below is a different feature and still current — those
 * are incidents OpenObserve itself raised and pushed here by webhook, rather than
 * anything aggregated from our own alert stream.
 */

/** GET /api/oo-incidents — OpenObserve webhook-synced incidents. */
export const fetchOpenObserveIncidents = async ({ signal } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const res = await apiFetch(`${baseUrl}/oo-incidents`, { signal });
  if (!res.ok) throw await alertsError(res);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
};

/** GET /api/oo-incidents/{id} — one OpenObserve webhook incident by UUID. */
export const fetchOpenObserveIncident = async (id, { signal } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const res = await apiFetch(`${baseUrl}/oo-incidents/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw await alertsError(res);
  return res.json();
};

/**
 * GET /api/alerts — the alert list.
 *
 * @param {object}  opts
 * @param {string}  [opts.folder]     folder id; omit for every folder
 * @param {string}  [opts.alertType]  'all' | 'scheduled' | 'realtime' | 'anomaly_detection'
 * @param {string}  [opts.search]     case-insensitive name substring
 * @param {boolean} [opts.enabled]    filter by enabled state
 * @returns {Promise<{items: Array, org: ?string, supported: boolean, total: ?number}>}
 */
export const fetchAlerts = async ({
  folder = '', alertType = '', search = '', streamType = '', streamName = '',
  owner = '', enabled = undefined, pageSize = 0, pageIdx = 0, signal,
} = {}) => {
  const params = { folder, alertType, search, streamType, streamName, owner };
  // Booleans and zero are meaningful, so they cannot go through the
  // truthiness filter in getAlertsJson — they are set explicitly.
  if (enabled === true || enabled === false) params.enabled = String(enabled);
  if (pageSize > 0) {
    params.pageSize = pageSize;
    if (pageIdx > 0) params.pageIdx = pageIdx;
  }
  const data = await getAlertsJson('', params, signal);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    org: data?.org ?? null,
    supported: data?.supported !== false,
    total: data?.total ?? null,
  };
};

/**
 * GET /api/alerts/{id} — one alert's full definition.
 *
 * `alert` is OpenObserve's own document, passed through untouched. The editor
 * MUST keep it and merge its edits into it rather than rebuilding it from the
 * form fields: it carries keys this UI does not render, and reconstructing it
 * would drop them on save.
 */
export const fetchAlert = async (alertId, { signal } = {}) => {
  const data = await getAlertsJson(`/${encodeURIComponent(alertId)}`, {}, signal);
  return {
    alert: data?.alert || null,
    alertId: data?.alertId || alertId,
    folderId: data?.folderId || null,
    supported: data?.supported !== false,
  };
};

/** POST /api/alerts — create. `alert` is a full OpenObserve alert document. */
export const createAlert = ({ alert, folderId = 'default' }) =>
  sendAlertsJson('POST', '', { alert, folderId });

/** PUT /api/alerts/{id} — replace. */
export const updateAlert = (alertId, { alert, folderId = 'default' }) =>
  sendAlertsJson('PUT', `/${encodeURIComponent(alertId)}`, { alert, folderId });

/** DELETE /api/alerts/{id}. */
export const deleteAlert = (alertId) =>
  sendAlertsJson('DELETE', `/${encodeURIComponent(alertId)}`);

/**
 * PATCH /api/alerts/{id}/enable — toggle without touching the definition.
 *
 * Used by the list's row switch. Deliberately not a full update: re-saving the
 * whole document just to flip a boolean would also write back whatever the
 * browser was holding, which may be stale.
 */
export const setAlertEnabled = (alertId, enabled) =>
  sendAlertsJson('PATCH', `/${encodeURIComponent(alertId)}/enable`, undefined,
    { value: String(!!enabled) });

/** PATCH /api/alerts/{id}/trigger — evaluate now, ignoring the schedule. */
export const triggerAlert = (alertId) =>
  sendAlertsJson('PATCH', `/${encodeURIComponent(alertId)}/trigger`);

/** POST /api/alerts/{id}/clone. */
export const cloneAlert = (alertId, { name = '', folderId = '' } = {}) =>
  sendAlertsJson('POST', `/${encodeURIComponent(alertId)}/clone`, { name, folderId });

/** PATCH /api/alerts/move — relocate alerts to another folder. */
export const moveAlerts = ({ alertIds, targetFolderId }) =>
  sendAlertsJson('PATCH', '/move', { alertIds, targetFolderId });

/**
 * POST /api/alerts/import — import one or many documents.
 *
 * @returns {Promise<Array<{name, ok, message, alertId}>>} one outcome per
 *   document; a malformed entry fails on its own without discarding the rest.
 */
export const importAlerts = ({ alerts, folderId = 'default' }) =>
  sendAlertsJson('POST', '/import', { alerts, folderId });

/**
 * GET /api/alerts/folders.
 *
 * OpenObserve's root folder is addressed by the literal id "default". It is
 * included here, but a fresh instance may not have materialised it yet, so
 * callers should treat "default" as always available — see AlertsView, which
 * synthesises it when absent.
 */
export const fetchAlertFolders = async ({ signal } = {}) => {
  const data = await getAlertsJson('/folders', {}, signal);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    supported: data?.supported !== false,
  };
};

/** POST /api/alerts/folders. */
export const createAlertFolder = ({ name, description = '' }) =>
  sendAlertsJson('POST', '/folders', { name, description });

/** PUT /api/alerts/folders/{id}. */
export const updateAlertFolder = (folderId, { name, description = '' }) =>
  sendAlertsJson('PUT', `/folders/${encodeURIComponent(folderId)}`, { name, description });

/** DELETE /api/alerts/folders/{id}. */
export const deleteAlertFolder = (folderId) =>
  sendAlertsJson('DELETE', `/folders/${encodeURIComponent(folderId)}`);

/** GET /api/alerts/destinations — what an alert can notify. */
export const fetchAlertDestinations = async ({ signal } = {}) => {
  const data = await getAlertsJson('/destinations', {}, signal);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    supported: data?.supported !== false,
  };
};

/**
 * POST /api/alerts/destinations.
 *
 * A `template` is required. Without one OpenObserve silently creates a PIPELINE
 * destination, which never appears in the alert editor's list — the backend
 * rejects that case rather than letting it look like it worked.
 */
export const createAlertDestination = (destination) =>
  sendAlertsJson('POST', '/destinations', destination);

/** GET /api/alerts/templates — notification body templates. */
export const fetchAlertTemplates = async ({ signal } = {}) => {
  const data = await getAlertsJson('/templates', {}, signal);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    supported: data?.supported !== false,
  };
};

/**
 * GET /api/alerts/streams — stream names for the editor's Stream Name select.
 *
 * `scopeType`/`scopeKey` are OPTIONAL and omitted from the query string when
 * absent, so a caller that does not pass them gets the identical unnarrowed
 * list it has always got. See `fetchScopedAlertStreams` for the wizard's use of
 * them, and for why the narrowing has to be reported separately from the list.
 */
export const fetchAlertStreams = async ({
  type = 'logs', scopeType, scopeKey, signal,
} = {}) => {
  const data = await getAlertsJson('/streams', { type, scopeType, scopeKey }, signal);
  return Array.isArray(data?.items) ? data.items : [];
};

/**
 * The same route, but reporting WHETHER the list was actually narrowed.
 *
 * Supply `scopeType` + `scopeKey` — `resource` with a Product Catalog row id,
 * `service` with a resolved `service_name`, or `product` with a product code —
 * and the backend answers with the streams that genuinely carry that scope:
 * for `metrics` the metric names it emits (a metric is its own stream in
 * OpenObserve), for `logs` and `traces` the streams a probe found its rows in.
 *
 * `scoped` is the part that cannot be dropped. `false` does NOT mean "this
 * service has no streams" — it means the backend could not work the narrowing
 * out and handed back everything instead, with the reason in `notice`. Rendered
 * identically to a real narrowing, that would let someone pick a stream their
 * service never writes to while believing the list had vouched for it, and the
 * resulting rule validates, syncs, reports itself healthy and never fires.
 *
 * @returns {Promise<{items: string[], scoped: boolean, requested: boolean, notice: string}>}
 */
export const fetchScopedAlertStreams = async ({
  type = 'logs', scopeType, scopeKey, signal,
} = {}) => {
  const data = await getAlertsJson('/streams', { type, scopeType, scopeKey }, signal);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    // Absent on the unscoped path and on a backend that predates the flag;
    // either way the honest answer is "not narrowed".
    scoped: data?.scoped === true,
    /** Did WE ask for a narrowing? Distinguishes "not scoped" from "not asked". */
    requested: !!(scopeType && scopeKey),
    notice: data?.notice || '',
  };
};

/**
 * GET /api/alerts/streams/{name}/fields — column names for the condition builder.
 *
 * An empty array is normal, not an error: a stream that has not been written to
 * has no schema yet. The condition builder falls back to a free-text column
 * input in that case rather than blocking the user.
 */
export const fetchAlertStreamFields = async ({ type = 'logs', streamName, signal } = {}) => {
  if (!streamName) return [];
  const data = await getAlertsJson(
    `/streams/${encodeURIComponent(streamName)}/fields`, { type }, signal,
  );
  return Array.isArray(data?.items) ? data.items : [];
};

/**
 * GET /api/alerts/streams/{name}/schema — column names WITH their types.
 *
 * Feeds the wizard's aggregation-column picker, which may only offer columns an
 * aggregate can be computed over: "avg of service_name" is not a question with
 * an answer, and OpenObserve's own alert UI offers only numeric columns there.
 *
 * Falls back to the plain `/fields` names when the route is not there — a
 * backend older than this endpoint answers 404, and the wizard is more useful
 * offering every column than offering none. Each fallback entry is reported as
 * `numeric: true` so nothing is filtered out on information we do not have.
 */
export const fetchAlertStreamSchema = async ({ type = 'logs', streamName, signal } = {}) => {
  if (!streamName) return [];
  try {
    const data = await getAlertsJson(
      `/streams/${encodeURIComponent(streamName)}/schema`, { type }, signal,
    );
    return Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const names = await fetchAlertStreamFields({ type, streamName, signal });
    return names.map((name) => ({ name, type: null, numeric: true }));
  }
};

/**
 * POST /api/alert-builder/preview — run a draft rule against real data.
 *
 * Deliberately NOT under `/alerts`: the builder routes are read-only, need no
 * rule to exist, and are mounted separately so they stay available on a
 * deployment with no rules database. Nothing here is stored.
 *
 * The answer is a LADDER, not a number. Step 0 is the window with no conditions
 * at all and each later step adds exactly one, so "matches nothing" separates
 * into its four different causes — wrong stream, wrong window, one bad
 * condition, or a rule that is simply correct and quiet — instead of arriving as
 * a single zero the operator has to guess at. `evaluation` then answers the
 * other question: whether that amount crosses the trigger.
 *
 * An UNSUPPORTED backend resolves rather than throwing, the same way
 * {@link validateCompositeExpression} does: a preview is an aid, and an editor
 * whose backend predates this route must stay usable without it.
 */
const normalizePreview = (data, streamType, streamName) => ({
  supported: data?.supported !== false,
  streamType: data?.streamType ?? streamType,
  streamName: data?.streamName ?? streamName,
  mode: data?.mode ?? null,
  periodMinutes: data?.periodMinutes ?? null,
  windowStart: data?.windowStart ?? null,
  windowEnd: data?.windowEnd ?? null,
  sql: data?.sql ?? '',
  scopeLabel: data?.scopeLabel ?? null,
  steps: Array.isArray(data?.steps) ? data.steps : [],
  evaluation: data?.evaluation || { evaluated: false },
  durationMs: data?.durationMs ?? 0,
  notice: data?.notice ?? '',
  error: data?.error ?? '',
});

export const previewAlert = async ({
  streamType, streamName, queryCondition, triggerCondition,
  periodMinutes, sampleSize = 0, scopeType, scopeKey, signal,
} = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const body = {
    streamType,
    streamName,
    queryCondition,
    triggerCondition,
    periodMinutes,
    sampleSize,
    scopeType: scopeType || undefined,
    scopeKey: scopeKey || undefined,
  };
  try {
    const res = await apiFetch(`${baseUrl}/alert-builder/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await alertsError(res);
    return normalizePreview(await res.json(), streamType, streamName);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      supported: false,
      steps: [],
      evaluation: { evaluated: false },
      error: err?.message || 'The preview could not be run.',
    };
  }
};

/**
 * POST /api/alerts/composites/validate — check a composite's boolean expression.
 *
 * A composite alert combines the CURRENT STATES of other alerts and never
 * queries a stream, so whether an expression is usable is a question only
 * OpenObserve can answer: it resolves every referenced alert, checks the caller
 * may read it, checks it is eligible to be composed, and checks the reference
 * graph stays acyclic. The answer also carries each child's current state, which
 * is what the expression preview renders.
 *
 * A REJECTED expression resolves rather than throwing — `{valid: false, message}`
 * is the answer, not a failure. Only a transport error rejects, and even that is
 * softened to an unsupported result so an editor whose backend predates this
 * route stays usable.
 */
export const validateCompositeExpression = async ({
  expression, staleChildPolicy = 'use_last_state', warningCountsAsFiring = true,
  compositeId = null, signal,
} = {}) => {
  const body = {
    compositeCondition: {
      expression,
      stale_child_policy: staleChildPolicy,
      warning_counts_as_firing: warningCountsAsFiring,
    },
    compositeId,
  };
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  try {
    const res = await apiFetch(`${baseUrl}/alerts/composites/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await alertsError(res);
    const data = await res.json();
    return {
      valid: !!data?.valid,
      supported: data?.supported !== false,
      canonicalExpression: data?.canonicalExpression ?? null,
      result: typeof data?.result === 'boolean' ? data.result : null,
      resultLevel: data?.resultLevel ?? null,
      code: data?.code ?? null,
      message: data?.message ?? '',
      children: Array.isArray(data?.children) ? data.children : [],
      warnings: Array.isArray(data?.warnings) ? data.warnings : [],
    };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // Unsupported rather than invalid: the expression may be perfectly good and
    // we simply could not ask. Calling it invalid would block a correct save.
    return {
      valid: false, supported: false, canonicalExpression: null, result: null,
      resultLevel: null, code: null, message: err?.message || 'Could not reach the validator.',
      children: [], warnings: [],
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Fired-alert notifications  (PostgreSQL-backed, NOT OpenObserve pass-through)
//
// All of these go to /api/alerts/notifications/* which is a completely separate
// set of endpoints from /api/alerts (the OpenObserve rule store).
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/alerts/notifications — active / historical fired alerts. */
export const fetchAlertNotifications = async ({
  state = '',       // '' = unresolved only | 'firing' | 'acknowledged' | 'resolved' | 'all'
  severity = '',    // critical | error | warning | info
  search = '',      // alert name substring
  streamName = '',
  limit = 200,
  signal,
} = {}) => {
  const data = await getAlertsJson('/notifications', { state, severity, search, streamName, limit }, signal);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    org: data?.org ?? null,
    supported: data?.supported !== false,
    total: data?.total ?? null,
    backend: data?.backend ?? null,
  };
};

/** GET /api/alerts/notifications/summary — badge counts. */
export const fetchAlertNotificationsSummary = async ({ signal } = {}) => {
  const data = await getAlertsJson('/notifications/summary', {}, signal);
  return {
    org: data?.org ?? null,
    supported: data?.supported !== false,
    firing: data?.firing ?? 0,
    acknowledged: data?.acknowledged ?? 0,
    resolved: data?.resolved ?? 0,
    // needsAttention = firing + acknowledged — the count the nav badge should show.
    // The backend computes this directly; fall back to the sum if absent.
    needsAttention: data?.needsAttention ?? ((data?.firing ?? 0) + (data?.acknowledged ?? 0)),
    bySeverity: data?.bySeverity ?? {},
  };
};

/**
 * GET /api/alerts/notifications/history — event log for one fingerprint.
 *
 * NOTE: history items have null alertName / severity / streamName (backend
 * limitation — alert_events doesn't store them). The caller must supply those
 * from the parent alert row rather than relying on the history items.
 */
export const fetchAlertNotificationHistory = async ({
  fingerprint,
  hours = 168, // 7 days
  signal,
} = {}) => {
  if (!fingerprint) return { items: [], total: 0 };
  const data = await getAlertsJson(
    '/notifications/history',
    { fingerprint, hours },
    signal,
  );
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: data?.total ?? 0,
  };
};

/** POST /api/alerts/notifications/{fingerprint}/acknowledge */
export const acknowledgeAlertNotification = (fingerprint, { actor = '', note = '' } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const url = `${baseUrl}/alerts/notifications/${encodeURIComponent(fingerprint)}/acknowledge`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor, note }),
  }).then(async (res) => {
    if (!res.ok) throw await alertsError(res);
    return res.json();
  });
};

/** POST /api/alerts/notifications/{fingerprint}/resolve */
export const resolveAlertNotification = (fingerprint, { actor = '', note = '' } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const url = `${baseUrl}/alerts/notifications/${encodeURIComponent(fingerprint)}/resolve`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor, note }),
  }).then(async (res) => {
    if (!res.ok) throw await alertsError(res);
    return res.json();
  });
};

/**
 * PUT /api/iam/users/{email} — update an organization member.
 *
 * Lives beside the alerts writes rather than with the IAM reads because it
 * shares their error convention: it rejects with the server's message so the
 * drawer can show why a change was refused.
 *
 * Attribution caveat: this deployment authenticates to OpenObserve with one
 * shared service account, so OpenObserve's audit trail records that account as
 * the editor — not whoever clicked Save. See IamService on the backend.
 */
export const updateIamUser = async (email, payload) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const res = await apiFetch(`${baseUrl}/iam/users/${encodeURIComponent(email)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await alertsError(res);
  return res.json();
};

// ─────────────────────────────────────────────────────────────────────────────
// Alerts — the enterprise screen.
//
// These hit /api/alerts/query, which is a SEPARATE contract from the older
// /api/alerts/notifications the previous screen used. That one still exists and
// still answers exactly as it did; this one adds the columns it never had
// (service, host, source, duration, closed-by, reopen count), multi-select
// filters, server-side sorting and the CLOSED / REOPENED transitions.
//
// Transitions take a numeric alert id, not a fingerprint. A fingerprint
// identifies the alert SERIES across every episode it has ever had, so
// acknowledging by fingerprint would be ambiguous about which episode the
// operator was looking at. An id is the row they clicked.
// ─────────────────────────────────────────────────────────────────────────────

/** GET/POST under /api/alerts/query, returning parsed JSON. */
const alertQueryRequest = async (method, path, { body, params, signal } = {}) => {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    // Repeatable params (severity, status) are sent once per value, which is how
    // the backend binds them into a List<String>. Joining them with a comma would
    // arrive as one nonsense value.
    if (Array.isArray(v)) v.forEach((entry) => { if (entry) qs.append(k, entry); });
    else qs.set(k, v);
  });

  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const queryString = qs.toString() ? `?${qs}` : '';
  const url = `${baseUrl}/alerts/query${path}${queryString}`;
  const res = await apiFetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await alertsError(res);
  const text = await res.text();
  if (!text) return { ok: true };
  try { return JSON.parse(text); } catch { return { ok: true }; }
};

/**
 * GET /api/alerts/query — a filtered, sorted, paged slice of the alert table.
 *
 * @param {object}   opts
 * @param {string}   [opts.search]    free text over name, service, host, stream, trace id
 * @param {string[]} [opts.severity]  multi-select
 * @param {string[]} [opts.status]    FIRING | ACKNOWLEDGED | RESOLVED | CLOSED
 * @param {string}   [opts.window]    e.g. 'now-24h'; omit for all time
 * @param {string}   [opts.sortBy]    lastFiredAt | severity | status | occurrences | …
 */
export const fetchAlerts2 = async ({
  search = '', severity = [], status = [], service = '', stream = '', source = '',
  ruleId = '', window = '', page = 0, size = 50, sortBy = '', sortDir = '', signal,
} = {}) => {
  const data = await alertQueryRequest('GET', '', {
    params: { search, severity, status, service, stream, source, ruleId, window, page, size, sortBy, sortDir },
    signal,
  });
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: data?.total ?? 0,
    page: data?.page ?? 0,
    size: data?.size ?? size,
    hasMore: !!data?.hasMore,
    sortBy: data?.sortBy ?? 'lastFiredAt',
    sortDir: data?.sortDir ?? 'desc',
  };
};

/**
 * GET /api/alerts/query/live — alerts read straight from the alert_events stream.
 *
 * The fallback for a broken or wedged ingest. Everything the normal table shows has
 * to have been polled into PostgreSQL first, so any fault upstream of that empties
 * the screen — and an empty alerts table reads as "all clear", which is the most
 * dangerous thing it can wrongly say. This asks OpenObserve directly instead.
 *
 * Read-only, and the rows say so by having **no id**: every transition route takes
 * one, so a live row cannot be acknowledged or resolved by any caller rather than
 * merely being displayed as if it could not.
 *
 * `partial` means OpenObserve served only part of the window; `truncated` means the
 * scan cap was hit and older firings were cut. Both are surfaced rather than
 * smoothed over — see the note on window scan limits.
 */
export const fetchLiveAlerts = async ({
  window = '', search = '', severity = [], page = 0, size = 50,
  sortBy = '', sortDir = '', signal,
} = {}) => {
  const data = await alertQueryRequest('GET', '/live', {
    params: { window, search, severity, page, size, sortBy, sortDir },
    signal,
  });
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: data?.total ?? 0,
    hasMore: !!data?.hasMore,
    source: data?.source ?? 'live-stream',
    partial: !!data?.partial,
    truncated: !!data?.truncated,
    windowStart: data?.windowStart ?? null,
    windowEnd: data?.windowEnd ?? null,
  };
};

/** GET /api/alerts/query/summary — card counts over the SAME window as the table. */
export const fetchAlertSummary2 = ({ window = '', signal } = {}) =>
  alertQueryRequest('GET', '/summary', { params: { window }, signal });

/** GET /api/alerts/query/filters — distinct values for the dropdowns. */
export const fetchAlertFilterOptions = async ({ signal } = {}) => {
  const d = await alertQueryRequest('GET', '/filters', { signal });
  return {
    severities: d?.severities || [],
    statuses: d?.statuses || [],
    sources: d?.sources || [],
    services: d?.services || [],
    streams: d?.streams || [],
    rules: d?.rules || [],
  };
};

/** GET /api/alerts/query/{id} — row + audit trail + rule + raw event. */
export const fetchAlertDetail = (id, { signal } = {}) =>
  alertQueryRequest('GET', `/${encodeURIComponent(id)}`, { signal });

/** One lifecycle transition. `action` is acknowledge | resolve | close | reopen. */
export const transitionAlert = (id, action, { actor = '', note = '' } = {}) =>
  alertQueryRequest('POST', `/${encodeURIComponent(id)}/${action}`, { body: { actor, note } });

/**
 * POST /api/alerts/query/bulk — one transition over many alerts.
 *
 * Resolves even on partial success: an alert the action cannot apply to comes
 * back SKIPPED with a reason, and treating that as a rejection would make the
 * caller redo the ones that worked.
 */
export const bulkTransitionAlerts = ({ ids, action, actor = '', note = '' }) =>
  alertQueryRequest('POST', '/bulk', { body: { ids, action, actor, note } });

/** GET /api/alerts/notifications/ingest-status — is the poller actually running? */
export const fetchAlertIngestStatus = async ({ signal } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const res = await apiFetch(`${baseUrl}/alerts/notifications/ingest-status`, { signal });
  if (!res.ok) throw await alertsError(res);
  return res.json();
};

/** POST /api/alerts/notifications/ingest-now — poll immediately, behind Refresh. */
export const triggerAlertIngest = async () => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const res = await apiFetch(`${baseUrl}/alerts/notifications/ingest-now`, { method: 'POST' });
  if (!res.ok) throw await alertsError(res);
  return res.json();
};

// ─────────────────────────────────────────────────────────────────────────────
// Product Catalog — the registry of monitored resources.
//
// Every route is org-scoped by apiFetch, like the rest of this module: a
// resource registered while looking at `default` does not exist under `DLH`,
// because they are different inventories with different telemetry.
//
// These use `alertsError` for rejections, which reads the backend's `{error}`
// body. That matters more here than elsewhere: the interesting failures are all
// explanations the operator needs to read — "no telemetry for this resource",
// "already registered under Databases" — not status codes.
// ─────────────────────────────────────────────────────────────────────────────

/** GET/POST/PATCH/DELETE under /api/product-catalog, returning parsed JSON. */
const catalogRequest = async (method, path, { body, params, signal } = {}) => {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  });
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const queryString = qs.toString() ? `?${qs}` : '';
  const url = `${baseUrl}/product-catalog${path}${queryString}`;

  const res = await apiFetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await alertsError(res);

  const text = await res.text();
  if (!text) return { ok: true };
  try { return JSON.parse(text); } catch { return { ok: true }; }
};

/**
 * GET /api/product-catalog/categories — the fixed taxonomy plus counts.
 *
 * The set is decided by the backend rather than hard-coded in the dialog, so a
 * category added there appears here without a UI change.
 */
export const fetchCatalogCategories = async ({ signal } = {}) => {
  const data = await catalogRequest('GET', '/categories', { signal });
  return { items: Array.isArray(data?.items) ? data.items : [] };
};

/**
 * GET /api/product-catalog — the registered resources.
 *
 * Filtering is sent to the backend rather than done here: it owns the registry,
 * and a client-side filter would disagree with the counts the categories
 * endpoint reports.
 *
 * @param {object}  opts
 * @param {string}  [opts.search]   free-text over name, category and status
 * @param {string}  [opts.category] category code, or 'ALL'
 * @param {string}  [opts.status]   'ENABLED' | 'DISABLED' | 'ALL'
 * @param {boolean} [opts.refresh]  force a Last Seen re-check against OpenObserve
 */
export const fetchCatalogResources = async ({
  search = '', category = '', status = '', refresh = false, signal,
} = {}) => {
  const params = { search, category, status };
  // Only sent when true — the backend default is the cached value, and an
  // explicit `refresh=false` on every poll would be noise in the access log.
  if (refresh) params.refresh = 'true';

  const data = await catalogRequest('GET', '', { params, signal });
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: data?.total ?? 0,
    org: data?.org ?? null,
    // Absent means an older backend that predates the flag; treat as supported
    // rather than blanking the screen.
    supported: data?.supported !== false,
    filterMode: data?.filterMode ?? null,
  };
};

/** GET /api/product-catalog/{id} — one resource, with its identifier bindings. */
export const fetchCatalogResource = (id, { signal } = {}) =>
  catalogRequest('GET', `/${encodeURIComponent(id)}`, { signal });

/**
 * POST /api/product-catalog/validate — does OpenObserve have telemetry for this?
 *
 * Resolves for a miss as well as a hit: "not found" is an answer the dialog
 * renders, not an error. Only a malformed request or an upstream failure rejects.
 */
export const validateCatalogResource = ({ category, resourceName }, { signal } = {}) =>
  catalogRequest('POST', '/validate', { body: { category, resourceName }, signal });

// ── Analytics Dashboard ─────────────────────────────────────────────────────
//
// One endpoint serves all three drill levels. Which level comes back is decided by
// what is supplied: nothing for categories, a category for its products, a category
// and product for its microservices.

/**
 * GET /api/analytics/scope — the catalog shape behind the pickers.
 *
 * Categories → products → microservices, with NO counts, so it runs no telemetry
 * query. One call fills all three dropdowns; deriving them from /log-counts would
 * cost an OpenObserve query per dropdown before the table ran its own.
 */
export const fetchAnalyticsScope = async ({ signal } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const response = await apiFetch(`${baseUrl}/analytics/scope`, { signal });
  if (!response.ok) throw await alertsError(response);
  const data = await response.json();
  return {
    categories: Array.isArray(data?.categories) ? data.categories : [],
    catalogEmpty: !!data?.catalogEmpty,
  };
};

/**
 * GET /api/analytics/log-counts — log volume over the Product Catalog.
 *
 * Every row is derived from what is REGISTERED, so this needs no list of categories
 * or products on the client: register a microservice and its product appears here.
 *
 * `total` is deliberately NOT info+warn+error+debug — the logs stream also carries
 * TRACE and a large unspecified bucket, reported as `other` so each row reconciles.
 *
 * ─── `level` skips the product tier ────────────────────────────────────────
 *
 * Omitted, the backend infers the grouping from `category`/`product` exactly as it
 * always has, which is what the drill table relies on. Passing `'microservice'` with
 * only a `category` returns EVERY microservice in that category instead of its
 * products — each row carrying the product it came from as `parentLabel`, so
 * flattening loses nothing. That is how the category board lists a category's
 * services without caring whether the category happens to have a product tier.
 */
const normalizeLogCounts = (data) => ({
  level: data?.level || 'CATEGORY',
  items: Array.isArray(data?.items) ? data.items : [],
  totals: data?.totals || null,
  category: data?.category || null,
  categoryLabel: data?.categoryLabel || null,
  product: data?.product || null,
  productLabel: data?.productLabel || null,
  window: data?.window || null,
  windowStart: data?.windowStart || null,
  windowEnd: data?.windowEnd || null,
  complete: data?.complete !== false,
  catalogEmpty: !!data?.catalogEmpty,
  supported: data?.supported !== false,
  message: data?.message || '',
});

export const fetchAnalyticsLogCounts = async ({
  category, product, window, level, signal,
} = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const qs = new URLSearchParams();
  if (category) qs.set('category', category);
  if (product) qs.set('product', product);
  if (window) qs.set('window', window);
  if (level) qs.set('level', level);
  const queryString = qs.toString() ? `?${qs}` : '';
  const url = `${baseUrl}/analytics/log-counts${queryString}`;

  const response = await apiFetch(url, { signal });
  // alertsError, like every other reader here: it lifts the backend's own message
  // out of the body, so a 400 explaining "category is required when product is
  // supplied" reaches the screen instead of a bare status code.
  if (!response.ok) throw await alertsError(response);
  return normalizeLogCounts(await response.json());
};

/**
 * GET /api/product-catalog/products — the product tier.
 *
 * The middle level of category → PRODUCT → microservice. Called ONCE with no
 * category so the register dialog can filter locally as the operator changes
 * category: refetching per change would put a network round trip inside a dropdown
 * interaction, and the whole list is a few dozen rows.
 *
 * Categories with no product list return an empty array rather than an error, so
 * one code path serves all seven.
 */
export const fetchCatalogProducts = async ({ category, signal } = {}) => {
  const data = await catalogRequest('GET', '/products', {
    params: category ? { category } : undefined,
    signal,
  });
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: data?.total ?? 0,
    supported: data?.supported !== false,
  };
};

/**
 * POST /api/product-catalog/register — validate, then register.
 *
 * `product` and `version` are omitted when empty rather than sent as null: the
 * backend requires a product exactly for the categories that have one and REJECTS
 * it for the categories that do not, so sending an empty value would turn a valid
 * Databases registration into a 400.
 */
export const registerCatalogResource = ({ category, product, resourceName, version, status }) =>
  catalogRequest('POST', '/register', {
    body: {
      category,
      resourceName,
      ...(product ? { product } : {}),
      ...(version ? { version } : {}),
      ...(status ? { status } : {}),
    },
  });

/**
 * PATCH /api/product-catalog/{id}/enable — surface this resource again.
 *
 * PATCH, not a full update: the row the browser is holding may be stale, and
 * re-sending it to flip one field would write that staleness back.
 */
export const enableCatalogResource = (id) =>
  catalogRequest('PATCH', `/${encodeURIComponent(id)}/enable`);

/** PATCH /api/product-catalog/{id}/disable — hide it across Logs/Traces/Metrics. */
export const disableCatalogResource = (id) =>
  catalogRequest('PATCH', `/${encodeURIComponent(id)}/disable`);

/** DELETE /api/product-catalog/{id} — unregister. The telemetry is untouched. */
export const removeCatalogResource = (id) =>
  catalogRequest('DELETE', `/${encodeURIComponent(id)}`);

/* ── Real User Monitoring ────────────────────────────────────────────────────
   Four readers over /api/rum, one per panel. Each is a different aggregation of
   the same RUM stream server-side, so they are separate calls here too — a
   combined fetch would make the Sessions tab pay for the Error Tracking queries.

   Every reader returns a `meta` block: which org and resolved window the numbers
   describe, whether OpenObserve supports the read at all, and `partial` — true
   when the window could not be fully scanned. `partial` is surfaced rather than
   swallowed because this deployment answers an unservable range with HTTP 200 and
   an empty result set, so a zero is not automatically a zero.

   No shape is invented on the client. Vitals, session rows and error issues are
   passed through as the backend built them; only defaults for absent collections
   are applied, so a panel renders empty instead of throwing on undefined.
   ────────────────────────────────────────────────────────────────────────── */

/** Shared `meta` normaliser. `supported` defaults TRUE: a reader that cannot find
 *  the flag should show the data it got, not an "unsupported" screen. */
const rumMeta = (m) => ({
  supported: m?.supported !== false,
  message: m?.message || '',
  org: m?.org || '',
  window: m?.window || '',
  windowStart: m?.windowStart || null,
  windowEnd: m?.windowEnd || null,
  partial: !!m?.partial,
});

/** The filter query string every RUM reader shares. Absent/`<ALL>` values are
 *  omitted entirely rather than sent as a literal the backend has to special-case. */
const rumParams = ({ window, service, env, version } = {}) => {
  const qs = new URLSearchParams();
  const set = (k, v) => {
    if (v && v !== '<ALL>') qs.set(k, v);
  };
  set('window', window);
  set('service', service);
  set('env', env);
  set('version', version);
  return qs;
};

/**
 * GET /api/rum/scope — what the Service / Env / Version dropdowns can offer.
 *
 * Its own call because it is three cheap DISTINCT queries. Deriving the lists from
 * a performance response instead would tie the selectable services to the currently
 * selected one — pick a service, and you could never pick another.
 */
export const fetchRumScope = async ({ window, signal } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const qs = rumParams({ window });
  const queryString = qs.toString() ? `?${qs}` : '';
  const response = await apiFetch(`${baseUrl}/rum/scope${queryString}`,
    { signal });
  if (!response.ok) throw await alertsError(response);
  const data = await response.json();
  return {
    meta: rumMeta(data?.meta),
    services: Array.isArray(data?.services) ? data.services : [],
    environments: Array.isArray(data?.environments) ? data.environments : [],
    versions: Array.isArray(data?.versions) ? data.versions : [],
    applications: Array.isArray(data?.applications) ? data.applications : [],
  };
};

/**
 * GET /api/rum/performance — Core Web Vitals, error counters, API timings.
 *
 * Vitals arrive at the 75th percentile and already in MILLISECONDS (the browser SDK
 * writes nanoseconds; the backend converts once so no consumer divides by 1e6 and
 * gets it wrong). CLS carries `unit: 'score'` and must not be treated as a duration.
 * Each vital reports the `sample` it was measured over, because they are not
 * populated together — INP only exists once someone has interacted.
 */
export const fetchRumPerformance = async ({ window, service, env, version, signal } = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const qs = rumParams({ window, service, env, version });
  const queryString = qs.toString() ? `?${qs}` : '';
  const response = await apiFetch(`${baseUrl}/rum/performance${queryString}`,
    { signal });
  if (!response.ok) throw await alertsError(response);
  const data = await response.json();
  return {
    meta: rumMeta(data?.meta),
    vitals: Array.isArray(data?.vitals) ? data.vitals : [],
    counts: {
      totalErrors: data?.counts?.totalErrors ?? 0,
      unhandledErrors: data?.counts?.unhandledErrors ?? 0,
      sessionsWithErrors: data?.counts?.sessionsWithErrors ?? 0,
      totalSessions: data?.counts?.totalSessions ?? 0,
    },
    api: Array.isArray(data?.api) ? data.api : [],
  };
};

/**
 * GET /api/rum/sessions — the session list and its summary.
 *
 * The summary describes every session in the window while `items` is one page, so
 * the two are deliberately not derivable from each other: a bounce rate computed
 * over 50 of 4,000 sessions is not a bounce rate. `medianDurationMs` is a median for
 * the same reason — one tab left open overnight moves a mean and says nothing about
 * a typical visit.
 */
export const fetchRumSessions = async ({
  window, service, env, version, page = 0, size = 50, signal,
} = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const qs = rumParams({ window, service, env, version });
  qs.set('page', String(page));
  qs.set('size', String(size));
  const response = await apiFetch(`${baseUrl}/rum/sessions?${qs}`, { signal });
  if (!response.ok) throw await alertsError(response);
  const data = await response.json();
  return {
    meta: rumMeta(data?.meta),
    summary: {
      sessions: data?.summary?.sessions ?? 0,
      withErrors: data?.summary?.withErrors ?? 0,
      frustrated: data?.summary?.frustrated ?? 0,
      medianDurationMs: data?.summary?.medianDurationMs ?? null,
      bounceRatePct: data?.summary?.bounceRatePct ?? null,
    },
    items: Array.isArray(data?.items) ? data.items : [],
    total: data?.total ?? 0,
  };
};

/**
 * GET /api/rum/errors — distinct issues, their occurrence series, crash-free rate.
 *
 * `items` are ISSUES, not occurrences: the backend groups on (type, message, source)
 * because the same message from two files is two bugs. `crashFreeSessionsPct` is
 * measured against all sessions, not against errored ones — the latter would read
 * 0% whenever any error existed.
 */
export const fetchRumErrors = async ({
  window, service, env, version, handling, page = 0, size = 50, signal,
} = {}) => {
  const baseUrl = getBaseUrl().replace(/\/$/, '');
  const qs = rumParams({ window, service, env, version });
  if (handling && handling !== 'all') qs.set('handling', handling);
  qs.set('page', String(page));
  qs.set('size', String(size));
  const response = await apiFetch(`${baseUrl}/rum/errors?${qs}`, { signal });
  if (!response.ok) throw await alertsError(response);
  const data = await response.json();
  return {
    meta: rumMeta(data?.meta),
    summary: {
      totalErrors: data?.summary?.totalErrors ?? 0,
      uniqueIssues: data?.summary?.uniqueIssues ?? 0,
      usersAffected: data?.summary?.usersAffected ?? 0,
      sessionsAffected: data?.summary?.sessionsAffected ?? 0,
      totalSessions: data?.summary?.totalSessions ?? 0,
      crashFreeSessionsPct: data?.summary?.crashFreeSessionsPct ?? null,
    },
    series: Array.isArray(data?.series) ? data.series : [],
    items: Array.isArray(data?.items) ? data.items : [],
    total: data?.total ?? 0,
  };
};
