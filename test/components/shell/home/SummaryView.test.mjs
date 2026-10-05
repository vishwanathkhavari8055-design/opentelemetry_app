/**
 * The Metrics & Services (Summary) screen: four independent cards, an Overview
 * panel derived from their responses, a window switch, a 30 s auto-refresh with
 * pause, and a per-service vitals drawer.
 *
 * Guarded because the wiring between cards is implicit: the Overview must be
 * computed from the cards' own fetches (no duplicates), the Metrics card must
 * default to the top error service exactly once, a failing card must not blank
 * its neighbours, and the drawer's "View logs" must drill and close.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup, within, act } = await import('@testing-library/react');
const { default: SummaryView } = await import('../../../../src/components/SummaryView.jsx');
const { default: LogsSummaryCard } = await import('../../../../src/components/summary/LogsSummaryCard.jsx');
const { default: TracesSummaryCard } = await import('../../../../src/components/summary/TracesSummaryCard.jsx');
const { default: MetricsSummaryCard } = await import('../../../../src/components/summary/MetricsSummaryCard.jsx');
const { default: ServicesUptimeCard } = await import('../../../../src/components/summary/ServicesUptimeCard.jsx');
const { default: ServiceVitalsDrawer } = await import('../../../../src/components/summary/ServiceVitalsDrawer.jsx');
const { default: OverviewPanel } = await import('../../../../src/components/home/OverviewPanel.jsx');

const LS_KEY = 'observability-ui:metrics-summary:service:v1';

const LOGS = {
  supported: true,
  totalCount: 2000,
  countsBySeverity: { ERROR: 40, FATAL: 10, WARN: 150, INFO: 1800 },
  topErrorServices: [{ serviceName: 'checkout', errorCount: 45 }, { serviceName: 'payments', errorCount: 5 }],
};
const TRACES = {
  supported: true, traceCount: 120, errorRate: 0.125, avgLatencyMs: 0.5, p95LatencyMs: 1500,
  slowestOps: [{ operationName: 'GET /cart', durationMs: 850 }],
};
const UPTIME = {
  supported: true,
  heartbeatStream: 'jvm_memory_used',
  items: [
    { 'service.name': 'payments', status: 'UP', healthStatus: 'UP', processUptimeSec: 8040 },
    { serviceName: 'checkout', status: 'DOWN', lastSeenAgoSec: 45 },
  ],
};
const pts = (...values) => values.map((value, i) => ({ timestamp: String(i), value }));
const METRICS = {
  supported: true,
  sparklines: { jvmHeap: pts(1, 2, 3), cpuUsage: pts(0.1, 0.2), threadsLive: pts(40), httpReqsCount: [] },
  latestValues: { jvmHeap: 3 * 1024 * 1024 * 1024, cpuUsage: 0.237, threadsLive: 42 },
};
const VITALS = {
  supported: true,
  windowStart: '2026-09-25T10:00:00Z',
  windowEnd: '2026-09-25T11:00:00Z',
  tiles: {
    reqRate: { latest: 12.345, unit: 'req/s', label: 'Requests', sparkline: pts(1, 5, 3) },
    heapUsedMb: { latest: 512, unit: 'MB', sparkline: pts(4) },
  },
  downstream: [
    { clientName: 'payments', reqRate: 3.456, maxLatencyMs: 120 },
    { clientName: 'inventory', reqRate: 1 },
  ],
  notes: ['hikaricp_connections_active not found'],
};

const summaryRoutes = (overrides = {}) => [
  [/\/logs\/summary/, overrides.logs ?? LOGS],
  [/\/traces\/summary/, overrides.traces ?? TRACES],
  [/\/services\/uptime/, overrides.uptime ?? UPTIME],
  [/\/metrics\/summary/, overrides.metrics ?? METRICS],
  [/\/services\/[^/]+\/vitals/, overrides.vitals ?? VITALS],
];

const card = (title) => screen.getByText(title, { selector: '.summary-card-title' }).closest('.summary-card');
const overviewTile = (label) => screen.getByText(label, { selector: '.ov-tile-label' }).closest('.ov-tile');

describe('SummaryView', () => {
  let stub;
  const realError = console.error;
  beforeEach(() => { console.error = () => {}; localStorage.clear(); });
  afterEach(() => {
    cleanup();
    stub?.restore();
    stub = undefined;
    console.error = realError;
    localStorage.clear();
    mock.timers.reset();
  });

  it('derives the Overview tiles from the cards and defaults Metrics to the top error service', async () => {
    stub = stubFetch(summaryRoutes());
    const went = [];
    render(React.createElement(SummaryView, { onNavigate: (k) => went.push(k) }));

    await waitFor(() => assert.equal(overviewTile('Services').querySelector('.ov-tile-value').textContent, '2'));
    assert.match(overviewTile('Services').textContent, /1 up · 1 down/);
    assert.equal(overviewTile('Log Events').querySelector('.ov-tile-value').textContent, (2000).toLocaleString());
    assert.match(overviewTile('Errors').textContent, /50.*2\.50% of events/);
    await waitFor(() => assert.match(overviewTile('Traces').textContent, /12\.5% error rate/));
    assert.match(overviewTile('Avg Latency').textContent, /0\.50 ms.*p95 1\.50 s/);
    assert.ok(screen.getByText('Last 1 hour', { selector: '.ov-panel-window' }));

    // One fetch per endpoint — the Overview does not refetch what the cards have.
    assert.equal(stub.calls.filter((c) => /\/logs\/summary/.test(c.url)).length, 1);

    // Metrics card: auto-picked from Logs' top error service, and remembered.
    await waitFor(() => assert.equal(screen.getByLabelText('Service').value, 'checkout'));
    await waitFor(() => assert.ok(within(card('Metrics')).getByText('JVM heap')));
    const metricsCall = stub.calls.find((c) => /\/metrics\/summary/.test(c.url));
    assert.match(metricsCall.url, /serviceName=checkout/);
    assert.equal(localStorage.getItem(LS_KEY), 'checkout');
    // The dropdown lists the uptime inventory plus the selection.
    const options = [...screen.getByLabelText('Service').options].map((o) => o.value);
    assert.deepEqual(options, ['checkout', 'payments']);

    fireEvent.click(overviewTile('Log Events'));
    fireEvent.click(overviewTile('Avg Latency'));
    fireEvent.click(overviewTile('Services')); // not a link
    assert.deepEqual(went, ['logs', 'traces']);
  });

  it('refetches every card for the new window when the window is switched', async () => {
    stub = stubFetch(summaryRoutes());
    render(React.createElement(SummaryView));
    await waitFor(() => assert.ok(within(card('Logs')).getByText('Top error services')));

    fireEvent.click(screen.getByRole('button', { name: 'Last 24h' }));
    await waitFor(() => assert.ok(screen.getByText('Last 24 hours', { selector: '.ov-panel-window' })));
    for (const path of ['logs/summary', 'traces/summary', 'services/uptime']) {
      await waitFor(() => assert.ok(stub.calls.some((c) => c.url.includes(path) && c.url.includes('window=now-24h')), path));
    }
    assert.equal(within(card('Logs')).getByText('LAST 24H').className, 'summary-card-subtitle');
  });

  it('refreshes every 30 s until paused, and resumes', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    stub = stubFetch(summaryRoutes());
    render(React.createElement(SummaryView));
    await waitFor(() => assert.ok(within(card('Logs')).getByText('Top error services')));
    const logsCalls = () => stub.calls.filter((c) => /\/logs\/summary/.test(c.url)).length;
    assert.equal(logsCalls(), 1);
    assert.ok(screen.getByText('Refreshes every 30s'));

    act(() => mock.timers.tick(30_000));
    await waitFor(() => assert.equal(logsCalls(), 2));

    fireEvent.click(screen.getByRole('button', { name: '⏸ Pause' }));
    assert.ok(screen.getByText('Auto-refresh paused'));
    act(() => mock.timers.tick(90_000));
    assert.equal(logsCalls(), 2);

    fireEvent.click(screen.getByRole('button', { name: '▶ Resume' }));
    act(() => mock.timers.tick(30_000));
    await waitFor(() => assert.equal(logsCalls(), 3));
  });

  it('opens the vitals drawer from an uptime row, and View logs drills then closes it', async () => {
    stub = stubFetch(summaryRoutes());
    const drilled = [];
    render(React.createElement(SummaryView, { onDrillToService: (s) => drilled.push(s) }));
    await waitFor(() => assert.ok(screen.getByTitle('Open vitals for Payments')));

    fireEvent.click(screen.getByTitle('Open vitals for Payments'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => assert.ok(within(dialog).getByText('Downstream calls')));
    assert.match(stub.calls.find((c) => /\/vitals/.test(c.url)).url, /\/services\/payments\/vitals\?window=now-1h/);

    fireEvent.click(within(dialog).getByRole('button', { name: 'View logs →' }));
    assert.deepEqual(drilled, ['payments']);
    assert.equal(screen.queryByRole('dialog'), null);

    // Also closes on its own button.
    fireEvent.click(screen.getByTitle('Open vitals for Checkout'));
    fireEvent.click(await screen.findByRole('button', { name: 'Close service vitals' }));
    assert.equal(screen.queryByRole('dialog'), null);
  });

  it('keeps the other cards when one endpoint fails', async () => {
    stub = stubFetch(summaryRoutes({ traces: { status: 500, body: {} } }));
    render(React.createElement(SummaryView));
    await waitFor(() => assert.ok(within(card('Traces')).getByText('Failed to load traces summary.')));
    await waitFor(() => assert.ok(within(card('Logs')).getByText('Top error services')));
    assert.equal(overviewTile('Traces').querySelector('.ov-tile-value').textContent, '—');
  });
});

describe('LogsSummaryCard', () => {
  let stub;
  const realError = console.error;
  beforeEach(() => { console.error = () => {}; });
  afterEach(() => { cleanup(); stub?.restore(); console.error = realError; });

  it('shows totals, severity rows in severity order and the top error services', async () => {
    stub = stubFetch([[/\/logs\/summary/, LOGS]]);
    const top = [];
    const got = [];
    render(React.createElement(LogsSummaryCard, {
      window: 'now-15m', refreshTick: 0, onTopErrorServices: (l) => top.push(l), onData: (d) => got.push(d),
    }));
    assert.ok(screen.getByText('Loading…'));
    await waitFor(() => assert.ok(screen.getByText('Top error services')));
    assert.ok(screen.getByText('LAST 15M'));
    const sevs = [...document.querySelectorAll('.sev-row-label')].map((n) => n.textContent);
    assert.deepEqual(sevs, ['FATAL', 'ERROR', 'WARN', 'INFO']);
    assert.ok(screen.getByText('90.0%'));
    assert.equal(screen.getByText('Errors').nextSibling.textContent, '50');
    assert.ok(screen.getByText('Checkout'));
    assert.equal(top[0][0].serviceName, 'checkout');
    assert.equal(got[0].totalCount, 2000);
  });

  it('says the backend does not support it, and shows the error state on failure', async () => {
    stub = stubFetch([[/\/logs\/summary/, { supported: false, backend: 'jaeger' }]]);
    render(React.createElement(LogsSummaryCard, { window: 'now-7d', refreshTick: 0 }));
    await waitFor(() => assert.ok(screen.getByText('Logs summary is not available on the jaeger backend.')));
    assert.ok(screen.getByText('NOW-7D'));
    cleanup();
    stub.restore();

    stub = stubFetch([[/\/logs\/summary/, { status: 500, body: {} }]]);
    render(React.createElement(LogsSummaryCard, { window: 'now-1h', refreshTick: 0 }));
    await waitFor(() => assert.ok(screen.getByText('Failed to load logs summary.')));
  });

  it('shows zeros without an error highlight when nothing has errored', async () => {
    stub = stubFetch([[/\/logs\/summary/, { supported: true, countsBySeverity: { INFO: 0 } }]]);
    render(React.createElement(LogsSummaryCard, { window: 'now-24h', refreshTick: 0 }));
    await waitFor(() => assert.ok(screen.getByText('INFO')));
    assert.equal(screen.getByText('Errors').nextSibling.className, 'summary-stat-value ');
    assert.equal(screen.queryByText('Top error services'), null);
  });
});

describe('TracesSummaryCard', () => {
  let stub;
  const realError = console.error;
  beforeEach(() => { console.error = () => {}; });
  afterEach(() => { cleanup(); stub?.restore(); console.error = realError; });

  it('formats rate and latencies, and lists the slowest operations', async () => {
    stub = stubFetch([[/\/traces\/summary/, TRACES]]);
    render(React.createElement(TracesSummaryCard, { window: 'now-24h', refreshTick: 0 }));
    await waitFor(() => assert.ok(screen.getByText('Slowest operations')));
    assert.ok(screen.getByText('12.5%'));
    assert.ok(screen.getByText('0.50 ms'));
    assert.ok(screen.getByText('1.50 s'));
    assert.ok(screen.getByText('850 ms'));
    assert.ok(screen.getByText('GET /cart'));
    assert.ok(screen.getByText('LAST 24H'));
  });

  it('shows 0.0% and dashes for missing figures, and the unsupported / failed states', async () => {
    stub = stubFetch([[/\/traces\/summary/, { supported: true }]]);
    render(React.createElement(TracesSummaryCard, { window: 'now-15m', refreshTick: 0 }));
    await waitFor(() => assert.ok(screen.getByText('0.0%')));
    assert.equal(screen.getAllByText('-').length, 2);
    cleanup(); stub.restore();

    stub = stubFetch([[/\/traces\/summary/, { supported: false }]]);
    render(React.createElement(TracesSummaryCard, { window: 'x', refreshTick: 0 }));
    await waitFor(() => assert.ok(screen.getByText('Traces summary is not available on the current backend.')));
    cleanup(); stub.restore();

    stub = stubFetch([[/\/traces\/summary/, { status: 503, body: {} }]]);
    render(React.createElement(TracesSummaryCard, { window: 'now-1h', refreshTick: 0 }));
    await waitFor(() => assert.ok(screen.getByText('Failed to load traces summary.')));
  });
});

describe('MetricsSummaryCard', () => {
  let stub;
  const realError = console.error;
  beforeEach(() => { console.error = () => {}; localStorage.clear(); });
  afterEach(() => { cleanup(); stub?.restore(); console.error = realError; localStorage.clear(); });

  const renderCard = (props = {}) => render(React.createElement(MetricsSummaryCard, {
    window: 'now-1h', refreshTick: 0, serviceOptions: ['payments', 'checkout'], ...props,
  }));

  it('asks for a service before fetching, then fetches and remembers the pick', async () => {
    stub = stubFetch([[/\/metrics\/summary/, METRICS]]);
    renderCard();
    assert.ok(screen.getByText(/Pick a service to view its JVM heap/));
    assert.equal(stub.calls.length, 0);

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'payments' } });
    await waitFor(() => assert.ok(screen.getByText('JVM heap')));
    assert.match(stub.calls[0].url, /serviceName=payments/);
    assert.equal(localStorage.getItem(LS_KEY), 'payments');
    assert.ok(screen.getByText('Payments · LAST 1H'));
    // Series formatting; the empty HTTP series is skipped.
    assert.ok(screen.getByText('3.00 GB'));
    assert.ok(screen.getByText('23.7%'));
    assert.ok(screen.getByText('42'));
    assert.equal(screen.queryByText('HTTP reqs'), null);
    assert.equal(document.querySelectorAll('.summary-spark-svg path').length, 2); // 1-point series draws nothing
  });

  it('restores the persisted pick and does not follow the top error service over it', async () => {
    localStorage.setItem(LS_KEY, 'orders');
    stub = stubFetch([[/\/metrics\/summary/, METRICS]]);
    renderCard({ topErrorService: 'checkout' });
    await waitFor(() => assert.ok(screen.getByText('JVM heap')));
    assert.equal(screen.getByLabelText('Service').value, 'orders');
    assert.deepEqual([...screen.getByLabelText('Service').options].map((o) => o.value), ['checkout', 'orders', 'payments']);
    assert.match(stub.calls[0].url, /serviceName=orders/);
  });

  it('formats smaller heap values in MB, KB and B', async () => {
    for (const [heap, text] of [[5 * 1024 * 1024, '5 MB'], [2048, '2 KB'], [12, '12 B'], [null, '-']]) {
      localStorage.setItem(LS_KEY, 'payments');
      stub = stubFetch([[/\/metrics\/summary/, {
        supported: true, sparklines: { jvmHeap: pts(1, 2), cpuUsage: pts(1, 2), threadsLive: pts(1, 2) },
        latestValues: { jvmHeap: heap },
      }]]);
      renderCard();
      await waitFor(() => assert.ok(screen.getByText('JVM heap')));
      assert.equal(screen.getByText('JVM heap').parentElement.querySelector('.summary-spark-value').textContent, text);
      if (heap == null) assert.equal(screen.getByText('CPU usage').parentElement.lastChild.textContent, '-');
      cleanup(); stub.restore();
    }
  });

  it('shows the no-data, unsupported and failed states', async () => {
    const cases = [
      [{ supported: true, sparklines: {} }, 'No metric streams have data for payments in this window.'],
      [{ supported: false, backend: 'prometheus' }, 'Metrics summary is not available on the prometheus backend.'],
      [{ status: 500, body: {} }, 'Failed to load metrics summary.'],
    ];
    for (const [answer, text] of cases) {
      localStorage.setItem(LS_KEY, 'payments');
      stub = stubFetch([[/\/metrics\/summary/, answer]]);
      renderCard();
      await waitFor(() => assert.ok(screen.getByText(text)));
      cleanup(); stub.restore();
    }
  });
});

describe('ServicesUptimeCard', () => {
  let stub;
  const realError = console.error;
  beforeEach(() => { console.error = () => {}; });
  afterEach(() => { cleanup(); stub?.restore(); console.error = realError; });

  it('lists problem services first with both signals, and reports names upward', async () => {
    stub = stubFetch([[/\/services\/uptime/, {
      supported: true,
      items: [
        { 'service.name': 'alpha', status: 'UP', healthStatus: 'UP', processUptimeSec: 30 },
        { 'service.name': 'bravo', status: 'UP', healthStatus: 'DOWN', processUptimeSec: 300 },
        { 'service.name': 'charlie', status: 'UP', healthStatus: 'OUT_OF_SERVICE', processUptimeSec: 200_000 },
        { 'service.name': 'delta', status: 'UP' },
        { serviceName: 'echo', lastSeenAgoSec: 7200 },
      ],
    }]]);
    const names = [];
    const clicked = [];
    render(React.createElement(ServicesUptimeCard, {
      window: 'now-15m', refreshTick: 0, onServicesList: (l) => names.push(l), onRowClick: (n) => clicked.push(n),
    }));
    await waitFor(() => assert.ok(screen.getByText('Alpha')));
    const order = [...document.querySelectorAll('.svc-uptime-name')].map((n) => n.textContent);
    assert.deepEqual(order, ['Bravo', 'Charlie', 'Alpha', 'Delta', 'Echo']);
    assert.deepEqual(names[0], ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    assert.ok(screen.getByText('uptime 30s'));
    assert.ok(screen.getByText('uptime 5m'));
    assert.ok(screen.getByText('uptime 2d 7h'));
    assert.ok(screen.getByText('last seen 2h 0m ago'));
    assert.ok(screen.getByText('HEALTH DOWN'));
    assert.ok(screen.getByText('HEALTH OUT_OF_SERVICE').className.includes('UNKNOWN'));
    assert.equal(screen.getAllByTitle('Health gauge not exposed by this service').length, 2);
    assert.ok(screen.getByText('LAST 15M'));

    fireEvent.click(screen.getByTitle('Open vitals for Echo'));
    assert.deepEqual(clicked, ['echo']);
  });

  it('shows the empty, unsupported and failed states', async () => {
    const cases = [
      [{ supported: true, items: [] }, 'No services have emitted metrics in this window.'],
      [{ supported: false }, /Service uptime needs OpenObserve/],
      [{ status: 500, body: {} }, 'Failed to load services uptime.'],
    ];
    for (const [answer, text] of cases) {
      stub = stubFetch([[/\/services\/uptime/, answer]]);
      render(React.createElement(ServicesUptimeCard, { window: 'custom', refreshTick: 0 }));
      await waitFor(() => assert.ok(screen.getByText(text)));
      cleanup(); stub.restore();
    }
  });
});

describe('ServiceVitalsDrawer', () => {
  let stub;
  const realError = console.error;
  beforeEach(() => { console.error = () => {}; });
  afterEach(() => { cleanup(); stub?.restore(); console.error = realError; });

  it('renders six tiles in fixed order with "—" for absent ones, downstream and notes', async () => {
    stub = stubFetch([[/\/vitals/, VITALS]]);
    render(React.createElement(ServiceVitalsDrawer, { serviceName: 'checkout', window: 'now-1h', onClose: () => {} }));
    assert.ok(screen.getByText('Loading vitals…'));
    await waitFor(() => assert.ok(screen.getByText('Missing signals')));
    const labels = [...document.querySelectorAll('.svc-vitals-tile-label')].map((n) => n.textContent);
    assert.deepEqual(labels, ['Requests', 'Error rate', 'Latency (max)', 'DB pool (active)', 'JVM heap', 'Error logs']);
    const values = [...document.querySelectorAll('.svc-vitals-tile-value')].map((n) => n.textContent);
    assert.deepEqual(values, ['12.35', '—', '—', '—', '512', '—']);
    assert.ok(screen.getByText('10:00 → 11:00'));
    assert.ok(screen.getByText('3.46 req/s'));
    assert.ok(screen.getByText('120 ms'));
    assert.ok(screen.getByText('1 req/s'));
    assert.ok(screen.getByText('hikaricp_connections_active not found'));
    assert.equal(screen.getByRole('heading', { name: 'Checkout' }).id, 'svc-vitals-title');
  });

  it('closes on Escape and on an overlay click, but not on a click inside', async () => {
    stub = stubFetch([[/\/vitals/, { supported: true, windowStart: 'bogus', windowEnd: 'bogus' }]]);
    let closed = 0;
    render(React.createElement(ServiceVitalsDrawer, { serviceName: 'checkout', window: 'now-15m', onClose: () => { closed += 1; } }));
    await waitFor(() => assert.ok(screen.getByText('No outbound HTTP client metrics in this window.')));
    assert.ok(screen.getByText('bogus → bogus'));
    assert.equal(screen.queryByText('Missing signals'), null);

    fireEvent.click(screen.getByRole('dialog'));
    assert.equal(closed, 0);
    fireEvent.keyDown(document, { key: 'Enter' });
    assert.equal(closed, 0);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(closed, 1);
    fireEvent.click(document.querySelector('.svc-vitals-overlay'));
    assert.equal(closed, 2);
  });

  it('shows the unsupported and failed states, and renders nothing without a service', async () => {
    stub = stubFetch([[/\/vitals/, { supported: false }]]);
    render(React.createElement(ServiceVitalsDrawer, { serviceName: 'checkout', window: 'now-24h', onClose: () => {} }));
    await waitFor(() => assert.ok(screen.getByText(/Service vitals need OpenObserve/)));
    assert.ok(screen.getByText('LAST 24H'));
    cleanup(); stub.restore();

    stub = stubFetch([[/\/vitals/, { status: 500, body: {} }]]);
    render(React.createElement(ServiceVitalsDrawer, { serviceName: 'checkout', window: 'odd', onClose: () => {} }));
    await waitFor(() => assert.ok(screen.getByText('Failed to load service vitals.')));
    assert.ok(screen.getByText('ODD'));
    cleanup();

    const { container } = render(React.createElement(ServiceVitalsDrawer, { serviceName: null, window: 'now-1h', onClose: () => {} }));
    assert.equal(container.innerHTML, '');
  });
});

describe('OverviewPanel', () => {
  afterEach(cleanup);

  it('shows "—" until data arrives and is not clickable without onNavigate', () => {
    render(React.createElement(OverviewPanel, { windowLabel: 'Last 1 hour' }));
    const values = [...document.querySelectorAll('.ov-tile-value')].map((n) => n.textContent);
    assert.deepEqual(values, ['—', '—', '—', '—', '—']);
    assert.equal(screen.queryByRole('button'), null);
  });

  it('formats large counts and whole-millisecond latency', () => {
    render(React.createElement(OverviewPanel, {
      windowLabel: 'w',
      logsSummary: { totalCount: 1_200_000_000, countsBySeverity: {} },
      tracesSummary: { traceCount: 25_000, avgLatencyMs: 12.4, p95LatencyMs: null },
      uptime: { items: [{ status: 'UP' }] },
    }));
    assert.ok(screen.getByText('1.2B'));
    assert.ok(screen.getByText('25.0K'));
    assert.ok(screen.getByText('12 ms'));
    assert.ok(screen.getByText('p95 —'));
    assert.ok(screen.getByText('0.00% of events'));
    assert.ok(screen.getByText('1 up · 0 down'));
  });
});
