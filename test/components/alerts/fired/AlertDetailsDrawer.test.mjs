/**
 * AlertDetailsDrawer: one alert's detail, loaded from GET /alerts/query/{id}.
 * Guarded — it requests the row by id and shows the loaded detail over the
 * table's row; a load failure is shown, not swallowed; a live row (no id) loads
 * nothing and offers no transitions; each section tab shows its facts (Rule only
 * when the backend sent a rule, with a sync warning when it is not SYNCED);
 * History lists the audit trail; Telemetry drills hand the target and a scoped
 * drill to onNavigate; footer transitions follow the status (or the backend's
 * own `actions`) and are hidden from read-only users; Escape, the backdrop, ×
 * and Close all close it.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react');
const { default: AlertDetailsDrawer } = await import('../../../../src/components/alerts/fired/AlertDetailsDrawer.jsx');

const ROW = { id: 7, alertName: 'High CPU', severity: 'critical', status: 'FIRING', serviceName: 'checkout' };

const DETAIL = {
  alert: {
    ...ROW,
    incidentType: 'Resource pressure', ruleName: 'cpu-rule', occurrences: 4, episode: 2,
    affectedCount: 3, fingerprint: 'fp-7', description: 'CPU is above 90% on 3 pods',
    currentValues: { cpu: 91.23456, mem: 12, gone: null, inf: Infinity, note: 'hot' },
    severitySource: 'template', parseError: 'missing field',
    hostName: 'node-1', namespace: 'prod', environment: 'live', streamName: 'k8s', streamType: 'metrics',
    source: 'openobserve', entities: 'pod-a\npod-b', labels: { pod: 'pod-a' },
    triggeredAt: '2026-09-25T10:00:00Z', lastFiredAt: '2026-09-25T10:05:00Z', lastUpdatedAt: 'not-a-date',
    duration: '5m', acknowledgedBy: 'ana', acknowledgedAt: '2026-09-25T10:01:00Z',
    resolvedBy: 'bo', resolvedAt: '2026-09-25T10:02:00Z', closedBy: 'cy', closedAt: '2026-09-25T10:03:00Z',
    reopenCount: 2, autoResolved: true, threshold: 90, operator: '>', periodMinutes: 5,
    observedCount: 3, aggValue: 91.2, traceId: '0123456789abcdef0123456789abcdef',
    windowStart: '2026-09-25T09:55:00Z', windowEnd: '2026-09-25T10:00:00Z',
    alertUrl: 'https://o2.example/alerts/7',
  },
  rule: {
    name: 'cpu-rule', description: 'CPU guard', enabled: true, severity: 'critical',
    streamType: 'metrics', streamName: 'k8s', syncStatus: 'PENDING',
    queryCondition: '{"sql":"select 1"}', triggerCondition: 'not json',
  },
  events: [
    { type: 'FIRED', occurredAt: '2026-09-25T10:00:00Z', actor: '' },
    { type: 'ACKNOWLEDGED', occurredAt: '2026-09-25T10:01:00Z', actor: 'ana', note: 'on it' },
  ],
  rawPayload: '{"a":1}',
};

let restore = () => {};

const renderDrawer = (props = {}, routes = [[/\/alerts\/query\/7$/, DETAIL]]) => {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const log = [];
  const utils = render(React.createElement(AlertDetailsDrawer, {
    alert: ROW,
    onClose: () => log.push(['close']),
    onAction: (a, action) => log.push(['action', a.id, action]),
    onNavigate: (tab, a, drill) => log.push(['navigate', tab, a.id, drill]),
    onCopyId: (a) => log.push(['copy', a.id]),
    ...props,
  }));
  return { ...utils, log, calls: stub.calls };
};

const tab = (name) => within(screen.getByRole('navigation', { name: 'Detail sections' }))
  .getByRole('button', { name });
const facts = (container) => Object.fromEntries(
  [...container.querySelectorAll('dl.pc-facts:not(.alerts-dynfacts) dt')].map((dt) => [dt.textContent, dt.nextSibling.textContent]),
);

describe('AlertDetailsDrawer', () => {
  afterEach(() => { cleanup(); restore(); });

  it('loads the alert by id and shows the detail, not just the row', async () => {
    const { calls, container } = renderDrawer();
    assert.ok(screen.getByText('Loading…'));
    await waitFor(() => assert.ok(screen.getByText('CPU is above 90% on 3 pods')));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/alerts\/query\/7$/);
    assert.equal((calls[0].init.method || 'GET'), 'GET');
    assert.equal(screen.queryByText('Loading…'), null);

    const f = facts(container);
    assert.equal(f['Incident type'], 'Resource pressure');
    assert.equal(f.Occurrences, '4 (episode 2)');
    assert.equal(f.Affected, '3 entities');
    assert.equal(f.Fingerprint, 'fp-7');
    assert.match(container.textContent, /· 3 entities/);
    assert.match(container.textContent, /Severity was decided by template/);
    assert.match(container.textContent, /arrived malformed.*missing field/);

    const dyn = container.querySelector('.alerts-dynfacts');
    const values = [...dyn.querySelectorAll('dd')].map((d) => d.textContent);
    assert.deepEqual(values, ['91.2346', '12', '—', '—', 'hot']);
  });

  it('shows the load error rather than hiding it', async () => {
    renderDrawer({}, [[/\/alerts\/query\/7$/, { status: 500, body: { error: 'database is down' } }]]);
    await waitFor(() => assert.ok(screen.getByText('database is down')));
    assert.equal(screen.queryByText('Loading…'), null);
  });

  it('a live row (no id) loads nothing and offers no transitions or Copy ID', () => {
    const { calls, container } = renderDrawer({ alert: { id: null, alertName: 'Live', summary: 'from the stream' } });
    assert.equal(calls.length, 0);
    assert.equal(screen.queryByText('Loading…'), null);
    assert.ok(screen.getByText('from the stream'));
    assert.equal(screen.queryByRole('button', { name: 'Copy ID' }), null);
    const foot = container.querySelector('.alerts-modal-foot');
    assert.deepEqual([...foot.querySelectorAll('button')].map((b) => b.textContent), ['Close']);
    assert.match(container.querySelector('.alerts-status2').textContent, /—/);
    assert.equal(container.querySelector('.alerts-sev2').textContent, 'info');
  });

  it('offers the Rule tab only once the backend sends a rule', async () => {
    renderDrawer();
    assert.equal(screen.queryByRole('button', { name: 'Rule' }), null);
    await waitFor(() => assert.ok(tab('Rule')));
  });

  it('Resource shows where it fired, what it affected and its labels', async () => {
    const { container } = renderDrawer();
    await waitFor(() => screen.getByText('CPU is above 90% on 3 pods'));
    fireEvent.click(tab('Resource'));
    assert.equal(tab('Resource').getAttribute('aria-current'), 'true');
    const f = facts(container);
    assert.equal(f.Host, 'node-1');
    assert.equal(f['Stream type'], 'metrics');
    assert.match(container.querySelector('pre').textContent, /pod-a\npod-b/);
    assert.match(container.textContent, /Dimensions & labels · 1/);
  });

  it('Timing shows who did what and the audit trail', async () => {
    const { container } = renderDrawer();
    await waitFor(() => screen.getByText('CPU is above 90% on 3 pods'));
    fireEvent.click(tab('Timing'));
    const f = facts(container);
    assert.equal(f['Last updated'], 'not-a-date', 'an unparseable time is shown as sent');
    assert.match(f.Acknowledged, /^ana · /);
    assert.match(f.Resolved, /^bo · /);
    assert.match(f.Closed, /^cy · /);
    assert.equal(f.Reopened, '2 time(s)');
    assert.match(container.textContent, /Resolved by the staleness sweep/);
    const trail = container.querySelectorAll('.alerts-trail2 li');
    assert.equal(trail.length, 2);
    assert.match(trail[0].textContent, /FIRED.*—/);
    assert.match(trail[1].textContent, /ACKNOWLEDGED.*ana.*on it/);
  });

  it('Timing says when there is no history, and a bare section says nothing was recorded', () => {
    const { container } = renderDrawer({ alert: { id: null, alertName: 'Live' } });
    fireEvent.click(tab('Timing'));
    assert.ok(screen.getByText('No recorded events yet.'));
    fireEvent.click(tab('Resource'));
    assert.ok(screen.getByText('Nothing recorded for this section.'));
    assert.equal(container.querySelector('.alerts-dynfacts'), null);
  });

  it('Rule shows the definition, pretty-prints JSON and warns when not synced', async () => {
    const { container } = renderDrawer();
    await waitFor(() => tab('Rule'));
    fireEvent.click(tab('Rule'));
    const f = facts(container);
    assert.equal(f.Enabled, 'Yes');
    assert.equal(f.Stream, 'metrics / k8s');
    assert.equal(f['Evaluation window'], '5 min');
    assert.match(container.textContent, /This rule is PENDING/);
    const pres = container.querySelectorAll('pre');
    assert.equal(pres[0].textContent, '{\n  "sql": "select 1"\n}');
    assert.equal(pres[1].textContent, 'not json');
  });

  it('Rule omits the sync warning when SYNCED and shows unknown streams as ?', async () => {
    const detail = { ...DETAIL, rule: { name: 'r', enabled: false, syncStatus: 'SYNCED' } };
    const { container } = renderDrawer({}, [[/\/alerts\/query\/7$/, detail]]);
    await waitFor(() => tab('Rule'));
    fireEvent.click(tab('Rule'));
    const f = facts(container);
    assert.equal(f.Enabled, 'No');
    assert.equal(f.Stream, '? / ?');
    assert.doesNotMatch(container.textContent, /This rule is/);
  });

  it('Telemetry drills hand the target and a scoped drill to onNavigate', async () => {
    const { log, container } = renderDrawer();
    await waitFor(() => screen.getByText('CPU is above 90% on 3 pods'));
    fireEvent.click(tab('Telemetry'));
    fireEvent.click(screen.getByRole('button', { name: 'View logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'View traces' }));
    fireEvent.click(screen.getByRole('button', { name: 'View metrics' }));
    assert.deepEqual(log.map(([k, t, id]) => [k, t, id]),
      [['navigate', 'logs', 7], ['navigate', 'traces', 7], ['navigate', 'metrics', 7]]);
    assert.deepEqual(log[0][3].services, ['checkout']);
    assert.equal(log[0][3].traceId, DETAIL.alert.traceId);
    assert.equal(screen.getByRole('link', { name: 'Open in OpenObserve' }).getAttribute('href'), DETAIL.alert.alertUrl);
    assert.match(facts(container)['Drill window'], /→/);
    assert.doesNotMatch(container.textContent, /names no service/);
  });

  it('Telemetry without a navigator or a service disables the drills and says so', () => {
    const { container } = renderDrawer({ alert: { id: null, alertName: 'Live' }, onNavigate: undefined });
    fireEvent.click(tab('Telemetry'));
    assert.equal(screen.getByRole('button', { name: 'View logs' }).disabled, true);
    assert.equal(screen.getByRole('button', { name: 'View metrics' }).disabled, true);
    assert.match(container.textContent, /This alert names no service/);
    assert.equal(screen.queryByRole('link', { name: 'Open in OpenObserve' }), null);
  });

  it('Raw shows the payload pretty-printed, or says none was kept', async () => {
    const { container } = renderDrawer();
    await waitFor(() => screen.getByText('CPU is above 90% on 3 pods'));
    fireEvent.click(tab('Raw'));
    assert.equal(container.querySelector('.alerts-pre2--raw').textContent, '{\n  "a": 1\n}');
    cleanup();
    renderDrawer({ alert: { id: null, alertName: 'Live' } });
    fireEvent.click(tab('Raw'));
    assert.ok(screen.getByText('No raw payload retained for this alert.'));
  });

  it('footer transitions follow the status and report the chosen action', async () => {
    const { log } = renderDrawer();
    await waitFor(() => screen.getByText('CPU is above 90% on 3 pods'));
    for (const name of ['Acknowledge', 'Resolve']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    // The × is labelled Close too; the footer's primary Close is the transition.
    fireEvent.click(closeButtons.find((b) => b.className === 'alerts-btn-primary'));
    assert.deepEqual(log, [['action', 7, 'acknowledge'], ['action', 7, 'resolve'], ['action', 7, 'close']]);
  });

  it('a resolved alert offers Reopen and Close', async () => {
    const { calls, container } = renderDrawer({ alert: { ...ROW, status: 'RESOLVED' } },
      [[/\/alerts\/query\/7$/, { alert: { ...ROW, status: 'RESOLVED' } }]]);
    await waitFor(() => assert.equal(calls.length, 1));
    const foot = container.querySelector('.alerts-modal-foot');
    assert.deepEqual([...foot.querySelectorAll('button')].map((b) => b.textContent), ['Close', 'Reopen', 'Close']);
  });

  it('the backend\'s own actions list wins over the status', async () => {
    const { container } = renderDrawer({}, [[/\/alerts\/query\/7$/, { alert: { ...ROW, actions: ['close'] } }]]);
    const foot = container.querySelector('.alerts-modal-foot');
    await waitFor(() => assert.deepEqual(
      [...foot.querySelectorAll('button')].map((b) => b.textContent), ['Close', 'Close']));
  });

  it('a read-only user gets no transitions', async () => {
    renderDrawer({ canAct: false });
    await waitFor(() => screen.getByText('CPU is above 90% on 3 pods'));
    assert.equal(screen.queryByRole('button', { name: 'Acknowledge' }), null);
  });

  it('Copy ID passes the alert up', async () => {
    const { log } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Copy ID' }));
    assert.deepEqual(log, [['copy', 7]]);
    await waitFor(() => screen.getByText('CPU is above 90% on 3 pods'));
  });

  it('closes on Escape, the backdrop, × and the Close button, but not a click inside', async () => {
    const { log, container } = renderDrawer({ alert: { id: null, alertName: 'Live' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.click(container.querySelector('.alerts-drawer'));
    fireEvent.click(screen.getByRole('dialog'));
    fireEvent.click(container.querySelector('.alerts-modal-x'));
    fireEvent.click(container.querySelector('.alerts-modal-foot .alerts-btn-ghost'));
    assert.deepEqual(log, [['close'], ['close'], ['close'], ['close']]);
  });
});
