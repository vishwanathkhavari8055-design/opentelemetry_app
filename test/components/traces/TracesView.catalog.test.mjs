/**
 * TracesView — the Service Catalog tab, the trace drill-down, alert
 * drill-through, download, and how failures surface.
 *
 * Guarded here, all through the fetch seam:
 *  - the Service Catalog asks one size-1000 aggregation over the same window,
 *    hides the editor and field list, and a service click switches to Spans
 *    narrowed to that service;
 *  - an open trace id (owned by the shell) shows TraceDetail, whose Back
 *    reports null upwards;
 *  - an alert drill REPLACES the query with the alert's services and trace,
 *    applies its range, clears a leftover errors-only switch, opens the trace
 *    only when asked, and is consumed exactly once;
 *  - Download saves the current tab's rows as `<tab>.json`, and does nothing
 *    for an empty page;
 *  - a failed listing shows its error in the table, a failed histogram never
 *    takes the table down, `supported: false` explains the backend it needs,
 *    and failed stream/service discovery degrades to the defaults.
 */
import '../../support/dom.mjs';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const {
  render, screen, fireEvent, waitFor, within, cleanup,
} = await import('@testing-library/react');
const { default: TracesView } = await import('../../../src/components/TracesView.jsx');
const {
  stubTracesBackend, callsTo, paramsOf, SPANS, CATALOG,
} = await import('./tracesViewFixture.mjs');

let backend;
const opened = [];

const renderView = (props = {}) => render(React.createElement(TracesView, {
  onTraceIdChange: (id) => opened.push(id), ...props,
}));

const nthCall = async (path, n) => {
  await waitFor(() => assert.ok(callsTo(backend.calls, path).length >= n,
    `expected ${n} ${path} calls, saw ${callsTo(backend.calls, path).length}`));
  return paramsOf(callsTo(backend.calls, path)[n - 1]);
};

const restub = (overrides) => { backend.restore(); backend = stubTracesBackend(overrides); };
const editor = () => screen.getByRole('textbox', { name: 'Query editor' });
const FAIL = { status: 500, body: { message: 'upstream down' } };

describe('TracesView — catalog, drill-down and failures', () => {
  beforeEach(() => {
    localStorage.clear();
    opened.length = 0;
    backend = stubTracesBackend();
    // The screen logs its failures; the assertions below read the UI instead.
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
  });
  afterEach(() => {
    cleanup();
    backend.restore();
    mock.restoreAll();
  });

  it('shows the Service Catalog and narrows Spans to a clicked service', async () => {
    renderView();
    await screen.findByText('GET /cart');
    const before = callsTo(backend.calls, 'catalog').length;
    fireEvent.click(screen.getByRole('tab', { name: 'Service Catalog' }));

    const cat = await nthCall('catalog', before + 1);
    assert.equal(cat.get('size'), '1000');
    assert.equal(cat.get('startTime'), 'now-15m');
    await screen.findByText('1 Critical');
    assert.ok(screen.getByText('4 services'));
    // No query editor, field list or chart row on this tab.
    assert.equal(screen.queryByRole('textbox', { name: 'Query editor' }), null);
    assert.equal(screen.queryByRole('combobox', { name: 'Stream' }), null);
    assert.equal(screen.queryAllByRole('img').length, 0);

    // The name filter is held by the container and applied by the table.
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter by service name' }), { target: { value: 'pay' } });
    await waitFor(() => assert.equal(document.querySelectorAll('.sc-row').length, 1));

    fireEvent.click(screen.getByText('payments').closest('.sc-row'));
    await waitFor(() => assert.equal(screen.getByRole('tab', { name: 'Spans' }).getAttribute('aria-selected'), 'true'));
    assert.equal(editor().value, "service_name='payments'");
    await waitFor(() => assert.deepEqual(
      paramsOf(callsTo(backend.calls, 'spans').at(-1)).getAll('serviceNames'), ['payments'],
    ));
  });

  it('shows the catalog failure in place of the table', async () => {
    restub({ catalog: FAIL });
    renderView();
    await screen.findByText('GET /cart');
    fireEvent.click(screen.getByRole('tab', { name: 'Service Catalog' }));
    await screen.findByText('HTTP error! status: 500');
    assert.ok(screen.getByText('0 services'));
  });

  it('opens TraceDetail for the shell-owned trace id, and Back reports null', async () => {
    restub({
      spans: (url) => (new URL(url, 'http://x').searchParams.get('traceId')
        ? { items: [] } : { items: SPANS, total: 2 }),
    });
    renderView({ traceId: 'aaaaaaaaaaaaaaaa1111' });
    await screen.findByText('No spans found for this trace.');
    const ask = paramsOf(callsTo(backend.calls, 'spans')[0]);
    assert.equal(ask.get('traceId'), 'aaaaaaaaaaaaaaaa1111');
    assert.equal(ask.get('size'), '1000');
    // The listing is not rendered behind the drill-down.
    assert.equal(screen.queryByRole('tablist', { name: 'Traces view' }), null);

    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    assert.deepEqual(opened, [null]);
  });

  it('replaces the query with an alert drill, applies its range and consumes it once', async () => {
    localStorage.setItem('observability-ui:traces:errors-only:v1', 'true');
    localStorage.setItem('observability-ui:traces:query:v1', JSON.stringify("operation_name='old'"));
    let consumed = 0;
    const drill = {
      services: ['checkout', 'payments'],
      traceId: 'aaaaaaaaaaaaaaaa1111',
      openTrace: false,
      range: { mode: 'relative', relative: '1h', from: '', to: '' },
    };
    const { rerender } = renderView({ drillPrefill: drill, onDrillPrefillConsumed: () => { consumed += 1; } });

    await waitFor(() => assert.equal(
      editor().value, "service_name='checkout' AND service_name='payments' AND trace_id='aaaaaaaaaaaaaaaa1111'",
    ));
    await waitFor(() => {
      const last = paramsOf(callsTo(backend.calls, 'spans').at(-1));
      assert.deepEqual(last.getAll('serviceNames'), ['checkout', 'payments']);
      assert.equal(last.get('traceId'), 'aaaaaaaaaaaaaaaa1111');
      assert.equal(last.get('startTime'), 'now-1h');
      assert.equal(last.get('outcome'), null);
      assert.equal(last.get('spanName'), null);
    });
    assert.equal(consumed, 1);
    assert.deepEqual(opened, [null]);
    assert.equal(screen.getByTitle('Show only errors').getAttribute('aria-checked'), 'false');
    assert.match(screen.getByTitle('Change the time range').textContent, /Past 1 Hour/);

    // Re-rendering with the same object does not re-apply it.
    rerender(React.createElement(TracesView, {
      drillPrefill: drill, onDrillPrefillConsumed: () => { consumed += 1; }, onTraceIdChange: (id) => opened.push(id),
    }));
    assert.equal(consumed, 1);
  });

  it('opens the trace directly when the drill asks for it, keeping the range otherwise', async () => {
    renderView({ drillPrefill: { services: ['checkout'], traceId: 'aaaaaaaaaaaaaaaa1111', openTrace: true } });
    await waitFor(() => assert.deepEqual(opened, ['aaaaaaaaaaaaaaaa1111']));
    await waitFor(() => assert.equal(
      paramsOf(callsTo(backend.calls, 'spans').at(-1)).get('startTime'), 'now-15m',
    ));
  });

  it('downloads the current tab as JSON, and nothing for an empty page', async () => {
    const blobs = [];
    const downloads = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { blobs.push(b); return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    mock.method(window.HTMLAnchorElement.prototype, 'click', function click() {
      downloads.push({ name: this.download, href: this.getAttribute('href'), attached: document.body.contains(this) });
    });
    try {
      renderView();
      await screen.findByText('GET /cart');
      fireEvent.click(screen.getByRole('button', { name: 'Download this page as JSON' }));
      assert.deepEqual(downloads, [{ name: 'spans.json', href: 'blob:test', attached: true }]);
      assert.equal(blobs[0].type, 'application/json');
      // The anchor is removed once used.
      assert.equal(document.querySelector('a[download]'), null);

      fireEvent.click(screen.getByRole('tab', { name: 'Service Catalog' }));
      await screen.findByText('1 Critical');
      fireEvent.click(screen.getByRole('button', { name: 'Download this page as JSON' }));
      assert.equal(downloads.at(-1).name, 'catalog.json');
      assert.ok(blobs[1].size > JSON.stringify(CATALOG.items).length);

      restub({ spans: { items: [], total: 0 } });
      fireEvent.click(screen.getByRole('tab', { name: 'Spans' }));
      await screen.findByText('No spans matched this query in the selected time range.');
      fireEvent.click(screen.getByRole('button', { name: 'Download this page as JSON' }));
      assert.equal(downloads.length, 2);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('shows a failed listing in the table, and keeps the table when only the chart fails', async () => {
    restub({ spans: FAIL });
    renderView();
    await screen.findByText('HTTP error! status: 500');
    assert.ok(screen.getByText('— Spans Found'));

    cleanup();
    restub({ histogram: FAIL });
    renderView();
    await screen.findByText('GET /cart');
    await waitFor(() => assert.equal(screen.getAllByText('No data in this window.').length, 3));
  });

  it('explains when the backend does not support trace analytics', async () => {
    restub({ spans: { supported: false, items: [] } });
    renderView();
    await screen.findByText('Traces analytics requires the OpenObserve backend.');
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('falls back to the default stream and unknown services when discovery fails', async () => {
    restub({ streams: FAIL, catalog: FAIL });
    renderView();
    await screen.findByText('GET /cart');
    await waitFor(() => assert.ok(callsTo(backend.calls, 'catalog').length >= 1));
    const opts = within(screen.getByRole('combobox', { name: 'Stream' })).getAllByRole('option');
    assert.deepEqual(opts.map((o) => o.value), ['default']);

    // With discovery unavailable a registered resource cannot be ticked.
    fireEvent.click(await screen.findByRole('button', { name: /Applications/ }));
    const box = await screen.findByRole('checkbox', { name: /checkout/ });
    await waitFor(() => assert.match(box.closest('label').title, /service discovery is unavailable/));
    assert.equal(box.disabled, true);
  });

  it('keeps the tenant list as-is when it already includes the default stream', async () => {
    restub({ streams: { items: ['default', 'b'] } });
    renderView();
    await waitFor(() => {
      const opts = within(screen.getByRole('combobox', { name: 'Stream' })).getAllByRole('option');
      assert.deepEqual(opts.map((o) => o.value), ['default', 'b']);
    });
  });

  it('lists only real, de-duplicated service names from discovery', async () => {
    restub({
      catalog: { items: [...CATALOG.items, { serviceName: 'checkout', requests: 5 }, { serviceName: '-' }] },
    });
    renderView();
    await screen.findByText('GET /cart');
    fireEvent.click(screen.getByRole('button', { name: /service_name/ }));
    const list = await screen.findByRole('textbox', { name: 'Filter services' });
    await waitFor(() => assert.equal(list.placeholder, 'Filter 2 services…'));
    const names = Array.from(document.querySelectorAll('.fb-svc-name')).map((n) => n.textContent);
    assert.deepEqual(names.sort(), ['checkout', 'payments']);

    // Ticking one in the field list is the same filter as the tree.
    fireEvent.click(screen.getByRole('checkbox', { name: /payments/, checked: false, hidden: false }));
    await waitFor(() => assert.deepEqual(
      paramsOf(callsTo(backend.calls, 'spans').at(-1)).getAll('serviceNames'), ['payments'],
    ));
  });
});
