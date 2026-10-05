/**
 * Syntax-checks the JavaScript this application generates for a dynamic text
 * panel's sandbox.
 *
 * ─── Why a test and not the build ───────────────────────────────────────────
 *
 * That code lives inside a template literal, so the bundler parses it as a
 * STRING. Nothing parses the JavaScript in it until a browser does, inside an
 * iframe, and a syntax error there fails in the worst possible way: the
 * `<script>` never runs, so the panel renders its template and then simply sits
 * there — no data, no drill-down, no error. Exactly what a panel with no data
 * looks like.
 *
 * So the prelude is extracted from the source and handed to `new Function`,
 * which parses without executing. Cheap, and it catches the one class of
 * mistake the rest of the toolchain cannot see.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DASHBOARD_PATH_PATTERN } from '../src/grafana/dashboardNavigation.js';

const SOURCE = readFileSync(
  new URL('../src/grafana/panelDynamicText.jsx', import.meta.url),
  'utf8',
);

/**
 * Pull one template-literal constant out of the module and evaluate it, so the
 * test sees the same string the browser is served — interpolations included.
 */
function evaluateTemplate(name) {
  const opening = `const ${name} = \``;
  const start = SOURCE.indexOf(opening);
  assert.notEqual(start, -1, `${name} was not found — has it been renamed?`);
  const from = start + opening.length;
  const end = SOURCE.indexOf('\n`;', from);
  assert.notEqual(end, -1, `${name} has no closing backtick`);

  // The only interpolation the prelude makes. Passed in rather than inlined so
  // a change to the pattern is reflected here automatically.
  return new Function(
    'DASHBOARD_PATH_PATTERN',
    `return \`${SOURCE.slice(from, end)}\`;`,
  )(DASHBOARD_PATH_PATTERN);
}

describe('the sandbox prelude', () => {
  const prelude = evaluateTemplate('SANDBOX_PRELUDE');

  it('parses as JavaScript', () => {
    assert.doesNotThrow(() => new Function(prelude));
  });

  it('interpolates a real regular expression, not the string "undefined"', () => {
    // A renamed import would leave `/undefined/` here — which parses, matches
    // nothing, and silently turns every drill-down into a no-op.
    const match = /var DASHBOARD_PATH = \/(.+)\/;/.exec(prelude);
    assert.ok(match, 'the prelude no longer declares DASHBOARD_PATH');
    assert.equal(match[1], DASHBOARD_PATH_PATTERN.source);
    assert.ok(new RegExp(match[1]).test('/d/afint-cc'));
  });

  it('bridges the query endpoint the panels actually call', () => {
    const match = /var QUERY_ENDPOINT = \/(.+)\/;/.exec(prelude);
    assert.ok(match, 'the prelude no longer declares QUERY_ENDPOINT');
    const pattern = new RegExp(match[1]);
    // What a panel's afterRender writes, verbatim.
    assert.ok(pattern.test('/api/ds/query'));
    assert.ok(pattern.test('/api/ds/query?ds_type=prometheus'));
    // And nothing else, so every other fetch is left to the browser.
    assert.ok(!pattern.test('/api/ds/query/extra'));
    assert.ok(!pattern.test('https://elsewhere.example.com/data.json'));
  });

  it('asks the parent for the dashboard\'s shared globals once it is listening', () => {
    // The `ready` handshake is what lets a panel that reloaded on a data
    // refresh pick up a `__` global the OWNING panel set before it reloaded.
    // Without it that panel waits for a change that already happened.
    const readyAt = prelude.indexOf("post({ op: 'ready' })");
    const listenerAt = prelude.indexOf("window.addEventListener('message'");
    assert.notEqual(readyAt, -1, 'the ready handshake is gone');
    assert.notEqual(listenerAt, -1, 'the message listener is gone');
    assert.ok(listenerAt < readyAt, 'ready must be posted AFTER the listener is installed');
  });
});

/**
 * What a panel's script is handed.
 *
 * This is the plugin's API surface, and getting it wrong is silent in the same
 * way everything else here is: the panel renders its template, its script reads
 * a property that is not there, gives up on its first few lines, and leaves a
 * complete set of tiles reading "--" over queries that all returned data.
 */
describe('the data a panel script receives', () => {
  const prelude = evaluateTemplate('SANDBOX_PRELUDE');

  it('exposes the result under BOTH names the plugin uses', () => {
    // Scripts on these dashboards read `context.panelData`; the plugin also
    // spells it `context.data`. Neither is optional — a panel picks one and has
    // no fallback if it is missing.
    assert.match(prelude, /^\s*data: panelData,$/m,
      'context.data is gone');
    assert.match(prelude, /^\s*panelData: panelData,$/m,
      'context.panelData is gone — a script that reads it will find nothing');
  });

  it('gives the script the panel\'s own element', () => {
    // `context.element || document` is how nearly every one of these scripts
    // starts. Without `element` every such panel silently widens its own
    // selectors to the whole document.
    assert.match(prelude, /^\s*element: element,$/m, 'context.element is gone');
    assert.match(prelude, /var element = document\.getElementById\('dt-content'\);/,
      'context.element is no longer the panel content element');
  });

  it('keeps one frame per query rather than flattening them', () => {
    // The scripts look a query up by refId (`F.find(f => f.refId === 'B')`).
    // One flattened frame cannot answer that, and a synthesised frame carries
    // no refId at all — which is exactly what left the KPI row empty.
    assert.match(prelude, /series: series,/,
      'panelData.series is no longer the frames as they arrived');
    assert.ok(!/series: \[dataFrame\]/.test(prelude),
      'panelData.series must not be a single synthesised frame');
    assert.match(prelude, /var dataFrame = series\[0\]/,
      'the "current" data frame should be the first real frame');
  });

  it('rebuilds template rows from the frames, keyed by display name', () => {
    // Values cross the wire once. Rows are keyed by `display` (what the
    // dashboard shows, which is what a template is written against) while a
    // script matches on the raw `name` — see framesToPayload.
    assert.match(prelude, /row\[fields\[k\]\.display\] = fields\[k\]\.values\[i\];/,
      'rows are no longer rebuilt from the frames by display name');
    assert.ok(!/Array\.isArray\(blob\.data\)/.test(prelude),
      'the prelude should no longer expect a pre-flattened blob.data');
  });
});

/**
 * The cross-panel DOM bridge.
 *
 * Every assertion here guards something whose absence is INVISIBLE at runtime: a
 * panel reaching into its neighbour just stops finding it, renders its own half
 * of the screen perfectly, and drops everything it was supposed to tell the
 * other panel. That is what the OSS Engine Overview dashboard looked like before
 * this existed — a KPI row with no alert count and no severity colours, and an
 * Alerts panel next to it that never filled in.
 *
 * These are static checks. The behaviour itself needs two frames and a real
 * MutationObserver, which is a browser; what a test without one can do is make
 * sure none of the moving parts has been quietly removed or reordered.
 */
describe('the cross-panel DOM bridge', () => {
  const prelude = evaluateTemplate('SANDBOX_PRELUDE');

  it('searches this panel\'s own content before any neighbour\'s', () => {
    // The ordering is the whole safety property: a selector that resolves
    // inside the panel must behave exactly as it did before mirrors existed.
    for (const method of ['querySelector', 'querySelectorAll', 'getElementById']) {
      const at = prelude.indexOf(`document.${method} = function`);
      assert.notEqual(at, -1, `document.${method} is no longer extended`);
      const body = prelude.slice(at, prelude.indexOf('\n  };', at));
      const realAt = body.search(/real(Query|QueryAll|ById)\(/);
      const mirrorAt = body.indexOf('mirrorRoots()');
      assert.notEqual(realAt, -1, `${method} no longer consults the real document`);
      assert.notEqual(mirrorAt, -1, `${method} no longer consults the mirrors`);
      assert.ok(realAt < mirrorAt,
        `${method} must try this panel's own document FIRST`);
    }
  });

  it('indexes its own nodes before the panel script can rewrite them', () => {
    // Addresses are element references captured up front. Taken later, they
    // would be indices into a DOM the panel's own script had already changed,
    // and a neighbour's write would land on the wrong element.
    const indexAt = prelude.indexOf('var ownNodes = indexNodes(');
    const runAt = prelude.indexOf('window.__dtRun');
    assert.notEqual(indexAt, -1, 'the own-node index is gone');
    assert.notEqual(runAt, -1, 'the panel script is no longer invoked by the prelude');
    assert.ok(indexAt < runAt, 'nodes must be indexed before the panel script runs');
  });

  it('holds the panel script until the mirrors are in place', () => {
    // `document.querySelector('#their-id')` has to answer on the FIRST call —
    // there is nothing in the plugin's API for a script to await. So the script
    // runs on `init`, not on load.
    assert.match(prelude, /if \(message\.op === 'init'\)|message\.op === 'init'/,
      'the init handshake is gone');
    const initAt = prelude.indexOf("message.op === 'init'");
    const startAt = prelude.indexOf('startPanelScript();', initAt);
    assert.notEqual(startAt, -1, 'init no longer starts the panel script');
    const installAt = prelude.indexOf('installMirror(panelId, foreign[panelId])', initAt);
    assert.notEqual(installAt, -1, 'init no longer installs the mirrors');
    assert.ok(installAt < startAt,
      'the mirrors must be installed BEFORE the panel script is started');
  });

  it('starts the panel script anyway if the host never answers', () => {
    // Late is the failure mode to have here. "Never runs" would turn a host
    // that dropped one message into a permanently blank panel.
    assert.match(prelude, /var startFallback = setTimeout\(startPanelScript, \d+\);/,
      'the fallback that starts an unanswered panel is gone');
  });

  it('runs the panel script exactly once', () => {
    // `init` can arrive after the fallback has already fired — on a slow first
    // paint, or if the parent answers late. Running twice would double every
    // query the script makes and re-enter panels that are not idempotent.
    const at = prelude.indexOf('function startPanelScript()');
    assert.notEqual(at, -1, 'startPanelScript is gone');
    const body = prelude.slice(at, at + 400);
    assert.ok(/if \(panelStarted\) return;/.test(body),
      'startPanelScript no longer guards against running twice');
    assert.ok(/panelStarted = true;/.test(body),
      'startPanelScript no longer records that it has run');
  });

  it('sends narrow writes, never a wholesale subtree replacement', () => {
    // An op that replaced a neighbour's subtree would undo whatever that
    // panel's OWN script had put there — the two write to the same row.
    assert.match(prelude, /kind: 'attr'/, 'the attribute op is gone');
    assert.match(prelude, /kind: 'html'/, 'the innerHTML op is gone');
    // And applying them touches only the addressed element.
    const at = prelude.indexOf('function applyDomOps');
    assert.notEqual(at, -1, 'applyDomOps is gone');
    const body = prelude.slice(at, prelude.indexOf('\n  }', at));
    assert.ok(/el\.setAttribute\(/.test(body) && /el\.removeAttribute\(/.test(body),
      'applyDomOps no longer applies attribute writes');
    assert.ok(/el\.innerHTML = /.test(body),
      'applyDomOps no longer applies content writes');
    assert.ok(!/\.outerHTML/.test(body),
      'applyDomOps must not replace an element wholesale');
  });

  it('keeps a neighbour\'s stylesheet out of this panel\'s document', () => {
    // Each of these panels ships its own `<style>` block, and they are not
    // written to coexist. A mirror in the light DOM would apply a neighbour's
    // CSS to this panel.
    const at = prelude.indexOf('function installMirror');
    assert.notEqual(at, -1, 'installMirror is gone');
    const body = prelude.slice(at, prelude.indexOf('\n  }', at));
    assert.match(body, /attachShadow/, 'the mirror is no longer inside a shadow root');
    assert.match(body, /host\.style\.display = 'none'/, 'the mirror host is no longer hidden');
  });

  it('re-seeds a mirror when the panel it mirrors re-renders', () => {
    // An address is an index into the mirrored HTML. A mirror left holding the
    // previous render resolves index N to the wrong element — which is worse
    // than resolving it to none, because the write still lands.
    assert.match(prelude, /message\.op === 'foreign'/,
      'a panel can no longer be told that a neighbour re-rendered');
  });
});

/**
 * The time range a panel script receives.
 *
 * Executed, not pattern-matched: the failure here was a value of the wrong TYPE
 * that still looked right. `timeRange.to` arrived as a date string, so the
 * topology script's `timeRange.to.valueOf()` produced the date text, which went
 * into its SQL as `start_time`; OpenObserve answered 400 and the whole severity
 * pass (CRIT/WARN badges, the Alerts list, the KPI alert count) was skipped.
 */
describe('the time range a panel script receives', () => {
  const prelude = evaluateTemplate('SANDBOX_PRELUDE');

  /** Run the prelude's time-range block against a blob, return what it built. */
  function buildFrom(blob) {
    const start = prelude.indexOf('function momentLike(');
    const end = prelude.indexOf('var element = ');
    assert.ok(start > -1 && end > start, 'the time-range block has moved');
    return new Function('blob', 'series',
      `${prelude.slice(start, end)}\nreturn { timeRange: timeRange, panelData: panelData, replaceVariables: replaceVariables };`,
    )(blob, []);
  }

  const FROM = 1790140000000;
  const TO = 1790140900000;

  it('gives from/to a valueOf() that is epoch milliseconds, as Moment does', () => {
    const { timeRange, panelData } = buildFrom({ timeRange: { from: FROM, to: TO, raw: { from: 'now-15m', to: 'now' } } });
    assert.equal(timeRange.from.valueOf(), FROM);
    assert.equal(timeRange.to.valueOf(), TO);
    // What the topology script does with it: arithmetic and String().
    assert.equal(String(timeRange.to.valueOf()), String(TO));
    assert.equal(timeRange.to - timeRange.from, TO - FROM);
    assert.equal(timeRange.from.toISOString(), new Date(FROM).toISOString());
    assert.equal(timeRange.raw.from, 'now-15m');
    assert.equal(panelData.timeRange, timeRange);
  });

  it('is absent rather than NaN when the host sent no usable range', () => {
    // A NaN crosses JSON as null; the script's own fallback (Date.now()) must win.
    assert.equal(buildFrom({}).timeRange, undefined);
    assert.equal(buildFrom({ timeRange: { from: null, to: null } }).timeRange, undefined);
  });

  it('resolves the time-range variables a script passes to replaceVariables', () => {
    const { replaceVariables } = buildFrom({ timeRange: { from: FROM, to: TO } });
    assert.equal(replaceVariables('${__from}000-${__to}000'), `${FROM}000-${TO}000`);
    assert.equal(replaceVariables('$__from..$__to'), `${FROM}..${TO}`);
    assert.equal(replaceVariables('$service'), '$service');
  });
});

describe('stale documents', () => {
  const prelude = evaluateTemplate('SANDBOX_PRELUDE');

  it('tags every message with the document that sent it', () => {
    // The iframe element outlives a srcDoc change, so this tag is the only way
    // the host can tell a query from the replaced document — and query ids
    // restart at q1 in every document, so an untagged late answer would resolve
    // the NEW document's q1 with the old one's data.
    assert.match(prelude, /message\.doc = blob\.doc;/,
      'messages no longer say which document sent them');
  });
});
