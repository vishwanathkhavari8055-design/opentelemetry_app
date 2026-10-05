/**
 * Guards the Dynamic Text panel: its Handlebars template, the sandbox document
 * its author's script runs in, and the postMessage bridge that sandbox talks to.
 *
 * The template half fails quietly — a helper that renders nothing, a partial that
 * leaks, a defaultContent never shown — and so does the bridge: a frame message
 * accepted from the wrong window, a query answered into a document that has been
 * replaced, a script that starts before its answer, storage keys that collide
 * with the app's own. jsdom does not run the frame's scripts, so the frame's side
 * of each conversation is played here by dispatching the messages it would send
 * and recording what the panel posts back to it.
 */
import './grafanaEnv.mjs';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { stubFetch } from '../support/fetch.mjs';
import { processedFrames, capturing } from './grafanaEnv.mjs';

const React = (await import('react')).default;
const { render, cleanup, act, screen } = await import('@testing-library/react');
const { dynamicTextPanelPlugin, DYNAMIC_TEXT_PLUGIN_ID } = await import('../../src/grafana/panelDynamicText.jsx');
const { AWAITS_QUERY_OPTION } = await import('../../src/grafana/panelAnswer.js');
const { onDashboardNavigation } = await import('../../src/grafana/dashboardNavigation.js');
const { dateTime } = await import('@grafana/data');

const Panel = dynamicTextPanelPlugin.panel;
const CHANNEL = 'dynamic-text-panel';

const rowsFrame = (extra = {}) => ({
  refId: 'A',
  fields: [
    { name: 'svc', type: 'string', values: ['api', 'db'] },
    { name: 'errors', type: 'number', values: [3, 0] },
  ],
  ...extra,
});

const answer = (frames = [rowsFrame()], extra = {}) => ({
  state: 'Done', series: processedFrames(frames), request: {}, ...extra,
});

const element = (props) => React.createElement(Panel, {
  data: answer(), width: 300, height: 200, title: 'DT', options: {}, replaceVariables: (v) => v, ...props,
});

/** The rendered iframe, its srcdoc parsed, and everything the panel posts into it. */
function mount(props = {}) {
  const utils = render(element(props));
  const frame = utils.container.querySelector('iframe');
  const posted = [];
  if (frame?.contentWindow) {
    frame.contentWindow.postMessage = (message, origin) => posted.push({ message, origin });
  }
  return { ...utils, frame, posted, doc: () => parseDoc(frame) };
}

function parseDoc(frame) {
  const html = frame.getAttribute('srcdoc');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const blob = JSON.parse(doc.getElementById('dt-blob').textContent);
  const scripts = [...doc.querySelectorAll('script:not([type])')].map((s) => s.textContent);
  return { html, doc, blob, content: doc.getElementById('dt-content'), scripts };
}

/** Play the frame: send the panel a message as if from inside `frame`. */
function fromFrame(frame, data, source = frame.contentWindow) {
  act(() => {
    window.dispatchEvent(new window.MessageEvent('message', { data: { source: CHANNEL, ...data }, source }));
  });
}

const flush = () => act(() => new Promise((resolve) => { setTimeout(resolve, 0); }));

describe('dynamic text panel', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('is registered under the community plugin id', () => {
    assert.equal(DYNAMIC_TEXT_PLUGIN_ID, 'marcusolsson-dynamictext-panel');
  });

  describe('the template', () => {
    const renderTemplate = (content, props = {}) => mount({ ...props, options: { content, ...props.options } }).doc().content.innerHTML;

    it('renders once with the rows as `data` by default', () => {
      const html = renderTemplate('{{#each data}}<i>{{svc}}={{errors}}</i>{{/each}}');
      assert.equal(html, '<i>api=3</i><i>db=0</i>');
    });

    it('renders once per row in everyRow mode, the row at the top level', () => {
      const html = renderTemplate('<b>{{svc}}/{{len data}}</b>', { options: { renderMode: 'everyRow' } });
      assert.equal(html, '<b>api/2</b><b>db/2</b>');
    });

    it('shows defaultContent when the query returned no rows', () => {
      const html = renderTemplate('never', {
        data: answer([]), options: { defaultContent: '<em>nothing yet</em>' },
      });
      assert.equal(html, '<em>nothing yet</em>');
    });

    it('substitutes dashboard variables before compiling', () => {
      const html = renderTemplate('env=$env', { replaceVariables: (s) => s.replace('$env', 'prod') });
      assert.equal(html, 'env=prod');
      cleanup();
      const raw = renderTemplate('env=$env', { replaceVariables: () => { throw new Error('unresolvable'); } });
      assert.equal(raw, 'env=$env');
    });

    it('offers the plugin helper set', () => {
      const cases = [
        ['{{#if (eq 1 1)}}y{{/if}}{{#if (ne 1 2)}}y{{/if}}', 'yy'],
        ['{{#if (lt 1 2)}}a{{/if}}{{#if (lte 2 2)}}b{{/if}}{{#if (gt 3 2)}}c{{/if}}{{#if (gte 2 3)}}d{{/if}}', 'abc'],
        ['{{#if (and true 1)}}a{{/if}}{{#if (and true 0)}}b{{/if}}{{#if (or 0 1)}}c{{/if}}{{#if (not 0)}}d{{/if}}', 'acd'],
        ['{{add 2 3}} {{sub 5 2}} {{mul 2 4}} {{div 9 3}} [{{div 1 0}}] {{abs -4}} {{round 2.6}}', '5 3 8 3 [] 4 3'],
        ['{{toFixed 3.14159 2}} {{toFixed 2.5}} [{{toFixed "x" 2}}]', '3.14 3 []'],
        ['{{upper "ab"}} {{lower "CD"}} {{join (split "a-b-c" "-") "+"}} {{join (split "x,y")}} [{{join 5}}]', 'AB cd a+b+c x, y []'],
        ['{{#if (contains "haystack" "st")}}s{{/if}}{{#if (contains (split "a,b") "b")}}a{{/if}}', 'sa'],
        ['{{replace "a.b.c" "." "/"}} {{replace "a.b" "."}} {{replace "keep" 5}}', 'a/b/c ab keep'],
        ['{{default "" "fallback"}} {{default "set" "fallback"}}', 'fallback set'],
        ['{{len "abcd"}} {{len (split "a,b,c")}}', '4 3'],
      ];
      for (const [template, expected] of cases) {
        assert.equal(renderTemplate(template), expected, template);
        cleanup();
      }
    });

    it('encodes json so data cannot close the script element it is embedded in', () => {
      const { content, html } = mount({
        options: { content: '{{{json data}}}' },
        data: answer([{ fields: [{ name: 'v', type: 'string', values: ['</script><b>x'] }] }]),
      }).doc();
      const json = content.textContent;
      const LT = '\\u003c'; // the six characters JSON uses for "<"
      assert.equal(json, `[{"v":"${LT}/script>${LT}b>x"}]`);
      assert.equal(JSON.parse(json)[0].v, '</script><b>x');
      assert.equal(content.querySelector('b'), null, 'the value did not become markup');
      assert.equal(html.includes('</script><b>x'), false);
    });

    it('scopes partials to the panel that declares them', async () => {
      const html = renderTemplate('{{> row}}{{> row}}', {
        options: { contentPartials: [{ name: 'row', content: '<p>P</p>' }, { name: 'bad' }, null] },
      });
      assert.equal(html, '<p>P</p><p>P</p>');
      cleanup();
      let other;
      await capturing('error', () => { other = renderTemplate('{{> row}}'); });
      assert.match(other, /Template error: The partial row could not be found/);
    });

    it('shows a malformed template as its error, escaped', async () => {
      let html;
      const logged = await capturing('error', () => { html = renderTemplate('{{#each data}}<x>'); });
      assert.match(html, /^<div style="padding:12px;color:[^"]+">Template error: /);
      assert.doesNotMatch(html, /<x>/);
      assert.match(logged.join(), /dynamic text panel "DT" template failed/);
    });

    it('warns once per panel that its custom helpers are not run', async () => {
      const warned = await capturing('warn', () => {
        mount({ title: 'Helpers Panel', options: { content: 'x', helpers: 'handlebars.registerHelper()' } });
        cleanup();
        mount({ title: 'Helpers Panel', options: { content: 'x', helpers: 'again' } });
        cleanup();
        mount({ title: undefined, options: { content: 'x', helpers: '   ' } });
      });
      assert.equal(warned.length, 1);
      assert.match(warned[0], /"Helpers Panel" registers custom Handlebars helpers/);
    });
  });

  describe('the sandbox document', () => {
    it('is a sandboxed iframe with scripts and no same-origin', () => {
      const { frame } = mount({ title: 'Topology' });
      assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
      assert.equal(frame.getAttribute('title'), 'Topology content');
      assert.equal(frame.className, 'viz-dynamic-text');
      cleanup();
      assert.equal(mount({ title: '' }).frame.getAttribute('title'), 'Dynamic text panel content');
    });

    it('carries the frames per refId, raw and display names, and JSON-safe values', () => {
      const when = new Date(Date.UTC(2026, 0, 1));
      const frames = [
        rowsFrame(),
        { refId: 'B', name: 'second', fields: [{ name: 'n', type: 'number', values: [Number.NaN] }, { name: 'at', type: 'time', values: [when] }] },
      ];
      const series = processedFrames(frames);
      // A bigint survives only if the panel serialises it itself.
      series[0].fields[1].values = [10n, 0];
      const { blob } = mount({ data: { state: 'Done', series, request: {} } }).doc();
      assert.deepEqual(blob.series.map((s) => [s.refId, s.name, s.length]), [['A', undefined, 2], ['B', 'second', 1]]);
      assert.deepEqual(blob.series[0].fields.map((f) => [f.name, f.type, f.values]), [
        ['svc', 'string', ['api', 'db']], ['errors', 'number', ['10', 0]],
      ]);
      assert.deepEqual(blob.series[1].fields[0].values, [null]);
      assert.deepEqual(blob.series[1].fields[1].values, [when.valueOf()]);
      assert.deepEqual(blob.series[0].fields[0].config, {});
      // Rows are keyed by DISPLAY name (disambiguated across frames); scripts match the RAW one.
      assert.deepEqual(blob.columns.map((c) => c.name), ['svc', 'errors', 'second n', 'at']);
      assert.deepEqual([blob.series[1].fields[0].name, blob.series[1].fields[0].display], ['n', 'second n']);
      assert.equal(blob.channel, CHANNEL);
      assert.match(blob.doc, /^dtd-\d+$/);
      assert.equal(blob.state, 'Done');
    });

    it('skips empty frames and reads Vector-style values', () => {
      const vector = { length: 2, get: (i) => ['x', 'y'][i] };
      const { blob } = mount({
        data: { state: 'Done', request: {}, series: [{ fields: [] }, { fields: [{ name: 'k', type: 'string', values: vector }] }, { fields: [{ name: 'k2' }] }] },
      }).doc();
      assert.equal(blob.series.length, 2);
      assert.deepEqual(blob.series[0].fields[0].values, ['x', 'y']);
      assert.equal(blob.series[1].length, 0);
      assert.equal(blob.series[1].fields[0].type, 'string');
    });

    it('hands the script the time range as epoch ms plus the raw strings', () => {
      const from = dateTime(Date.UTC(2026, 0, 1));
      const to = dateTime(Date.UTC(2026, 0, 2));
      const { blob } = mount({
        timeZone: 'utc',
        data: answer(undefined, { timeRange: { from, to, raw: { from: 'now-1d', to: 'now' } } }),
      }).doc();
      assert.deepEqual(blob.timeRange, { from: from.valueOf(), to: to.valueOf(), raw: { from: 'now-1d', to: 'now' } });
      assert.equal(blob.timeZone, 'utc');
    });

    it("seeds its storage with this app's prefixed keys only", () => {
      window.localStorage.setItem('grafana-dt-panel/cols', '["a"]');
      window.localStorage.setItem('app-token', 'secret');
      const { blob } = mount().doc();
      assert.deepEqual(blob.storage, { cols: '["a"]' });
    });

    it('wraps the author script, escaping a closing script tag, and embeds styles safely', () => {
      const { doc } = mount({
        options: {
          content: 'x',
          afterRender: 'var s = "</script><img src=x>"; element.textContent = s;',
          styles: 'p { color: red } </style><script>alert(1)</script>',
          externalStyles: ['https://cdn.example/a.css', { url: 'http://cdn.example/b.css?x="y"' }, 'javascript:alert(1)', { url: 5 }],
          renderMode: 'allRows',
          wrap: true,
        },
      });
      const parsed = doc();
      const { html } = parsed;
      const last = parsed.scripts.at(-1);
      assert.match(last, /^window\.__dtRun = function \(\) \{/);
      assert.match(last, /<\\\/script><img src=x>/);
      assert.equal(parsed.doc.querySelectorAll('script').length, 3, 'blob, prelude, author script — nothing injected');
      const style = parsed.doc.querySelector('style').textContent;
      assert.match(style, /p \{ color: red \}/);
      assert.doesNotMatch(style, /<\/style/);
      const links = [...parsed.doc.querySelectorAll('link')].map((l) => l.getAttribute('href'));
      assert.deepEqual(links, ['https://cdn.example/a.css', 'http://cdn.example/b.css?x="y"']);
      assert.match(html, /href="http:\/\/cdn\.example\/b\.css\?x=&quot;y&quot;"/);
      assert.deepEqual(parsed.blob.options, { renderMode: 'allRows', wrap: true });
      assert.match(style, /color-scheme: dark/);
    });

    it('also accepts the script as options.code, and sends no script when there is none', () => {
      assert.match(mount({ options: { code: 'void 0;' } }).doc().scripts.at(-1), /void 0;/);
      cleanup();
      assert.equal(mount({ options: { afterRender: '   ' } }).doc().scripts.at(-1), '');
    });

    it('holds a queried panel\'s script until the query has answered, then keeps the answer through a reload', () => {
      const options = { content: '{{len data}}', defaultContent: 'waiting', afterRender: 'run();', [AWAITS_QUERY_OPTION]: true };
      const { rerender, container } = render(element({ options, data: { state: 'Done', series: [] } }));
      const current = () => parseDoc(container.querySelector('iframe'));
      assert.equal(current().content.innerHTML, 'waiting');
      assert.equal(current().scripts.at(-1), '', 'no script before the answer');

      rerender(element({ options, data: answer() }));
      assert.equal(current().content.innerHTML, '2');
      assert.match(current().scripts.at(-1), /run\(\);/);

      // A refresh in flight keeps the previous answer on screen.
      rerender(element({ options, data: { state: 'Loading', series: [] } }));
      assert.equal(current().content.innerHTML, '2');
    });

    it('shows a failed query as its error, not as an empty table', () => {
      mount({ data: { state: 'Error', error: { message: 'datasource down' }, series: [] } });
      assert.ok(screen.getByText('datasource down'));
      assert.equal(document.querySelector('iframe'), null);
    });
  });

  describe('the bridge', () => {
    it('answers ready with an init carrying shared globals and neighbours\' HTML', () => {
      const a = mount({ options: { content: '<span id="kpi">A</span>' } });
      const b = render(element({ options: { content: '<span>B</span>' } }));
      const bFrame = b.container.querySelector('iframe');
      const bPosted = [];
      bFrame.contentWindow.postMessage = (message) => bPosted.push(message);

      fromFrame(a.frame, { op: 'ready' });
      const init = a.posted.at(-1);
      assert.equal(init.origin, '*');
      assert.equal(init.message.op, 'init');
      assert.equal(init.message.source, CHANNEL);
      assert.deepEqual(init.message.values, {});
      assert.deepEqual(Object.values(init.message.foreign), ['<span>B</span>']);

      // A publishes a global: B hears about it, A does not hear its own echo.
      const before = a.posted.length;
      fromFrame(a.frame, { op: 'globals', values: { __afHtml: '"x"' } });
      assert.deepEqual(bPosted.at(-1), { op: 'globals', values: { __afHtml: '"x"' }, source: CHANNEL });
      assert.equal(a.posted.length, before);
      fromFrame(bFrame, { op: 'ready' });
      assert.deepEqual(bPosted.at(-1).values, { __afHtml: '"x"' });
      fromFrame(a.frame, { op: 'globals', values: 'not an object' });

      // A writes into its mirror of B: the write is replayed in B's frame.
      const bId = Object.keys(init.message.foreign)[0];
      fromFrame(a.frame, { op: 'dom', target: bId, ops: [{ index: 0, attr: 'class', value: 'hot' }] });
      assert.deepEqual(bPosted.at(-1), { op: 'dom-apply', ops: [{ index: 0, attr: 'class', value: 'hot' }], source: CHANNEL });
      const count = bPosted.length;
      fromFrame(a.frame, { op: 'dom', target: bId, ops: [] });
      fromFrame(a.frame, { op: 'dom', target: 'dtp-nobody', ops: [{}] });
      assert.equal(bPosted.length, count);
    });

    it('pushes a re-rendered panel\'s HTML to the neighbours that mirror it', () => {
      const a = mount({ options: { content: 'A' } });
      const props = { options: { content: 'B1' } };
      const b = render(element(props));
      assert.equal(a.posted.at(-1)?.message.op, 'foreign');
      assert.equal(a.posted.at(-1).message.html, 'B1');
      b.rerender(element({ options: { content: 'B2' } }));
      assert.equal(a.posted.at(-1).message.html, 'B2');
    });

    it('forgets shared globals once the last panel of a dashboard goes', () => {
      const a = mount();
      fromFrame(a.frame, { op: 'globals', values: { __k: '1' } });
      cleanup();
      const next = mount();
      fromFrame(next.frame, { op: 'ready' });
      assert.deepEqual(next.posted.at(-1).message.values, {});
    });

    it('ignores messages from any other window, or on any other channel', () => {
      const { frame, posted } = mount();
      fromFrame(frame, { op: 'ready' }, window);
      act(() => {
        window.dispatchEvent(new window.MessageEvent('message', { data: { op: 'ready', source: 'other' }, source: frame.contentWindow }));
        window.dispatchEvent(new window.MessageEvent('message', { data: null, source: frame.contentWindow }));
      });
      fromFrame(frame, { op: 'unknown-op' });
      assert.equal(posted.length, 0);
    });

    it('stores what the script saves under its own prefix, never over app keys', () => {
      window.localStorage.setItem('grafana-dt-panel/old', '1');
      window.localStorage.setItem('keep-me', 'app');
      const { frame } = mount();
      fromFrame(frame, { op: 'set', key: 'cols', value: 42 });
      assert.equal(window.localStorage.getItem('grafana-dt-panel/cols'), '42');
      fromFrame(frame, { op: 'set', key: 'empty' });
      assert.equal(window.localStorage.getItem('grafana-dt-panel/empty'), '');
      fromFrame(frame, { op: 'remove', key: 'cols' });
      assert.equal(window.localStorage.getItem('grafana-dt-panel/cols'), null);
      fromFrame(frame, { op: 'set', key: 7, value: 'no' });
      assert.equal(window.localStorage.getItem('grafana-dt-panel/7'), null);
      fromFrame(frame, { op: 'clear' });
      assert.equal(window.localStorage.getItem('grafana-dt-panel/old'), null);
      assert.equal(window.localStorage.getItem('keep-me'), 'app');
    });

    it('routes a drill-down to whoever is listening for dashboard navigation', () => {
      const seen = [];
      const off = onDashboardNavigation((target) => seen.push(target));
      try {
        const { frame } = mount();
        fromFrame(frame, { op: 'navigate', url: '/d/abc123/some-dash?from=now-1h' });
        assert.equal(seen.length, 1);
        assert.equal(seen[0].uid, 'abc123');
      } finally {
        off();
      }
    });

    describe('queries', () => {
      let fetchStub;
      afterEach(() => fetchStub?.restore());

      const queryResult = (posted) => posted.map((p) => p.message).filter((m) => m.op === 'query-result');

      it("runs a script's query through the app's own query path and answers it", async () => {
        fetchStub = stubFetch([[/\/dashboards\/query/, { results: { A: { frames: [] } } }]]);
        const m = mount();
        const docId = m.doc().blob.doc;
        fromFrame(m.frame, { op: 'query', id: 'q1', doc: docId, body: JSON.stringify({ queries: [{ refId: 'A' }] }) });
        await flush();
        assert.equal(fetchStub.calls.length, 1);
        assert.deepEqual(JSON.parse(fetchStub.calls[0].init.body), { queries: [{ refId: 'A' }] });
        assert.deepEqual(queryResult(m.posted), [{
          op: 'query-result', id: 'q1', ok: true, status: 200, body: { results: { A: { frames: [] } } }, source: CHANNEL,
        }]);
      });

      it('refuses a request with no JSON body, a bad one, or one too large — and still answers', async () => {
        fetchStub = stubFetch([[/\/dashboards\/query/, { results: {} }]]);
        const m = mount();
        const doc = m.doc().blob.doc;
        await capturing('warn', async () => {
          fromFrame(m.frame, { op: 'query', id: 'q1', doc });
          fromFrame(m.frame, { op: 'query', id: 'q2', doc, body: '{not json' });
          fromFrame(m.frame, { op: 'query', id: 'q3', doc, body: 'x'.repeat(1_000_001) });
          await flush();
        });
        const answers = queryResult(m.posted);
        assert.deepEqual(answers.map((a) => [a.id, a.ok, a.status]), [['q1', false, 400], ['q2', false, 400], ['q3', false, 400]]);
        assert.match(answers[0].body.message, /no JSON body/);
        assert.match(answers[2].body.message, /too large/);
        assert.deepEqual(answers[1].body.results, {});
        assert.equal(fetchStub.calls.length, 0);
      });

      it('answers a failed query with its status and empty results', async () => {
        fetchStub = stubFetch([[/\/dashboards\/query/, { status: 503, body: { message: 'grafana down' } }]]);
        const m = mount();
        const warned = await capturing('warn', async () => {
          fromFrame(m.frame, { op: 'query', id: 'q9', doc: m.doc().blob.doc, body: '{}' });
          await flush();
        });
        const [reply] = queryResult(m.posted);
        assert.deepEqual([reply.ok, reply.status, reply.body.results, reply.body.message], [false, 503, {}, 'grafana down']);
        assert.match(warned.join(), /query failed/);
      });

      it('ignores a query from a document that has been replaced', async () => {
        fetchStub = stubFetch([[/\/dashboards\/query/, { results: {} }]]);
        const m = mount();
        fromFrame(m.frame, { op: 'query', id: 'q1', doc: 'dtd-stale', body: '{}' });
        await flush();
        assert.equal(fetchStub.calls.length, 0);
        assert.deepEqual(queryResult(m.posted), []);
      });

      it('cancels an in-flight query when its document is replaced, and when the panel goes', async () => {
        const pending = [];
        fetchStub = stubFetch([[/\/dashboards\/query/, (url, init) => new Promise((resolve, reject) => {
          pending.push(init.signal);
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })]]);
        const m = mount({ options: { content: 'one' } });
        fromFrame(m.frame, { op: 'query', id: 'q1', doc: m.doc().blob.doc, body: '{}' });
        await flush();
        // New content means a new document: the old one's query is abandoned.
        m.rerender(element({ options: { content: 'two' } }));
        await flush();
        assert.equal(pending[0].aborted, true);

        fromFrame(m.frame, { op: 'query', id: 'q1', doc: parseDoc(m.frame).blob.doc, body: '{}' });
        await flush();
        m.unmount();
        await flush();
        assert.equal(pending[1].aborted, true);
        assert.deepEqual(queryResult(m.posted), [], 'nobody is answered after cancellation');
      });
    });
  });
});
