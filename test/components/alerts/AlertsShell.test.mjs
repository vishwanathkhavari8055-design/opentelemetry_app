/**
 * AlertsShell picks between the Rules and (fired) Alerts faces of the Alerts
 * screen. Guarded: it opens on Alerts by default and restores a remembered
 * Rules choice; the Rules tab and panel are ABSENT (not just hidden) for a user
 * without VIEW_ALERT_RULES, even if Rules was remembered; the firing badge comes
 * from /notifications/summary (needsAttention, capped at 99+) and a failed
 * summary leaves no badge rather than breaking the screen.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { default: AlertsShell } = await import('../../../src/components/alerts/AlertsShell.jsx');
const { default: AuthContext } = await import('../../../src/auth/AuthContext.jsx');

const LS_TAB = 'observability-ui:alerts:shell-tab:v1';

const renderShell = (role) => render(
  React.createElement(AuthContext.Provider, { value: { role } },
    React.createElement(AlertsShell, { activeOrg: 'org1', onNavigate: () => {} })),
);

const tab = (id) => document.getElementById(id);
const panel = (id) => document.getElementById(id);

describe('AlertsShell', () => {
  let stub;
  let origError;
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* none */ }
    // The fired page and rules list log their own unstubbed-endpoint failures.
    origError = console.error;
    console.error = () => {};
  });
  afterEach(() => { cleanup(); stub?.restore(); stub = null; console.error = origError; });

  it('opens on Alerts with the needs-attention badge, and switches to Rules and back', async () => {
    stub = stubFetch([[/\/alerts\/notifications\/summary/, { firing: 2, acknowledged: 1, needsAttention: 3 }]]);
    renderShell('ADMIN');
    assert.ok(screen.getByText('Alerts', { selector: 'h1' }));
    assert.equal(tab('alerts-tab-fired').getAttribute('aria-selected'), 'true');
    assert.equal(panel('alerts-panel-rules').hidden, true, 'rules is mounted but hidden');
    assert.equal(panel('alerts-panel-fired').hidden, false);
    await waitFor(() => assert.equal(screen.getByLabelText('3 firing').textContent, '3'));

    fireEvent.click(tab('alerts-tab-rules'));
    assert.equal(tab('alerts-tab-rules').getAttribute('aria-selected'), 'true');
    assert.equal(panel('alerts-panel-rules').hidden, false);
    assert.equal(panel('alerts-panel-fired').children.length, 0, 'fired page unmounts off its tab');
    assert.equal(localStorage.getItem(LS_TAB), 'rules');

    fireEvent.click(tab('alerts-tab-fired'));
    assert.equal(localStorage.getItem(LS_TAB), 'fired');
    assert.ok(panel('alerts-panel-fired').children.length > 0);
  });

  it('restores a remembered Rules tab and ignores a stale key', () => {
    stub = stubFetch([[/summary/, { firing: 0 }]]);
    localStorage.setItem(LS_TAB, 'rules');
    renderShell('ADMIN');
    assert.equal(tab('alerts-tab-rules').getAttribute('aria-selected'), 'true');
    cleanup();
    localStorage.setItem(LS_TAB, 'bogus');
    renderShell('ADMIN');
    assert.equal(tab('alerts-tab-fired').getAttribute('aria-selected'), 'true');
  });

  it('omits the Rules tab and panel without the rules grant, even when Rules was remembered', async () => {
    localStorage.setItem(LS_TAB, 'rules');
    stub = stubFetch([[/summary/, { firing: 150, acknowledged: 0 }]]);
    renderShell('OPERATOR');
    assert.equal(tab('alerts-tab-rules'), null);
    assert.equal(panel('alerts-panel-rules'), null);
    assert.equal(tab('alerts-tab-fired').getAttribute('aria-selected'), 'true');
    await waitFor(() => assert.equal(screen.getByLabelText('150 firing').textContent, '99+'));
    assert.equal(stub.calls.some((c) => /\/alerts(\?|$)/.test(c.url)), false,
      'the rule store is never queried for a user who may not read it');
  });

  it('shows no badge when nothing needs attention or the summary fails', async () => {
    stub = stubFetch([[/summary/, { status: 500, body: { error: 'down' } }]]);
    renderShell('OPERATOR');
    await waitFor(() => assert.ok(stub.calls.some((c) => /summary/.test(c.url))));
    assert.equal(document.querySelector('.alerts-shell-badge'), null);
    cleanup();
    stub.restore();
    stub = stubFetch([[/summary/, { firing: 0, acknowledged: 0 }]]);
    renderShell('OPERATOR');
    await waitFor(() => assert.ok(stub.calls.some((c) => /summary/.test(c.url))));
    assert.equal(document.querySelector('.alerts-shell-badge'), null);
  });
});
