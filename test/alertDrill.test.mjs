/**
 * Guards the alert → telemetry drill-through.
 *
 * Every way of getting this wrong is silent. A window built around the wrong
 * anchor, a service clause the target dialect cannot express, a metric name
 * guessed from a display label, a PromQL selector filtered on a label whose values
 * never contain the alert's — all four produce a screen that renders perfectly and
 * shows either everything or nothing. The operator following the link has no way
 * to tell, which is exactly why these are asserted rather than eyeballed.
 *
 * The fixtures are real rows from `/api/alerts/query`, trimmed to the fields the
 * module reads. Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  alertDrillWindow,
  buildLogsDrill,
  buildMetricsDrill,
  buildTracesDrill,
  canDrill,
  drillHint,
  identityValuesOf,
  resolveMetricIdentity,
  __testing,
} from '../src/components/alerts/alertDrill.js';

/** A JVM metric alert: names its metric in the description, no window fields. */
const jvmAlert = {
  alertName: 'Microservice JVM CPU%',
  severity: 'critical',
  serviceName: 'StreamMonitorService',
  hostName: 'tiotstreammonitorsvc-879f5c4d5-b2gwm',
  namespace: '-',
  environment: 'nightly',
  streamName: null,
  streamType: null,
  traceId: null,
  windowStart: null,
  windowEnd: null,
  periodMinutes: null,
  lastFiredAt: '2026-09-04T06:30:49.627880Z',
  triggeredAt: '2026-08-28T12:14:49.627944Z',
  description: 'jvm_cpu_recent_utilization realtime - warn >= 50%, crit >= 80%',
  currentValues: { current_usage: 94.83, value: 0.948 },
  labels: { metric: 'jvm-cpu-pct', service: 'StreamMonitorService', pod: '-' },
};

/** A kubelet alert: no description, incident-start window, rich k8s labels. */
const podAlert = {
  alertName: 'K8s Pod High Memory Usage',
  severity: 'disaster',
  serviceName: 'tiotvoiceaidashboardsvc',
  hostName: 'kubeworker18',
  namespace: 'dev',
  traceId: null,
  windowStart: '2026-08-31T11:34:36Z',
  windowEnd: null,
  lastFiredAt: '2026-09-04T06:30:00Z',
  summary: 'Pod tiotvoiceaidashboardsvc-6f7b746f4-s4cbv memory at 95% of limit',
  currentValues: { current_usage: 95 },
  labels: {
    k8s_pod_name: 'tiotvoiceaidashboardsvc-6f7b746f4-s4cbv',
    k8s_namespace_name: 'dev',
    k8s_node_name: 'kubeworker18',
    service_name: 'tiotvoiceaidashboardsvc',
    node: 'kubeworker18',
    pod: 'tiotvoiceaidashboardsvc-6f7b746f4-s4cbv',
  },
};

const NOW = Date.parse('2026-09-04T06:35:00Z');

describe('alertDrillWindow', () => {
  it('anchors on the firing when the payload sends no window', () => {
    const r = alertDrillWindow(jvmAlert, NOW);
    assert.equal(r.mode, 'absolute');
    // 15 minutes before 06:30:49 through 5 minutes after it, in local wall time.
    const from = new Date(r.from).getTime();
    const to = new Date(r.to).getTime();
    const fired = Date.parse(jvmAlert.lastFiredAt);
    assert.ok(fired - from >= 15 * 60_000 && fired - from < 17 * 60_000, `from=${r.from}`);
    assert.ok(to > fired && to - fired <= 6 * 60_000, `to=${r.to}`);
  });

  it('IGNORES a lone windowStart — it is the incident, not the window', () => {
    // The regression this whole module exists to prevent. windowStart here is
    // four days before the firing; honouring it opens a scan OpenObserve answers
    // with 200 and zero hits, which reads on screen as "nothing happened".
    const r = alertDrillWindow(podAlert, NOW);
    const span = new Date(r.to).getTime() - new Date(r.from).getTime();
    assert.ok(span <= __testing.MAX_SPAN_MINUTES * 60_000, `span=${span}ms`);
    assert.ok(new Date(r.from).getTime() > Date.parse('2026-09-04T00:00:00Z'));
  });

  it('honours windowStart and windowEnd when BOTH arrive and the span is sane', () => {
    const r = alertDrillWindow({
      ...jvmAlert,
      windowStart: '2026-09-04T06:00:00Z',
      windowEnd: '2026-09-04T06:30:00Z',
    }, NOW);
    assert.equal(new Date(r.from).getTime(), Date.parse('2026-09-04T06:00:00Z'));
    // The end is nudged out by a minute: the picker holds minutes, so truncating
    // seconds would cut the firing off the edge of its own window.
    assert.equal(new Date(r.to).getTime(), Date.parse('2026-09-04T06:31:00Z'));
  });

  it('falls back to the rule period when it states one', () => {
    const r = alertDrillWindow({ ...jvmAlert, periodMinutes: 60 }, NOW);
    const lead = Date.parse(jvmAlert.lastFiredAt) - new Date(r.from).getTime();
    assert.ok(lead >= 60 * 60_000 && lead < 62 * 60_000, `lead=${lead}`);
  });

  it('never opens a window wider than the scan ceiling', () => {
    const r = alertDrillWindow({ ...jvmAlert, periodMinutes: 60 * 24 * 30 }, NOW);
    const span = new Date(r.to).getTime() - new Date(r.from).getTime();
    assert.ok(span <= (__testing.MAX_SPAN_MINUTES + __testing.TRAIL_MINUTES + 1) * 60_000);
  });

  it('does not fall over on an alert with no usable timestamps', () => {
    const r = alertDrillWindow({ alertName: 'x' }, NOW);
    assert.equal(r.mode, 'absolute');
    assert.ok(new Date(r.from).getTime() < new Date(r.to).getTime());
  });
});

describe('buildLogsDrill', () => {
  it('carries the service and the window, and never a severity', () => {
    const d = buildLogsDrill(jvmAlert, NOW);
    assert.deepEqual(d.services, ['StreamMonitorService']);
    // An alert's "critical" is the rule's grading, not a log level. Mapping it
    // would hide the INFO lines that usually explain the firing.
    assert.equal(d.severity, '');
    assert.equal(d.traceId, '');
    assert.equal(d.range.mode, 'absolute');
  });

  it('passes a trace id through only when it is one', () => {
    const good = buildLogsDrill({ ...jvmAlert, traceId: 'A'.repeat(32) }, NOW);
    assert.equal(good.traceId, 'A'.repeat(32));
    // Anything else would be sent as free text and match nothing.
    assert.equal(buildLogsDrill({ ...jvmAlert, traceId: 'not-a-trace' }, NOW).traceId, '');
  });

  it('treats a placeholder service as no service', () => {
    assert.deepEqual(buildLogsDrill({ ...jvmAlert, serviceName: '-' }, NOW).services, []);
  });
});

describe('buildTracesDrill', () => {
  it('opens the trace directly when the alert names one', () => {
    const d = buildTracesDrill({ ...jvmAlert, traceId: 'b'.repeat(32) }, NOW);
    assert.equal(d.openTrace, true);
    assert.equal(d.traceId, 'b'.repeat(32));
  });

  it('falls back to the service and window otherwise', () => {
    const d = buildTracesDrill(jvmAlert, NOW);
    assert.equal(d.openTrace, false);
    assert.deepEqual(d.services, ['StreamMonitorService']);
  });
});

describe('buildMetricsDrill', () => {
  it('reads the metric the description names, ahead of the payload noise', () => {
    const d = buildMetricsDrill(jvmAlert, null, NOW);
    assert.equal(d.candidates[0], 'jvm_cpu_recent_utilization');
    // `current_usage` and friends are still offered, but only after — they are
    // dropped anyway by the caller unless the catalogue knows them.
    assert.ok(d.candidates.includes('current_usage'));
  });

  it('never derives a candidate from the alert NAME', () => {
    // "K8s Pod High Memory Usage" word-matches the real metric k8s_pod_memory_usage,
    // while the rule that fired reads k8s_pod_memory_limit_utilization. A chart
    // whose numbers disagree with the alert that led you to it is worse than a list.
    const d = buildMetricsDrill(podAlert, null, NOW);
    assert.ok(!d.candidates.some((c) => c.startsWith('k8s_pod_memory')), d.candidates.join());
  });

  it('uses the rule’s own PromQL when this application owns the rule', () => {
    const rule = { queryCondition: { promql: 'sum(rate(http_requests_total[5m]))' } };
    assert.equal(buildMetricsDrill(jvmAlert, rule, NOW).promql,
      'sum(rate(http_requests_total[5m]))');
  });

  it('takes a metrics alert’s stream name as the metric', () => {
    const d = buildMetricsDrill(
      { ...jvmAlert, streamType: 'metrics', streamName: 'container_memory_usage' }, null, NOW,
    );
    assert.equal(d.candidates[0], 'container_memory_usage');
  });
});

describe('identityValuesOf', () => {
  it('collects what the alert says it is about, most specific first', () => {
    const v = identityValuesOf(podAlert);
    assert.equal(v[0], 'kubeworker18');
    assert.ok(v.includes('tiotvoiceaidashboardsvc-6f7b746f4-s4cbv'));
    assert.ok(v.includes('tiotvoiceaidashboardsvc'));
  });

  it('drops the template’s placeholders', () => {
    // `"pod": "-"` arrives on every microservice alert. Filtering on it pins the
    // query to a literal dash.
    assert.ok(!identityValuesOf(jvmAlert).includes('-'));
  });
});

describe('resolveMetricIdentity', () => {
  const fakeBackend = (labels, values) => ({
    fetchLabels: async () => labels,
    fetchLabelValues: async ({ label }) => values[label] || [],
  });

  it('pins the exact pod when the metric carries its host label', async () => {
    const { fetchLabels, fetchLabelValues } = fakeBackend(
      ['__name__', 'host_name', 'service_name', 'process_pid'],
      {
        host_name: ['kafka1', 'tiotstreammonitorsvc-879f5c4d5-b2gwm'],
        service_name: ['IoTOpsSvc', 'StreamMonitorService'],
      },
    );
    const out = await resolveMetricIdentity({
      metric: 'jvm_cpu_recent_utilization',
      identityValues: identityValuesOf(jvmAlert),
      fetchLabels,
      fetchLabelValues,
    });
    assert.deepEqual(out, [
      ['host_name', 'tiotstreammonitorsvc-879f5c4d5-b2gwm'],
      ['service_name', 'StreamMonitorService'],
    ]);
  });

  it('rejects a label whose values do not contain the alert’s', async () => {
    // The kube-state trap, verbatim: kube_pod_container_status_restarts_total HAS a
    // service_name, but it is the scrape target, never the alerting service. The
    // container label is what actually carries it.
    const { fetchLabels, fetchLabelValues } = fakeBackend(
      ['container', 'pod', 'namespace', 'service_name'],
      {
        service_name: ['argocd-metrics', 'druid-coordinator', 'tiotopenobserve'],
        container: ['tiotvoiceaiconferencesvc', 'kafka1'],
        pod: ['-'],
        namespace: ['-'],
      },
    );
    const out = await resolveMetricIdentity({
      metric: 'kube_pod_container_status_restarts_total',
      identityValues: identityValuesOf({
        serviceName: 'tiotvoiceaiconferencesvc',
        hostName: '-',
        namespace: '-',
        labels: { pod: '-', node: '-', service: 'tiotvoiceaiconferencesvc' },
      }),
      fetchLabels,
      fetchLabelValues,
    });
    assert.deepEqual(out, [['container', 'tiotvoiceaiconferencesvc']]);
  });

  it('never emits the same value under two spellings of one dimension', async () => {
    const { fetchLabels, fetchLabelValues } = fakeBackend(
      ['k8s_pod_name', 'pod', 'service_name'],
      {
        k8s_pod_name: ['tiotvoiceaidashboardsvc-6f7b746f4-s4cbv'],
        pod: ['tiotvoiceaidashboardsvc-6f7b746f4-s4cbv'],
        service_name: ['tiotvoiceaidashboardsvc'],
      },
    );
    const out = await resolveMetricIdentity({
      metric: 'k8s_pod_memory_limit_utilization',
      identityValues: identityValuesOf(podAlert),
      fetchLabels,
      fetchLabelValues,
    });
    assert.deepEqual(out, [
      ['k8s_pod_name', 'tiotvoiceaidashboardsvc-6f7b746f4-s4cbv'],
      ['service_name', 'tiotvoiceaidashboardsvc'],
    ]);
  });

  it('returns nothing rather than a filter when the label lookup fails', async () => {
    const out = await resolveMetricIdentity({
      metric: 'x',
      identityValues: ['a'],
      fetchLabels: async () => { throw new Error('502'); },
      fetchLabelValues: async () => [],
    });
    assert.deepEqual(out, []);
  });

  it('survives one label’s values failing without losing the others', async () => {
    const out = await resolveMetricIdentity({
      metric: 'x',
      identityValues: ['svc-a'],
      fetchLabels: async () => ['host_name', 'service_name'],
      fetchLabelValues: async ({ label }) => {
        if (label === 'host_name') throw new Error('timeout');
        return ['svc-a'];
      },
    });
    assert.deepEqual(out, [['service_name', 'svc-a']]);
  });
});

describe('drillHint and canDrill', () => {
  it('says what will actually happen, per signal', () => {
    assert.match(drillHint('traces', jvmAlert), /no trace id/i);
    assert.match(drillHint('traces', { ...jvmAlert, traceId: 'c'.repeat(32) }), /directly/i);
    assert.match(drillHint('metrics', jvmAlert), /jvm_cpu_recent_utilization/);
    // No metric named: the honest answer is the service's inventory, not a guess.
    assert.match(drillHint('metrics', podAlert), /inventory/i);
    assert.match(drillHint('metrics', jvmAlert, { queryCondition: { promql: 'up' } }), /PromQL/);
  });

  it('refuses a logs or traces drill an alert cannot scope at all', () => {
    const bare = { alertName: 'orphan', serviceName: '-', traceId: null };
    assert.equal(canDrill('logs', bare), false);
    assert.equal(canDrill('traces', bare), false);
    // Metrics always has somewhere to land — the catalogue itself.
    assert.equal(canDrill('metrics', bare), true);
  });
});
