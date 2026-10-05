/**
 * The Dashboards screen: a folder-tile browser over the registry.
 *
 * Guarded here, because each has a distinct fix and they look alike on screen:
 *  - the tree is built from Grafana's folders plus ENABLED registrations, a
 *    single allow-listed parent collapses into the breadcrumb, and tiles carry
 *    counts, "N disabled" and "In Grafana: …" notes;
 *  - "nothing registered" vs "Grafana is not configured" vs a load failure;
 *  - a panel drill-down to an unregistered UID explains itself instead of
 *    silently doing nothing, and a registered one opens the viewer.
 *
 * The viewer itself (DashboardSceneViewer) pulls in @grafana/* which does not
 * load under Node, so opening a dashboard is asserted up to the Suspense
 * fallback; the lazy import's failure is contained by a test error boundary.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react');
const { default: DashboardsView } = await import('../../../../src/components/dashboards/DashboardsView.jsx');
const { requestDashboardNavigation } = await import('../../../../src/grafana/dashboardNavigation.js');

const h = React.createElement;

class Contain extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? h('p', null, 'viewer failed to load') : this.props.children; }
}

const FOLDERS = { items: [
  { uid: 'app', title: 'App', path: 'App', depth: 0 },
  { uid: 'orgA', title: 'Org A', path: 'App / Org A', depth: 1, parentUid: 'app' },
  { uid: 'orgB', title: 'Org B', path: 'App / Org B', depth: 1, parentUid: 'app' },
  { uid: 'svc', title: 'Services', path: 'App / Org A / Services', depth: 2, parentUid: 'orgA' },
  { uid: 'empty', title: 'Empty', path: 'App / Empty', depth: 1, parentUid: 'app' },
] };
const REGS = { items: [
  { uid: 'cpu', title: 'CPU', folderUid: 'svc', enabled: true, displayOrder: 1 },
  { uid: 'mem', title: '', folderUid: 'orgB', enabled: true, folderMismatch: true, grafanaFolderTitle: 'Legacy' },
] };
const TILES = { items: [{ folderUid: 'orgB', total: 2, enabled: 1 }] };

const routes = ({ tiles = TILES, regs = REGS, folders = FOLDERS, health = { supported: true } } = {}) => [
  [/\/registry\/folder-summary/, tiles],
  [/\/registry/, regs],
  [/\/folders/, folders],
  [/\/health/, health],
];

let stub;
const swallow = (e) => e.preventDefault();
beforeEach(() => window.addEventListener('error', swallow));
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = null;
  window.removeEventListener('error', swallow);
});

const heading = () => document.querySelector('h1').textContent;
const loaded = () => waitFor(() => assert.equal(document.querySelector('.gd-loader') === null, true));

describe('DashboardsView', () => {
  it('browses the collapsed folder tree down to a dashboard and back', async () => {
    stub = stubFetch(routes());
    render(h(DashboardsView, { activeOrg: 'default' }));
    assert.ok(screen.getByLabelText('Loading'));
    await loaded();
    assert.ok(stub.calls.some((c) => /\/registry\?enabledOnly=true/.test(c.url)));

    // The lone "App" parent is folded into the breadcrumb; the orgs are the tiles.
    assert.equal(heading(), 'App');
    assert.ok(screen.getByText('App', { selector: '.gd-crumb-ghost' }));
    assert.equal(screen.queryByText('Empty') === null, true);
    const orgB = screen.getByTitle('App / Org B');
    assert.match(orgB.textContent, /1 dashboard/);
    assert.match(orgB.textContent, /1 disabled/);
    assert.equal(document.querySelector('.gd-foot').textContent, '2 dashboards across 2 folders.');

    fireEvent.click(screen.getByTitle('App / Org A'));
    assert.equal(heading(), 'Org A');
    fireEvent.click(screen.getByTitle('App / Org A / Services'));
    assert.equal(heading(), 'Services');
    assert.ok(screen.getByTitle('Open CPU'));
    assert.equal(document.querySelector('.gd-foot') === null, true);

    fireEvent.click(screen.getByText('Org A', { selector: 'button' }));
    assert.equal(heading(), 'Org A');
    fireEvent.click(screen.getByText('Dashboards', { selector: 'button' }));
    assert.equal(heading(), 'App');

    fireEvent.click(screen.getByTitle('App / Org B'));
    const tile = screen.getByTitle('Open mem');
    assert.match(tile.textContent, /In Grafana: Legacy/);
  });

  it('opening a dashboard swaps the browser for the viewer', async () => {
    stub = stubFetch(routes());
    render(h(Contain, null, h(DashboardsView)));
    await loaded();
    fireEvent.click(screen.getByTitle('App / Org A'));
    fireEvent.click(screen.getByTitle('App / Org A / Services'));
    fireEvent.click(screen.getByTitle('Open CPU'));
    assert.equal(screen.queryByTitle('Open CPU') === null, true);
    assert.ok(document.querySelector('.gd-view--viewer') || screen.getByText('viewer failed to load'));
  });

  it('a drill-down to an unregistered dashboard explains itself; a registered one opens', async (t) => {
    t.mock.method(console, 'warn', () => {});
    stub = stubFetch(routes());
    render(h(Contain, null, h(DashboardsView)));
    await loaded();
    act(() => { requestDashboardNavigation('/d/nope/some-slug'); });
    assert.match(screen.getByRole('status').textContent, /That dashboard is not registered.*"nope"/);

    act(() => { requestDashboardNavigation('/d/cpu/cpu?from=now-1h&to=now'); });
    assert.equal(screen.queryByTitle('App / Org A') === null, true);
  });

  it('says nothing is registered yet', async () => {
    stub = stubFetch(routes({ regs: { items: [] }, tiles: { items: [] } }));
    render(h(DashboardsView));
    assert.ok(await screen.findByText('No dashboards registered yet'));
    assert.ok(screen.getByText(/Register a Grafana dashboard UID in Settings/));
  });

  it('says Grafana is not configured, both when empty and over registered tiles', async () => {
    const health = { supported: false, message: 'GRAFANA_BASE_URL is not set.' };
    stub = stubFetch(routes({ regs: { items: [] }, tiles: { items: [] }, health }));
    render(h(DashboardsView));
    assert.ok(await screen.findByText('Grafana is not configured'));
    assert.ok(screen.getByText('GRAFANA_BASE_URL is not set.'));
    cleanup();
    stub.restore();

    stub = stubFetch(routes({ health }));
    render(h(DashboardsView));
    await loaded();
    assert.match(document.querySelector('.alerts-banner').textContent,
      /GRAFANA_BASE_URL is not set\. The dashboards below are registered/);
  });

  it('shows a load failure, dismisses it, and Refresh reloads', async () => {
    let fail = true;
    stub = stubFetch([
      [/\/registry\/folder-summary/, () => (fail ? { status: 503, body: { error: 'Registry unavailable.' } } : TILES)],
      ...routes().slice(1),
    ]);
    render(h(DashboardsView));
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent, /Registry unavailable\./);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    assert.equal(document.querySelector('[role="alert"]') === null, true);

    fail = false;
    fireEvent.click(screen.getByLabelText('Refresh'));
    await waitFor(() => assert.equal(heading(), 'App'));
  });

  it('files dashboards from folders Grafana no longer lists under their own tile', async () => {
    stub = stubFetch(routes({
      folders: { items: [] },
      regs: { items: [{ uid: 'x', title: 'Orphan', folderUid: 'gone', folderTitle: 'Gone folder', enabled: true }] },
      tiles: { items: [] },
    }));
    render(h(DashboardsView));
    await loaded();
    // A single detached folder with dashboards does not collapse.
    fireEvent.click(await screen.findByText('Gone folder'));
    assert.ok(screen.getByTitle('Open Orphan'));
    assert.equal(document.querySelector('.gd-subtitle').textContent, '1 dashboard');
  });
});
