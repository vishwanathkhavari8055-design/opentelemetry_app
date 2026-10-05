/**
 * The three RUM tabs (Performance, Sessions, Error Tracking) against a stubbed
 * /api/rum. What is guarded: each tab sends its filters (and only real ones —
 * `<ALL>` is never sent), keeps loading / error / unsupported / empty apart
 * instead of collapsing them into "no data", flags a partial scan alongside the
 * numbers, prints CLS as a score rather than a duration, and pages and filters
 * the way its labels say. RumPanelState's string discriminant is covered here too:
 * the element-is-always-truthy bug it replaced hid every panel's real content.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
const { default: RumPerformance } = await import('../../../src/components/rum/RumPerformance.jsx');
const { default: RumSessions } = await import('../../../src/components/rum/RumSessions.jsx');
const { default: RumErrors } = await import('../../../src/components/rum/RumErrors.jsx');
const { default: RumPanelState, panelStateKind, RumPartialNotice } = await import('../../../src/components/rum/RumPanelState.jsx');

const h = React.createElement;
const QUERY = { window: 'now-1h', service: 'web', env: '<ALL>', version: '', reloadToken: 0 };
const ago = (ms) => new Date(Date.now() - ms).toISOString();

let stub;
afterEach(() => { cleanup(); stub?.restore(); stub = null; });

const paramsOf = (call) => new URL(call.url, 'http://x').searchParams;

describe('panelStateKind / RumPanelState', () => {
  it('orders unsupported > loading > error > empty > content', () => {
    assert.equal(panelStateKind({ meta: { supported: false }, loading: true, error: 'x' }), 'unsupported');
    assert.equal(panelStateKind({ loading: true, error: 'x' }), 'loading');
    assert.equal(panelStateKind({ error: 'x', empty: true }), 'error');
    assert.equal(panelStateKind({ empty: true }), 'empty');
    assert.equal(panelStateKind({ meta: { supported: true } }), null);
  });

  it('renders nothing when there is no state, and the default unsupported message', () => {
    const { container } = render(h(RumPanelState, {}));
    assert.equal(container.innerHTML, '');
    render(h(RumPanelState, { meta: { supported: false } }));
    screen.getByText('This deployment has the OpenObserve reader disabled.');
  });

  it('shows the partial notice only for a partial scan', () => {
    const { container } = render(h(RumPartialNotice, { meta: { partial: false } }));
    assert.equal(container.innerHTML, '');
    render(h(RumPartialNotice, { meta: { partial: true } }));
    assert.match(screen.getByRole('status').textContent, /Partial scan\./);
  });
});

const PERF = {
  meta: { supported: true },
  vitals: [
    { key: 'lcp', label: 'LCP', value: 1050, unit: 'ms', sample: 12, rating: 'good' },
    { key: 'inp', label: 'INP', value: null, unit: 'ms', sample: 0 },
    { key: 'cls', label: 'CLS', value: 0.083, unit: 'score', sample: 1, rating: 'needs-improvement' },
    { key: 'ttfb', label: 'TTFB', value: 4.5, unit: 'ms', sample: 3 },
    { key: 'load', label: 'Load', value: 2.5, unit: 's', sample: 3 },
  ],
  counts: { totalErrors: 35, unhandledErrors: 5, sessionsWithErrors: 2, totalSessions: 8 },
  api: [
    { url: 'http://host:4200/api/items?x=1', method: 'GET', calls: 1500, avgMs: 12.3, p95Ms: 65_000, errorCalls: 3 },
    { url: 'not a url', calls: 1, avgMs: null, p95Ms: 0.5, errorCalls: 0 },
  ],
};

describe('RumPerformance', () => {
  it('requests the performance aggregate with only the real filters', async () => {
    stub = stubFetch([[/\/rum\/performance/, PERF]]);
    render(h(RumPerformance, { query: QUERY }));
    screen.getByText('Reading RUM events…');
    await screen.findByText('Performance Summary');
    const qs = paramsOf(stub.calls[0]);
    assert.equal(qs.get('window'), 'now-1h');
    assert.equal(qs.get('service'), 'web');
    assert.equal(qs.has('env'), false);
    assert.equal(qs.has('version'), false);
  });

  it('shows vitals and counters on the overview, CLS as a score', async () => {
    stub = stubFetch([[/\/rum\/performance/, PERF]]);
    render(h(RumPerformance, { query: QUERY }));
    await screen.findByText('Performance Summary');
    screen.getByText('1.05s');
    screen.getByText('0.08');
    screen.getByText(/p75 over 1 view · needs improvement/);
    screen.getByText(/p75 over 12 views · good/);
    screen.getByText('not reported in this window');
    screen.getByText('35');
    // (8-2)/8 = 75% error-free.
    screen.getByText('75.0%');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('switches sub-tabs over the same response without refetching', async () => {
    stub = stubFetch([[/\/rum\/performance/, PERF]]);
    render(h(RumPerformance, { query: QUERY }));
    await screen.findByText('Performance Summary');

    fireEvent.click(screen.getByRole('tab', { name: 'Web Vitals' }));
    screen.getByText('Supporting load metrics');
    screen.getByText('4.50ms');
    screen.getByText('2.50s');

    fireEvent.click(screen.getByRole('tab', { name: 'Errors' }));
    screen.getByText('30'); // handled = 35 - 5
    screen.getByText('2 of 8');

    fireEvent.click(screen.getByRole('tab', { name: 'API' }));
    const rows = screen.getAllByRole('row');
    assert.equal(rows.length, 3);
    assert.match(rows[1].textContent, /\/api\/items\?x=1GET1\.5K12ms1m 5s3/);
    assert.match(rows[2].textContent, /not a url—1—0\.50ms0/);
    assert.equal(stub.calls.length, 1);
  });

  it('explains an empty API table', async () => {
    stub = stubFetch([[/\/rum\/performance/, { ...PERF, api: [] }]]);
    render(h(RumPerformance, { query: QUERY }));
    await screen.findByText('Performance Summary');
    fireEvent.click(screen.getByRole('tab', { name: 'API' }));
    screen.getByText('No xhr or fetch calls were recorded in this window.');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('shows the empty state when nothing was reported', async () => {
    stub = stubFetch([[/\/rum\/performance/, { vitals: [{ key: 'lcp', value: null }], counts: {} }]]);
    render(h(RumPerformance, { query: QUERY }));
    await screen.findByText('No RUM data in this window');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('shows the backend error message', async () => {
    stub = stubFetch([[/\/rum\/performance/, { status: 500, body: { message: 'scan failed' } }]]);
    render(h(RumPerformance, { query: QUERY }));
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /Could not read RUM data\. scan failed/);
  });

  it('shows the unsupported state with the server message', async () => {
    stub = stubFetch([[/\/rum\/performance/, { meta: { supported: false, message: 'RUM is off here' } }]]);
    render(h(RumPerformance, { query: QUERY }));
    await screen.findByText('Real User Monitoring is not available');
    screen.getByText('RUM is off here');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('shows "—" error-free share when sessions are zero but a vital exists', async () => {
    stub = stubFetch([[/\/rum\/performance/, { vitals: [PERF.vitals[0]], counts: { totalSessions: 0 } }]]);
    render(h(RumPerformance, { query: QUERY }));
    await screen.findByText('Performance Summary');
    const tile = screen.getByText('Error-free Sessions').parentElement;
    assert.equal(within(tile).getByText('—').textContent, '—');
  });
});

const session = (id, over = {}) => ({
  sessionId: id, user: null, source: 'browser', sessionType: 'user', views: 1, events: 3,
  errorCount: 0, frustrationCount: 0, browser: 'Chrome', os: 'Windows', device: 'Desktop',
  durationMs: 65_000, lastSeenAt: ago(5 * 60_000), ...over,
});

const SESSIONS = {
  meta: { partial: true },
  summary: { sessions: 120, withErrors: 30, frustrated: 4, medianDurationMs: 3_720_000, bounceRatePct: 12.5 },
  items: [
    session('0123456789abcdef-long-session-id', { user: 'alice@example.com', errorCount: 2, lastViewUrl: '/home' }),
    session('s2', { frustrationCount: 1, sessionType: 'synthetics', device: 'Other', os: '' }),
    session('s3', { browser: '', lastSeenAt: null }),
  ],
  total: 120,
};

describe('RumSessions', () => {
  it('requests a page of sessions and shows the window-wide summary', async () => {
    stub = stubFetch([[/\/rum\/sessions/, SESSIONS]]);
    render(h(RumSessions, { query: QUERY }));
    await screen.findByText('Median Duration');
    const qs = paramsOf(stub.calls[0]);
    assert.equal(qs.get('page'), '0');
    assert.equal(qs.get('size'), '50');
    assert.equal(qs.get('service'), 'web');
    screen.getByText('1h 2m');
    screen.getByText('12.5%');
    screen.getByText('25.0% · ≥1 error');
    assert.match(screen.getByRole('status').textContent, /Partial scan/);
  });

  it('renders one row per session with health pills and short ids', async () => {
    stub = stubFetch([[/\/rum\/sessions/, SESSIONS]]);
    render(h(RumSessions, { query: QUERY }));
    await screen.findByText('Median Duration');
    const rows = screen.getAllByRole('row').slice(1);
    assert.equal(rows.length, 3);
    assert.match(rows[0].textContent, /alice@…\.com/);
    assert.match(rows[0].textContent, /012345…n-id · \/home/);
    assert.match(rows[0].textContent, /2 err/);
    assert.match(rows[0].textContent, /Windows · Desktop/);
    assert.match(rows[0].textContent, /1m 5s/);
    assert.match(rows[0].textContent, /5m ago/);
    assert.match(rows[1].textContent, /Unknown/);
    assert.match(rows[1].textContent, /synthetics/);
    assert.match(rows[1].textContent, /1 frustr/);
    assert.match(rows[2].textContent, /clean/);
    assert.match(rows[2].textContent, /Unknown/);
    assert.match(rows[2].textContent, /—$/);
  });

  it('filters the page client-side by health, without refetching', async () => {
    stub = stubFetch([[/\/rum\/sessions/, SESSIONS]]);
    render(h(RumSessions, { query: QUERY }));
    await screen.findByText('Median Duration');
    fireEvent.click(screen.getByRole('button', { name: 'With errors · 1' }));
    assert.equal(screen.getAllByRole('row').length, 2);
    screen.getByText(/Showing 1 of 3 on page 1 of 3/);
    fireEvent.click(screen.getByRole('button', { name: 'Clean · 1' }));
    assert.match(screen.getAllByRole('row')[1].textContent, /clean/);
    fireEvent.click(screen.getByRole('button', { name: 'Frustrated · 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'All · 3' }));
    assert.equal(screen.getAllByRole('row').length, 4);
    assert.equal(stub.calls.length, 1);
  });

  it('says so when no row on the page matches the filter', async () => {
    stub = stubFetch([[/\/rum\/sessions/, { ...SESSIONS, items: [session('only')] }]]);
    render(h(RumSessions, { query: QUERY }));
    await screen.findByText('Median Duration');
    fireEvent.click(screen.getByRole('button', { name: 'With errors · 0' }));
    screen.getByText(/No session on this page matches the “With errors”/);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('pages forward and back through the backend', async () => {
    stub = stubFetch([[/\/rum\/sessions/, SESSIONS]]);
    render(h(RumSessions, { query: QUERY }));
    await screen.findByText('Median Duration');
    const prev = screen.getByRole('button', { name: 'Previous' });
    assert.equal(prev.disabled, true);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText(/on page 2 of 3/);
    assert.equal(paramsOf(stub.calls.at(-1)).get('page'), '1');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText(/on page 1 of 3/);
    assert.equal(paramsOf(stub.calls.at(-1)).get('page'), '0');
  });

  it('shows the empty and error states', async () => {
    stub = stubFetch([[/\/rum\/sessions/, { total: 0 }]]);
    render(h(RumSessions, { query: QUERY }));
    await screen.findByText('No sessions in this window');
    cleanup(); stub.restore();

    stub = stubFetch([[/\/rum\/sessions/, { status: 502, body: { error: 'gateway' } }]]);
    render(h(RumSessions, { query: QUERY }));
    assert.match((await screen.findByRole('alert')).textContent, /gateway/);
  });

  it('shows a single-session summary without a percentage when there are no sessions counted', async () => {
    stub = stubFetch([[/\/rum\/sessions/, { summary: {}, items: [session('a')], total: 1 }]]);
    render(h(RumSessions, { query: QUERY }));
    await screen.findByText(/1 session in window/);
    screen.getByText('—', { selector: '.rum-tile-foot' });
    assert.ok(document.body.innerHTML.length > 0);
  });
});

const ERRORS = {
  meta: {},
  summary: { totalErrors: 35, uniqueIssues: 9, usersAffected: 4, sessionsAffected: 3, totalSessions: 60, crashFreeSessionsPct: 95 },
  series: [
    { bucketStart: ago(3_600_000), handled: 2, unhandled: 1 },
    { bucketStart: ago(1_800_000), handled: 0, unhandled: 0 },
  ],
  items: [
    { type: 'TypeError', message: 'x is undefined', handling: 'unhandled', source: 'app.js:10', service: 'web',
      events: 20, users: 3, sessions: 2, firstSeen: ago(2 * 86_400_000), lastSeen: ago(10 * 60_000) },
    { events: 1, users: 1, sessions: 1 },
  ],
  total: 51,
};

describe('RumErrors', () => {
  it('shows the issue summary, chart and table', async () => {
    stub = stubFetch([[/\/rum\/errors/, ERRORS]]);
    render(h(RumErrors, { query: QUERY }));
    await screen.findByText('Errors over time');
    screen.getByText('across 9 unique issues');
    screen.getByText('95.0%');
    screen.getByText('3 of 60 sessions hit an error');
    screen.getByRole('img', { name: 'Error volume across 2 time buckets' });
    screen.getByText(/2 buckets · peak 3 error/);
    const rows = screen.getAllByRole('row').slice(1);
    assert.match(rows[0].textContent, /TypeError: x is undefinedUNHANDLEDapp\.js:10web/);
    assert.match(rows[0].textContent, /10m ago/);
    assert.match(rows[0].textContent, /first 2d ago/);
    assert.match(rows[1].textContent, /\(no message reported\)UNKNOWN/);
    assert.match(rows[1].textContent, /first —/);
    screen.getByText(/51 issues · page 1 of/);
    assert.equal(paramsOf(stub.calls[0]).has('handling'), false);
  });

  it('re-queries with the handling filter and resets to page one', async () => {
    stub = stubFetch([[/\/rum\/errors/, ERRORS]]);
    render(h(RumErrors, { query: QUERY }));
    await screen.findByText('Errors over time');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => assert.equal(paramsOf(stub.calls.at(-1)).get('page'), '1'));
    await screen.findByText(/page 2 of 2/);
    fireEvent.click(screen.getByRole('button', { name: 'Unhandled' }));
    await waitFor(() => {
      const qs = paramsOf(stub.calls.at(-1));
      assert.equal(qs.get('handling'), 'unhandled');
      assert.equal(qs.get('page'), '0');
    });
    await screen.findByText(/page 1 of 2/);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    await waitFor(() => assert.equal(paramsOf(stub.calls.at(-1)).get('handling'), 'handled'));
  });

  it('colours crash-free by band and handles an empty series', async () => {
    const cases = [[99.5, 'good'], [80, 'error'], [null, null]];
    for (const [pct, tone] of cases) {
      stub = stubFetch([[/\/rum\/errors/, {
        ...ERRORS, series: [], total: 1, summary: { ...ERRORS.summary, uniqueIssues: 1, crashFreeSessionsPct: pct },
      }]]);
      render(h(RumErrors, { query: QUERY }));
      await screen.findByText('No error events to plot in this window.');
      screen.getByText('across 9 unique issues'.replace('9 unique issues', '1 unique issue'));
      const tile = screen.getByText('Crash-free Sessions').parentElement;
      if (tone) assert.match(tile.className, new RegExp(`rum-tile--${tone}`));
      else assert.doesNotMatch(tile.className, /rum-tile--/);
      screen.getByText(/1 issue · page 1 of 1/);
      cleanup(); stub.restore();
    }
  });

  it('draws a flat chart when every bucket is zero', async () => {
    stub = stubFetch([[/\/rum\/errors/, { ...ERRORS, series: [{ handled: 0, unhandled: 0 }] }]]);
    render(h(RumErrors, { query: QUERY }));
    await screen.findByText(/1 buckets · peak 0 errors/);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('shows the empty and error states', async () => {
    stub = stubFetch([[/\/rum\/errors/, { summary: { totalErrors: 0 } }]]);
    render(h(RumErrors, { query: QUERY }));
    await screen.findByText('No frontend errors in this window');
    cleanup(); stub.restore();

    stub = stubFetch([[/\/rum\/errors/, { status: 500, body: {} }]]);
    render(h(RumErrors, { query: QUERY }));
    await screen.findByRole('alert');
    assert.ok(document.body.innerHTML.length > 0);
  });
});
