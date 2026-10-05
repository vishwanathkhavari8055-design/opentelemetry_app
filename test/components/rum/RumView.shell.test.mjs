/**
 * RumView is the shell every RUM tab reads its scope from. What is guarded: the
 * Service / Env / Version dropdowns come from /api/rum/scope for the chosen
 * window, a selection flows into the active tab's request, a selection that has
 * vanished from the stream drops back to <ALL> (otherwise every panel goes empty
 * for a reason hidden in a dropdown), the tab and window persist, only the
 * visible tab fetches, Refresh and auto-refresh re-run its query, and a failed
 * scope read is a warning rather than a broken screen.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
const { default: RumView } = await import('../../../src/components/rum/RumView.jsx');

const h = React.createElement;
const LS_TAB = 'observability-ui:rum:tab:v1';
const LS_WINDOW = 'observability-ui:rum:window:v1';

const SCOPE = { services: ['web', 'admin'], environments: ['prod'], versions: [] };
const PERF = {
  vitals: [{ key: 'lcp', label: 'LCP', value: 900, unit: 'ms', sample: 2 }],
  counts: { totalSessions: 2 },
};
const SESSIONS = { summary: { sessions: 1 }, items: [], total: 1 };
const ERRORS = { summary: { totalErrors: 1 }, items: [], total: 1 };

const routes = (scope = SCOPE) => [
  [/\/rum\/scope/, scope],
  [/\/rum\/performance/, PERF],
  [/\/rum\/sessions/, SESSIONS],
  [/\/rum\/errors/, ERRORS],
];

const paramsOf = (call) => new URL(call.url, 'http://x').searchParams;
const callsTo = (stub, path) => stub.calls.filter((c) => c.url.includes(`/rum/${path}`));

let stub;
beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  mock.timers.reset(); cleanup(); stub?.restore(); stub = null;
  delete document.visibilityState; // un-shadow jsdom's own getter
});

describe('RumView', () => {
  it('opens on Performance over the past 6 hours and loads the scope', async () => {
    stub = stubFetch(routes());
    render(h(RumView, {}));
    await screen.findByText('Performance Summary');
    assert.equal(screen.getByRole('tab', { name: 'Performance' }).getAttribute('aria-selected'), 'true');
    assert.equal(screen.getByLabelText('Time range').value, 'now-6h');
    assert.equal(paramsOf(callsTo(stub, 'scope')[0]).get('window'), 'now-6h');
    await waitFor(() => assert.equal(screen.getByLabelText('Service').options.length, 3));
    // Version has nothing to offer, so it is disabled with a reason.
    const version = screen.getByLabelText('Version');
    assert.equal(version.disabled, true);
    assert.equal(version.title, 'No version values reported in this window');
    assert.equal(callsTo(stub, 'sessions').length, 0);
  });

  it('sends the selected service to the tab and persists tab and window', async () => {
    stub = stubFetch(routes());
    render(h(RumView, {}));
    await waitFor(() => assert.equal(screen.getByLabelText('Service').disabled, false));

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Env'), { target: { value: 'prod' } });
    await waitFor(() => {
      const qs = paramsOf(callsTo(stub, 'performance').at(-1));
      assert.equal(qs.get('service'), 'admin');
      assert.equal(qs.get('env'), 'prod');
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    await screen.findByText('Median Duration');
    assert.equal(paramsOf(callsTo(stub, 'sessions')[0]).get('service'), 'admin');
    screen.getByText('Real user sessions — who, on what, how long, and what broke');
    assert.equal(localStorage.getItem(LS_TAB), 'sessions');

    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'now-7d' } });
    await waitFor(() => assert.equal(paramsOf(callsTo(stub, 'scope').at(-1)).get('window'), 'now-7d'));
    assert.equal(localStorage.getItem(LS_WINDOW), 'now-7d');

    fireEvent.click(screen.getByRole('tab', { name: 'Error Tracking' }));
    await screen.findByText('Crash-free Sessions');
    assert.equal(paramsOf(callsTo(stub, 'errors')[0]).get('window'), 'now-7d');
  });

  it('restores the stored tab and window, ignoring junk values', async () => {
    localStorage.setItem(LS_TAB, 'errors');
    localStorage.setItem(LS_WINDOW, 'now-15m');
    stub = stubFetch(routes());
    render(h(RumView, {}));
    await screen.findByText('Crash-free Sessions');
    assert.equal(screen.getByLabelText('Time range').value, 'now-15m');
    cleanup();

    localStorage.setItem(LS_TAB, 'bogus');
    localStorage.setItem(LS_WINDOW, 'now-99y');
    render(h(RumView, {}));
    await screen.findByText('Performance Summary');
    assert.equal(screen.getByLabelText('Time range').value, 'now-6h');
  });

  it('drops a selection that vanished from the new window back to <ALL>', async () => {
    let scope = SCOPE;
    stub = stubFetch([[/\/rum\/scope/, () => scope], ...routes().slice(1)]);
    render(h(RumView, {}));
    await waitFor(() => assert.equal(screen.getByLabelText('Service').disabled, false));
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Env'), { target: { value: 'prod' } });
    assert.equal(screen.getByLabelText('Service').value, 'admin');

    scope = { services: ['web'], environments: ['staging'], versions: ['1.0'] };
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'now-1h' } });
    await waitFor(() => assert.equal(screen.getByLabelText('Service').value, '<ALL>'));
    assert.equal(screen.getByLabelText('Env').value, '<ALL>');
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0' } });
    assert.equal(screen.getByLabelText('Version').value, '1.0');

    scope = { services: ['web'], environments: ['staging'], versions: ['2.0'] };
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'now-12h' } });
    await waitFor(() => assert.equal(screen.getByLabelText('Version').value, '<ALL>'));
  });

  it('warns when the scope cannot be read but still shows the panel', async () => {
    stub = stubFetch([[/\/rum\/scope/, { status: 500, body: { message: 'scope down' } }], ...routes().slice(1)]);
    render(h(RumView, {}));
    await screen.findByText('Performance Summary');
    const banner = await screen.findByText(/scope down The filters below may be incomplete/);
    assert.ok(banner);
    assert.equal(screen.getByLabelText('Service').disabled, true);
  });

  it('re-runs the scope and the active tab on Refresh', async () => {
    stub = stubFetch(routes());
    render(h(RumView, {}));
    await screen.findByText('Performance Summary');
    const before = callsTo(stub, 'performance').length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => assert.equal(callsTo(stub, 'performance').length, before + 1));
    assert.equal(callsTo(stub, 'scope').length, 2);
  });

  it('auto-refreshes on the chosen interval, pauses while hidden and catches up on return', async () => {
    stub = stubFetch(routes());
    render(h(RumView, {}));
    await screen.findByText('Performance Summary');
    mock.timers.enable({ apis: ['setInterval'] });
    fireEvent.change(screen.getByLabelText('Auto refresh interval'), { target: { value: '30' } });
    const before = callsTo(stub, 'scope').length;

    act(() => { mock.timers.tick(30_000); });
    const afterTick = () => callsTo(stub, 'scope').length;
    await act(async () => {});
    assert.equal(afterTick(), before + 1);

    // Hidden: the interval stops.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { mock.timers.tick(60_000); });
    await act(async () => {});
    assert.equal(afterTick(), before + 1);

    // Visible again: one immediate refresh, then the interval resumes.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => {});
    assert.equal(afterTick(), before + 2);
    act(() => { mock.timers.tick(30_000); });
    await act(async () => {});
    assert.equal(afterTick(), before + 3);

    fireEvent.change(screen.getByLabelText('Auto refresh interval'), { target: { value: '0' } });
    act(() => { mock.timers.tick(120_000); });
    await act(async () => {});
    assert.equal(afterTick(), before + 3);
  });

  it('rebuilds the panel when the organization changes', async () => {
    stub = stubFetch(routes());
    const { rerender } = render(h(RumView, { activeOrg: 'a' }));
    await screen.findByText('Performance Summary');
    const before = callsTo(stub, 'performance').length;
    rerender(h(RumView, { activeOrg: 'b' }));
    await waitFor(() => assert.equal(callsTo(stub, 'performance').length, before + 1));
    await screen.findByText('Performance Summary');
  });
});
