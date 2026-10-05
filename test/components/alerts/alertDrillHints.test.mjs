/**
 * Guards the one-sentence hints beside an alert's Telemetry buttons, for the
 * cases test/alertDrill.test.mjs does not reach: the Logs hint, an unknown
 * target, and an alert that names neither a metric nor a service.
 *
 * The hint is the operator's only preview of the query they will land on. The
 * Logs one must say whether it is pinned to a trace or only scoped to a service
 * and window — the logs dialect filters by service, severity and trace and
 * nothing else — and a button with nothing to show must say so rather than
 * promise a chart.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canDrill, drillHint } from '../../../src/components/alerts/alertDrill.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('drillHint for logs', () => {
  it('pins to the trace when the alert carries one, abbreviated', () => {
    assert.equal(
      drillHint('logs', { serviceName: 'StreamMonitorService', traceId: TRACE }),
      'Logs of trace 4bf92f3577b3… in the firing window.',
    );
  });

  it('otherwise scopes to the service and window, and says why that is all', () => {
    const hint = drillHint('logs', { serviceName: 'StreamMonitorService', traceId: null });
    assert.match(hint, /^Logs for service StreamMonitorService in the firing window\. This alert carries no trace id/);
    assert.match(hint, /filters by service, severity and trace only/);
  });

  it('says "every service" when the alert names none', () => {
    assert.match(drillHint('logs', { serviceName: '-', traceId: null }), /^Logs for every service in the firing window/);
  });
});

describe('drillHint edge cases', () => {
  it('admits there is nothing to plot for an alert with no metric and no service', () => {
    assert.equal(
      drillHint('metrics', { alertName: 'orphan', serviceName: '-' }),
      'This alert names neither a metric nor a service, so there is nothing to plot.',
    );
  });

  it('is empty for a target it does not know', () => {
    assert.equal(drillHint('profiles', { serviceName: 'svc' }), '');
  });
});

describe('canDrill', () => {
  it('refuses every target without an alert', () => {
    for (const target of ['logs', 'traces', 'metrics']) assert.equal(canDrill(target, null), false, target);
  });

  it('allows logs and traces with only a trace id', () => {
    assert.equal(canDrill('logs', { serviceName: '-', traceId: TRACE }), true);
    assert.equal(canDrill('traces', { serviceName: '-', traceId: TRACE }), true);
  });
});
