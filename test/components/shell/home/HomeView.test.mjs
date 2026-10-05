/**
 * The Home screen: every figure comes from GET /org/summary, the Dashboards
 * count from the Dashboard Catalog registry, and each shortcut lands on this
 * app's own screen through onNavigate.
 *
 * Guarded here because the failure modes are quiet by design: an unreachable
 * endpoint must show "—" (never a zero that reads as "nothing ingested"), keep
 * the reason on the refresh button's tooltip, and a failure of one backend must
 * not blank the other's figures. A shortcut with nowhere to go must not render.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup, within } = await import('@testing-library/react');
const { default: HomeView } = await import('../../../../src/components/HomeView.jsx');
const { HomeResourcesCard, HomeSplitCard } = await import('../../../../src/components/home/HomePanels.jsx');
const { default: StreamsPanel, formatBytes, formatCount } = await import('../../../../src/components/home/StreamsPanel.jsx');

const SUMMARY = {
  org: 'acme',
  streams: {
    count: 632,
    events: 47_800_000,
    ingestedBytes: 113_537_003_192, // 105.74 GB
    compressedBytes: 0,
    indexBytes: 500,
  },
  functions: { count: 3 },
  alerts: { scheduled: 4, realTime: 2, health: { healthy: 5, failed: 1, warning: 0 } },
  pipelines: { scheduled: 0, realTime: 0 },
};

const REGISTRY = { items: [{ uid: 'a' }, { uid: 'b' }] };

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/** The value cell of a Resources row, found by its label. */
const resourceValue = (label) => {
  const row = screen.getByText(label).closest('.home-res-row');
  return row.querySelector('.home-res-value')?.textContent;
};

/** The value of a Streams tile, found by its label. */
const tileValue = (label) => screen.getByText(label, { selector: '.ov-tile-label' }).closest('.ov-tile').querySelector('.ov-tile-value').textContent;

describe('HomeView', () => {
  let stub;
  const realWarn = console.warn;
  const realError = console.error;
  const realNow = Date.now;

  beforeEach(() => {
    console.warn = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    cleanup();
    stub?.restore();
    stub = undefined;
    console.warn = realWarn;
    console.error = realError;
    Date.now = realNow;
  });

  it('renders the org summary figures and the enabled dashboard count', async () => {
    stub = stubFetch([
      [/\/org\/summary/, SUMMARY],
      [/\/dashboards\/registry/, REGISTRY],
    ]);
    render(React.createElement(HomeView, { onNavigate: () => {} }));

    await waitFor(() => assert.equal(tileValue('Streams'), '632'));
    assert.equal(tileValue('Events'), '47.8M');
    assert.equal(tileValue('Ingested Size'), '105.74 GB');
    assert.equal(tileValue('Compressed Size'), '0 B');
    assert.equal(tileValue('Index Size'), '500 B');
    assert.ok(screen.getByText('acme'));
    await waitFor(() => assert.equal(resourceValue('Dashboards'), '2'));
    assert.equal(resourceValue('Functions'), '3');
    assert.match(screen.getByText(/updated/).textContent, /updated just now/);

    // Alerts has trigger outcomes → a chart; Pipelines is all zero → "No data".
    assert.ok(screen.getByRole('figure', { name: 'Alerts trigger status: Healthy 5, Failed 1, Warning 0' }));
    const pipelines = screen.getByText('Pipelines').closest('.home-card');
    assert.ok(within(pipelines).getByText('No data available'));

    // The registry is asked for the viewer's list only.
    const registryCall = stub.calls.find((c) => /\/dashboards\/registry/.test(c.url));
    assert.match(registryCall.url, /enabledOnly=true/);
    assert.equal(screen.getByRole('button', { name: 'Refresh org summary' }).title, 'Refresh org summary');
  });

  it('sends every shortcut through onNavigate with the shell tab key', async () => {
    stub = stubFetch([[/\/org\/summary/, SUMMARY], [/\/dashboards\/registry/, REGISTRY]]);
    const went = [];
    render(React.createElement(HomeView, { onNavigate: (k) => went.push(k) }));
    await waitFor(() => assert.equal(tileValue('Streams'), '632'));

    fireEvent.click(screen.getByRole('button', { name: 'Open Alerts' }));
    fireEvent.click(screen.getByTitle('Open Dashboards'));
    for (const label of ['Logs', 'Log Analytics', 'Traces', 'Metrics', 'RUM']) {
      fireEvent.click(screen.getByTitle(`Open ${label}`));
    }
    assert.deepEqual(went, ['alerts', 'dashboards', 'logs', 'analytics', 'traces', 'metrics', 'rum']);

    // Streams, Functions and Pipelines have no screen here: no arrow, no link.
    assert.equal(screen.queryByRole('button', { name: 'Open Pipelines' }), null);
    assert.equal(screen.queryByTitle('Open Functions'), null);
    assert.equal(screen.queryByRole('button', { name: 'Open the Logs screen' }), null);
  });

  it('renders no arrows or Explore list when mounted without onNavigate', async () => {
    stub = stubFetch([[/\/org\/summary/, SUMMARY], [/\/dashboards\/registry/, REGISTRY]]);
    render(React.createElement(HomeView));
    await waitFor(() => assert.equal(tileValue('Streams'), '632'));
    assert.equal(screen.queryByText('Explore'), null);
    assert.equal(screen.queryByRole('button', { name: 'Open Alerts' }), null);
    assert.equal(screen.queryByTitle('Open Dashboards'), null);
  });

  it('shows "—" and names the missing endpoint on the refresh tooltip when /org/summary is not deployed', async () => {
    stub = stubFetch([
      [/\/org\/summary/, { status: 404, body: { message: 'nope' } }],
      [/\/dashboards\/registry/, REGISTRY],
    ]);
    render(React.createElement(HomeView, { onNavigate: () => {} }));

    const refresh = screen.getByRole('button', { name: 'Refresh org summary' });
    await waitFor(() => assert.match(refresh.title, /GET \/api\/org\/summary returned HTTP 404/));
    assert.match(refresh.title, /endpoint not on the lib yet/);
    for (const label of ['Streams', 'Events', 'Ingested Size', 'Compressed Size', 'Index Size']) {
      assert.equal(tileValue(label), '—');
    }
    assert.equal(resourceValue('Functions'), '—');
    // The catalog is a different backend: its count survives the summary failure.
    await waitFor(() => assert.equal(resourceValue('Dashboards'), '2'));
    assert.equal(screen.queryByText(/updated/), null);
  });

  it('quotes the error itself on the tooltip for a failure that is not a missing endpoint', async () => {
    stub = stubFetch([
      [/\/org\/summary/, { status: 403, body: {} }],
      [/\/dashboards\/registry/, { status: 500, body: { message: 'grafana down' } }],
    ]);
    render(React.createElement(HomeView, { onNavigate: () => {} }));
    const refresh = screen.getByRole('button', { name: 'Refresh org summary' });
    await waitFor(() => assert.equal(refresh.title,
      'Refresh — figures unavailable: GET /org/summary returned HTTP 403'));
    // An unreadable catalog is "—", never 0.
    await waitFor(() => assert.equal(screen.queryAllByLabelText('Loading').length, 0));
    assert.equal(resourceValue('Dashboards'), '—');
  });

  it('shows "—" for the dashboard count when the registry answers without an items list', async () => {
    stub = stubFetch([[/\/org\/summary/, SUMMARY], [/\/dashboards\/registry/, { total: 4 }]]);
    render(React.createElement(HomeView, { onNavigate: () => {} }));
    await waitFor(() => assert.equal(tileValue('Streams'), '632'));
    await waitFor(() => assert.equal(screen.queryAllByLabelText('Loading').length, 0));
    assert.equal(resourceValue('Dashboards'), '—');
  });

  it('refetches both sources on Refresh and says "refreshing…" while the summary is in flight', async () => {
    let summaryCalls = 0;
    let gate = null;
    stub = stubFetch([
      [/\/org\/summary/, async () => {
        summaryCalls += 1;
        if (gate) await gate.promise;
        return summaryCalls === 1 ? SUMMARY : { ...SUMMARY, streams: { ...SUMMARY.streams, count: 700 } };
      }],
      [/\/dashboards\/registry/, REGISTRY],
    ]);
    render(React.createElement(HomeView, { onNavigate: () => {} }));
    await waitFor(() => assert.equal(tileValue('Streams'), '632'));

    gate = deferred();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh org summary' }));
    await waitFor(() => assert.ok(screen.getByText('refreshing…')));
    gate.resolve();
    await waitFor(() => assert.equal(tileValue('Streams'), '700'));
    assert.equal(summaryCalls, 2);
    assert.equal(stub.calls.filter((c) => /\/dashboards\/registry/.test(c.url)).length, 2);
  });

  it('ages the "updated" stamp in seconds, minutes and hours', async () => {
    for (const [offsetMs, text] of [[30_000, 'updated 30s ago'], [120_000, 'updated 2m ago'], [7_200_000, 'updated 2h ago']]) {
      const gate = deferred();
      stub = stubFetch([
        [/\/org\/summary/, SUMMARY],
        [/\/dashboards\/registry/, async () => { await gate.promise; return REGISTRY; }],
      ]);
      render(React.createElement(HomeView, { onNavigate: () => {} }));
      await waitFor(() => assert.equal(tileValue('Streams'), '632'));
      // The stamp is computed on render; the late registry answer re-renders it.
      const base = realNow();
      Date.now = () => base + offsetMs;
      gate.resolve();
      await waitFor(() => assert.equal(resourceValue('Dashboards'), '2'));
      assert.equal(screen.getByText(/^updated/).textContent, text);
      cleanup();
      stub.restore();
      Date.now = realNow;
    }
  });

  it('stops listening when unmounted mid-request', async () => {
    const gate = deferred();
    stub = stubFetch([
      [/\/org\/summary/, async () => { await gate.promise; return SUMMARY; }],
      [/\/dashboards\/registry/, async () => { await gate.promise; return REGISTRY; }],
    ]);
    const { unmount } = render(React.createElement(HomeView, { onNavigate: () => {} }));
    unmount();
    gate.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls.every((c) => c.init.signal.aborted), true);
  });
});

describe('Home panels', () => {
  afterEach(cleanup);

  it('StreamsPanel shows its arrow only when given somewhere to go, and a spinner while loading', () => {
    const opened = [];
    render(React.createElement(StreamsPanel, { loading: true, onOpen: () => opened.push(1) }));
    assert.ok(screen.getByLabelText('Loading'));
    fireEvent.click(screen.getByRole('button', { name: 'Open the Logs screen' }));
    assert.deepEqual(opened, [1]);
  });

  it('HomeSplitCard draws bars relative to the largest, and reads null counts as unknown', () => {
    render(React.createElement(HomeSplitCard, {
      title: 'Alerts', icon: 'alerts', scheduled: 12_345, realTime: null,
      health: { healthy: 900, failed: 1, warning: null },
    }));
    const chart = screen.getByRole('figure', { name: 'Alerts trigger status: Healthy 900, Failed 1, Warning unknown' });
    const bars = chart.querySelectorAll('.home-health-bar');
    assert.equal(bars[0].style.height, '100%');
    assert.equal(bars[1].style.height, '2%'); // a 1 beside a 900 is still visible
    assert.equal(bars[2].style.height, '0%');
    assert.ok(screen.getByText('12.3K'));
    const realTime = screen.getByText('Real time').parentElement.querySelector('.home-split-value');
    assert.equal(realTime.textContent, '—');
  });

  it('HomeSplitCard says "No data available" when trigger status is unreadable', () => {
    render(React.createElement(HomeSplitCard, { title: 'Pipelines', icon: 'pipelines', health: null }));
    assert.ok(screen.getByText('No data available'));
  });

  it('HomeResourcesCard renders unlinked rows as plain rows and hides Explore when empty', () => {
    render(React.createElement(HomeResourcesCard, {
      counts: [{ key: 'functions', label: 'Functions', icon: 'functions', value: 2_500_000_000 }],
      explore: [],
      loading: true,
    }));
    assert.ok(screen.getByText('2.5B'));
    assert.equal(screen.queryByRole('button'), null);
    assert.equal(screen.queryByText('Explore'), null);
    assert.ok(screen.getByLabelText('Loading'));
  });

  it('formats counts and bytes compactly', () => {
    assert.equal(formatCount(null), '—');
    assert.equal(formatCount(9_999), (9_999).toLocaleString());
    assert.equal(formatCount(1_500_000), '1.5M');
    assert.equal(formatBytes(null), '—');
    assert.equal(formatBytes(1536), '1.50 KB');
  });
});
