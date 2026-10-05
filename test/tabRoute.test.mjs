/**
 * Guards the URL fragment ↔ screen mapping.
 *
 * Every way of getting this wrong is quiet. Decide that a fragment names no
 * screen and the reload lands on Home, which is exactly the bug this replaced.
 * Decide that it names one when it does not, and the shell renders a blank
 * content column. Rebuild the fragment without carrying its query across and a
 * host that mounts this app behind a hash route loses the SSO context on the
 * next reload — a landing page that will not sign anyone in, with a URL that
 * looks right.
 *
 * None of those show up as an error; they show up as "the app went somewhere
 * else". So the shapes a fragment actually arrives in — hand-edited, pasted,
 * rewritten by a portal — are asserted here rather than tried in a browser.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TAB,
  hashForTab,
  isRoutableTab,
  tabFromHash,
  traceFromHash,
} from '../src/components/common/tabRoute.js';

/** A real W3C trace-context id — 32 hex characters. */
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('tabFromHash', () => {
  it('reads the canonical form this app writes', () => {
    assert.equal(tabFromHash('#/traces'), 'traces');
    assert.equal(tabFromHash('#/alerts'), 'alerts');
    assert.equal(tabFromHash('#/home'), 'home');
  });

  it('accepts the shapes a hand-edited or rewritten fragment arrives in', () => {
    // No slash, trailing slash, wrong case, stray whitespace — all the same screen.
    assert.equal(tabFromHash('#traces'), 'traces');
    assert.equal(tabFromHash('#/traces/'), 'traces');
    assert.equal(tabFromHash('#//traces'), 'traces');
    assert.equal(tabFromHash('#/TRACES'), 'traces');
    assert.equal(tabFromHash('#/%20metrics%20'), 'metrics');
    // Already stripped of its '#' by a caller reading it some other way.
    assert.equal(tabFromHash('/traces'), 'traces');
  });

  it('ignores the SSO query a host may have put in the fragment', () => {
    assert.equal(
      tabFromHash('#/metrics?role=administrator&tenantCode=Primary'),
      'metrics',
    );
  });

  it('reads only the first segment — the rest names a drill-down', () => {
    assert.equal(tabFromHash('#/iam/catalog'), 'iam');
    assert.equal(tabFromHash(`#/logs/trace/${TRACE}`), 'logs');
    assert.equal(tabFromHash(`#/traces/trace/${TRACE}`), 'traces');
  });

  it('resolves a GROUP to its first section, as the rail does', () => {
    // 'logs' is both the group and its first section today. Asserted so that
    // renaming the group cannot silently produce an empty content column.
    assert.equal(tabFromHash('#/logs'), 'logs');
  });

  it('routes every screen on the rail, including the placeholders', () => {
    // The placeholder tabs are real rail entries; a link to one must land on the
    // "not wired up yet" screen rather than bouncing to Home.
    ['home', 'logs', 'analytics', 'traces', 'metrics', 'aiops', 'rum',
      'dashboards', 'reports', 'alerts', 'iam'].forEach((key) => {
      assert.equal(tabFromHash(`#/${key}`), key, `${key} should be routable`);
    });
  });

  it('returns "" for a fragment naming nothing this app renders', () => {
    // '' and not 'home': the caller has to tell "the URL said nothing" from
    // "the URL said Home", because the host page may own the fragment.
    assert.equal(tabFromHash(''), '');
    assert.equal(tabFromHash('#'), '');
    assert.equal(tabFromHash('#/'), '');
    assert.equal(tabFromHash('#/catalog'), '');   // moved inside Settings
    assert.equal(tabFromHash('#/nonsense'), '');
    assert.equal(tabFromHash('#/%E0%A4%A'), '');  // malformed escape
    assert.equal(tabFromHash('#?role=administrator'), '');
    assert.equal(tabFromHash(undefined), '');
  });
});

describe('traceFromHash', () => {
  it('reads the open trace on either screen that has one', () => {
    assert.equal(traceFromHash(`#/logs/trace/${TRACE}`), TRACE);
    assert.equal(traceFromHash(`#/traces/trace/${TRACE}`), TRACE);
  });

  it('survives the same rewrites the tab does', () => {
    assert.equal(traceFromHash(`#logs/trace/${TRACE}`), TRACE);
    assert.equal(traceFromHash(`#/logs/trace/${TRACE}/`), TRACE);
    assert.equal(traceFromHash(`#/logs/TRACE/${TRACE}`), TRACE);
    assert.equal(traceFromHash(`#/logs/trace/${TRACE}?role=administrator`), TRACE);
  });

  it('does not lower-case the id — only the route words are case-free', () => {
    // Trace ids are opaque to this app. Folding their case would turn a valid id
    // into one the spans endpoint has never seen, and the screen would render a
    // perfectly calm "No spans found for this trace."
    assert.equal(traceFromHash('#/logs/trace/AbCdEf01'), 'AbCdEf01');
  });

  it('returns "" when the fragment names no trace', () => {
    assert.equal(traceFromHash('#/logs'), '');
    assert.equal(traceFromHash('#/traces'), '');
    assert.equal(traceFromHash(''), '');
    assert.equal(traceFromHash('#/iam/catalog'), '');   // a section, not a trace
    assert.equal(traceFromHash('#/logs/trace'), '');    // the word with no id
    assert.equal(traceFromHash('#/logs/trace/'), '');
  });

  it('refuses an id that is not one opaque token', () => {
    // Everything here would be forwarded to the spans endpoint. None of it is a
    // trace id, and a fragment is the one input a stranger can hand the user.
    assert.equal(traceFromHash('#/logs/trace/a%2Fb'), '');          // a slash, escaped
    assert.equal(traceFromHash('#/logs/trace/a%20b'), '');          // a space
    assert.equal(traceFromHash('#/logs/trace/%E0%A4%A'), '');       // malformed escape
    assert.equal(traceFromHash(`#/logs/trace/${'f'.repeat(129)}`), '');
  });
});

describe('hashForTab', () => {
  it('writes the canonical form', () => {
    assert.equal(hashForTab('traces'), '#/traces');
    assert.equal(hashForTab('iam', ''), '#/iam');
  });

  it('carries the fragment query across — that is the SSO context', () => {
    assert.equal(
      hashForTab('metrics', '#/logs?role=administrator&tenantCode=Primary'),
      '#/metrics?role=administrator&tenantCode=Primary',
    );
    assert.equal(hashForTab('logs', '#?refKey=qgit6fmspn7ebu'), '#/logs?refKey=qgit6fmspn7ebu');
  });

  it('writes the open trace, and omits it when there is none', () => {
    assert.equal(hashForTab('logs', '', TRACE), `#/logs/trace/${TRACE}`);
    assert.equal(hashForTab('traces', '', TRACE), `#/traces/trace/${TRACE}`);
    assert.equal(hashForTab('logs', '', ''), '#/logs');
    assert.equal(hashForTab('logs', '', null), '#/logs');
  });

  it('puts the drill-down BEFORE the query, so both still parse', () => {
    assert.equal(
      hashForTab('logs', '#/traces?role=administrator', TRACE),
      `#/logs/trace/${TRACE}?role=administrator`,
    );
  });

  it('refuses to write an id it would not read back', () => {
    // A fragment that cannot round-trip is worse than none: it survives in a
    // pasted link and fails silently on someone else's screen.
    assert.equal(hashForTab('logs', '', 'a/b'), '#/logs');
    assert.equal(hashForTab('logs', '', 'a b'), '#/logs');
  });

  it('round-trips an open trace on both screens', () => {
    ['logs', 'traces'].forEach((key) => {
      const hash = hashForTab(key, '#?role=admin', TRACE);
      assert.equal(tabFromHash(hash), key);
      assert.equal(traceFromHash(hash), TRACE);
    });
  });

  it('round-trips with tabFromHash for every routable screen', () => {
    ['home', 'logs', 'analytics', 'traces', 'metrics', 'aiops', 'rum',
      'dashboards', 'reports', 'alerts', 'iam'].forEach((key) => {
      assert.equal(tabFromHash(hashForTab(key)), key);
      // And with a query riding along, which is the case that actually breaks.
      assert.equal(tabFromHash(hashForTab(key, '#?role=admin')), key);
    });
  });
});

describe('isRoutableTab', () => {
  it('answers for sections and groups alike, and rejects the rest', () => {
    assert.equal(isRoutableTab('traces'), true);   // a section
    assert.equal(isRoutableTab('logs'), true);     // a group
    assert.equal(isRoutableTab('reports'), true);  // a placeholder
    assert.equal(isRoutableTab('catalog'), false);
    assert.equal(isRoutableTab(''), false);
    assert.equal(isRoutableTab(undefined), false);
  });
});

describe('DEFAULT_TAB', () => {
  it('is Home — the cold-start landing page, unchanged', () => {
    assert.equal(DEFAULT_TAB, 'home');
    assert.equal(tabFromHash('') || DEFAULT_TAB, 'home');
  });
});
