/**
 * The application shell (App.jsx): the rail, the section column, the address
 * bar, role gating and the organization scope every screen runs under.
 *
 * Rendered under the real AuthContext.Provider with a signed-in value, so the
 * permission hooks answer exactly as they do after a portal hand-off, and with
 * the backend behind stubFetch — screens this file does not own simply get 404s
 * and render their own error states.
 *
 * What is guarded, and why:
 *  - The URL fragment names the screen: a reload returns to it, a rail click
 *    PUSHES an entry (so Back works), the boot normalisation REPLACES one, and
 *    the query part (the SSO hand-off lives there) is never touched.
 *  - Back/Forward and hand-typed fragments are followed and canonicalised; a
 *    fragment naming nothing routable is ignored rather than yanking to Home.
 *  - An operator never sees Settings in the rail, and a fragment pointing
 *    there is bounced to Home without the screen mounting.
 *  - The org list adopts the backend default on first load, and an org that
 *    vanished elsewhere is replaced by the default WITH a visible notice.
 *  - Switching org re-scopes the requests that follow.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, act, within } = await import('@testing-library/react');
const { default: AuthContext } = await import('../../../../src/auth/AuthContext.jsx');
const { default: App } = await import('../../../../src/App.jsx');
const api = await import('../../../../src/services/api.js');

const h = React.createElement;

const ORGS = {
  items: [
    { identifier: 'default', name: 'Default Org', type: 'default' },
    { identifier: 'dlh', name: 'DLH' },
  ],
};

const USERS = {
  ADMIN: { id: 'a', username: 'admin.user', role: 'ADMIN', roleLabel: 'Administrator', displayName: 'Ada Admin' },
  OPERATOR: { id: 'o', username: 'op.user', role: 'OPERATOR', roleLabel: 'Operator', displayName: 'Otto Op' },
};

let fetchStub;
let consoleSaved;
const logouts = [];

function mountApp(role = 'ADMIN') {
  const user = USERS[role];
  const value = {
    status: 'AUTHENTICATED', isAuthenticated: true, isInitializing: false, isSubmitting: false,
    user, role, tenantCode: 'Primary', error: null, signedOut: false,
    sso: {}, retry() {}, logout() { logouts.push(role); }, clearError() {}, can: () => true,
  };
  return render(h(AuthContext.Provider, { value }, h(App)));
}

const setUrl = (path) => window.history.replaceState(null, '', path);
const orgCalls = () => fetchStub.calls.filter((c) => /\/iam\/organizations/.test(c.url));
const rail = (name) => within(screen.getByRole('tablist', { name: 'Primary view' })).getByRole('tab', { name });

beforeEach(() => {
  localStorage.clear();
  api.setOrg('');
  setUrl('/');
  consoleSaved = { error: console.error, warn: console.warn };
  // The screens behind the rail log their 404s; the shell's own logging is
  // asserted on explicitly where it matters.
  console.error = () => {};
  console.warn = () => {};
  fetchStub = stubFetch([[/\/iam\/organizations/, ORGS]]);
});

afterEach(() => {
  cleanup();
  fetchStub.restore();
  console.error = consoleSaved.error;
  console.warn = consoleSaved.warn;
  api.setOrg('');
  localStorage.clear();
  setUrl('/');
});

describe('App shell — routing', () => {
  it('lands on Home, normalises the fragment in place, and keeps the query', async () => {
    setUrl('/?role=admin&tenantCode=Primary');
    const before = window.history.length;
    mountApp();
    assert.ok(screen.getByRole('heading', { name: 'Home', level: 1 }));
    assert.equal(window.location.hash, '#/home');
    assert.equal(window.location.search, '?role=admin&tenantCode=Primary');
    assert.equal(window.history.length, before, 'the boot write replaces rather than pushes');
    assert.equal(rail('Home').getAttribute('aria-selected'), 'true');
    // The org list is fetched and the backend default adopted.
    await waitFor(() => assert.match(screen.getByRole('button', { name: /Default Org/ }).textContent, /Default Org/));
    assert.equal(api.getOrg(), 'default');
  });

  it('pushes a history entry per rail click and shows the placeholder screens', async () => {
    mountApp();
    const before = window.history.length;
    fireEvent.click(rail('AIOps'));
    assert.ok(screen.getByRole('heading', { name: 'AIOps', level: 1 }));
    assert.ok(screen.getByText(/Detected anomalies/));
    assert.equal(window.location.hash, '#/aiops');
    fireEvent.click(rail('Reports'));
    assert.ok(screen.getByRole('heading', { name: 'Reports', level: 1 }));
    assert.equal(window.location.hash, '#/reports');
    assert.equal(window.history.length, before + 2);
    // The brand mark goes Home.
    fireEvent.click(screen.getByRole('button', { name: 'Go to Home' }));
    assert.ok(screen.getByRole('heading', { name: 'Home', level: 1 }));
    assert.equal(window.location.hash, '#/home');
  });

  it('reopens the screen the fragment names on a reload', () => {
    setUrl('/#/reports?share=1');
    mountApp();
    assert.ok(screen.getByRole('heading', { name: 'Reports', level: 1 }));
    assert.equal(window.location.hash, '#/reports?share=1');
  });

  it('follows Back/Forward and hand-typed fragments, canonicalising them', async () => {
    mountApp();
    await act(async () => {
      window.history.replaceState(null, '', '/#/AIOPS/');
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    });
    assert.ok(screen.getByRole('heading', { name: 'AIOps', level: 1 }));
    assert.equal(window.location.hash, '#/aiops');

    // Somebody else's fragment: ignored, the screen stays.
    await act(async () => {
      window.history.replaceState(null, '', '/#section-3');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    assert.ok(screen.getByRole('heading', { name: 'AIOps', level: 1 }));

    await act(async () => {
      window.history.replaceState(null, '', '/#/reports');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    assert.ok(screen.getByRole('heading', { name: 'Reports', level: 1 }));
  });

  it('opens the Logs group on its first section, with the section column', async () => {
    localStorage.setItem('observability-ui:logs:page-size:v1', '250');
    mountApp();
    fireEvent.click(rail('Logs'));
    assert.equal(window.location.hash, '#/logs');
    const column = screen.getByRole('navigation', { name: 'Logs sections' });
    assert.ok(column);
    // The rail keeps the GROUP lit while a section is open.
    assert.equal(rail('Logs').getAttribute('aria-selected'), 'true');
    assert.equal(localStorage.getItem('observability-ui:logs:page-size:v1'), '250');

    fireEvent.click(screen.getByTitle('Analytics'));
    assert.equal(window.location.hash, '#/analytics');
    assert.ok(await screen.findByRole('heading', { name: 'Log Analytics' }));
    fireEvent.click(screen.getByTitle('Metrics'));
    assert.equal(window.location.hash, '#/metrics');
    fireEvent.click(screen.getByTitle('Traces'));
    assert.equal(window.location.hash, '#/traces');
    assert.equal(rail('Logs').getAttribute('aria-selected'), 'true');
  });

  it('carries an open trace in the fragment, on the screen it belongs to', async () => {
    setUrl('/#/logs/trace/4bf92f3577b34da6a3ce929d0e0e4736');
    mountApp();
    assert.equal(window.location.hash, '#/logs/trace/4bf92f3577b34da6a3ce929d0e0e4736');
    // Leaving the Logs screen drops the id from the address, not from Logs.
    fireEvent.click(rail('AIOps'));
    assert.equal(window.location.hash, '#/aiops');
    fireEvent.click(rail('Logs'));
    assert.equal(window.location.hash, '#/logs/trace/4bf92f3577b34da6a3ce929d0e0e4736');

    // A Back into the plain Logs fragment closes the detail view.
    await act(async () => {
      window.history.replaceState(null, '', '/#/logs');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    assert.equal(window.location.hash, '#/logs');

    // A traces fragment with a trace applies to Traces only.
    await act(async () => {
      window.history.replaceState(null, '', '/#/traces/trace/abc123');
      window.dispatchEvent(new window.PopStateEvent('popstate'));
    });
    assert.equal(window.location.hash, '#/traces/trace/abc123');
    fireEvent.click(rail('Home'));
    assert.equal(window.location.hash, '#/home');
  });

  it('mounts the other top-level screens from the rail', async () => {
    mountApp();
    fireEvent.click(rail('Alerts'));
    assert.equal(window.location.hash, '#/alerts');
    assert.ok(await screen.findByRole('heading', { name: 'Alerts', level: 1 }));
    fireEvent.click(rail('RUM'));
    assert.equal(window.location.hash, '#/rum');
    assert.ok(await screen.findByRole('heading', { name: 'Real User Monitoring' }));
    fireEvent.click(rail('Dashboards'));
    assert.equal(window.location.hash, '#/dashboards');
    fireEvent.click(rail('Settings'));
    assert.equal(window.location.hash, '#/iam');
    assert.ok(await screen.findByRole('heading', { name: 'Settings', level: 1 }));
  });
});

describe('App shell — role gating', () => {
  it('leaves Settings out of an operator\'s rail', () => {
    mountApp('OPERATOR');
    assert.equal(screen.queryByRole('tab', { name: 'Settings' }) === null, true);
    assert.ok(rail('Alerts'));
    assert.ok(screen.getByTitle('Read-only access'));
  });

  it('bounces an operator\'s Settings fragment to Home, without mounting it', async () => {
    const before = window.history.length;
    setUrl('/#/iam');
    mountApp('OPERATOR');
    assert.ok(screen.getByRole('heading', { name: 'Home', level: 1 }));
    await waitFor(() => assert.equal(window.location.hash, '#/home'));
    assert.equal(window.history.length, before, 'the correction replaces the entry');
    assert.equal(fetchStub.calls.some((c) => /\/iam\/users/.test(c.url)), false);
  });
});

describe('App shell — organizations', () => {
  it('falls back to the default, and says so, when the active org has gone', async () => {
    api.setOrg('gone_org');
    mountApp();
    const notice = await screen.findByText(/no longer exists/);
    assert.match(notice.textContent, /Organization “gone_org” no longer exists — switched to default\./);
    assert.equal(api.getOrg(), 'default');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    assert.equal(screen.queryByText(/no longer exists/) === null, true);
  });

  it('keeps a still-existing org, and re-scopes requests when the user switches', async () => {
    api.setOrg('default');
    mountApp();
    const face = await screen.findByRole('button', { name: /Default Org/ });
    const listed = orgCalls().length;
    fireEvent.click(face); // opening refreshes the list
    await waitFor(() => assert.equal(orgCalls().length, listed + 1));
    fireEvent.click(screen.getByRole('option', { name: /DLH/ }));
    assert.equal(api.getOrg(), 'dlh');
    assert.match(screen.getByRole('button', { name: /DLH/ }).textContent, /DLH/);
    // Picking the org already active changes nothing.
    fireEvent.click(screen.getByRole('button', { name: /DLH/ }));
    fireEvent.click(screen.getByRole('option', { name: /DLH/ }));
    assert.equal(api.getOrg(), 'dlh');

    const mark = fetchStub.calls.length;
    await act(async () => { window.dispatchEvent(new window.Event('focus')); });
    await waitFor(() => assert.ok(fetchStub.calls.slice(mark).some((c) => /iam\/organizations\?org=dlh/.test(c.url))));
  });

  it('refreshes on becoming visible, and keeps the switcher usable when the list fails', async () => {
    fetchStub.restore();
    fetchStub = stubFetch([[/\/iam\/organizations/, { status: 503, body: { message: 'down' } }]]);
    mountApp();
    await waitFor(() => assert.ok(orgCalls().length >= 1));
    const n = orgCalls().length;
    await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
    await waitFor(() => assert.ok(orgCalls().length > n));
    fireEvent.click(screen.getByRole('button', { name: /default/ }));
    assert.ok(await screen.findByText('No organizations available.'));
  });

  it('adopts nothing from an empty list', async () => {
    fetchStub.restore();
    fetchStub = stubFetch([[/\/iam\/organizations/, { items: [] }]]);
    mountApp();
    await waitFor(() => assert.ok(orgCalls().length >= 1));
    await act(async () => { await new Promise((r) => { setTimeout(r, 10); }); });
    assert.equal(api.getOrg(), '');
  });
});

describe('App shell — jumps from inside a screen', () => {
  const EMPTY_CATALOG = [
    [/\/iam\/organizations/, ORGS],
    [/\/analytics\//, { categories: [], items: [], catalogEmpty: true }],
  ];

  it('routes "Open Product Catalog" to Settings for someone who can open it', async () => {
    fetchStub.restore();
    fetchStub = stubFetch(EMPTY_CATALOG);
    setUrl('/#/analytics');
    mountApp();
    fireEvent.click(await screen.findByText('Open Product Catalog'));
    assert.equal(window.location.hash, '#/iam');
    assert.ok(await screen.findByRole('heading', { name: 'Settings', level: 1 }));
  });

  it('does not offer that jump to an operator', async () => {
    fetchStub.restore();
    fetchStub = stubFetch(EMPTY_CATALOG);
    setUrl('/#/analytics');
    mountApp('OPERATOR');
    await screen.findByText(/Nothing is registered in the Product Catalog yet/);
    assert.equal(screen.queryByText('Open Product Catalog') === null, true);
  });

  it('follows a Home tile into its section of the Logs group', async () => {
    mountApp();
    fireEvent.click(await screen.findByTitle('Open Traces'));
    assert.equal(window.location.hash, '#/traces');
    assert.ok(screen.getByRole('navigation', { name: 'Logs sections' }));
  });
});
