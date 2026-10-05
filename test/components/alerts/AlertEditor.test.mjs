/**
 * AlertEditor is the one-screen create/edit form for an OpenObserve alert.
 * Guarded here, through the rendered form and the requests it sends:
 *  - editing MERGES the form into the server's document, so keys this form
 *    does not model (anomaly_config and friends) survive a save, and the PUT
 *    goes to the alert's own id and folder;
 *  - a new alert is POSTed with what the user actually picked (stream, query
 *    type, destinations, priority, tags, state);
 *  - nothing is sent while the form is invalid, and the user is told which
 *    field is wrong; backend rejections are shown verbatim;
 *  - the tabs follow the alert's kind (no Compare tab for realtime, Compare is
 *    explained rather than hidden for a non-SQL scheduled alert), and each
 *    tab's controls reach the Summary and the saved document;
 *  - side flows: inline folder creation, destination refresh / Add
 *    Destination, and the logs-only Preview sample.
 */
import '../../support/dom.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from '../../support/fetch.mjs';

const React = (await import('react')).default;
const { render, screen, fireEvent, within, cleanup, configure } = await import('@testing-library/react');

// A failed query's error would otherwise carry a pretty-print of the whole
// editor, which costs far more than the query itself on a tree this size.
configure({ getElementError: (message) => new Error(message) });
const { default: AlertEditor } = await import('../../../src/components/alerts/AlertEditor.jsx');

const FOLDERS = [
  { folderId: 'default', name: 'default' },
  { folderId: 'f-ops', name: 'Ops' },
];
const DESTS = { items: [{ name: 'oncall', type: 'email' }, { name: 'hook', type: 'http' }] };

const isGet = (init) => !init.method || init.method === 'GET';

/** The backend every editor test needs, plus per-test overrides first. */
const baseRoutes = (extra = []) => [
  ...extra,
  [/\/alerts\/destinations/, DESTS],
  [/\/alerts\/templates/, { items: [{ name: 'tpl_email' }] }],
  [/\/alerts\/streams\/[^/]+\/fields/, { items: ['level', 'host_name'] }],
  [/\/alerts\/streams\?/, { items: ['default', 'app'] }],
];

let restore = () => {};
const setup = ({ routes = [], props = {} } = {}) => {
  const stub = stubFetch(baseRoutes(routes));
  restore = stub.restore;
  const closed = [];
  const saved = [];
  const utils = render(React.createElement(AlertEditor, {
    folders: FOLDERS,
    onClose: () => closed.push(true),
    onSaved: (m) => saved.push(m),
    ...props,
  }));
  return { ...stub, ...utils, closed, saved };
};

/** A document with every modelled section filled, plus one key the form ignores. */
const richDoc = (over = {}) => ({
  name: 'high_errors',
  description: 'desc',
  stream_type: 'logs',
  stream_name: 'default',
  is_real_time: false,
  enabled: true,
  anomaly_config: { keep: 'me' },
  query_condition: {
    type: 'sql',
    sql: 'SELECT count(*) FROM "default"',
    conditions: { and: [] },
    multi_time_range: [{ offSet: '1h', uuid: 'u1' }],
  },
  trigger_condition: {
    period: 15, operator: '>=', threshold: 5, frequency: 2, frequency_type: 'minutes',
    silence: 20, timezone: 'UTC', align_time: true, warning_threshold: 2,
  },
  destinations: ['oncall', 'gone_dest'],
  template: 'deleted_tpl',
  priority: 2,
  tags: ['prod'],
  deduplication: { fingerprint_fields: ['host_name'], time_window_minutes: 5 },
  context_attributes: { team: 'sre' },
  row_template: '',
  ...over,
});

const editRoutes = (doc, extra = []) => [
  [(u, i) => /\/alerts\/a1$/.test(u) && isGet(i), { alert: doc, alertId: 'a1', folderId: 'f-ops' }],
  ...extra,
];

/* Role queries over this editor's large tree are slow enough in jsdom to
   dominate the run (and to exhaust memory when one fails and pretty-prints the
   DOM), so buttons, tabs and listboxes are found by accessible name directly. */
const nameOf = (el) => (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/g, ' ').trim();
const matches = (el, name) => (name instanceof RegExp ? name.test(nameOf(el)) : nameOf(el) === name);
const findAll = (sel, name, root = document) => [...root.querySelectorAll(sel)].filter((el) => matches(el, name));
const find = (sel, what) => (name, root) => {
  const hits = findAll(sel, name, root);
  if (hits.length !== 1) throw new Error(`expected one ${what} named ${name}, found ${hits.length}`);
  return hits[0];
};
const btn = find('button, [role=button]', 'button');
const qbtn = (name, root) => findAll('button, [role=button]', name, root)[0] ?? null;
const tabEl = find('[role=tab]', 'tab');
const qtabEl = (name) => findAll('[role=tab]', name)[0] ?? null;
const listbox = (label) => {
  const el = document.querySelector(`[role=listbox][aria-label="${label}"], [role=menu][aria-label="${label}"]`);
  if (!el) throw new Error(`no listbox ${label}`);
  return el;
};

const tab = (name) => fireEvent.click(tabEl(new RegExp(name)));
const saveBtn = () => btn('Save');
const summary = () => document.querySelector('.ae-summary');
const summaryText = () => summary()?.textContent || '';
const pickSearchable = async (label, option) => {
  fireEvent.click(btn(label));
  const list = await settle(() => listbox(label));
  fireEvent.click(await settle(() => within(list).getByRole('option', { name: option })));
};
const toggleDestination = (label) => {
  fireEvent.click(btn('Destinations'));
  const list = listbox('Destinations');
  fireEvent.click(within(list).getByLabelText(new RegExp(label)));
  fireEvent.click(btn('Destinations'));
};
/**
 * Retry `fn` until it stops throwing, then return its result.
 *
 * Used instead of Testing Library's waitFor: on timeout waitFor pretty-prints
 * the whole document into the error, and this editor's tree is large enough
 * that doing so stalls the run for minutes and can exhaust the heap. Failing
 * with the assertion's own message is both faster and more useful.
 */
const settle = async (fn, ms = 1500) => {
  const end = Date.now() + ms;
  for (;;) {
    try { return fn(); } catch (err) {
      if (Date.now() > end) throw err;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
};
const until = (ok, ms) => settle(() => assert.ok(ok(), 'condition not met in time'), ms);
const sentBody = (calls, method) => JSON.parse(calls.find((c) => c.init.method === method).init.body);

describe('AlertEditor — create', () => {
  afterEach(() => { cleanup(); restore(); });

  it('starts empty, and refuses to save an invalid form without sending anything', async () => {
    const { calls, saved } = setup();
    screen.getByText('Configure your alert to see a summary');
    screen.getByText('Select a stream type and stream name to see a preview');
    screen.getByText('Add Alert in');
    assert.deepEqual([...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.replace(/\*|\d/g, '')),
      ['Alert Rules', 'Compare with Past', 'Deduplication', 'Advanced']);
    fireEvent.click(saveBtn());
    screen.getByText('Fix the highlighted fields before saving.');
    screen.getByText('Alert name is required.');
    screen.getByText('Stream name is required.');
    screen.getByText('Add at least one condition.');
    screen.getByText(/field\(s\) need attention/);
    fireEvent.click(btn('Dismiss'));
    assert.equal(screen.queryByText('Fix the highlighted fields before saving.'), null);
    await settle(() => assert.ok(calls.some((c) => /destinations/.test(c.url))));
    assert.equal(calls.filter((c) => c.init.method === 'POST').length, 0);
    assert.deepEqual(saved, []);
  });

  it('POSTs a new SQL alert with what the user picked', async () => {
    const { calls, saved } = setup({
      routes: [[(u, i) => /\/alerts$/.test(u) && i.method === 'POST', { ok: true }]],
      props: { initialFolderId: 'f-ops' },
    });
    fireEvent.change(screen.getByLabelText('Alert name'), { target: { value: 'errors_5xx' } });
    await pickSearchable('Stream name', 'app');
    await settle(() => assert.ok(calls.some((c) => /streams\/app\/fields/.test(c.url))));
    fireEvent.change(screen.getByLabelText('Query type'), { target: { value: 'sql' } });
    fireEvent.change(document.getElementById('ae-sql'), { target: { value: 'SELECT count(*) AS total FROM "app"' } });
    await settle(() => btn('Destinations'));
    toggleDestination('oncall — email');
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '1' } });
    const tags = screen.getByLabelText('Tags');
    fireEvent.change(tags, { target: { value: 'Prod' } });
    fireEvent.keyDown(tags, { key: 'Enter' });
    fireEvent.click(btn(/Enabled/));
    screen.getByText('Disabled');
    fireEvent.change(screen.getByLabelText('Look back window'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Threshold'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Threshold operator'), { target: { value: '>' } });
    fireEvent.change(screen.getByLabelText('Cooldown period'), { target: { value: '15' } });

    const s = summaryText();
    for (const part of ['errors_5xx', 'app (logs)', 'Ops', 'SELECT count(*) AS total FROM "app"',
      '30 mins', 'every 5 mins', 'events > 7', '15 mins', 'oncall', 'P1', 'prod', 'Disabled (will not evaluate)']) {
      assert.ok(s.includes(part), `summary shows ${part}: ${s}`);
    }

    fireEvent.click(saveBtn());
    await settle(() => assert.deepEqual(saved, [{ message: 'Alert “errors_5xx” created.' }]));
    const body = sentBody(calls, 'POST');
    assert.equal(body.folderId, 'f-ops');
    assert.equal(body.alert.name, 'errors_5xx');
    assert.equal(body.alert.stream_name, 'app');
    assert.equal(body.alert.enabled, false);
    assert.equal(body.alert.query_condition.type, 'sql');
    assert.equal(body.alert.query_condition.sql, 'SELECT count(*) AS total FROM "app"');
    assert.deepEqual(body.alert.destinations, ['oncall']);
    assert.deepEqual(body.alert.tags, ['prod']);
    assert.equal(Number(body.alert.priority), 1);
    assert.equal(body.alert.trigger_condition.period, 30);
    assert.equal(body.alert.trigger_condition.threshold, 7);
    assert.equal(body.alert.trigger_condition.operator, '>');
  });

  it("shows the backend's rejection and lets the user retry", async () => {
    const { saved } = setup({
      routes: [
        editRoutes(richDoc())[0],
        [(u, i) => /\/alerts\/a1$/.test(u) && i.method === 'PUT', { status: 400, body: { error: 'Invalid cron expression' } }],
      ],
      props: { alertId: 'a1' },
    });
    await settle(() => screen.getByDisplayValue('high_errors'));
    fireEvent.click(saveBtn());
    await settle(() => screen.getByText('Invalid cron expression'));
    assert.equal(saveBtn().disabled, false);
    assert.deepEqual(saved, []);
  });

  it('switches stream type, clearing the stream, and says previews are logs-only', async () => {
    const { calls } = setup();
    await pickSearchable('Stream name', 'default');
    await settle(() => screen.getByText('Run a sample to see recent rows from this stream.'));
    fireEvent.change(screen.getByLabelText('Stream type'), { target: { value: 'metrics' } });
    await settle(() => assert.ok(calls.some((c) => /streams\?type=metrics/.test(c.url))));
    assert.match(btn('Stream name').textContent, /Select…/);
    await pickSearchable('Stream name', 'app');
    screen.getByText(/Preview is available for logs streams only — metrics/);
  });

  it('runs a preview sample of recent log rows', async () => {
    let answer = { items: [{ id: 'r1', '@timestamp': '2026-09-25T10:00:00Z', 'service.name': 'checkout', severity_text: 'error', body: 'boom' }] };
    const { calls } = setup({ routes: [[/\/logs\?/, () => answer]] });
    await pickSearchable('Stream name', 'default');
    fireEvent.click(btn('Run sample'));
    await settle(() => screen.getByText('Showing 1 recent row(s).'));
    const row = screen.getByText('checkout').closest('tr');
    assert.ok(within(row).getByText('ERROR'));
    assert.ok(within(row).getByText('boom'));
    assert.match(calls.find((c) => /\/logs\?/.test(c.url)).url, /size=10/);
    answer = { items: [] };
    fireEvent.click(btn('Run sample'));
    await settle(() => screen.getByText('No rows in the last hour.'));
    answer = { status: 500, body: {} };
    const orig = console.error;
    console.error = () => {};
    try {
      fireEvent.click(btn('Run sample'));
      await settle(() => screen.getByText(/HTTP error! status: 500/));
    } finally { console.error = orig; }
  });

  it('realtime drops the Compare tab and the schedule rows', async () => {
    setup();
    tab('Compare with Past');
    screen.getByText('Comparison windows need a SQL alert.');
    fireEvent.change(screen.getByLabelText('Alert type'), { target: { value: 'realtime' } });
    await settle(() => assert.equal(qtabEl(/Compare/), null));
    assert.equal(tabEl(/Alert Rules/).getAttribute('aria-selected'), 'true');
    screen.getByText(/Evaluated against every row as it is ingested/);
    screen.getByText(/No window, cadence or threshold for a realtime alert/);
    assert.equal(screen.queryByLabelText('Look back window'), null);
    assert.equal(qbtn('+ Add warning'), null);
  });

  it('validates a cron schedule and shows it in the summary', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Alert name'), { target: { value: 'c' } });
    fireEvent.change(screen.getByLabelText('Schedule type'), { target: { value: 'cron' } });
    fireEvent.click(saveBtn());
    screen.getByText('A cron expression is required.');
    assert.match(summaryText(), /cron \(not set\)/);
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '*/5 * * * *' } });
    assert.match(summaryText(), /cron: \*\/5 \* \* \* \*/);
    fireEvent.change(screen.getByLabelText('Look back window'), { target: { value: '0' } });
    screen.getByText('Look back window must be at least 1 minute.');
    fireEvent.change(screen.getByLabelText('Schedule type'), { target: { value: 'minutes' } });
    fireEvent.change(screen.getByLabelText('Frequency'), { target: { value: '0' } });
    screen.getByText('Frequency must be at least 1 minute.');
    fireEvent.change(screen.getByLabelText('Cooldown period'), { target: { value: '-1' } });
    screen.getByText('Cooldown period cannot be negative.');
    fireEvent.change(screen.getByLabelText('Alert name'), { target: { value: 'bad name' } });
    screen.getByText(/no spaces/);
  });

  it('adds and removes a warning tier on the event threshold', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Alert name'), { target: { value: 'w' } });
    fireEvent.click(btn('+ Add warning'));
    const warn = screen.getByLabelText('Warning threshold');
    fireEvent.change(warn, { target: { value: '9' } });
    screen.getByText(/Warning \(9\) must be lower than critical \(3\)/);
    fireEvent.change(warn, { target: { value: '1' } });
    assert.match(summaryText(), /Warning at>= 1/);
    fireEvent.click(btn('Remove warning'));
    assert.equal(screen.queryByLabelText('Warning threshold'), null);
    assert.doesNotMatch(summaryText(), /Warning at/);
  });

  it('PromQL: threshold, per-series toggle and warning', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Alert name'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Query type'), { target: { value: 'promql' } });
    fireEvent.click(saveBtn());
    screen.getByText('PromQL query is required for a PromQL alert.');
    fireEvent.change(document.getElementById('ae-promql'), { target: { value: 'up == 0' } });
    fireEvent.change(screen.getByLabelText('PromQL threshold value'), { target: { value: '' } });
    screen.getByText('A value to compare the expression against is required.');
    fireEvent.change(screen.getByLabelText('PromQL threshold value'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('PromQL threshold operator'), { target: { value: '>' } });
    screen.getByText('Having series');
    fireEvent.change(screen.getByLabelText('Threshold'), { target: { value: '4' } });
    const toggle = btn(/Single/);
    fireEvent.click(toggle);
    screen.getByText('Each series alerts, recovers and notifies on its own.');
    assert.equal(screen.getByLabelText('Threshold').value, '1');
    assert.equal(screen.getByLabelText('Threshold operator').value, '>=');
    fireEvent.click(btn('+ Add warning'));
    fireEvent.change(screen.getByLabelText('Warning threshold'), { target: { value: 'x' } });
    const s = summaryText();
    assert.ok(s.includes('up == 0'), s);
    assert.ok(s.includes('value > 5'), s);
    assert.ok(s.includes('Each series on its own'), s);
    fireEvent.click(btn(/Per series/));
    screen.getByText('Every series collapses into one state and one notification.');
  });

  it('custom conditions: free-text column when the stream reports no schema', async () => {
    const { calls } = setup({ routes: [[/\/alerts\/streams\/[^/]+\/fields/, { items: [] }]] });
    await pickSearchable('Stream name', 'default');
    await settle(() => assert.ok(calls.some((c) => /fields/.test(c.url))));
    screen.getByText(/No schema reported for “default”/);
    fireEvent.change(screen.getByLabelText('Column'), { target: { value: 'level' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'error' } });
    assert.match(summaryText(), /1 condition\(s\)/);
    assert.equal(screen.queryByText('Add at least one condition.'), null);
  });

  it('creates a folder inline and selects it', async () => {
    const { calls } = setup({
      routes: [
        [(u, i) => /\/alerts\/folders$/.test(u) && i.method === 'POST', { folderId: 'f-new' }],
        [/\/alerts\/folders$/, { items: [...FOLDERS, { folderId: 'f-new', name: 'Payments' }] }],
      ],
    });
    fireEvent.click(btn('New folder'));
    fireEvent.click(btn('Add'));   // empty: ignored
    const input = screen.getByLabelText('New folder name');
    fireEvent.change(input, { target: { value: 'Payments' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(() => assert.match(btn('Folder').textContent, /Payments/));
    assert.deepEqual(sentBody(calls, 'POST'), { name: 'Payments', description: '' });
    assert.equal(screen.queryByLabelText('New folder name'), null);
    // Picking another folder from the list.
    await pickSearchable('Folder', 'Ops');
    assert.match(btn('Folder').textContent, /Ops/);
  });

  it('reports a folder that could not be created; Cancel abandons the input', async () => {
    setup({ routes: [[/\/alerts\/folders$/, { status: 409, body: { error: 'exists' } }]] });
    fireEvent.click(btn('New folder'));
    fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Ops' } });
    fireEvent.click(btn('Add'));
    await settle(() => screen.getByText('Could not create folder — exists'));
    const cancels = findAll('button', 'Cancel');
    fireEvent.click(cancels[0]);
    assert.equal(screen.queryByLabelText('New folder name'), null);
  });

  it('refreshes destinations and adds one created in the dialog to the selection', async () => {
    let dests = DESTS;
    const { calls } = setup({
      routes: [
        [(u, i) => /\/alerts\/destinations$/.test(u) && i.method === 'POST', { ok: true }],
        [(u, i) => /\/alerts\/destinations$/.test(u) && isGet(i), () => dests],
      ],
    });
    await settle(() => assert.equal(calls.filter((c) => /destinations/.test(c.url)).length, 1));
    dests = { items: [...DESTS.items, { name: 'pager' }] };
    fireEvent.click(btn('Refresh destinations'));
    await settle(() => assert.equal(calls.filter((c) => /destinations/.test(c.url)).length, 2));
    await settle(() => assert.equal(btn('Refresh destinations').disabled, false));

    fireEvent.click(btn('Add Destination'));
    const dialog = document.querySelector('dialog');
    fireEvent.click(btn('Cancel', dialog));
    assert.equal(document.querySelector('dialog'), null);

    fireEvent.click(btn('Add Destination'));
    await settle(() => assert.ok(document.querySelector('#dest-template option[value="tpl_email"]')));
    fireEvent.change(document.getElementById('dest-name'), { target: { value: 'newdest' } });
    fireEvent.change(document.getElementById('dest-emails'), { target: { value: 'a@x.com' } });
    fireEvent.change(document.getElementById('dest-template'), { target: { value: 'tpl_email' } });
    fireEvent.click(btn('Save', document.querySelector('dialog')));
    await until(() => !document.querySelector('dialog'));
    await until(() => calls.filter((c) => /destinations$/.test(c.url) && isGet(c.init)).length === 3);
    // Selected even though the refreshed list does not (yet) carry it.
    assert.match(btn('Destinations').textContent, /^newdest \(missing\)/);
  });

  it('keeps working, and says so, when templates and destinations cannot load', async () => {
    const orig = console.error;
    const logged = [];
    console.error = (...a) => { if (/unavailable/.test(String(a[0]))) logged.push(a[0]); };
    try {
      setup({
        routes: [
          [/\/alerts\/destinations/, { status: 500, body: {} }],
          [/\/alerts\/templates/, { status: 500, body: {} }],
          [/\/alerts\/streams\?/, { status: 500, body: {} }],
        ],
      });
      await settle(() => assert.deepEqual(logged.sort(),
        ['Destinations unavailable:', 'Stream list unavailable:', 'Templates unavailable:']));
      fireEvent.click(btn('Refresh destinations'));
      await settle(() => assert.equal(logged.filter((m) => /Destinations/.test(m)).length, 2));
      tab('Advanced');
      screen.getByText('No templates available');
    } finally { console.error = orig; }
  });

  it('Back and Cancel both close', () => {
    const { closed } = setup();
    fireEvent.click(btn('Back to alerts'));
    fireEvent.click(btn('Cancel'));
    assert.equal(closed.length, 2);
  });
});

describe('AlertEditor — edit', () => {
  afterEach(() => { cleanup(); restore(); });

  it('loads the document, and a save PUTs it back with unmodelled keys intact', async () => {
    const { calls, saved } = setup({
      routes: editRoutes(richDoc(), [
        [(u, i) => /\/alerts\/a1$/.test(u) && i.method === 'PUT', { message: 'Server says updated' }],
      ]),
      props: { alertId: 'a1' },
    });
    screen.getByText('Loading alert…');
    await settle(() => screen.getByDisplayValue('high_errors'));
    screen.getByText('Edit Alert in');
    screen.getByText('Editing an existing alert — unmodelled fields are preserved.');
    assert.match(btn('Folder').textContent, /Ops/);
    assert.match(btn('Destinations').textContent, /2 destinations/);
    // Badges: one comparison window, one dedup field.
    assert.match(tabEl(/Compare/).textContent, /1$/);
    assert.match(tabEl(/Deduplication/).textContent, /1$/);
    const s = summaryText();
    for (const part of ['high_errors', 'Scheduled', 'default (logs)', 'Ops', '15 mins', 'every 2 mins',
      'events >= 5', 'Warning at>= 2', '1 Hour ago', '20 mins', 'by host_name within 5 mins',
      'oncall, gone_dest', 'deleted_tpl', 'P2', 'prod', 'Enabled']) {
      assert.ok(s.includes(part), `summary shows ${part}: ${s}`);
    }
    fireEvent.change(screen.getByLabelText('Alert name'), { target: { value: 'high_errors_v2' } });
    fireEvent.click(saveBtn());
    await settle(() => assert.deepEqual(saved, [{ message: 'Server says updated' }]));
    const put = calls.find((c) => c.init.method === 'PUT');
    assert.match(put.url, /\/alerts\/a1$/);
    const body = JSON.parse(put.init.body);
    assert.equal(body.folderId, 'f-ops');
    assert.equal(body.alert.name, 'high_errors_v2');
    assert.deepEqual(body.alert.anomaly_config, { keep: 'me' });
    assert.deepEqual(body.alert.destinations, ['oncall', 'gone_dest']);
    assert.equal(body.alert.template, 'deleted_tpl');
    assert.equal(body.alert.query_condition.multi_time_range[0].offSet, '1h');
  });

  it('flags a destination that no longer exists as missing', async () => {
    setup({ routes: editRoutes(richDoc()), props: { alertId: 'a1' } });
    await settle(() => screen.getByDisplayValue('high_errors'));
    fireEvent.click(btn('Destinations'));
    const list = listbox('Destinations');
    await settle(() => within(list).getByText(/oncall — email/));
    within(list).getByText('gone_dest (missing)');
    assert.ok(document.body.innerHTML.length > 0);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('uses the default confirmation when the server sends no message', async () => {
    const { saved } = setup({
      routes: editRoutes(richDoc(), [[(u, i) => i.method === 'PUT', { status: 204, body: null }]]),
      props: { alertId: 'a1' },
    });
    await settle(() => screen.getByDisplayValue('high_errors'));
    fireEvent.click(saveBtn());
    await settle(() => assert.deepEqual(saved, [{ message: 'Alert “high_errors” updated.' }]));
  });

  it('shows why an alert could not be loaded', async () => {
    const { closed } = setup({
      routes: [[/\/alerts\/a1$/, { status: 404, body: { error: 'Alert a1 not found' } }]],
      props: { alertId: 'a1' },
    });
    await settle(() => screen.getByText('Alert a1 not found'));
    fireEvent.click(btn('Back to alerts'));
    assert.equal(closed.length, 1);
  });

  it('treats an empty document as not found', async () => {
    setup({ routes: [[/\/alerts\/a1$/, { alert: null }]], props: { alertId: 'a1' } });
    await settle(() => screen.getByText('Alert not found, or the backend returned no document.'));
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('Compare with Past: blocked for non-SQL with a removal warning, editable for SQL', async () => {
    setup({
      routes: editRoutes(richDoc({
        query_condition: {
          type: 'custom', conditions: { and: [{ column: 'level', operator: '=', value: 'error' }] },
          multi_time_range: [{ offSet: '2d' }],
        },
      })),
      props: { alertId: 'a1' },
    });
    await settle(() => screen.getByDisplayValue('high_errors'));
    tab('Compare with Past');
    screen.getByText('Comparison windows need a SQL alert.');
    screen.getByText(/This alert has 1 comparison window/);
    screen.getByText(/will remove it\./);
    fireEvent.click(saveBtn());
    tab('Alert Rules');
    fireEvent.change(screen.getByLabelText('Query type'), { target: { value: 'sql' } });
    fireEvent.change(document.getElementById('ae-sql'), { target: { value: 'SELECT 1' } });
    tab('Compare with Past');
    screen.getByText(/Running for 15 mins, every 2 mins/);
    screen.getByText('Reference Window 1');
    screen.getByText(/previous 2 Days\./);
    fireEvent.click(btn('+ Add Comparison Window'));
    screen.getByText('Reference Window 2');
    fireEvent.change(screen.getByLabelText('Offset amount for reference window 2'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Offset unit for reference window 2'), { target: { value: 'w' } });
    screen.getByText(/previous 1 Week\./);
    assert.match(summaryText(), /2 Days, 1 Week ago/);
    fireEvent.change(screen.getByLabelText('Offset amount for reference window 2'), { target: { value: '0' } });
    screen.getByText('Every comparison window needs a positive offset.');
    fireEvent.click(btn('Remove reference window 2'));
    fireEvent.click(btn('Remove reference window 1'));
    screen.getByText(/No comparison windows/);
    fireEvent.change(screen.getByLabelText('Alert type'), { target: { value: 'scheduled' } });
  });

  it('Compare with Past explains a cron cadence', async () => {
    setup({
      routes: editRoutes(richDoc({
        trigger_condition: { period: 5, frequency_type: 'cron', cron: '0 * * * *', silence: 1 },
      })),
      props: { alertId: 'a1' },
    });
    await settle(() => screen.getByDisplayValue('high_errors'));
    tab('Compare with Past');
    screen.getByText(/every cron: 0 \* \* \* \*/);
    tab('Deduplication');
    screen.getByText(/Empty matches the check interval\./);
    assert.ok(document.body.innerHTML.length > 0);
  });

  it('Deduplication: fields and window reach the summary and the save', async () => {
    const { calls } = setup({
      routes: editRoutes(richDoc({ deduplication: undefined }), [
        [(u, i) => i.method === 'PUT', { ok: true }],
      ]),
      props: { alertId: 'a1' },
    });
    await settle(() => screen.getByDisplayValue('high_errors'));
    assert.doesNotMatch(summaryText(), /Deduplicates/);
    tab('Deduplication');
    screen.getByText(/Empty matches the check interval \(2 mins\)\./);
    const fields = screen.getByLabelText('Deduplication fields');
    fireEvent.change(fields, { target: { value: 'service_name' } });
    fireEvent.keyDown(fields, { key: 'Enter' });
    assert.match(summaryText(), /by service_name within the check interval/);
    fireEvent.click(btn('Remove service_name'));
    fireEvent.change(screen.getByLabelText('Deduplication time window'), { target: { value: '-3' } });
    screen.getByText('Deduplication window must be a non-negative number of minutes.');
    fireEvent.change(screen.getByLabelText('Deduplication time window'), { target: { value: '10' } });
    assert.match(summaryText(), /by auto-detected fields within 10 mins/);
    fireEvent.change(fields, { target: { value: 'host_name' } });
    fireEvent.keyDown(fields, { key: ',' });
    fireEvent.click(saveBtn());
    await settle(() => assert.ok(calls.some((c) => c.init.method === 'PUT')));
    const dedup = sentBody(calls, 'PUT').alert.deduplication;
    assert.deepEqual(dedup.fingerprint_fields, ['host_name']);
    assert.equal(Number(dedup.time_window_minutes), 10);
  });

  it('Advanced: aggregation per group, template, variables and text fields reach the save', async () => {
    const { calls } = setup({
      routes: editRoutes(richDoc({
        query_condition: { type: 'custom', conditions: { and: [{ column: 'level', operator: '=', value: 'error' }] } },
        trigger_condition: { period: 10, operator: '>=', threshold: 3, frequency: 1, silence: 10 },
      }), [[(u, i) => i.method === 'PUT', { ok: true }]]),
      props: { alertId: 'a1' },
    });
    await settle(() => screen.getByDisplayValue('high_errors'));
    tab('Advanced');
    const override = screen.getByLabelText('Template override');
    assert.ok(within(override).getByRole('option', { name: 'deleted_tpl (missing)' }));
    fireEvent.change(override, { target: { value: 'tpl_email' } });

    fireEvent.click(btn(/^Off/));
    fireEvent.click(saveBtn());
    screen.getByText('Threshold for the aggregation is required.');
    fireEvent.change(screen.getByLabelText('Aggregation function'), { target: { value: 'avg' } });
    fireEvent.change(screen.getByLabelText('Having operator'), { target: { value: '>' } });
    fireEvent.change(screen.getByLabelText('Having value'), { target: { value: '100' } });
    fireEvent.click(btn('+ Add warning'));
    fireEvent.change(screen.getByLabelText('Warning threshold'), { target: { value: '50' } });
    fireEvent.click(btn(/Simple alert/));
    screen.getByText('Add at least one Group By column to alert per group.');
    fireEvent.change(screen.getByLabelText('Group by columns'), { target: { value: 'host_name' } });
    screen.getByText('Each group alerts, recovers and notifies on its own.');

    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'Asia/Kolkata' } });
    fireEvent.click(screen.getByText('Align time').closest('.ae-row').querySelector('button'));

    // Variables: existing one edited, a half row blocks the save, then removed.
    fireEvent.change(screen.getByLabelText('Value for team'), { target: { value: 'platform' } });
    fireEvent.click(btn('+ Add variable'));
    const names = screen.getAllByLabelText('Variable name');
    fireEvent.change(names[1], { target: { value: 'region' } });
    screen.getByText(/Every variable needs both a name and a value/);
    fireEvent.click(btn('Remove variable region'));

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'pages SRE' } });
    fireEvent.change(screen.getByLabelText('VRL function'), { target: { value: '.x = 1' } });
    assert.equal(screen.queryByLabelText('Row template type'), null);
    fireEvent.change(screen.getByLabelText('Row template'), { target: { value: '{host_name}' } });
    screen.getByText('Rows are joined into one text block.');
    fireEvent.change(screen.getByLabelText('Row template type'), { target: { value: 'json' } });
    screen.getByText('Rows are emitted as a JSON array.');

    tab('Alert Rules');
    screen.getByText('Having groups');
    assert.equal(screen.getByLabelText('Threshold').value, '1');
    const s = summaryText();
    assert.ok(s.includes('avg > 100'), s);
    assert.ok(s.includes('Warning at> 50'), s);
    assert.ok(s.includes('Each group on its own'), s);
    assert.ok(s.includes('tpl_email'), s);

    // Per-group alerting cannot be combined with incident creation.
    fireEvent.click(screen.getByText('Creates Incident').closest('.ae-row').querySelector('button'));
    tab('Advanced');
    screen.getByText('Per-group alerting cannot yet be combined with incident creation.');
    tab('Alert Rules');
    fireEvent.click(screen.getByText('Creates Incident').closest('.ae-row').querySelector('button'));

    fireEvent.click(saveBtn());
    await settle(() => assert.ok(calls.some((c) => c.init.method === 'PUT')));
    const { alert } = sentBody(calls, 'PUT');
    assert.equal(alert.query_condition.aggregation.function, 'avg');
    assert.deepEqual(alert.query_condition.aggregation.group_by, ['host_name']);
    assert.equal(alert.query_condition.aggregation.multi_alert, true);
    assert.equal(alert.template, 'tpl_email');
    assert.deepEqual(alert.context_attributes, { team: 'platform' });
    assert.equal(alert.description, 'pages SRE');
    assert.equal(alert.row_template, '{host_name}');
    assert.equal(alert.row_template_type, 'json');
    assert.equal(alert.trigger_condition.timezone, 'Asia/Kolkata');
    assert.equal(alert.trigger_condition.align_time, false);
    assert.ok(alert.query_condition.vrl_function, 'VRL is stored (encoded)');

    // Turning aggregation back off restores the event-count wording.
    tab('Advanced');
    fireEvent.click(btn(/^On/));
    tab('Alert Rules');
    screen.getByText('Critical if');
  });

  it('aggregation without group-by counts events', async () => {
    setup({
      routes: editRoutes(richDoc({
        query_condition: {
          type: 'custom', conditions: { and: [{ column: 'level', operator: '=', value: 'e' }] },
          aggregation: { function: 'count', having: { column: 'count', operator: '>=', value: 3 }, group_by: [] },
        },
      })),
      props: { alertId: 'a1' },
    });
    await settle(() => screen.getByDisplayValue('high_errors'));
    screen.getByText('Critical if');
    assert.match(summaryText(), /count >= 3/);
  });
});
