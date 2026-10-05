/**
 * The two wrappers around the Analytics faces: AnalyticsShell (the tab strip in
 * use) and AnalyticsFlipDeck (the older flip card, still mountable).
 *
 * Guards that only the visible face is mounted — so a hidden face is not polling
 * OpenObserve — that switching tabs swaps which face is on screen, that the chosen
 * face is remembered under the key both wrappers share, that the drill callback
 * reaches either face unchanged, and that the flip ignores a click mid-animation.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubAnalytics, countCalls } from './fixtures.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { default: AnalyticsShell } = await import('../../../../src/components/analytics/AnalyticsShell.jsx');
const { default: AnalyticsFlipDeck } = await import('../../../../src/components/analytics/AnalyticsFlipDeck.jsx');

const LS_FACE = 'observability-ui:analytics:face:v1';
const tableShown = () => !!document.querySelector('.an-view');
const boardShown = () => !!document.querySelector('.acb-view');

let net;
beforeEach(() => { localStorage.clear(); net = stubAnalytics(); });
afterEach(() => {
  cleanup();
  net.restore();
  localStorage.clear();
});

describe('AnalyticsShell', () => {
  it('opens on the Category Table and mounts only that face', async () => {
    render(React.createElement(AnalyticsShell, { activeOrg: 'acme' }));
    assert.ok(screen.getByRole('heading', { name: 'Log Analytics' }));
    const tab = screen.getByRole('tab', { name: 'Category Table' });
    assert.equal(tab.getAttribute('aria-selected'), 'true');
    assert.ok(tableShown());
    assert.equal(boardShown(), false);
    await screen.findByText('Applications', { selector: '.an-label-text' });
    assert.equal(document.getElementById('analytics-panel-board').hidden, true);
  });

  it('switches to the Category Board, remembers it, and hands the drill through', async () => {
    const drills = [];
    render(React.createElement(AnalyticsShell, { onDrillToLogs: (d) => drills.push(d) }));
    fireEvent.click(screen.getByRole('tab', { name: 'Category Board' }));
    assert.equal(screen.getByRole('tab', { name: 'Category Board' }).getAttribute('aria-selected'), 'true');
    assert.ok(boardShown());
    assert.equal(tableShown(), false);
    assert.equal(localStorage.getItem(LS_FACE), 'board');

    fireEvent.click(await screen.findByText('Tools', { selector: '.acb-card-name' }));
    await screen.findByText('Tool1', { selector: '.acb-name-text' });
    const total = document.querySelector('.acb-row .acb-num.is-link');
    fireEvent.click(total);
    assert.deepEqual(drills[0].services, ['tool1']);

    cleanup();
    render(React.createElement(AnalyticsShell, {}));
    assert.ok(boardShown());
  });

  it('ignores an unknown stored tab', () => {
    localStorage.setItem(LS_FACE, 'pie');
    render(React.createElement(AnalyticsShell, {}));
    assert.ok(tableShown());
  });
});

describe('AnalyticsFlipDeck', () => {
  it('flips to the other face in two halves, and ignores clicks while flipping', async () => {
    render(React.createElement(AnalyticsFlipDeck, { activeOrg: 'acme' }));
    assert.ok(tableShown());
    const flip = screen.getByRole('button', { name: 'Flip to Category Board' });
    // Asking for the face already shown does nothing.
    fireEvent.click(screen.getByRole('tab', { name: 'Drill Table' }));
    assert.equal(flip.disabled, false);

    fireEvent.click(flip);
    assert.equal(flip.disabled, true);
    assert.ok(document.querySelector('.anf-stage.is-out'));
    // A second request mid-flip is ignored rather than queued.
    fireEvent.click(screen.getByRole('tab', { name: 'Drill Table' }));

    await waitFor(() => assert.ok(boardShown()));
    assert.equal(tableShown(), false);
    await waitFor(() => assert.ok(document.querySelector('.anf-stage.is-idle')));
    assert.equal(localStorage.getItem(LS_FACE), 'board');
    assert.equal(screen.getByRole('tab', { name: 'Category Board' }).getAttribute('aria-selected'), 'true');
    assert.ok(screen.getByRole('button', { name: 'Flip to Drill Table' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Drill Table' }));
    await waitFor(() => assert.ok(tableShown()));
    await waitFor(() => assert.ok(document.querySelector('.anf-stage.is-idle')));
  });

  it('restores the last face, and unmounting mid-flip leaves no timer behind', async () => {
    localStorage.setItem(LS_FACE, 'board');
    const { unmount } = render(React.createElement(AnalyticsFlipDeck, {}));
    assert.ok(boardShown());
    await screen.findByText('Applications', { selector: '.acb-card-name' });
    assert.deepEqual(countCalls(net.calls).at(-1), { window: 'now-24h' });
    fireEvent.click(screen.getByRole('button', { name: 'Flip to Drill Table' }));
    unmount();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(document.querySelector('.anf-deck'), null);
  });
});
