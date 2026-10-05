/**
 * The Logs screen end to end, against a stubbed backend: what it asks
 * /api/logs (and /logs/services, /streams, /product-catalog) for, and what the
 * user sees for each answer.
 *
 * Guarded contracts:
 *  - draft vs committed: typing does not query; Run / Ctrl+Enter does, and the
 *    request carries exactly the parsed clauses (serviceNames, severity,
 *    traceId, search, startTime/endTime, stream, page, size).
 *  - an unparseable query is never sent (it would return the whole stream).
 *  - every click-to-filter path (field value, `=` button, legend, product tree)
 *    rewrites the editor AND re-runs, so the editor always shows what applies.
 *  - time ranges map to the backend's `now-Nx` grammar (months → days) and
 *    absolute ranges to ISO; auto-refresh pauses (and says why) off page 1.
 *  - drill-throughs (service / trace / filter prefill, shared links) land on
 *    exactly the question that was asked, and are consumed once.
 *  - Source Details: row click opens it; Search Around re-points the query.
 *  - a failed table fetch shows the error; failed side fetches never take the
 *    table down.
 */
import '../../support/dom.mjs';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const {
  render, screen, fireEvent, cleanup, waitFor, act, within,
} = await import('@testing-library/react');
const { default: LogsView } = await import('../../../src/components/LogsView.jsx');

const h = React.createElement;
const TRACE = 'ab'.repeat(16);

const WIRE = [
  {
    '@timestamp': '2026-09-25T10:00:00.000Z', 'service.name': 'orders', severity_text: 'ERROR',
    body: 'payment, "timeout"', traceId: TRACE, host: 'h1',
  },
  {
    '@timestamp': '2026-09-25T09:59:00.000Z', 'service.name': 'billing', severity_text: 'INFO',
    body: 'ok', host: 'h2',
  },
];

const CATALOG = {
  categories: { items: [{ code: 'APP', label: 'Applications', registeredCount: 2 }] },
  resources: {
    items: [
      { id: 1, resourceName: 'orders', category: 'APP', status: 'ENABLED' },
      { id: 2, resourceName: 'billing', category: 'APP', status: 'ENABLED' },
    ],
    supported: true,
  },
};

/** Backend stub. `logs` answers the table; the 500-row sample gets `sample`. */
const backend = ({
  logs = () => ({ items: WIRE, hasMore: false, total: null }),
  sample = () => ({ items: WIRE }),
  streams = { items: ['default', 'audit'] },
  services = { services: [{ name: 'orders', count: 10 }, { name: 'billing', count: 5 }], supported: true },
} = {}) => stubFetch([
  [/\/streams\?/, streams],
  [/\/logs\/services/, services],
  [/\/logs\?/, (url) => (new URL(url, 'http://x').searchParams.get('size') === '500' ? sample(url) : logs(url))],
  [/\/product-catalog\/categories/, CATALOG.categories],
  [/\/product-catalog/, CATALOG.resources],
]);

const params = (call) => new URL(call.url, 'http://x').searchParams;
const tableCalls = (calls) => calls
  .filter((c) => /\/logs\?/.test(c.url) && params(c).get('size') !== '500')
  .map(params);
const sampleCalls = (calls) => calls
  .filter((c) => /\/logs\?/.test(c.url) && params(c).get('size') === '500')
  .map(params);
const lastTable = (calls) => tableCalls(calls).at(-1);

/** jsdom's Blob has no .text(); its FileReader does the job. */
const readBlob = (blob) => new Promise((resolve, reject) => {
  const reader = new window.FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

function Harness(props) {
  const [page, setPage] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(50);
  const [hovered, setHovered] = React.useState(null);
  return h(LogsView, {
    onTraceClick: () => {}, hoveredTraceId: hovered, setHoveredTraceId: setHovered,
    page, setPage, pageSize, setPageSize, ...props,
  });
}

const LS = 'observability-ui:logs:';
const editor = () => screen.getByRole('textbox', { name: 'Query editor' });
const runBtn = () => screen.getByRole('button', { name: /^(Run query|Running…)$/ });
const rowsShown = () => document.querySelectorAll('.oo-row-wrap').length;
const loaded = async () => waitFor(() => assert.equal(rowsShown(), 2));

let stub;
let quiet;
const mount = async (props = {}, backendOpts) => {
  stub = backend(backendOpts);
  const utils = render(h(Harness, props));
  return utils;
};

describe('LogsView', () => {
  beforeEach(() => {
    localStorage.clear();
    // Auto-refresh off unless a test turns it on: a real 60s timer is noise here.
    localStorage.setItem(`${LS}refresh-secs:v3`, '0');
    window.history.replaceState(null, '', '/');
    quiet = [mock.method(console, 'error', () => {}), mock.method(console, 'warn', () => {})];
  });
  afterEach(() => {
    cleanup();
    stub?.restore();
    stub = null;
    mock.timers.reset();
    quiet.forEach((m) => m.mock.restore());
  });

  it('loads the last 15 minutes of the default stream on mount, with a sample for chart and fields', async () => {
    await mount();
    await loaded();
    const t = lastTable(stub.calls);
    assert.equal(t.get('stream'), 'default');
    assert.equal(t.get('page'), '0');
    assert.equal(t.get('size'), '50');
    assert.equal(t.get('sort'), 'timestamp,desc');
    assert.equal(t.get('startTime'), 'now-15m');
    assert.equal(t.get('endTime'), null);
    assert.equal(sampleCalls(stub.calls).length, 1);
    assert.ok(stub.calls.some((c) => /\/logs\/services\?startTime=now-15m/.test(c.url)));
    assert.match(document.querySelector('.results-bar-count').textContent, /Showing 1 to 2 events/);
    // Stream picker lists what /api/streams discovered.
    await waitFor(() => assert.equal(screen.getByRole('combobox', { name: 'Stream' }).options.length, 2));
    // Histogram and field list are built from the sample.
    await screen.findByRole('button', { name: /ERROR/, pressed: false });
    assert.ok(screen.getByTitle(/^host — 2 distinct values/));
  });

  it('typing does not query; Run sends the parsed clauses and clears the dirty state', async () => {
    await mount();
    await loaded();
    const before = tableCalls(stub.calls).length;
    fireEvent.change(editor(), { target: { value: "service_name='orders' AND severity_text='error' AND timeout" } });
    assert.equal(tableCalls(stub.calls).length, before);
    assert.equal(runBtn().title, 'Unrun changes — click to apply');

    fireEvent.click(runBtn());
    await waitFor(() => assert.equal(tableCalls(stub.calls).length, before + 1));
    const t = lastTable(stub.calls);
    assert.deepEqual(t.getAll('serviceNames'), ['orders']);
    assert.equal(t.get('severity'), 'ERROR');
    assert.equal(t.get('search'), 'timeout');
    await waitFor(() => assert.equal(runBtn().title, 'Re-run the query'));
    // The committed search term is highlighted in the rows.
    await waitFor(() => assert.ok(document.querySelector('.oo-row-src mark')));
    // The draft is persisted.
    assert.match(localStorage.getItem(`${LS}query:v1`), /orders/);
  });

  it('Ctrl+Enter in the editor runs the same query; a bare trace id pins traceId', async () => {
    await mount();
    await loaded();
    fireEvent.change(editor(), { target: { value: TRACE } });
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    await waitFor(() => assert.equal(lastTable(stub.calls).get('traceId'), TRACE));
  });

  it('never sends an unparseable query and says why', async () => {
    await mount();
    await loaded();
    fireEvent.click(screen.getByRole('switch'));
    assert.equal(editor().value, 'SELECT * FROM "default"');
    fireEvent.change(editor(), { target: { value: 'SELECT nonsense' } });
    assert.match(screen.getByRole('alert').textContent, /Expected SELECT/);
    assert.equal(runBtn().disabled, true);

    const before = tableCalls(stub.calls).length;
    const samples = sampleCalls(stub.calls).length;
    fireEvent.keyDown(editor(), { key: 'Enter', ctrlKey: true });
    await screen.findByText('Query failed');
    assert.ok(within(document.querySelector('.log-empty')).getByText(/Expected SELECT/));
    assert.equal(tableCalls(stub.calls).length, before);
    assert.equal(sampleCalls(stub.calls).length, samples);
  });

  it('SQL mode carries the expression across and back, and shows warnings', async () => {
    await mount();
    await loaded();
    fireEvent.change(editor(), { target: { value: "host='h1'" } });
    fireEvent.click(screen.getByRole('switch'));
    assert.equal(editor().value, `SELECT * FROM "default" WHERE host='h1'`);
    assert.ok(screen.getByText(/No dedicated filter for "host"/));
    assert.equal(editor().placeholder, `SELECT * FROM "default" WHERE severity_text='ERROR'`);
    fireEvent.click(screen.getByRole('switch'));
    assert.equal(editor().value, "host='h1'");
  });

  it('shows the backend error when the table fetch fails, while side fetches may also fail', async () => {
    await mount({}, {
      logs: () => ({ status: 500, body: {} }),
      sample: () => ({ status: 500, body: {} }),
      streams: { status: 503, body: { error: 'down' } },
      services: { status: 500, body: {} },
    });
    await screen.findByText('Query failed');
    assert.ok(screen.getByText('HTTP error! status: 500'));
    // The stream picker keeps the fallback.
    assert.equal(screen.getByRole('combobox', { name: 'Stream' }).options.length, 1);
    await screen.findByText('No events to chart for the current filters.');
  });

  it('a field value click appends the clause and re-runs', async () => {
    await mount();
    await loaded();
    fireEvent.change(editor(), { target: { value: "service_name='orders'" } });
    fireEvent.click(screen.getByTitle(/^host — 2 distinct values/));
    fireEvent.click(screen.getByTitle("Add host='h2' to the query"));
    assert.equal(editor().value, "service_name='orders' AND host='h2'");
    await waitFor(() => assert.equal(lastTable(stub.calls).get('search'), 'h2'));
    // Clicking it again leaves the query alone but still re-runs.
    const n = tableCalls(stub.calls).length;
    fireEvent.click(screen.getByTitle("Add host='h2' to the query"));
    assert.equal(editor().value, "service_name='orders' AND host='h2'");
    await waitFor(() => assert.equal(tableCalls(stub.calls).length, n + 1));
  });

  it('the `=` button in an expanded row adds a clause, in SQL mode too', async () => {
    await mount();
    await loaded();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand record' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Add host equals h1 to the query' }));
    assert.equal(editor().value, `SELECT * FROM "default" WHERE host='h1'`);
    fireEvent.click(screen.getAllByRole('button', { name: /Expand record|Collapse record/ })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand record' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /Add service\.name equals orders/ }));
    assert.equal(editor().value, `SELECT * FROM "default" WHERE host='h1' AND service.name='orders'`);
    await waitFor(() => assert.deepEqual(lastTable(stub.calls).getAll('serviceNames'), ['orders']));
  });

  it('an empty SQL query gets a full SELECT when a value is clicked', async () => {
    localStorage.setItem(`${LS}sql-mode:v1`, 'true');
    await mount();
    await loaded();
    assert.equal(editor().value, '');
    fireEvent.click(screen.getAllByRole('button', { name: 'Expand record' })[0]);
    // A role query over the expanded record is slow in jsdom under full-suite load.
    fireEvent.click(await screen.findByRole('button', { name: 'Add host equals h1 to the query' }, { timeout: 5000 }));
    assert.equal(editor().value, `SELECT * FROM "default" WHERE host='h1'`);
  });

  it('the legend filters by severity and a second click clears it', async () => {
    await mount();
    await loaded();
    fireEvent.change(editor(), { target: { value: "host='h1'" } });
    fireEvent.click(await screen.findByRole('button', { name: /^ERROR/ }));
    assert.equal(editor().value, "host='h1' AND severity_text='ERROR'");
    await waitFor(() => assert.equal(lastTable(stub.calls).get('severity'), 'ERROR'));
    await waitFor(() => assert.equal(screen.getByRole('button', { name: /^ERROR/ }).getAttribute('aria-pressed'), 'true'));
    fireEvent.click(screen.getByRole('button', { name: /^ERROR/ }));
    assert.equal(editor().value, "host='h1'");
    await waitFor(() => assert.equal(lastTable(stub.calls).get('severity'), null));
    // From an empty editor the clause stands alone.
    fireEvent.change(editor(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^INFO/ }));
    assert.equal(editor().value, "severity_text='INFO'");
  });

  it('legend filtering in SQL mode keeps the SELECT form', async () => {
    await mount();
    await loaded();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(await screen.findByRole('button', { name: /^ERROR/ }));
    assert.equal(editor().value, `SELECT * FROM "default" WHERE severity_text='ERROR'`);
    fireEvent.change(editor(), { target: { value: `SELECT * FROM "default" WHERE host='h1'` } });
    fireEvent.click(screen.getByRole('button', { name: /^INFO/ }));
    assert.equal(editor().value, `SELECT * FROM "default" WHERE host='h1' AND severity_text='INFO'`);
  });

  it('time range picks commit immediately; months become days; absolute is sent as ISO', async () => {
    await mount();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /Past 15 Minutes/ }));
    const months = within(screen.getByText('Months').parentElement);
    fireEvent.click(months.getByRole('button', { name: '2' }));
    await waitFor(() => assert.equal(lastTable(stub.calls).get('startTime'), 'now-60d'));
    assert.ok(stub.calls.some((c) => /\/logs\/services\?startTime=now-60d/.test(c.url)));

    fireEvent.click(screen.getByRole('button', { name: /Past 2 Months/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Absolute' }));
    const [from, to] = document.querySelectorAll('input[type="datetime-local"]');
    fireEvent.change(from, { target: { value: '2026-09-25T10:00' } });
    fireEvent.change(to, { target: { value: '2026-09-25T11:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => assert.equal(lastTable(stub.calls).get('startTime'), new Date('2026-09-25T10:00').toISOString()));
    assert.equal(lastTable(stub.calls).get('endTime'), new Date('2026-09-25T11:00').toISOString());
  });

  it('changing stream sends it on the next run', async () => {
    await mount();
    await loaded();
    const picker = screen.getByRole('combobox', { name: 'Stream' });
    await waitFor(() => assert.equal(picker.options.length, 2));
    fireEvent.change(picker, { target: { value: 'audit' } });
    fireEvent.click(runBtn());
    await waitFor(() => assert.equal(lastTable(stub.calls).get('stream'), 'audit'));
  });

  it('pages through results and pauses auto-refresh off page 1', async () => {
    localStorage.setItem(`${LS}refresh-secs:v3`, '60');
    await mount({}, { logs: () => ({ items: WIRE, hasMore: true, total: null }) });
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => assert.equal(lastTable(stub.calls).get('page'), '1'));
    assert.ok(screen.getByTitle('Auto-refresh 1m — Paused while you are off the first page'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '100' } });
    await waitFor(() => assert.equal(lastTable(stub.calls).get('size'), '100'));
    assert.equal(lastTable(stub.calls).get('page'), '0');
  });

  it('hiding both the chart and the field list skips the sample fetch', async () => {
    await mount();
    await loaded();
    const samples = sampleCalls(stub.calls).length;
    fireEvent.click(screen.getAllByTitle('Hide the event-volume chart')[0]);
    fireEvent.click(screen.getByTitle('Hide the field list'));
    assert.equal(document.querySelector('.histo'), null);
    assert.ok(screen.getByRole('button', { name: 'Show fields' }));
    fireEvent.click(runBtn());
    await waitFor(() => assert.equal(tableCalls(stub.calls).length, 2));
    assert.equal(sampleCalls(stub.calls).length, samples);
    assert.equal(localStorage.getItem(`${LS}histogram:v1`), 'false');
    // The refresh button re-runs exactly what is on screen.
    fireEvent.click(screen.getByRole('button', { name: 'Re-run the query' }));
    await waitFor(() => assert.equal(tableCalls(stub.calls).length, 3));
  });

  it('collapses the editor and toggles expand-all', async () => {
    await mount();
    await loaded();
    fireEvent.click(screen.getAllByTitle('Hide the query editor')[0]);
    assert.equal(screen.queryByRole('textbox', { name: 'Query editor' }), null);
    fireEvent.click(screen.getAllByTitle('Show the query editor')[0]);
    assert.ok(editor());
    fireEvent.click(screen.getByTitle('Expand every record'));
    assert.equal(document.querySelectorAll('.oo-detail').length, 2);
  });

  it('saves, loads and deletes views, persisting them', async () => {
    await mount();
    await loaded();
    fireEvent.change(editor(), { target: { value: "host='h2'" } });
    fireEvent.click(screen.getByTitle('Saved views'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Saved view name' }), { target: { value: 'h2 only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    assert.equal(JSON.parse(localStorage.getItem(`${LS}saved-views:v1`))[0].query, "host='h2'");

    fireEvent.change(editor(), { target: { value: '' } });
    fireEvent.click(screen.getByTitle('Saved views'));
    fireEvent.click(screen.getByRole('button', { name: 'h2 only' }));
    assert.equal(editor().value, "host='h2'");
    await waitFor(() => assert.equal(lastTable(stub.calls).get('search'), 'h2'));

    fireEvent.click(screen.getByTitle('Saved views'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved view h2 only' }));
    assert.ok(screen.getByText('Nothing saved yet.'));
  });

  it('copies a share link that reproduces the query', async () => {
    const written = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (t) => { written.push(t); } },
    });
    await mount();
    await loaded();
    fireEvent.change(editor(), { target: { value: "host='h1'" } });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy share link' })); });
    const url = new URL(written[0]);
    assert.equal(url.searchParams.get('q'), "host='h1'");
    assert.equal(url.searchParams.get('period'), '15m');
    assert.ok(screen.getByRole('menuitem', { name: 'Link copied ✓' }));
    act(() => { mock.timers.tick(2000); });
    assert.ok(screen.getByRole('menuitem', { name: 'Copy share link' }));
  });

  it('a share link for an absolute range carries from/to and the SQL flag', async () => {
    const written = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (t) => { written.push(t); } },
    });
    localStorage.setItem(`${LS}sql-mode:v1`, 'true');
    localStorage.setItem(`${LS}time-range:v1`, JSON.stringify({
      mode: 'absolute', relative: '15m', from: '2026-09-25T10:00', to: '2026-09-25T11:00',
    }));
    await mount();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Copy share link' })); });
    const url = new URL(written[0]);
    assert.equal(url.searchParams.get('sql'), '1');
    assert.equal(url.searchParams.get('from'), '2026-09-25T10:00');
    assert.equal(url.searchParams.get('to'), '2026-09-25T11:00');
    assert.equal(url.searchParams.get('period'), null);
    assert.equal(url.searchParams.get('q'), null);
    act(() => { mock.timers.tick(2000); });
  });

  it('opens a shared link on exactly its query and range', async () => {
    window.history.replaceState(null, '', "/?q=host%3D'h2'&sql=0&period=1h");
    await mount();
    await loaded();
    assert.equal(editor().value, "host='h2'");
    const t = lastTable(stub.calls);
    assert.equal(t.get('search'), 'h2');
    assert.equal(t.get('startTime'), 'now-1h');
  });

  it('a shared absolute link sends ISO bounds', async () => {
    window.history.replaceState(null, '', '/?from=2026-09-25T10:00&to=2026-09-25T11:00&sql=1');
    await mount();
    await waitFor(() => assert.ok(tableCalls(stub.calls).length >= 1));
    assert.equal(lastTable(stub.calls).get('startTime'), new Date('2026-09-25T10:00').toISOString());
    assert.equal(screen.getByRole('switch').getAttribute('aria-checked'), 'true');
  });

  it('downloads the page as CSV and JSON', async () => {
    const blobs = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x'; };
    URL.revokeObjectURL = () => {};
    const clicks = mock.method(window.HTMLAnchorElement.prototype, 'click', function click() {
      blobs.at(-1).filename = this.download;
    });
    try {
      await mount();
      await loaded();
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download this page (CSV)' }));
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download this page (JSON)' }));
      assert.equal(blobs.length, 2);
      assert.equal(blobs[0].filename, 'logs.csv');
      const csv = await readBlob(blobs[0]);
      const lines = csv.split('\n');
      assert.equal(lines[0], '@timestamp,service.name,severity_text,body,traceId,host');
      // Quotes and commas are escaped; a missing field is an empty cell.
      assert.equal(lines[1], `2026-09-25T10:00:00.000Z,orders,ERROR,"payment, ""timeout""",${TRACE},h1`);
      assert.equal(lines[2], '2026-09-25T09:59:00.000Z,billing,INFO,ok,,h2');
      assert.equal(blobs[1].filename, 'logs.json');
      assert.deepEqual(JSON.parse(await readBlob(blobs[1])), WIRE);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      clicks.mock.restore();
    }
  });

  it('downloading an empty page does nothing', async () => {
    const created = mock.fn(() => 'blob:x');
    const orig = URL.createObjectURL;
    URL.createObjectURL = created;
    try {
      await mount({}, { logs: () => ({ items: [] }) });
      await screen.findByText('No events in the selected time range.');
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Download this page (JSON)' }));
      assert.equal(created.mock.callCount(), 0);
    } finally {
      URL.createObjectURL = orig;
    }
  });

  it('row click opens Source Details; Next walks; Open trace hands the id back', async () => {
    const traces = [];
    await mount({ onTraceClick: (t) => traces.push(t) });
    await loaded();
    fireEvent.click(screen.getAllByTitle('Open source details')[0]);
    const dialog = screen.getByRole('dialog', { name: 'Source Details' });
    assert.ok(within(dialog).getByText('1 of 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    assert.ok(screen.getByText('2 of 2'));
    fireEvent.click(screen.getByRole('button', { name: '‹ Previous' }));
    assert.ok(screen.getByText('1 of 2'));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Open trace →' }));
    assert.deepEqual(traces, [TRACE]);
    assert.equal(screen.queryByRole('dialog'), null);
  });

  it('closes the modal when the rows it pointed at are gone', async () => {
    let items = WIRE;
    await mount({}, { logs: () => ({ items }) });
    await loaded();
    fireEvent.click(screen.getAllByTitle('Open source details')[1]);
    assert.ok(screen.getByText('2 of 2'));
    items = [WIRE[0]];
    fireEvent.click(screen.getByRole('button', { name: 'Re-run the query' }));
    // assert.ok, not assert.equal(el, null): a failing equal would util.inspect
    // a jsdom element on every poll, which takes seconds each time.
    await waitFor(() => assert.ok(!document.querySelector('[role="dialog"]')));
    assert.equal(rowsShown(), 1);
  });

  it('Search Around drops the filters and re-points at a window centred on the record', async () => {
    await mount();
    await loaded();
    fireEvent.change(editor(), { target: { value: "host='h1'" } });
    fireEvent.click(runBtn());
    await waitFor(() => assert.equal(lastTable(stub.calls).get('search'), 'h1'));
    fireEvent.click(screen.getAllByTitle('Open source details')[0]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Number of surrounding events' }), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search Around' }));
    assert.equal(screen.queryByRole('dialog'), null);
    assert.equal(editor().value, '');
    await waitFor(() => assert.equal(lastTable(stub.calls).get('size'), '100'));
    const t = lastTable(stub.calls);
    // 100 events → ±150 s around 10:00:00Z.
    assert.equal(t.get('startTime'), '2026-09-25T09:57:30.000Z');
    assert.equal(t.get('endTime'), '2026-09-25T10:02:30.000Z');
    assert.equal(t.get('search'), null);
  });

  it('Search Around ignores a record without a usable timestamp', async () => {
    await mount({}, { logs: () => ({ items: [{ body: 'no time' }] }) });
    await waitFor(() => assert.equal(rowsShown(), 1));
    const n = tableCalls(stub.calls).length;
    fireEvent.click(screen.getByTitle('Open source details'));
    fireEvent.click(screen.getByRole('button', { name: 'Search Around' }));
    assert.ok(screen.getByRole('dialog'));
    assert.equal(tableCalls(stub.calls).length, n);
  });

  it('a service prefill becomes a service_name clause and is consumed once', async () => {
    const consumed = [];
    await mount({ servicePrefill: 'orders', onServicePrefillConsumed: () => consumed.push(1) });
    await waitFor(() => assert.deepEqual(lastTable(stub.calls).getAll('serviceNames'), ['orders']));
    assert.equal(editor().value, "service_name='orders'");
    assert.equal(consumed.length, 1);
  });

  it('a trace prefill replaces the query with the trace id, leaving SQL mode', async () => {
    localStorage.setItem(`${LS}sql-mode:v1`, 'true');
    const consumed = [];
    await mount({ tracePrefill: TRACE, onTracePrefillConsumed: () => consumed.push(1) });
    await waitFor(() => assert.equal(lastTable(stub.calls).get('traceId'), TRACE));
    assert.equal(editor().value, TRACE);
    assert.equal(screen.getByRole('switch').getAttribute('aria-checked'), 'false');
    assert.equal(consumed.length, 1);
  });

  it('a filter prefill applies services, severity, trace and range as one question', async () => {
    const consumed = [];
    const range = { mode: 'relative', relative: '1h', from: '', to: '' };
    localStorage.setItem(`${LS}query:v1`, JSON.stringify("service_name='stale'"));
    await mount({
      filterPrefill: { services: ['orders'], severity: 'error', traceId: TRACE, range },
      onFilterPrefillConsumed: () => consumed.push(1),
    });
    await waitFor(() => assert.equal(lastTable(stub.calls).get('startTime'), 'now-1h'));
    const t = lastTable(stub.calls);
    assert.deepEqual(t.getAll('serviceNames'), ['orders']);
    assert.equal(t.get('severity'), 'ERROR');
    assert.equal(t.get('traceId'), TRACE);
    assert.equal(editor().value, `service_name='orders' AND severity='ERROR' AND trace_id='${TRACE}'`);
    assert.ok(screen.getByRole('button', { name: /Past 1 Hour/ }));
    assert.equal(consumed.length, 1);
  });

  it('a filter prefill without a range keeps the current one', async () => {
    await mount({ filterPrefill: { services: [] } });
    await waitFor(() => assert.ok(tableCalls(stub.calls).length >= 1));
    assert.equal(lastTable(stub.calls).get('startTime'), 'now-15m');
    assert.equal(editor().value, '');
  });

  it('the product tree ticks services and whole categories into the query', async () => {
    const navs = [];
    await mount({ onNavigate: (k) => navs.push(k) });
    await loaded();
    const apps = await screen.findByRole('button', { name: /Applications/ });
    fireEvent.click(apps);
    const orders = await waitFor(() => {
      const el = [...document.querySelectorAll('.pt-service')]
        .find((l) => l.querySelector('.pt-service-name').textContent === 'orders');
      assert.ok(el);
      assert.equal(el.querySelector('input').disabled, false);
      return el;
    });
    fireEvent.click(orders.querySelector('input'));
    assert.equal(editor().value, "service_name='orders'");
    await waitFor(() => assert.deepEqual(lastTable(stub.calls).getAll('serviceNames'), ['orders']));

    // Unticking removes it again.
    fireEvent.click(orders.querySelector('input'));
    assert.equal(editor().value, '');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all resources in Applications' }));
    // The catalog lists a category's resources alphabetically.
    assert.equal(editor().value, "service_name='billing' AND service_name='orders'");
    await waitFor(() => assert.deepEqual(lastTable(stub.calls).getAll('serviceNames'), ['billing', 'orders']));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Clear all resources in Applications' }));
    assert.equal(editor().value, '');
  });

  it('auto-refresh re-runs on its interval, skips a hidden tab, and catches up on return', async () => {
    await mount();
    await loaded();
    mock.timers.enable({ apis: ['setTimeout'] });
    // Picking an interval arms the (mocked) timer.
    fireEvent.click(screen.getByTitle('Auto-refresh is off'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '5 sec' }));
    const n = tableCalls(stub.calls).length;
    act(() => { mock.timers.tick(5000); });
    assert.equal(tableCalls(stub.calls).length, n + 1);

    // While that request is in flight a tick is deferred, not dropped.
    act(() => { mock.timers.tick(5000); });
    assert.equal(tableCalls(stub.calls).length, n + 1);

    // Hidden tab: the tick passes without a request.
    let isHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
    try {
      await act(async () => { await Promise.resolve(); });
      mock.timers.reset();
      await waitFor(() => assert.equal(runBtn().textContent, 'Run query'));
      mock.timers.enable({ apis: ['setTimeout'] });
      // Re-arm under the mocked clock by switching interval.
      fireEvent.click(screen.getByTitle(/Auto-refreshing every 5s/));
      fireEvent.click(screen.getByRole('menuitemradio', { name: '10 sec' }));
      const m = tableCalls(stub.calls).length;
      act(() => { mock.timers.tick(10_000); });
      assert.equal(tableCalls(stub.calls).length, m);
      // Coming back to the tab re-runs immediately.
      isHidden = false;
      act(() => { document.dispatchEvent(new window.Event('visibilitychange')); });
      assert.equal(tableCalls(stub.calls).length, m + 1);
    } finally {
      // Drop the own-property override; jsdom's prototype getter shows through again.
      delete document.hidden;
    }
  });
});
