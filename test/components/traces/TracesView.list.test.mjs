/**
 * TracesView — the Spans and Traces listings over one shared query.
 *
 * Guarded here, all through the fetch seam:
 *  - mount asks for the first page of spans and the histogram over the last
 *    15 minutes, and renders the rows, totals, charts and discovered streams;
 *  - the editor is a DRAFT: typing never re-queries, Run query / Ctrl+Enter
 *    commit it, and the parsed query becomes serviceNames / outcome params;
 *  - the range picker and the errors-only switch commit immediately (a toggle
 *    that needs a second click reads as broken), months become days because
 *    the backend grammar has no months, and absolute ranges go as ISO;
 *  - ticking a service or a whole category, or clicking a sampled field
 *    value, rewrites the query and runs it;
 *  - paging, page size and Re-run ask for the right page again;
 *  - the Traces tab asks the trace-grain endpoint, and clicking a row opens
 *    that trace upwards; hiding the charts stops asking for them;
 *  - preferences persist in localStorage and are read back on mount.
 */
import '../../support/dom.mjs';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const React = (await import('react')).default;
const {
  render, screen, fireEvent, waitFor, within, cleanup, act,
} = await import('@testing-library/react');
const { default: TracesView } = await import('../../../src/components/TracesView.jsx');
const {
  stubTracesBackend, callsTo, paramsOf,
} = await import('./tracesViewFixture.mjs');

let backend;
const opened = [];

const renderView = (props = {}) => render(React.createElement(TracesView, {
  onTraceIdChange: (id) => opened.push(id), ...props,
}));

/** Wait until `path` has been asked `n` times, and return the last ask's params. */
const nthCall = async (path, n) => {
  await waitFor(() => assert.ok(callsTo(backend.calls, path).length >= n,
    `expected ${n} ${path} calls, saw ${callsTo(backend.calls, path).length}`));
  return paramsOf(callsTo(backend.calls, path)[n - 1]);
};

const editor = () => screen.getByRole('textbox', { name: 'Query editor' });
const runButton = () => screen.getByRole('button', { name: /^(Run query|Running…)$/ });

describe('TracesView — spans and traces listings', () => {
  beforeEach(() => {
    localStorage.clear();
    opened.length = 0;
    backend = stubTracesBackend();
  });
  afterEach(() => {
    // Real timers back first: the catalog poll was started on a real
    // setInterval, and a mocked clearInterval at unmount would leak it.
    mock.timers.reset();
    cleanup();
    backend.restore();
  });

  it('loads the first page of spans, the totals, the charts and the streams', async () => {
    renderView();
    await screen.findByText('GET /cart');

    const spans = paramsOf(callsTo(backend.calls, 'spans')[0]);
    assert.equal(spans.get('page'), '0');
    assert.equal(spans.get('size'), '25');
    assert.equal(spans.get('startTime'), 'now-15m');
    assert.equal(spans.get('outcome'), null);
    const hist = await nthCall('histogram', 1);
    assert.equal(hist.get('startTime'), 'now-15m');

    assert.ok(screen.getByText('2 Spans Found'));
    assert.ok(screen.getByText('1 Error Spans'));
    assert.ok(screen.getByText('POST /pay'));
    // Charts are on by default and drawn from the histogram.
    await waitFor(() => assert.equal(screen.getAllByRole('img').length, 3));
    // The stream picker offers the configured default plus the tenant's own.
    await waitFor(() => {
      const opts = within(screen.getByRole('combobox', { name: 'Stream' })).getAllByRole('option');
      assert.deepEqual(opts.map((o) => o.value), ['default', 'otel_traces']);
    });
    // Service discovery reads the catalog over the same window, size 1000.
    const discovery = paramsOf(callsTo(backend.calls, 'catalog')[0]);
    assert.equal(discovery.get('size'), '1000');
    assert.equal(discovery.get('startTime'), 'now-15m');
  });

  it('keeps typing as a draft until Run query or Ctrl+Enter commits it', async () => {
    renderView();
    await screen.findByText('GET /cart');
    assert.equal(runButton().title, 'Re-run the query');

    fireEvent.change(editor(), { target: { value: "service_name='checkout' AND span_status='ERROR'" } });
    assert.equal(runButton().title, 'Unrun changes — click to apply');
    // Give any stray effect a chance to fire: typing must not query.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    assert.equal(callsTo(backend.calls, 'spans').length, 1);

    fireEvent.click(runButton());
    const run = await nthCall('spans', 2);
    assert.deepEqual(run.getAll('serviceNames'), ['checkout']);
    assert.equal(run.get('outcome'), 'ERROR');
    await waitFor(() => assert.equal(runButton().title, 'Re-run the query'));
    // The histogram follows the committed query too.
    assert.equal((await nthCall('histogram', 2)).get('outcome'), 'ERROR');

    fireEvent.change(editor(), { target: { value: "operation_name='GET /cart'" } });
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    const ctrl = await nthCall('spans', 3);
    assert.equal(ctrl.get('spanName'), 'GET /cart');
    assert.equal(ctrl.get('serviceNames'), null);

    // The draft survives a reload.
    assert.equal(JSON.parse(localStorage.getItem('observability-ui:traces:query:v1')), "operation_name='GET /cart'");
  });

  it('commits the errors-only switch and time range immediately', async () => {
    renderView();
    await screen.findByText('GET /cart');

    fireEvent.click(screen.getByTitle('Show only errors'));
    assert.equal((await nthCall('spans', 2)).get('outcome'), 'ERROR');

    fireEvent.click(screen.getByTitle('Change the time range'));
    fireEvent.click(screen.getByText('Hours').parentElement.querySelector('button'));
    const hour = await nthCall('spans', 3);
    assert.equal(hour.get('startTime'), 'now-1h');
    assert.equal(hour.get('outcome'), 'ERROR');
    assert.match(screen.getByTitle('Change the time range').textContent, /Past 1 Hour/);

    // Months are not in the backend's grammar; they go as 30-day multiples.
    fireEvent.click(screen.getByTitle('Change the time range'));
    fireEvent.click(screen.getByText('Months').parentElement.querySelectorAll('button')[1]);
    assert.equal((await nthCall('spans', 4)).get('startTime'), 'now-60d');

    // Absolute ranges go as ISO instants, with an empty end omitted.
    fireEvent.click(screen.getByTitle('Change the time range'));
    fireEvent.click(screen.getByRole('tab', { name: 'Absolute' }));
    const [from] = document.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(from, { target: { value: '2026-08-03T12:45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    const abs = await nthCall('spans', 5);
    assert.equal(abs.get('startTime'), new Date('2026-08-03T12:45').toISOString());
    assert.equal(abs.get('endTime'), null);
    // Service discovery follows the committed range.
    await waitFor(() => assert.equal(
      paramsOf(callsTo(backend.calls, 'catalog').at(-1)).get('startTime'),
      new Date('2026-08-03T12:45').toISOString(),
    ));
  });

  it('turns a ticked resource, a whole category and a sampled value into query clauses', async () => {
    renderView();
    await screen.findByText('GET /cart');

    // Product Catalog tree: open Applications and tick one resource.
    fireEvent.click(await screen.findByRole('button', { name: /Applications/ }));
    const checkout = await screen.findByRole('checkbox', { name: /checkout/ });
    await waitFor(() => assert.equal(checkout.disabled, false));
    fireEvent.click(checkout);
    assert.deepEqual((await nthCall('spans', 2)).getAll('serviceNames'), ['checkout']);
    assert.equal(editor().value, "service_name='checkout'");

    // Unticking removes the clause rather than leaving it behind.
    fireEvent.click(screen.getByRole('checkbox', { name: /checkout/ }));
    assert.deepEqual((await nthCall('spans', 3)).getAll('serviceNames'), []);
    assert.equal(editor().value, '');

    // The category box selects every enabled resource in it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all resources in Applications' }));
    assert.deepEqual((await nthCall('spans', 4)).getAll('serviceNames').sort(), ['checkout', 'payments']);
    await waitFor(() => assert.ok(screen.getByRole('checkbox', { name: 'Clear all resources in Applications' })));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Clear all resources in Applications' }));
    assert.deepEqual((await nthCall('spans', 5)).getAll('serviceNames'), []);

    // A value from the sampled span documents is appended and run.
    await screen.findByText('GET /cart');
    fireEvent.click(screen.getByRole('button', { name: /http_method/ }));
    fireEvent.click(screen.getByTitle("Add http_method='POST' to the query"));
    await nthCall('spans', 6);
    assert.equal(editor().value, "http_method='POST'");
    await screen.findByText('GET /cart');
    // A second value is ANDed on, and a repeat is not duplicated.
    fireEvent.click(screen.getByTitle("Add http_method='GET' to the query"));
    await nthCall('spans', 7);
    assert.equal(editor().value, "http_method='POST' AND http_method='GET'");
    await screen.findByText('GET /cart');
    fireEvent.click(screen.getByTitle("Add http_method='GET' to the query"));
    await nthCall('spans', 8);
    assert.equal(editor().value, "http_method='POST' AND http_method='GET'");
  });

  it('converts the query to SQL and back, and applies clicked values in SQL', async () => {
    renderView();
    await screen.findByText('GET /cart');

    fireEvent.click(screen.getByRole('switch', { name: 'SQL' }));
    assert.equal(editor().value, 'SELECT * FROM "default"');
    assert.equal(editor().placeholder, `SELECT * FROM "default" WHERE service_name='SSOservice'`);

    fireEvent.click(screen.getByRole('button', { name: /http_method/ }));
    fireEvent.click(screen.getByTitle("Add http_method='GET' to the query"));
    await nthCall('spans', 2);
    assert.equal(editor().value, `SELECT * FROM "default" WHERE http_method='GET'`);
    await screen.findByText('GET /cart');
    fireEvent.click(screen.getByTitle("Add http_method='POST' to the query"));
    await nthCall('spans', 3);
    assert.equal(editor().value, `SELECT * FROM "default" WHERE http_method='GET' AND http_method='POST'`);

    // Back to filter mode keeps just the WHERE clause.
    fireEvent.click(screen.getByRole('switch', { name: 'SQL' }));
    assert.equal(editor().value, "http_method='GET' AND http_method='POST'");

    // Filter text converts to SQL on the chosen stream.
    fireEvent.change(screen.getByRole('combobox', { name: 'Stream' }), { target: { value: 'otel_traces' } });
    fireEvent.change(editor(), { target: { value: "service_name='checkout'" } });
    await waitFor(() => assert.ok(screen.getByRole('option', { name: 'otel_traces' })));
    fireEvent.change(screen.getByRole('combobox', { name: 'Stream' }), { target: { value: 'otel_traces' } });
    fireEvent.click(screen.getByRole('switch', { name: 'SQL' }));
    assert.equal(editor().value, `SELECT * FROM "otel_traces" WHERE service_name='checkout'`);
  });

  it('refuses to run SQL that does not parse, and shows why instead of querying', async () => {
    renderView();
    await screen.findByText('GET /cart');
    fireEvent.click(screen.getByRole('switch', { name: 'SQL' }));
    fireEvent.change(editor(), { target: { value: 'DELETE everything' } });
    assert.ok(runButton().disabled);
    assert.equal(runButton().title, "The query doesn't parse — see the message under the editor");
    assert.match(screen.getByRole('alert').textContent, /Expected SELECT/);

    // A range change commits the (bad) draft: the table shows the parse error
    // and nothing is sent.
    const before = callsTo(backend.calls, 'spans').length;
    fireEvent.click(screen.getByTitle('Change the time range'));
    fireEvent.click(screen.getByText('Hours').parentElement.querySelector('button'));
    await waitFor(() => assert.ok(document.querySelector('.log-empty-error')));
    assert.match(document.querySelector('.log-empty-error').textContent, /Expected SELECT/);
    assert.equal(callsTo(backend.calls, 'spans').length, before);
    assert.equal(screen.queryAllByRole('img').length, 0);
  });

  it('pages, resizes and re-runs the listing', async () => {
    backend.restore();
    backend = stubTracesBackend({ spans: { items: (await import('./tracesViewFixture.mjs')).SPANS, total: null, hasMore: true } });
    renderView();
    await screen.findByText('GET /cart');
    assert.ok(screen.getByText('— Spans Found'));

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const next = await nthCall('spans', 2);
    assert.equal(next.get('page'), '1');
    // Paging never re-asks for the histogram: it describes the whole window.
    assert.equal(callsTo(backend.calls, 'histogram').length, 1);

    await screen.findByText('GET /cart');
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '50' } });
    await waitFor(() => {
      const last = paramsOf(callsTo(backend.calls, 'spans').at(-1));
      assert.equal(last.get('size'), '50');
      assert.equal(last.get('page'), '0');
    });

    await screen.findByText('GET /cart');
    const n = callsTo(backend.calls, 'spans').length;
    fireEvent.click(screen.getByRole('button', { name: 'Re-run the query' }));
    await nthCall('spans', n + 1);
    assert.equal(callsTo(backend.calls, 'histogram').length, 2);
  });

  it('lists traces on the Traces tab and opens one on click', async () => {
    renderView();
    await screen.findByText('GET /cart');
    fireEvent.click(screen.getByRole('tab', { name: 'Traces' }));

    const list = await nthCall('list', 1);
    assert.equal(list.get('page'), '0');
    await screen.findByText('POST /order');
    assert.ok(screen.getByText('1 Traces Found'));
    assert.ok(screen.getByText('1 Error Traces'));
    assert.equal(JSON.parse(localStorage.getItem('observability-ui:traces:tab:v1')), 'traces');

    fireEvent.click(screen.getByText('POST /order').closest('[role="row"]'));
    assert.deepEqual(opened, ['cccccccccccccccc3333']);

    // Spans rows open their trace the same way.
    fireEvent.click(screen.getByRole('tab', { name: 'Spans' }));
    fireEvent.click((await screen.findByText('POST /pay')).closest('[role="row"]'));
    assert.deepEqual(opened, ['cccccccccccccccc3333', 'bbbbbbbbbbbbbbbb2222']);
  });

  it('stops asking for charts while they are hidden, and collapses panes', async () => {
    renderView();
    await screen.findByText('GET /cart');
    await nthCall('histogram', 1);

    fireEvent.click(screen.getByTitle('Hide the Rate / Errors / Duration charts'));
    await waitFor(() => assert.equal(screen.queryAllByRole('img').length, 0));
    fireEvent.click(runButton());
    await nthCall('spans', 2);
    assert.equal(callsTo(backend.calls, 'histogram').length, 1);
    assert.equal(JSON.parse(localStorage.getItem('observability-ui:traces:charts:v1')), false);
    // The results bar has the same toggle.
    fireEvent.click(screen.getByTitle('Show the event-volume chart'));
    await nthCall('histogram', 2);

    fireEvent.click(screen.getByRole('button', { name: 'Hide fields' }));
    assert.ok(screen.getByRole('button', { name: 'Show fields' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show fields' }));
    assert.ok(screen.getByRole('button', { name: 'Hide fields' }));
    fireEvent.click(screen.getByTitle('Hide the field list'));
    assert.ok(screen.getByRole('button', { name: 'Show fields' }));

    // The toolbar and the editor's own title bar both collapse the editor.
    const toolbarEditorBtn = () => document.querySelector('.traces-toolbar .tb-btn:nth-child(3)');
    fireEvent.click(toolbarEditorBtn());
    assert.equal(screen.queryByRole('textbox', { name: 'Query editor' }), null);
    assert.equal(toolbarEditorBtn().title, 'Show the query editor');
    fireEvent.click(toolbarEditorBtn());
    assert.ok(editor());
    fireEvent.click(screen.getByRole('button', { name: /Query Editor/ }));
    assert.equal(screen.queryByRole('textbox', { name: 'Query editor' }), null);
    assert.equal(JSON.parse(localStorage.getItem('observability-ui:traces:editor-collapsed:v1')), true);
  });

  it('restores the tab, query and switches from localStorage', async () => {
    localStorage.setItem('observability-ui:traces:tab:v1', JSON.stringify('traces'));
    localStorage.setItem('observability-ui:traces:query:v1', JSON.stringify("service_name='gateway'"));
    localStorage.setItem('observability-ui:traces:errors-only:v1', 'true');
    localStorage.setItem('observability-ui:traces:time-range:v1', JSON.stringify({ mode: 'relative', relative: '6h', from: '', to: '' }));
    localStorage.setItem('observability-ui:traces:charts:v1', '{not json');
    renderView();

    const list = await nthCall('list', 1);
    assert.deepEqual(list.getAll('serviceNames'), ['gateway']);
    assert.equal(list.get('outcome'), 'ERROR');
    assert.equal(list.get('startTime'), 'now-6h');
    assert.equal(editor().value, "service_name='gateway'");
    // Corrupt JSON falls back to the default (charts shown).
    await nthCall('histogram', 1);
    assert.equal(callsTo(backend.calls, 'spans').length, 0);
  });

  it('ignores an unknown stored tab', async () => {
    localStorage.setItem('observability-ui:traces:tab:v1', JSON.stringify('bogus'));
    renderView();
    await nthCall('spans', 1);
    assert.equal(screen.getByRole('tab', { name: 'Spans' }).getAttribute('aria-selected'), 'true');
  });

  it('auto-refreshes on the chosen interval while on the first page', async () => {
    renderView();
    await screen.findByText('GET /cart');
    mock.timers.enable({ apis: ['setInterval'] });
    fireEvent.click(screen.getByTitle('Auto-refresh is off'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '5 sec' }));
    assert.equal(JSON.parse(localStorage.getItem('observability-ui:traces:refresh-secs:v1')), 5);

    await act(async () => { mock.timers.tick(5000); });
    await nthCall('spans', 2);
    await screen.findByText('GET /cart');
    await act(async () => { mock.timers.tick(5000); });
    await nthCall('spans', 3);
  });
});
