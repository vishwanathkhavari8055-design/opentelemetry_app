/**
 * Shared backend for the TracesView tests: one set of stubbed endpoints the
 * screen talks to on mount (streams, Product Catalog, service discovery, the
 * listing and the histogram), plus helpers to read back what was asked.
 *
 * Not a test file itself — imported by TracesView.*.test.mjs after dom.mjs.
 */
import { stubFetch } from '../../support/fetch.mjs';

export const SPANS = [
  {
    spanId: 'sp-1', traceId: 'aaaaaaaaaaaaaaaa1111', timestamp: '2026-08-03T13:44:30Z',
    serviceName: 'checkout', operationName: 'GET /cart', durationUs: 1410, spanStatus: 'ERROR',
    raw: { service_name: 'checkout', http_method: 'GET', trace_id: 'aaaaaaaaaaaaaaaa1111' },
  },
  {
    spanId: 'sp-2', traceId: 'bbbbbbbbbbbbbbbb2222', timestamp: '2026-08-03T13:44:31Z',
    serviceName: 'payments', operationName: 'POST /pay', durationUs: 26, spanStatus: 'OK',
    raw: { service_name: 'payments', http_method: 'POST', trace_id: 'bbbbbbbbbbbbbbbb2222' },
  },
];

export const TRACES = [
  {
    traceId: 'cccccccccccccccc3333', timestamp: '2026-08-03T13:44:30Z', serviceName: 'gateway',
    operationName: 'POST /order', durationUs: 5_261_305, spanCount: 7, status: 'ERROR',
    services: [{ serviceName: 'gateway', durationUs: 3000, spanCount: 1 }],
  },
];

export const CATALOG = {
  items: [
    { serviceName: 'checkout', status: 'CRITICAL', requests: 120, errorRate: 0.1, errors: 12 },
    { serviceName: 'payments', status: 'HEALTHY', requests: 80, errorRate: 0, errors: 0 },
    { serviceName: 'unknown-service', requests: 1 },
    { serviceName: '  ', requests: 1 },
  ],
  criticalCount: 1,
};

export const BUCKETS = [
  { timestamp: '2026-08-03T13:00:00', count: 10, errors: 1, p50Us: 100, p95Us: 200, maxUs: 300 },
  { timestamp: '2026-08-03T13:10:00', count: 20, errors: 0, p50Us: 100, p95Us: 200, maxUs: 300 },
];

const CATEGORIES = { items: [{ code: 'APP', label: 'Applications', registeredCount: 2 }] };
const RESOURCES = {
  items: [
    { id: 1, category: 'APP', resourceName: 'checkout', status: 'ENABLED' },
    { id: 2, category: 'APP', resourceName: 'payments', status: 'ENABLED' },
  ],
  total: 2,
};

/** The query string of a request, as a URLSearchParams. */
export const paramsOf = (call) => new URL(call.url, 'http://localhost').searchParams;

/** Calls to one traces analytics endpoint ('spans' | 'list' | 'catalog' | 'histogram'). */
export const callsTo = (calls, path) => calls.filter((c) => new RegExp(`/traces/${path}\\?`).test(c.url));

/**
 * Stub the backend. `overrides` replaces an endpoint's answer by key:
 * spans, list, catalog, histogram, streams.
 */
export const stubTracesBackend = (overrides = {}) => {
  const pick = (key, fallback) => (key in overrides ? overrides[key] : fallback);
  return stubFetch([
    [/\/streams\?type=traces/, pick('streams', { items: ['otel_traces'] })],
    [/\/product-catalog\/categories/, CATEGORIES],
    [/\/product-catalog(\?|$)/, RESOURCES],
    [/\/traces\/spans\?/, pick('spans', { items: SPANS, total: 2, errorTotal: 1, hasMore: false })],
    [/\/traces\/list\?/, pick('list', { items: TRACES, total: 1, errorTotal: 1, hasMore: false })],
    [/\/traces\/catalog\?/, pick('catalog', CATALOG)],
    [/\/traces\/histogram\?/, pick('histogram', { buckets: BUCKETS, interval: '10 minutes' })],
  ]);
};
