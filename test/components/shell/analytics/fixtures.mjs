/**
 * A small registered estate for the Analytics faces, answered the way
 * /api/analytics/log-counts and /api/analytics/scope answer: two categories,
 * Applications (with a product tier) and Tools (without one).
 */
import { stubFetch } from '../../../support/fetch.mjs';

const row = (key, label, counts, extra = {}) => ({
  key, label, total: 0, info: 0, warn: 0, error: 0, debug: 0, other: 0, ...counts, ...extra,
});

export const CATEGORIES = [
  row('APP', 'Applications', { total: 1500, info: 1000, warn: 200, error: 100, debug: 50, other: 150 },
    { childCount: 1, leafCount: 2, matchedOn: ['service_name=svcA', 'service_name=svcB'] }),
  row('TOOLS', 'Tools', { total: 10, info: 10 }, { childCount: 1, matchedOn: ['service_name=tool1'] }),
];

export const PRODUCTS = [
  row('IOT', 'IoT Hub', { total: 1400, info: 900, warn: 200, error: 100, debug: 50, other: 150 },
    { childCount: 2, matchedOn: ['service_name=svcA', 'service_name=svcB'] }),
  row('LONE', 'Lone resource', { total: 100, info: 100 }, { childCount: 0 }),
];

export const SERVICES = [
  row('svc-a', 'SvcA', { total: 900, info: 700, error: 100, other: 100 },
    { matchedOn: ['service_name=svcA'], parentLabel: 'IoT Hub' }),
  row('svc-b', 'SvcB', { total: 500, info: 200, warn: 200, debug: 50, other: 50 },
    { matchedOn: ['service_name=svcB'], parentLabel: 'IoT Hub' }),
];

export const TOOL_SERVICES = [
  row('t1', 'Tool1', { total: 10, info: 10 }, { matchedOn: ['service_name=tool1'] }),
];

export const SCOPE = {
  catalogEmpty: false,
  categories: [
    {
      code: 'APP', label: 'Applications', microservices: [],
      products: [{
        code: 'IOT', label: 'IoT Hub',
        microservices: [{ id: 'svc-a', label: 'SvcA' }, { id: 'svc-b', label: 'SvcB' }, { id: 'svc-z', label: 'SvcZ' }],
      }],
    },
    { code: 'TOOLS', label: 'Tools', products: [], microservices: [{ id: 't1', label: 'Tool1' }] },
  ],
};

const totalsOf = (items) => items.reduce((acc, r) => {
  for (const k of ['total', 'info', 'warn', 'error', 'debug', 'other']) acc[k] = (acc[k] || 0) + r[k];
  return acc;
}, {});

/** The log-counts answer for a request, keyed off its query string. */
export function logCounts(url) {
  const q = new URL(url, 'http://localhost').searchParams;
  const category = q.get('category');
  const product = q.get('product');
  const base = {
    windowStart: '2026-09-24T10:00:00Z', windowEnd: '2026-09-25T10:00:00Z', window: q.get('window'),
  };
  if (!category) return { ...base, level: 'CATEGORY', items: CATEGORIES, totals: totalsOf(CATEGORIES) };
  if (category === 'TOOLS' || q.get('level') === 'microservice') {
    const items = category === 'TOOLS' ? TOOL_SERVICES : SERVICES;
    return { ...base, level: 'MICROSERVICE', items, totals: totalsOf(items) };
  }
  if (!product) return { ...base, level: 'PRODUCT', items: PRODUCTS, totals: totalsOf(PRODUCTS) };
  return { ...base, level: 'MICROSERVICE', items: SERVICES, totals: totalsOf(SERVICES) };
}

/** The standard estate, with overridable answers. */
export function stubAnalytics({ counts = logCounts, scope = SCOPE } = {}) {
  return stubFetch([
    [/\/analytics\/scope/, scope],
    [/\/analytics\/log-counts/, counts],
  ]);
}

export const countCalls = (calls) => calls
  .filter((c) => /\/analytics\/log-counts/.test(c.url))
  .map((c) => Object.fromEntries(new URL(c.url, 'http://localhost').searchParams));
