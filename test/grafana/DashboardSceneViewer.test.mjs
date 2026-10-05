/**
 * Guards the screen that fetches a registered dashboard's live definition,
 * builds its scene and drives it from this application's own toolbar.
 *
 * What it owes the user: an error card that says WHICH failure happened (not
 * found, disabled, Grafana not configured, unreachable) with a retry; a scene
 * that opens on the time range the user drilled in with; a toolbar whose range,
 * refresh and auto-refresh actually reach the scene's live time range; a
 * dashboard edited in Grafana picked up without a reload; and drill-down links
 * inside panels re-routed to this app rather than to Grafana.
 */
import './grafanaEnv.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { stubFetch } from '../support/fetch.mjs';
import { capturing } from './grafanaEnv.mjs';

const React = (await import('react')).default;
const { render, cleanup, screen, waitFor, fireEvent, act } = await import('@testing-library/react');
const { sceneGraph } = await import('@grafana/scenes');
const { default: DashboardSceneViewer } = await import('../../src/components/dashboards/DashboardSceneViewer.jsx');
const { onDashboardNavigation } = await import('../../src/grafana/dashboardNavigation.js');
const { CATALOG_MAX_AGE_MS } = await import('../../src/grafana/datasources.js');

const DEFINITION = /\/dashboards\/registry\/([^/]+)\/definition/;
const model = (extra = {}) => ({
  uid: 'dash-1',
  title: 'Model title',
  time: { from: 'now-1h', to: 'now' },
  panels: [{ id: 1, type: 'text', title: 'Notes', gridPos: { x: 0, y: 0, w: 12, h: 4 }, options: { content: 'hi' } }],
  ...extra,
});

let fetchStub;
let clock = Date.now();
function serve(definition, { health } = {}) {
  fetchStub?.restore();
  fetchStub = stubFetch([
    [DEFINITION, definition],
    [/\/dashboards\/health/, health ?? { supported: true }],
    [/\/dashboards\/datasources/, { items: [] }],
  ]);
  return fetchStub;
}

const view = (props = {}) => render(React.createElement(DashboardSceneViewer, { uid: 'dash-1', ...props }));
const rangeSelect = () => screen.getByLabelText('Time range');
const status = (container) => container.querySelector('.gd-status').textContent;
const definitionCalls = () => fetchStub.calls.filter((c) => DEFINITION.test(c.url)).length;

async function opened(props, definition = { model: model(), title: 'Service Health', version: 3 }) {
  serve(definition);
  const utils = view(props);
  await waitFor(() => assert.ok(utils.container.querySelector('.gd-toolbar-sub').textContent.includes(`v${definition.version}`)));
  await waitFor(() => assert.notEqual(status(utils.container), 'Loading'));
  return utils;
}

/**
 * Spy on the scene's LIVE time range — the object sceneGraph resolves, which is
 * the only one the viewer is allowed to drive. Its handlers are instance fields,
 * so they are wrapped on each instance as the graph hands it out.
 */
function spyOnLiveTimeRange() {
  const calls = { onRefresh: [], onTimeRangeChange: [] };
  const original = sceneGraph.getTimeRange;
  const wrapped = new WeakSet();
  mock.method(sceneGraph, 'getTimeRange', (object) => {
    const range = original(object);
    if (range && !wrapped.has(range)) {
      wrapped.add(range);
      for (const name of Object.keys(calls)) {
        const real = range[name];
        range[name] = (...args) => { calls[name].push(args); return real.apply(range, args); };
      }
    }
    return range;
  });
  return calls;
}

describe('DashboardSceneViewer', () => {
  beforeEach(() => {
    // Each test sees its own datasource catalog, not a cached one.
    clock += CATALOG_MAX_AGE_MS * 10;
    mock.method(Date, 'now', () => clock);
  });
  afterEach(() => {
    cleanup();
    fetchStub?.restore();
    fetchStub = undefined;
    mock.restoreAll();
  });

  it('shows the registration title and a loader while the definition arrives', async () => {
    let release;
    serve(() => new Promise((resolve) => { release = resolve; }));
    const { container } = view({ registration: { title: 'From registry', folderTitle: 'Ops' } });
    assert.equal(container.querySelector('.gd-toolbar-heading').textContent, 'From registry');
    assert.equal(container.querySelector('.gd-toolbar-sub').textContent, 'UID dash-1 · Ops');
    assert.ok(screen.getByRole('status', { name: 'Loading' }));
    assert.equal(status(container), 'Loading');
    assert.equal(rangeSelect().disabled, true);
    await waitFor(() => assert.ok(release));
    release({ model: model(), title: 'Arrived', version: 1 });
    await waitFor(() => assert.equal(container.querySelector('.gd-toolbar-heading').textContent, 'Arrived'));
  });

  it("renders the scene with the definition's title, version and default range", async () => {
    const { container } = await opened({ registration: { folderTitle: 'Ops' } });
    assert.equal(container.querySelector('.gd-toolbar-heading').textContent, 'Service Health');
    assert.equal(container.querySelector('.gd-toolbar-sub').textContent, 'UID dash-1 · v3 · Ops');
    assert.equal(rangeSelect().value, 'now-1h');
    assert.equal(rangeSelect().disabled, false);
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.ok(container.querySelector('.gd-scene').children.length > 0, 'scene mounted');
    assert.match(fetchStub.calls[0].url, /\/dashboards\/registry\/dash-1\/definition$/);
  });

  it('opens on the range the user drilled in with, overriding the dashboard default', async () => {
    await opened({ initialFrom: 'now-24h', initialTo: 'now' });
    assert.equal(rangeSelect().value, 'now-24h');
    cleanup();
    await opened({ initialFrom: '1767225600000', initialTo: '1767229200000' });
    assert.match(rangeSelect().selectedOptions[0].textContent, /^Custom · 1767225600000 → 1767229200000$/);
  });

  it('starts auto-refresh when the dashboard saved a refresh interval the toolbar offers', async () => {
    const { container } = await opened(undefined, { model: model({ refresh: '30s' }), title: 'T', version: 1 });
    assert.equal(status(container), 'Live · 30s');
    assert.equal(screen.getByLabelText('Auto-refresh interval').value, '30s');
    assert.ok(container.querySelector('.gd-dot.is-live'));
  });

  it('ignores a saved refresh interval the toolbar does not offer', async () => {
    const { container } = await opened(undefined, { model: model({ refresh: '7s' }), title: 'T', version: 1 });
    await waitFor(() => assert.equal(status(container), 'Paused'));
  });

  it("moves the scene's live time range when the toolbar range changes", async () => {
    const calls = spyOnLiveTimeRange();
    await opened();
    fireEvent.change(rangeSelect(), { target: { value: 'now-7d' } });
    assert.equal(calls.onTimeRangeChange.length, 1);
    assert.deepEqual(calls.onTimeRangeChange[0][0].raw, { from: 'now-7d', to: 'now' });
    await waitFor(() => assert.equal(rangeSelect().value, 'now-7d'));
  });

  it('refreshes the scene on demand, and shows it is doing so', async () => {
    const calls = spyOnLiveTimeRange();
    const { container } = await opened();
    const button = screen.getByLabelText('Refresh now');
    fireEvent.click(button);
    assert.equal(calls.onRefresh.length, 1);
    assert.equal(button.disabled, true);
    assert.ok(container.querySelector('svg.gd-spin'));
    await waitFor(() => assert.equal(button.disabled, false), { timeout: 1500 });
  });

  it('ticks auto-refresh when the tab becomes visible, and stops while it is hidden', async () => {
    const calls = spyOnLiveTimeRange();
    const { container } = await opened();
    fireEvent.change(screen.getByLabelText('Auto-refresh interval'), { target: { value: '10s' } });
    await waitFor(() => assert.equal(status(container), 'Live · 10s'));

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      act(() => { document.dispatchEvent(new window.Event('visibilitychange')); });
      assert.equal(calls.onRefresh.length, 0);
    } finally {
      delete document.visibilityState;
    }
    act(() => { document.dispatchEvent(new window.Event('visibilitychange')); });
    assert.equal(calls.onRefresh.length, 1, 'a returning tab refreshes at once');
  });

  it('picks up a dashboard edited in Grafana, keeping the range on screen', async () => {
    const { container } = await opened();
    fireEvent.change(rangeSelect(), { target: { value: 'now-3h' } });
    await waitFor(() => assert.equal(rangeSelect().value, 'now-3h'));

    serve({ model: model({ title: 'x' }), title: 'Service Health v4', version: 4 });
    const logged = await capturing('info', async () => {
      act(() => { document.dispatchEvent(new window.Event('visibilitychange')); });
      await waitFor(() => assert.equal(container.querySelector('.gd-toolbar-sub').textContent, 'UID dash-1 · v4'));
    });
    assert.match(logged.join(), /"Service Health v4" changed in Grafana \(v3 -> v4\)/);
    assert.equal(container.querySelector('.gd-toolbar-heading').textContent, 'Service Health v4');
    assert.equal(rangeSelect().value, 'now-3h');
  });

  it('leaves the scene alone when the definition is unchanged or the check fails', async () => {
    const { container } = await opened();
    act(() => { document.dispatchEvent(new window.Event('visibilitychange')); });
    await waitFor(() => assert.equal(definitionCalls(), 2));
    assert.equal(container.querySelector('.gd-toolbar-sub').textContent, 'UID dash-1 · v3');

    serve({ status: 500, body: { message: 'blip' } });
    const warned = await capturing('warn', async () => {
      act(() => { document.dispatchEvent(new window.Event('visibilitychange')); });
      await waitFor(() => assert.equal(definitionCalls(), 1));
      await act(() => new Promise((resolve) => { setTimeout(resolve, 10); }));
    });
    assert.match(warned.join(), /could not check the dashboard for changes/);
    assert.equal(container.querySelector('[role="alert"]'), null, 'a failed check is not an error card');
  });

  it('re-routes a dashboard link inside a panel to this application', async () => {
    const { container } = await opened();
    const seen = [];
    const off = onDashboardNavigation((target) => seen.push(target));
    try {
      const scene = container.querySelector('.gd-scene');
      const link = document.createElement('a');
      link.setAttribute('href', '/d/other-uid/other?from=now-1h&to=now');
      link.innerHTML = '<span>open</span>';
      const external = document.createElement('a');
      external.setAttribute('href', '#notes');
      scene.append(link, external);

      const inner = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      link.firstChild.dispatchEvent(inner);
      assert.equal(inner.defaultPrevented, true);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].uid, 'other-uid');

      const outside = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      external.dispatchEvent(outside);
      assert.equal(outside.defaultPrevented, false, 'a non-dashboard link is left alone');
      scene.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      assert.equal(seen.length, 1);
    } finally {
      off();
    }
  });

  describe('failures', () => {
    const failsWith = async (answer, options) => {
      serve(answer, options);
      const { container } = view();
      const alert = await screen.findByRole('alert');
      return { container, title: alert.querySelector('.gd-state-title').textContent, detail: alert.querySelector('.gd-state-detail').textContent };
    };

    for (const [status, title] of [
      [404, 'Dashboard not found'],
      [400, 'Grafana rejected the request'],
      [502, 'Grafana could not be reached'],
      [500, 'Could not load the dashboard'],
    ]) {
      it(`names an HTTP ${status} "${title}"`, async () => {
        const failed = await failsWith({ status, body: { message: `said ${status}` } });
        assert.equal(failed.title, title);
        assert.equal(failed.detail, `said ${status}`);
        assert.equal(failed.container.querySelector('.gd-status').textContent, 'Error');
      });
    }

    it('tells a disabled dashboard from a deployment with no Grafana', async () => {
      const disabled = await failsWith({ status: 409, body: { message: 'disabled' } });
      assert.equal(disabled.title, 'This dashboard is disabled');
      cleanup();
      const unconfigured = await failsWith({ status: 409, body: {} }, { health: { supported: false, message: 'No GRAFANA_URL set' } });
      assert.equal(unconfigured.title, 'Grafana is not configured on this deployment');
      assert.equal(unconfigured.detail, 'No GRAFANA_URL set');
      cleanup();
      const defaulted = await failsWith({ status: 409, body: {} }, { health: { supported: false } });
      assert.equal(defaulted.detail, 'No Grafana is configured on this deployment.');
      cleanup();
      const healthDown = await failsWith({ status: 409, body: { message: 'x' } }, { health: { status: 500, body: {} } });
      assert.equal(healthDown.title, 'This dashboard is disabled');
    });

    it('says the backend is unreachable when the request never lands', async () => {
      fetchStub?.restore();
      const original = globalThis.fetch;
      globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
      try {
        view();
        const alert = await screen.findByRole('alert');
        assert.equal(alert.querySelector('.gd-state-title').textContent, 'The backend is unreachable');
      } finally {
        globalThis.fetch = original;
      }
    });

    it('rejects a definition with no model', async () => {
      const failed = await failsWith({ title: 'x' });
      assert.equal(failed.title, 'Invalid dashboard');
      assert.equal(failed.detail, 'Grafana returned no dashboard model for this UID.');
    });

    it('tries again on request', async () => {
      await failsWith({ status: 502, body: {} });
      serve({ model: model(), title: 'Recovered', version: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => assert.equal(document.querySelector('.gd-toolbar-heading').textContent, 'Recovered'));
      assert.equal(screen.queryByRole('alert'), null);
    });
  });
});
