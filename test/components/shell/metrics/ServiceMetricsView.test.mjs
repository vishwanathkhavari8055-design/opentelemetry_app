/**
 * ServiceMetricsView reads the metric catalogue by service, from the producers
 * index at GET /metrics/producers. Guarded here: the loading and unsupported
 * states say why there is no list; a finished index states its age and the
 * reconciliation line; a running sweep reports progress and polls until it
 * finishes; Rebuild POSTs and reloads; kind facets and search (by service or by
 * metric name) narrow the list; EXPOSES and OBSERVED stay separate tabs; a
 * drill-seeded service is preselected and flagged when it is not in the index;
 * and picking a metric hands it back with the service it was picked under.
 */
import '../../../support/dom.mjs';
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../../support/fetch.mjs';

const React = (await import('react')).default;
const {
  render, screen, fireEvent, cleanup, waitFor, within, act,
} = await import('@testing-library/react');
const { default: ServiceMetricsView } = await import('../../../../src/components/metrics/ServiceMetricsView.jsx');

const h = React.createElement;

const SVC_A = {
  name: 'IoTOpsSvc',
  kind: 'microservice',
  kindLabel: 'Microservice',
  emitted: {
    count: 3,
    technologies: [{ name: 'JVM', count: 2 }, { name: 'HTTP', count: 1 }],
    metrics: [
      { name: 'jvm_memory_used_bytes', type: 'gauge', technology: 'JVM' },
      { name: 'jvm_threads_live', type: 'gauge', technology: 'JVM' },
      { name: 'hikaricp_connections', type: 'counter', technology: 'HTTP' },
    ],
  },
  observed: {
    count: 1,
    technologies: [{ name: 'Kubernetes', count: 1 }],
    metrics: [{ name: 'kube_pod_info', technology: 'Kubernetes' }],
  },
};
const SVC_B = {
  name: 'pgexporter', kind: 'middleware', kindLabel: 'Middleware',
  emitted: { count: 0, technologies: [], metrics: [] }, observed: { count: 0 },
};
const SVC_C = {
  name: 'ghost', kind: 'observed-only', kindLabel: 'Observed only',
  emitted: { count: 0, metrics: [] }, observed: { count: 0 },
};

const INDEX = {
  services: [SVC_A, SVC_B, SVC_C],
  building: false,
  ageSeconds: 7200,
  buildMillis: 91000,
  windowSeconds: 3600,
  metricsProbed: 3215,
  metricsWithNoData: 120,
  metricsUnscoped: 40,
  probeFailures: 2,
};

let restore = () => {};
let errSpy;
afterEach(() => {
  cleanup();
  restore();
  restore = () => {};
  errSpy?.mock.restore();
  mock.timers.reset();
});

const mount = (routes, props = {}) => {
  const stub = stubFetch(routes);
  restore = stub.restore;
  const opened = [];
  render(h(ServiceMetricsView, { onOpenMetric: (m, s) => opened.push([m, s]), ...props }));
  return { ...stub, opened };
};

describe('ServiceMetricsView', () => {
  it('says the index is loading, then explains when it is unsupported', async () => {
    mount([[/\/metrics\/producers/, { supported: false, error: 'metrics.producers.enabled=false' }]]);
    assert.ok(screen.getByText('Loading the service index…'));
    await waitFor(() => assert.match(document.body.textContent, /Service index unavailable — metrics.producers.enabled=false/));
    assert.match(document.body.textContent, /on the backend to enable it/);
  });

  it('treats a failed request as unsupported, with its reason', async () => {
    errSpy = mock.method(console, 'error', () => {});
    mount([[/\/metrics\/producers/, { status: 500, body: {} }]]);
    await waitFor(() => assert.match(document.body.textContent, /Service index unavailable — HTTP error! status: 500/));
    assert.doesNotMatch(document.body.textContent, /to enable it/);
  });

  it('shows the built index, its age and the reconciliation line, first service selected', async () => {
    mount([[/\/metrics\/producers/, INDEX]]);
    await screen.findByText('IoTOpsSvc', { selector: 'h3' });
    const text = document.body.textContent;
    assert.match(text, /3 producers from 3,215 metrics · built 2h ago in 91s/);
    assert.match(text, /120 metrics wrote nothing in the last 60m · 40 carry no service_name · 2 probes failed — index is partial/);
    // Exposes tab, grouped by technology.
    const heads = [...document.querySelectorAll('.svm-section-head')].map((n) => n.firstChild.textContent);
    assert.deepEqual(heads, ['JVM', 'HTTP']);
    assert.ok(screen.getByRole('tab', { name: 'Exposes (3)' }));
  });

  it('opens a metric with the service it was picked under', async () => {
    const { opened } = mount([[/\/metrics\/producers/, INDEX]]);
    fireEvent.click(await screen.findByText('hikaricp_connections'));
    assert.equal(opened.length, 1);
    assert.equal(opened[0][0].name, 'hikaricp_connections');
    assert.equal(opened[0][1], 'IoTOpsSvc');
  });

  it('keeps observed platform metrics on their own tab', async () => {
    mount([[/\/metrics\/producers/, INDEX]]);
    const observedTab = await screen.findByRole('tab', { name: 'Observed about it (1)' });
    fireEvent.click(observedTab);
    assert.equal(observedTab.getAttribute('aria-selected'), 'true');
    assert.ok(screen.getByText('kube_pod_info'));
    assert.equal(screen.queryByText('jvm_threads_live'), null);
    // An unknown type shows "?" as its badge.
    assert.ok(screen.getByText('?'));
    fireEvent.click(screen.getByRole('tab', { name: 'Exposes (3)' }));
    assert.ok(screen.getByText('jvm_threads_live'));
  });

  it('filters by kind, and says when a service exposes nothing', async () => {
    mount([[/\/metrics\/producers/, INDEX]]);
    await screen.findByText('IoTOpsSvc', { selector: 'h3' });
    const facets = screen.getByRole('group', { name: 'Filter by kind' });
    assert.ok(within(facets).getByText('Observed only'));
    fireEvent.click(within(facets).getByText('Middleware'));
    await screen.findByText('pgexporter', { selector: 'h3' });
    assert.ok(screen.getByText('This service exposes no metrics of its own.'));
    assert.ok(screen.getByRole('tab', { name: 'Observed about it (0)' }).disabled);
    // Clicking the active kind again clears it; "All" also does.
    fireEvent.click(within(facets).getByText('Middleware'));
    assert.equal(document.querySelectorAll('.svm-row').length, 3);
    fireEvent.click(within(facets).getByText('Observed only'));
    assert.deepEqual([...document.querySelectorAll('.svm-row-name')].map((n) => n.textContent), ['ghost']);
    fireEvent.click(within(facets).getByText('All'));
    assert.equal(document.querySelectorAll('.svm-row').length, 3);
  });

  it('searches by service name and by a metric the service exposes', async () => {
    mount([[/\/metrics\/producers/, INDEX]]);
    await screen.findByText('IoTOpsSvc', { selector: 'h3' });
    const box = screen.getByRole('searchbox');
    fireEvent.change(box, { target: { value: 'hikari' } });
    assert.deepEqual([...document.querySelectorAll('.svm-row-name')].map((n) => n.textContent), ['IoTOpsSvc']);
    fireEvent.change(box, { target: { value: 'pgexp' } });
    // The old selection went off screen; the first visible row takes over.
    await screen.findByText('pgexporter', { selector: 'h3' });
    fireEvent.change(box, { target: { value: 'nothing-here' } });
    assert.match(document.body.textContent, /No service matches “nothing-here”\./);
    assert.ok(screen.getByText('Pick a service.'));
  });

  it('switches the detail pane when another service row is clicked', async () => {
    mount([[/\/metrics\/producers/, INDEX]]);
    await screen.findByText('IoTOpsSvc', { selector: 'h3' });
    fireEvent.click(screen.getByText('ghost', { selector: '.svm-row-name' }));
    await screen.findByText('ghost', { selector: 'h3' });
    assert.match(document.body.textContent, /Emits nothing\./);
  });

  it('Rebuild POSTs the refresh and reloads the index', async () => {
    const { calls } = mount([
      [(url, init) => init.method === 'POST', { building: true }],
      [/\/metrics\/producers/, INDEX],
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild' }));
    await waitFor(() => assert.equal(calls.filter((c) => /producers$|producers\?/.test(c.url)).length, 2));
    assert.ok(calls.some((c) => /\/metrics\/producers\/refresh/.test(c.url) && c.init.method === 'POST'));
  });

  it('reports sweep progress and polls until the build finishes', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    let n = 0;
    const { calls } = mount([[/\/metrics\/producers/, () => {
      n += 1;
      return n === 1
        ? {
          building: true, partial: true, progressDone: 800, progressTotal: 3200, services: [SVC_A],
        }
        : INDEX;
    }]]);
    await waitFor(() => assert.match(document.body.textContent, /Sweeping the catalogue — 800 of 3,200 metrics \(25%\) · 1 producers so far/));
    assert.match(document.body.textContent, /Partial — counts will grow/);
    assert.equal(screen.queryByRole('button', { name: 'Rebuild' }), null);
    await act(async () => { mock.timers.tick(2000); });
    await screen.findByRole('button', { name: 'Rebuild' });
    const before = calls.length;
    // Finished: no more polling.
    await act(async () => { mock.timers.tick(6000); });
    assert.equal(calls.length, before);
  });

  it('says it is still sweeping when a cold build has no rows yet', async () => {
    mount([[/\/metrics\/producers/, { building: true, progressDone: 0, progressTotal: 0 }]]);
    await screen.findByText('Still sweeping…');
    assert.match(document.body.textContent, /0 of 0 metrics \(0%\)/);
  });

  it('preselects a drill-seeded service and shows the caller notice', async () => {
    mount([[/\/metrics\/producers/, INDEX]], { initialService: 'pgexporter', notice: 'This alert names no metric.' });
    await screen.findByText('pgexporter', { selector: 'h3' });
    assert.ok(screen.getByRole('status').textContent.includes('This alert names no metric.'));
    assert.doesNotMatch(screen.getByRole('status').textContent, /not in this index/);
  });

  it('flags a seeded service that is not in the index at all', async () => {
    mount([[/\/metrics\/producers/, INDEX]], { initialService: 'NoSuchSvc', notice: 'Pick one.' });
    await waitFor(() => assert.match(screen.getByRole('status').textContent, /NoSuchSvc is not in this index at all/));
  });
});
