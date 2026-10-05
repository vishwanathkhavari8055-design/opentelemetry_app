/**
 * FiredAlertsPage wired to a stubbed backend, the way it runs. Guarded — the
 * first load asks for the list (with the default status/window filters sent as
 * repeatable params) and the summary, and renders both; a load error shows a
 * banner whose ↻ retries; filters and cards re-query the server; acknowledging
 * asks for a name, POSTs it as the actor and remembers it; resolve POSTs at
 * once; bulk actions go through a confirm and POST /bulk with the selected ids;
 * a live-stream row (no id) is transitioned by fingerprint; an unhealthy ingest
 * shows its banner and falls back to the live stream, and says so when even that
 * fails; the pager and page size re-query; the drawer opens and a drill both
 * navigates and closes it; a read-only role gets no bulk bar or row actions.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { default: AuthContext } = await import('../../../../src/auth/AuthContext.jsx');
const { default: FiredAlertsPage } = await import('../../../../src/components/alerts/fired/FiredAlertsPage.jsx');

const A1 = { id: 1, alertName: 'High CPU', serviceName: 'checkout', severity: 'critical', status: 'FIRING', lastFiredAt: '2026-09-25T10:00:00Z' };
const A2 = { id: 2, alertName: 'Disk full', serviceName: 'db', severity: 'warning', status: 'RESOLVED', lastFiredAt: '2026-09-25T09:00:00Z' };
const SUMMARY = { open: 1, acknowledged: 0, critical: 1, warning: 1, error: 0, resolved: 1 };
const HEALTHY = { healthy: true };

const pathOf = (url) => new URL(url, 'http://localhost').pathname;
const paramsOf = (url) => new URL(url, 'http://localhost').searchParams;
const isList = (url) => pathOf(url).endsWith('/alerts/query');

/** The routes a healthy backend answers, with overrides by name. */
const backend = ({
  list = { items: [A1, A2], total: 2, hasMore: false },
  summary = SUMMARY,
  ingest = HEALTHY,
  live = { items: [], total: 0 },
  transition = (url) => ({ message: `done ${pathOf(url).split('/').pop()}`, status: 'ACKNOWLEDGED' }),
  bulk = { message: 'bulk ok', skipped: 0 },
  notification = { message: 'fingerprint ok' },
  detail = (url) => ({ alert: [A1, A2].find((a) => pathOf(url).endsWith(`/${a.id}`)) }),
} = {}) => [
  [(url) => pathOf(url).endsWith('/alerts/query/summary'), summary],
  [(url) => pathOf(url).endsWith('/alerts/query/live'), live],
  [(url) => pathOf(url).endsWith('/alerts/query/bulk'), bulk],
  [(url) => pathOf(url).endsWith('/ingest-status'), ingest],
  [(url) => pathOf(url).endsWith('/ingest-now'), { ok: true }],
  [(url) => /\/alerts\/notifications\/[^/]+\/(acknowledge|resolve)$/.test(pathOf(url)), notification],
  [(url) => /\/alerts\/query\/\d+\/\w+$/.test(pathOf(url)), transition],
  [(url) => /\/alerts\/query\/\d+$/.test(pathOf(url)), detail],
  [isList, list],
];

let restore = () => {};

const renderPage = ({ role = 'ADMIN', routes = backend(), onNavigate } = {}) => {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const utils = render(React.createElement(AuthContext.Provider, { value: { role } },
    React.createElement(FiredAlertsPage, { activeOrg: 'default', onNavigate })));
  return { ...utils, calls: stub.calls };
};

const listCalls = (calls) => calls.filter((c) => isList(c.url));
const rowOf = (name) => screen.getByText(name, { selector: '.alerts-name2-btn' }).closest('.alerts-row2');
const loaded = () => waitFor(() => rowOf('High CPU'));
const bodyOf = (call) => JSON.parse(call.init.body);

describe('FiredAlertsPage', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); restore(); localStorage.clear(); });

  it('loads the list and summary with the default filters and renders both', async () => {
    const { calls, container } = renderPage();
    await loaded();
    const first = paramsOf(listCalls(calls)[0].url);
    assert.deepEqual(first.getAll('status'), ['FIRING', 'ACKNOWLEDGED']);
    assert.equal(first.get('window'), 'now-1d');
    assert.equal(first.get('sortBy'), 'lastFiredAt');
    assert.equal(first.get('size'), '50');
    assert.equal(paramsOf(calls.find((c) => pathOf(c.url).endsWith('/summary')).url).get('window'), 'now-1d');
    assert.ok(calls.some((c) => pathOf(c.url).endsWith('/ingest-status')));

    assert.match(screen.getByRole('button', { name: /^Critical/ }).textContent, /1$/);
    const foot = container.querySelector('.iam-foot').textContent;
    assert.match(foot, /2 alerts/);
    assert.match(foot, /updated /);
    assert.match(foot, /Showing 1 - 2 of 2/);
    assert.equal(screen.getByRole('button', { name: 'Previous page' }).disabled, true);
    assert.equal(screen.getByRole('button', { name: 'Next page' }).disabled, true);
  });

  it('shows the load error in a banner and ↻ retries', async () => {
    let fail = true;
    const routes = backend({
      list: () => (fail ? { status: 500, body: { error: 'query service unavailable' } } : { items: [A1], total: 1 }),
    });
    const { calls } = renderPage({ routes });
    await waitFor(() => assert.ok(screen.getByText('query service unavailable')));
    assert.ok(screen.getByText(/No alerts recorded yet/));
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await loaded();
    assert.equal(screen.queryByText('query service unavailable'), null);
    assert.equal(listCalls(calls).length, 2);
    assert.match(screen.getByText(/^1 alert/).textContent, /^1 alert$|^1 alert /);
  });

  it('a summary card re-queries with its filter, and Clear resets to the defaults', async () => {
    const { calls } = renderPage();
    await loaded();
    fireEvent.click(screen.getByText('Resolved', { selector: '.alerts-card-label' }).closest('button'));
    await waitFor(() => assert.deepEqual(paramsOf(listCalls(calls).at(-1).url).getAll('status'), ['RESOLVED']));
    fireEvent.click(screen.getByRole('button', { name: 'Clear 1 filter' }));
    await waitFor(() => assert.deepEqual(paramsOf(listCalls(calls).at(-1).url).getAll('status'), ['FIRING', 'ACKNOWLEDGED']));
  });

  it('"All time" drops the window and the status filter on the next query', async () => {
    const { calls } = renderPage();
    await loaded();
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: '' } });
    await waitFor(() => {
      const p = paramsOf(listCalls(calls).at(-1).url);
      assert.equal(p.get('window'), null);
      assert.deepEqual(p.getAll('status'), []);
    });
    assert.ok(screen.getByRole('button', { name: 'Clear 2 filters' }));
  });

  it('search is sent to the server after the debounce', async () => {
    const { calls } = renderPage();
    await loaded();
    fireEvent.change(screen.getByPlaceholderText('Search Alerts'), { target: { value: 'cpu' } });
    await waitFor(() => assert.equal(paramsOf(listCalls(calls).at(-1).url).get('search'), 'cpu'));
  });

  it('sorting by a column re-queries, and a second click flips the direction', async () => {
    const { calls } = renderPage();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /^Severity/ }));
    await waitFor(() => assert.equal(paramsOf(listCalls(calls).at(-1).url).get('sortBy'), 'severity'));
    assert.equal(paramsOf(listCalls(calls).at(-1).url).get('sortDir'), 'desc');
    fireEvent.click(screen.getByRole('button', { name: /^Severity/ }));
    await waitFor(() => assert.equal(paramsOf(listCalls(calls).at(-1).url).get('sortDir'), 'asc'));
  });

  it('acknowledge asks for a name, posts it as the actor, and remembers it', async () => {
    const { calls } = renderPage();
    await loaded();
    fireEvent.click(within(rowOf('High CPU')).getByText('Actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Acknowledge' }));

    const dialog = screen.getByRole('dialog', { name: 'Acknowledge alert' });
    assert.match(dialog.textContent, /Acknowledge “High CPU”/);
    const submit = within(dialog).getByText('Acknowledge', { selector: 'button[type="submit"]' });
    assert.equal(submit.disabled, true, 'a blank name cannot be submitted');
    fireEvent.change(within(dialog).getByLabelText('Your name'), { target: { value: '  ana  ' } });
    fireEvent.submit(submit.closest('form'));

    await waitFor(() => assert.ok(screen.getByText('done acknowledge')));
    const post = calls.find((c) => /\/alerts\/query\/1\/acknowledge$/.test(pathOf(c.url)));
    assert.equal(post.init.method, 'POST');
    assert.equal(bodyOf(post).actor, 'ana');
    assert.equal(localStorage.getItem('lnm_alert_actor'), 'ana');
    await waitFor(() => assert.ok(listCalls(calls).length >= 2, 'the list reloads after a transition'));
  });

  it('the acknowledge dialog pre-fills the remembered name and cancels by Escape, ×, backdrop', async () => {
    localStorage.setItem('lnm_alert_actor', 'bo');
    const { calls } = renderPage();
    await loaded();
    const open = () => {
      fireEvent.click(within(rowOf('High CPU')).getByText('Actions'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Acknowledge' }));
      return screen.getByRole('dialog', { name: 'Acknowledge alert' });
    };
    let dialog = open();
    assert.equal(within(dialog).getByLabelText('Your name').value, 'bo');
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('dialog'), null);
    dialog = open();
    fireEvent.click(dialog.querySelector('form'));
    assert.ok(screen.getByRole('dialog'), 'a click inside keeps it open');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    assert.equal(screen.queryByRole('dialog'), null);
    dialog = open();
    fireEvent.click(dialog);
    assert.equal(screen.queryByRole('dialog'), null);
    dialog = open();
    fireEvent.click(within(dialog).getByText('Cancel'));
    assert.equal(screen.queryByRole('dialog'), null);
    assert.equal(calls.filter((c) => c.init.method === 'POST').length, 0);
  });

  it('resolve posts at once with the session user as actor', async () => {
    localStorage.setItem('lnm_user', JSON.stringify({ username: 'sam' }));
    const { calls } = renderPage();
    await loaded();
    fireEvent.click(within(rowOf('High CPU')).getByText('Actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resolve' }));
    await waitFor(() => assert.ok(screen.getByText('done resolve')));
    const post = calls.find((c) => /\/alerts\/query\/1\/resolve$/.test(pathOf(c.url)));
    assert.equal(bodyOf(post).actor, 'sam');
  });

  it('a failed transition shows the server\'s reason', async () => {
    const routes = backend({ transition: { status: 409, body: { error: 'already resolved elsewhere' } } });
    renderPage({ routes });
    await loaded();
    fireEvent.click(within(rowOf('High CPU')).getByText('Actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resolve' }));
    await waitFor(() => assert.ok(screen.getByText('already resolved elsewhere')));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    assert.equal(screen.queryByText('already resolved elsewhere'), null);
  });

  it('bulk resolve confirms, then posts the selected ids and clears the selection', async () => {
    const { calls } = renderPage();
    await loaded();
    fireEvent.click(screen.getByLabelText('Select all rows on this page'));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    assert.match(bar.textContent, /2 selected/);
    fireEvent.click(within(bar).getByText('Resolve'));
    const confirm = screen.getByRole('dialog', { name: 'Resolve 2 alert(s)?' });
    fireEvent.click(within(confirm).getByText('Resolve', { selector: '.alerts-btn-primary' }));
    await waitFor(() => assert.ok(screen.getByText('bulk ok')));
    const post = calls.find((c) => pathOf(c.url).endsWith('/bulk'));
    assert.deepEqual(bodyOf(post), { ids: [1, 2], action: 'resolve', actor: 'unknown', note: '' });
    assert.equal(screen.queryByRole('region', { name: 'Bulk actions' }), null);
  });

  it('bulk acknowledge asks for a name for the whole selection', async () => {
    const { calls } = renderPage({ routes: backend({ bulk: { message: '1 skipped', skipped: 1 } }) });
    await loaded();
    fireEvent.click(screen.getByLabelText('Select High CPU'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByText('Acknowledge'));
    const dialog = screen.getByRole('dialog', { name: 'Acknowledge alert' });
    assert.match(dialog.textContent, /Acknowledge 1 alert/);
    fireEvent.change(within(dialog).getByLabelText('Your name'), { target: { value: 'cy' } });
    fireEvent.submit(dialog.querySelector('form'));
    await waitFor(() => assert.ok(screen.getByText('1 skipped')));
    assert.equal(bodyOf(calls.find((c) => pathOf(c.url).endsWith('/bulk'))).actor, 'cy');
    assert.equal(screen.getByRole('status').className, 'toast toast--warn');
  });

  it('a bulk confirm can be cancelled, and Clear selection empties it', async () => {
    const { calls } = renderPage();
    await loaded();
    fireEvent.click(screen.getByLabelText('Select High CPU'));
    fireEvent.click(screen.getByLabelText('Select High CPU'));
    assert.equal(screen.queryByRole('region', { name: 'Bulk actions' }), null, 'toggling twice deselects');
    fireEvent.click(screen.getByLabelText('Select High CPU'));
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    fireEvent.click(within(bar).getByText('Close'));
    let confirm = screen.getByRole('dialog', { name: 'Close 1 alert(s)?' });
    fireEvent.click(within(confirm).getByText('Cancel'));
    fireEvent.click(within(bar).getByText('Reopen'));
    confirm = screen.getByRole('dialog', { name: 'Reopen 1 alert(s)?' });
    fireEvent.click(confirm.querySelector('.alerts-modal'));
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('dialog'), null);
    fireEvent.click(within(bar).getByText('Close'));
    fireEvent.click(screen.getByRole('dialog'));
    assert.equal(screen.queryByRole('dialog'), null);
    fireEvent.click(within(bar).getByText('Clear selection'));
    assert.equal(screen.queryByRole('region', { name: 'Bulk actions' }), null);
    assert.equal(calls.filter((c) => c.init.method === 'POST').length, 0);
  });

  it('a failed bulk action reports the error', async () => {
    renderPage({ routes: backend({ bulk: { status: 500, body: { message: 'bulk exploded' } } }) });
    await loaded();
    fireEvent.click(screen.getByLabelText('Select High CPU'));
    fireEvent.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByText('Close'));
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Close', { selector: '.alerts-btn-primary' }));
    await waitFor(() => assert.ok(screen.getByText('bulk exploded')));
  });

  it('opens the drawer, reopens from it through a confirm, and a drill navigates and closes it', async () => {
    const nav = [];
    const { calls } = renderPage({ onNavigate: (tab, alert) => nav.push([tab, alert.id]) });
    await waitFor(() => rowOf('Disk full'));
    fireEvent.click(screen.getByText('Disk full', { selector: '.alerts-name2-btn' }));
    const drawer = () => screen.getByRole('dialog', { name: 'Alert Disk full' });
    await waitFor(() => assert.ok(calls.some((c) => /\/alerts\/query\/2$/.test(pathOf(c.url)))));

    fireEvent.click(within(drawer()).getByText('Reopen'));
    const confirm = screen.getByRole('dialog', { name: 'Reopen Disk full?' });
    fireEvent.click(within(confirm).getByText('Reopen', { selector: '.alerts-btn-primary' }));
    await waitFor(() => assert.ok(screen.getByText('done reopen')));
    assert.match(drawer().querySelector('.alerts-status2').textContent, /ACKNOWLEDGED|RESOLVED/);

    fireEvent.click(within(drawer()).getByText('Telemetry'));
    fireEvent.click(within(drawer()).getByText('View logs'));
    assert.deepEqual(nav, [['logs', 2]]);
    assert.equal(screen.queryByRole('dialog', { name: 'Alert Disk full' }), null);
  });

  it('Copy ID writes to the clipboard, and says so when it cannot', async () => {
    const writes = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (t) => { writes.push(t); } },
    });
    renderPage();
    await loaded();
    fireEvent.click(screen.getByText('High CPU', { selector: '.alerts-name2-btn' }));
    fireEvent.click(screen.getByText('Copy ID'));
    await waitFor(() => assert.ok(screen.getByText('Alert id 1 copied.')));
    assert.deepEqual(writes, ['1']);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('denied'); } },
    });
    fireEvent.click(screen.getByText('Copy ID'));
    await waitFor(() => assert.ok(screen.getByText('Could not access the clipboard. Alert id is 1.')));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Alert High CPU' })).getByLabelText('Close'));
    assert.equal(screen.queryByRole('dialog'), null);
    delete navigator.clipboard;
  });

  it('pages forward and back, and a new page size goes back to page 0', async () => {
    const { calls, container } = renderPage({
      routes: backend({ list: (url) => ({ items: [A1, A2], total: 120, hasMore: paramsOf(url).get('page') === '0' }) }),
    });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => assert.equal(paramsOf(listCalls(calls).at(-1).url).get('page'), '1'));
    await waitFor(() => assert.match(container.querySelector('.iam-foot-range').textContent, /Showing 51 - 52 of 120/));
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => assert.equal(paramsOf(listCalls(calls).at(-1).url).get('page'), '0'));
    fireEvent.change(screen.getByLabelText('Records per page'), { target: { value: '100' } });
    await waitFor(() => assert.equal(paramsOf(listCalls(calls).at(-1).url).get('size'), '100'));
  });

  it('Refresh polls the ingest now, then reloads', async () => {
    const { calls } = renderPage();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => assert.equal(listCalls(calls).length, 2));
    const poll = calls.find((c) => pathOf(c.url).endsWith('/ingest-now'));
    assert.equal(poll.init.method, 'POST');
  });

  it('an unhealthy ingest shows its banner and falls back to the live stream, read by fingerprint', async () => {
    const LIVE = { id: null, fingerprint: 'fp/1', alertName: 'Live CPU', status: 'FIRING', lastFiredAt: '2026-09-25T10:00:00Z' };
    const { calls, container } = renderPage({
      routes: backend({
        list: { items: [], total: 0 },
        ingest: { healthy: false, cursors: [{ lastError: 'timeout talking to OpenObserve' }] },
        live: { items: [LIVE], total: 1, hasMore: false },
      }),
    });
    await waitFor(() => rowOf('Live CPU'));
    assert.ok(screen.getByText(/Alert ingest is not healthy.*Last error: timeout talking to OpenObserve/));
    assert.match(container.querySelector('.iam-foot-total').textContent, /1 alert · live from stream/);
    assert.equal(paramsOf(calls.find((c) => pathOf(c.url).endsWith('/live')).url).get('window'), 'now-1d');

    fireEvent.click(within(rowOf('Live CPU')).getByText('Actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resolve' }));
    await waitFor(() => assert.ok(screen.getByText('fingerprint ok')));
    const post = calls.find((c) => /\/notifications\/.+\/resolve$/.test(pathOf(c.url)));
    assert.match(post.url, /fp%2F1\/resolve/);

    fireEvent.click(within(rowOf('Live CPU')).getByText('Actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Acknowledge' }));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'dee' } });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form'));
    await waitFor(() => assert.ok(calls.some((c) => /\/notifications\/.+\/acknowledge$/.test(pathOf(c.url)))));
  });

  it('says so when even the live stream cannot be read', async () => {
    renderPage({
      routes: backend({
        list: { items: [], total: 0 },
        ingest: { healthy: false, stalled: true },
        live: { status: 502, body: { error: 'o2 unreachable' } },
      }),
    });
    await waitFor(() => assert.ok(screen.getByText(/alert_events stream could not be read either.*o2 unreachable/)));
    assert.ok(screen.getByText(/No successful poll recently/));
  });

  it('a read-only role sees the rows but no bulk bar and no row actions', async () => {
    const { container } = renderPage({ role: 'VIEWER' });
    await loaded();
    assert.equal(screen.getByLabelText('Select High CPU').disabled, true);
    assert.equal(within(rowOf('High CPU')).queryByText('Actions'), null);
    assert.equal(container.querySelector('.alerts-bulkbar2'), null);
  });
});
