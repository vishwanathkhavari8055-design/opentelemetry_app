/**
 * The small building blocks of the Dashboards screens, driven the way a user
 * drives them:
 *  - DashboardToolbar turns the range / auto-refresh pickers into the values the
 *    scene viewer consumes, and shows a custom window instead of snapping to a
 *    preset (the reader must see what is actually on screen).
 *  - FolderCascadePicker offers one dropdown per level and reports the chosen
 *    uid at any depth, with "(register here)" stopping at the parent.
 *  - FolderTileBrowser's breadcrumb and tiles navigate by uid path.
 *  - SceneErrorBoundary contains a crashing scene and recovers on retry or when
 *    the dashboard changes, so one bad panel cannot blank the application.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, within } = await import('@testing-library/react');
const {
  default: DashboardToolbar, parseRefresh, RANGE_OPTIONS, REFRESH_OPTIONS,
} = await import('../../../../src/components/dashboards/DashboardToolbar.jsx');
const { default: FolderCascadePicker } = await import('../../../../src/components/dashboards/FolderCascadePicker.jsx');
const { default: FolderTileBrowser } = await import('../../../../src/components/dashboards/FolderTileBrowser.jsx');
const { default: SceneErrorBoundary } = await import('../../../../src/components/dashboards/SceneErrorBoundary.jsx');

const h = React.createElement;

describe('DashboardToolbar', () => {
  afterEach(cleanup);

  it('parses refresh intervals into milliseconds and rejects anything else', () => {
    assert.equal(parseRefresh(''), 0);
    assert.equal(parseRefresh('10s'), 10_000);
    assert.equal(parseRefresh('5m'), 300_000);
    assert.equal(parseRefresh('2h'), 7_200_000);
    assert.equal(parseRefresh('soon'), 0);
    assert.ok(RANGE_OPTIONS.length > 5 && REFRESH_OPTIONS[0].value === '');
  });

  it('reports a preset range, an interval and a refresh click', () => {
    const ranges = []; const intervals = []; let refreshed = 0;
    render(h(DashboardToolbar, {
      title: 'Node health', subtitle: 'Monitoring', breadcrumb: h('nav', null, 'crumbs'),
      range: { from: 'now-1h', to: 'now' }, onRangeChange: (r) => ranges.push(r),
      autoRefresh: '', onAutoRefreshChange: (v) => intervals.push(v),
      onRefresh: () => { refreshed += 1; }, status: 'Updated just now', live: true,
      actions: h('button', { type: 'button' }, 'Extra'),
    }));
    assert.equal(screen.getByRole('heading').textContent, 'Node health');
    assert.ok(screen.getByText('Monitoring'));
    assert.ok(screen.getByText('crumbs'));
    assert.ok(screen.getByRole('button', { name: 'Extra' }));
    assert.ok(screen.getByText('Updated just now'));

    const rangeSelect = screen.getByLabelText('Time range');
    assert.equal(rangeSelect.value, 'now-1h');
    fireEvent.change(rangeSelect, { target: { value: 'now-7d' } });
    assert.deepEqual(ranges, [{ from: 'now-7d', to: 'now' }]);

    fireEvent.change(screen.getByLabelText('Auto-refresh interval'), { target: { value: '30s' } });
    assert.deepEqual(intervals, ['30s']);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    assert.equal(refreshed, 1);
  });

  it('shows a custom window as its own option and disables while refreshing', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    render(h(DashboardToolbar, {
      range: { from: { toDate: () => from }, to: 'now-1h' }, refreshing: true,
    }));
    assert.equal(screen.getByRole('heading').textContent, 'Dashboard');
    const rangeSelect = screen.getByLabelText('Time range');
    assert.equal(rangeSelect.value, '');
    assert.match(rangeSelect.options[0].textContent, /^Custom · .+ → now-1h$/);
    assert.equal(screen.getByRole('button', { name: 'Refresh now' }).disabled, true);
  });

  it('labels a Date or missing bound in the custom option', () => {
    render(h(DashboardToolbar, { range: { from: new Date(0), to: undefined } }));
    assert.match(screen.getByLabelText('Time range').options[0].textContent, /^Custom · .+ → $/);
  });
});

// Two orgs under one allow-listed parent: the parent collapses away, so the
// first dropdown offers the orgs.
const FOLDERS = [
  { uid: 'root', title: 'Monitoring', path: 'Monitoring', depth: 0 },
  { uid: 'orgA', title: 'Org A', path: 'Monitoring / Org A', depth: 1, parentUid: 'root' },
  { uid: 'orgB', title: 'Org B', path: 'Monitoring / Org B', depth: 1, parentUid: 'root' },
  { uid: 'svc', title: 'Services', path: 'Monitoring / Org A / Services', depth: 2, parentUid: 'orgA' },
];

describe('FolderCascadePicker', () => {
  afterEach(cleanup);

  const renderPicker = (value) => {
    const picks = [];
    const utils = render(h(FolderCascadePicker, {
      id: 'f', folders: FOLDERS, value, onChange: (v) => picks.push(v),
    }));
    return { ...utils, picks };
  };

  it('starts at the orgs, skipping the single parent', () => {
    const { picks } = renderPicker('');
    const first = screen.getByLabelText('Folder');
    const labels = [...first.options].map((o) => o.textContent);
    assert.deepEqual(labels, ['Choose a folder…', 'Org A ›', 'Org B']);
    fireEvent.change(first, { target: { value: 'orgA' } });
    assert.deepEqual(picks, ['orgA']);
  });

  it('opens a subfolder level once a parent is chosen, and "(register here)" keeps the parent', () => {
    const { picks } = renderPicker('orgA');
    const second = screen.getByLabelText('Subfolder, level 2');
    assert.equal(second.options[0].textContent, '(register here)');
    fireEvent.change(second, { target: { value: 'svc' } });
    fireEvent.change(second, { target: { value: '' } });
    assert.deepEqual(picks, ['svc', 'orgA']);
  });

  it('shows the full trail for a deep value and falls back to the whole tree for the collapsed root', () => {
    renderPicker('svc');
    assert.equal(screen.getByLabelText('Folder').value, 'orgA');
    assert.equal(screen.getByLabelText('Subfolder, level 2').value, 'svc');
    cleanup();
    renderPicker('root');
    assert.equal(screen.getByLabelText('Folder').value, 'root');
  });
});

const node = (uid, title, extra = {}) => ({
  uid, title, path: title, children: [], dashboards: [], total: 0, disabled: 0, ...extra,
});

describe('FolderTileBrowser', () => {
  afterEach(cleanup);

  it('tiles folders at the top level with counts and navigates into one', () => {
    const paths = [];
    const child = node('c', 'Child');
    render(h(FolderTileBrowser, {
      rootLabel: 'Dashboards', trail: [node('p', 'Parent')], nodes: [],
      onNavigate: (p) => paths.push(p),
      folders: [
        node('a', 'Alpha', { total: 1, children: [child], disabled: 2 }),
        node('b', 'Beta', { total: 3, children: [child, child] }),
      ],
      actions: h('button', { type: 'button' }, 'Act'),
    }, h('p', null, 'body')));
    assert.equal(screen.getByRole('heading').textContent, 'Parent');
    assert.ok(screen.getByText('Parent', { selector: '.gd-crumb-ghost' }));
    const alpha = screen.getByRole('button', { name: /Alpha/ });
    assert.match(alpha.textContent, /1 dashboard · 1 folder/);
    assert.match(alpha.textContent, /2 disabled/);
    assert.match(screen.getByRole('button', { name: /Beta/ }).textContent, /3 dashboards · 2 folders/);
    fireEvent.click(alpha);
    assert.deepEqual(paths, [['a']]);
    assert.ok(screen.getByText('body'));
  });

  it('inside a folder, the breadcrumb goes back up and the subtitle counts contents', () => {
    const paths = [];
    const a = node('a', 'Alpha');
    const b = node('b', 'Beta', { dashboards: [{ uid: 'd1' }] });
    render(h(FolderTileBrowser, {
      rootLabel: 'Dashboards', trail: [], nodes: [a, b],
      onNavigate: (p) => paths.push(p), folders: [node('x', 'X')],
    }));
    assert.equal(screen.getByRole('heading').textContent, 'Beta');
    assert.equal(screen.getByText(/folder/, { selector: '.gd-subtitle' }).textContent, '1 folder · 1 dashboard');
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    fireEvent.click(crumbs.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(crumbs.getByRole('button', { name: 'Dashboards' }));
    assert.deepEqual(paths, [['a'], []]);
  });

  it('with nothing open and no trail, the root label is the heading', () => {
    render(h(FolderTileBrowser, {
      rootLabel: 'Dashboards', trail: [], nodes: [], onNavigate: () => {}, folders: [],
    }));
    assert.equal(screen.getByRole('heading').textContent, 'Dashboards');
  });

  it('pluralises the subtitle for several folders and dashboards, and omits zero folders', () => {
    render(h(FolderTileBrowser, {
      rootLabel: 'D', trail: [], onNavigate: () => {},
      nodes: [node('a', 'A', { dashboards: [{}, {}] })],
      folders: [],
    }));
    assert.equal(document.querySelector('.gd-subtitle').textContent, '2 dashboards');
  });
});

describe('SceneErrorBoundary', () => {
  // React rethrows a caught render error through jsdom's window; silence that echo.
  const swallow = (e) => e.preventDefault();
  beforeEach(() => window.addEventListener('error', swallow));
  afterEach(() => { window.removeEventListener('error', swallow); cleanup(); });

  let shouldThrow = true;
  const Bomb = () => {
    if (shouldThrow) throw new Error('panel exploded');
    return h('span', null, 'scene ok');
  };

  it('replaces a crashing scene with a message and recovers on "Try again"', (t) => {
    t.mock.method(console, 'error', () => {});
    shouldThrow = true;
    render(h(SceneErrorBoundary, { resetKey: 'a' }, h(Bomb)));
    assert.match(screen.getByRole('alert').textContent, /could not be rendered.*panel exploded/);
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    assert.ok(screen.getByText('scene ok'));
  });

  it('clears a previous failure when the reset key changes', (t) => {
    t.mock.method(console, 'error', () => {});
    shouldThrow = true;
    const { rerender } = render(h(SceneErrorBoundary, { resetKey: 'a' }, h(Bomb)));
    assert.ok(screen.getByRole('alert'));
    shouldThrow = false;
    rerender(h(SceneErrorBoundary, { resetKey: 'b' }, h(Bomb)));
    assert.ok(screen.getByText('scene ok'));
  });
});
