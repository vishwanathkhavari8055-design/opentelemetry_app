/**
 * The shell's small, shared chrome: the icon rail, the section column, the
 * legacy tab strip, the placeholder screen, the error boundary, toasts and the
 * organization switcher.
 *
 * Each is a thin control whose contract with App.jsx is "render what you are
 * handed, report the key that was clicked". The guarded behaviour is exactly
 * that: the active entry is the one marked selected, a click reports its own
 * key, the organization menu reports the identifier (what goes on the wire)
 * rather than the name, success toasts clear themselves while errors wait to be
 * dismissed, and a crashing child is replaced by a recoverable message instead
 * of taking the host page down with it.
 */
import '../../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { default: SideNav } = await import('../../../../../src/components/common/SideNav.jsx');
const { default: SectionNav } = await import('../../../../../src/components/common/SectionNav.jsx');
const { default: TabBar } = await import('../../../../../src/components/common/TabBar.jsx');
const { default: NavIcon, NAV_ICONS } = await import('../../../../../src/components/common/NavIcons.jsx');
const { default: PlaceholderView } = await import('../../../../../src/components/common/PlaceholderView.jsx');
const { default: ErrorBoundary } = await import('../../../../../src/components/common/ErrorBoundary.jsx');
const { default: Toast } = await import('../../../../../src/components/common/Toast.jsx');
const { default: OrgSwitcher } = await import('../../../../../src/components/common/OrgSwitcher.jsx');

const h = React.createElement;

const ITEMS = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'logs', label: 'Logs', icon: 'logs' },
  { key: 'alerts', label: 'Alerts', icon: 'alerts' },
];

afterEach(cleanup);

describe('SideNav', () => {
  it('marks the active entry and reports the clicked key', () => {
    const clicked = [];
    render(h(SideNav, { items: ITEMS, activeItem: 'logs', onItemChange: (k) => clicked.push(k) }));
    const tabs = screen.getAllByRole('tab');
    assert.deepEqual(tabs.map((t) => t.textContent), ['Home', 'Logs', 'Alerts']);
    assert.equal(screen.getByRole('tab', { name: 'Logs' }).getAttribute('aria-selected'), 'true');
    assert.equal(screen.getByRole('tab', { name: 'Home' }).getAttribute('aria-selected'), 'false');
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));
    assert.deepEqual(clicked, ['alerts']);
  });
});

describe('SectionNav', () => {
  it('labels the column, marks the active section and reports the key', () => {
    const picked = [];
    render(h(SectionNav, {
      items: ITEMS, activeItem: 'home', label: 'Logs sections', onSelect: (k) => picked.push(k),
    }));
    const nav = screen.getByRole('navigation', { name: 'Logs sections' });
    const home = within(nav).getByRole('tab', { name: 'Home' });
    assert.equal(home.getAttribute('aria-selected'), 'true');
    assert.equal(home.getAttribute('title'), 'Home');
    fireEvent.click(within(nav).getByRole('tab', { name: 'Logs' }));
    assert.deepEqual(picked, ['logs']);
  });
});

describe('TabBar', () => {
  it('is one flat tablist without a trailing slot', () => {
    const picked = [];
    render(h(TabBar, { tabs: ITEMS, activeTab: 'alerts', onTabChange: (k) => picked.push(k) }));
    assert.equal(screen.getAllByRole('tablist').length, 1);
    assert.equal(screen.getByRole('tab', { name: 'Alerts' }).getAttribute('aria-selected'), 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Home' }));
    assert.deepEqual(picked, ['home']);
  });

  it('keeps trailing controls out of the tablist', () => {
    render(h(TabBar, {
      tabs: ITEMS, activeTab: 'home', onTabChange: () => {},
      trailing: h('button', { type: 'button' }, 'Account'),
    }));
    const list = screen.getByRole('tablist');
    assert.equal(within(list).queryByText('Account'), null);
    assert.ok(screen.getByRole('button', { name: 'Account' }));
  });
});

describe('NavIcon', () => {
  it('draws the named glyph at the requested size, and home for an unknown name', () => {
    const { container } = render(h('div', null,
      h(NavIcon, { name: 'traces', size: 16, className: 'x' }),
      h(NavIcon, { name: 'no-such-icon' })));
    const [traces, unknown] = container.querySelectorAll('svg');
    assert.equal(traces.getAttribute('width'), '16');
    assert.equal(traces.getAttribute('class'), 'x');
    assert.equal(traces.querySelectorAll('circle').length, 3);
    assert.equal(unknown.getAttribute('width'), '20');
    // Home glyph is three paths and nothing else.
    assert.equal(unknown.querySelectorAll('path').length, 3);
    assert.ok(Object.keys(NAV_ICONS).includes('iam'));
  });
});

describe('PlaceholderView', () => {
  it('says what the screen will show and what it is waiting on', () => {
    render(h(PlaceholderView, {
      title: 'Reports', icon: 'reports', summary: 'Scheduled reports.',
      willShow: ['Report definitions'], needs: ['A reports endpoint'],
    }));
    assert.ok(screen.getByRole('heading', { name: 'Reports', level: 1 }));
    assert.ok(screen.getByText('Not wired up'));
    assert.ok(screen.getByText('Scheduled reports.'));
    assert.ok(screen.getByText('What this screen will show'));
    assert.ok(screen.getByText('Report definitions'));
    assert.ok(screen.getByText('A reports endpoint'));
  });

  it('omits the empty cards', () => {
    render(h(PlaceholderView, { title: 'AIOps', icon: 'aiops', summary: 'Soon.' }));
    assert.equal(screen.queryByText('What this screen will show'), null);
    assert.equal(screen.queryByText('What it needs first'), null);
  });
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(h(ErrorBoundary, null, h('p', null, 'fine')));
    assert.ok(screen.getByText('fine'));
  });

  it('replaces a crashing child with a recoverable message', () => {
    const Boom = () => { throw new Error('kaput'); };
    const originalError = console.error;
    console.error = () => {};
    try {
      render(h(ErrorBoundary, null, h(Boom)));
    } finally {
      console.error = originalError;
    }
    assert.ok(screen.getByRole('heading', { name: 'Something went wrong' }));
    assert.ok(screen.getByRole('button', { name: 'Reload Module' }));
  });
});

describe('Toast', () => {
  it('renders nothing without a message', () => {
    const { container } = render(h(Toast, { message: '', onDismiss: () => {} }));
    assert.equal(container.innerHTML, '');
  });

  it('announces a success politely and clears itself after the duration', async () => {
    let dismissed = 0;
    render(h(Toast, { message: 'Saved', duration: 20, onDismiss: () => { dismissed += 1; } }));
    const status = screen.getByRole('status');
    assert.match(status.textContent, /Success/);
    assert.match(status.textContent, /Saved/);
    assert.equal(screen.queryByRole('button', { name: 'Dismiss' }), null);
    await waitFor(() => assert.equal(dismissed, 1));
  });

  it('uses the caller title for a warning', () => {
    render(h(Toast, { message: 'Partly', tone: 'warn', title: 'Heads up', onDismiss: () => {} }));
    assert.match(screen.getByRole('status').textContent, /Heads up/);
  });

  it('keeps an error until it is dismissed', async () => {
    let dismissed = 0;
    render(h(Toast, { message: 'Failed', tone: 'error', duration: 5, onDismiss: () => { dismissed += 1; } }));
    const alert = screen.getByRole('alert');
    assert.match(alert.textContent, /Error/);
    await new Promise((r) => { setTimeout(r, 30); });
    assert.equal(dismissed, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    assert.equal(dismissed, 1);
  });
});

describe('OrgSwitcher', () => {
  const ORGS = [
    { identifier: 'default', name: 'Default org', type: 'default' },
    { identifier: 'dlh_7', name: 'DLH' },
  ];

  it('shows the active name, refreshes on open and reports the identifier picked', () => {
    const changes = [];
    let opened = 0;
    render(h(OrgSwitcher, {
      organizations: ORGS, value: 'default', onChange: (v) => changes.push(v),
      onOpen: () => { opened += 1; },
    }));
    const face = screen.getByRole('button', { name: /Default org/ });
    assert.equal(face.getAttribute('title'), 'Organization: Default org (default)');
    fireEvent.click(face);
    assert.equal(opened, 1);
    assert.equal(screen.getByRole('option', { name: /Default org/ }).getAttribute('aria-selected'), 'true');
    fireEvent.click(screen.getByRole('option', { name: /DLH/ }));
    assert.deepEqual(changes, ['dlh_7']);
    assert.equal(screen.queryByRole('listbox'), null);
  });

  it('falls back to the identifier, then to "default", before the list loads', () => {
    const { rerender } = render(h(OrgSwitcher, { organizations: [], value: 'acme', onChange: () => {}, loading: true }));
    assert.ok(screen.getByRole('button', { name: /acme/ }));
    fireEvent.click(screen.getByRole('button', { name: /acme/ }));
    assert.ok(screen.getByText('Loading…'));
    rerender(h(OrgSwitcher, { organizations: [], value: '', onChange: () => {}, loading: false }));
    assert.ok(screen.getByText('No organizations available.'));
    assert.match(screen.getByRole('button', { expanded: true }).textContent, /default/);
  });

  it('closes on Escape and on a click outside', () => {
    render(h('div', null,
      h('span', null, 'outside'),
      h(OrgSwitcher, { organizations: ORGS, value: 'dlh_7', onChange: () => {} })));
    const face = screen.getByRole('button', { name: /DLH/ });
    fireEvent.click(face);
    assert.ok(screen.getByRole('listbox'));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('listbox'), null);
    fireEvent.click(face);
    fireEvent.mouseDown(screen.getByRole('listbox'));
    assert.ok(screen.getByRole('listbox'), 'a click inside keeps it open');
    fireEvent.mouseDown(screen.getByText('outside'));
    assert.equal(screen.queryByRole('listbox'), null);
    // Closing via the face again does not trigger a refresh.
    fireEvent.click(face);
    fireEvent.click(face);
    assert.equal(screen.queryByRole('listbox'), null);
  });
});
