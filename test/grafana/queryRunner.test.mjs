/**
 * Guards dashboard-variable interpolation for panel queries
 * (src/grafana/queryRunner.js).
 *
 * Scenes hands raw targets to the datasource, so without this a query written as
 * `up{host=~"$host"}` reaches Prometheus with the literal "$host" and the panel
 * quietly shows no data. Pinned here, against a real scene:
 *  - every string of a target is interpolated, except identifier keys
 *    (datasource, refId, …), and a string without `$` is untouched;
 *  - a multi-value variable renders as PromQL's `(a|b)` alternation with
 *    Grafana's exact regex escaping, not Scenes' `{a,b}` glob;
 *  - `$__interval` reflects the re-floored step from `minIntervalTiers`, so the
 *    query's range window and its evaluation step agree;
 *  - one target that cannot be interpolated costs that request nothing worse
 *    than its raw targets — never an exception out of the runner.
 *
 * @grafana/ui (pulled in by @grafana/scenes) require()s a stylesheet from CJS,
 * which the ESM hooks in test/support cannot stub, so `.css` is stubbed for
 * require() below before the module loads.
 */

import Module from 'node:module';

import '../support/dom.mjs';

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

Module._extensions['.css'] = (module) => { module.exports = {}; };

const S = await import('@grafana/scenes');
const {
  InterpolatingQueryRunner, PROM_LIKE, interpolateDeep, prometheusFormat,
} = await import('../../src/grafana/queryRunner.js');
const { PROM_MIN_INTERVAL_TIERS } = await import('../../src/grafana/minInterval.js');

const PROM_DS = {
  uid: 'prom', type: 'prometheus', meta: {},
  getRef() { return { uid: 'prom', type: 'prometheus' }; },
};

/** A runner inside a scene with `$host` (multi) and `$env` (constant). */
function sceneWith(runnerState, { from = 'now-6h', to = 'now' } = {}) {
  const timeRange = new S.SceneTimeRange({ from, to });
  const runner = new InterpolatingQueryRunner(runnerState);
  new S.EmbeddedScene({
    $timeRange: timeRange,
    $variables: new S.SceneVariableSet({
      variables: [
        new S.CustomVariable({ name: 'host', query: 'a.b,c', value: ['a.b', 'c'], text: ['a.b', 'c'], isMulti: true }),
        new S.ConstantVariable({ name: 'env', value: 'prod' }),
      ],
    }),
    $data: runner,
    body: new S.SceneFlexLayout({ children: [] }),
  });
  return { runner, timeRange };
}

describe('PROM_LIKE', () => {
  it('names the Prometheus-compatible datasource types', () => {
    for (const type of ['prometheus', 'mimir', 'thanos', 'grafana-amazonprometheus-datasource']) {
      assert.ok(PROM_LIKE.has(type), type);
    }
    assert.equal(PROM_LIKE.has('loki'), false);
  });
});

describe('prometheusFormat', () => {
  it('escapes backslashes and quotes for a single-value variable', () => {
    assert.equal(prometheusFormat("a\\b'c", { multi: false }), "a\\\\b\\'c");
    assert.equal(prometheusFormat('x.y', undefined), 'x.y', 'no regex escaping for a plain value');
    assert.equal(prometheusFormat(5, {}), 5);
  });

  it('regex-escapes a multi or include-all string value', () => {
    assert.equal(prometheusFormat('a.b', { multi: true }), 'a\\\\.b');
    assert.equal(prometheusFormat('$^*{}[]\'+?.()|', { includeAll: true }),
      '\\\\$\\\\^\\\\*\\\\{\\\\}\\\\[\\\\]\\\\\'\\\\+\\\\?\\\\.\\\\(\\\\)\\\\|');
    assert.equal(prometheusFormat('a\\b', { multi: true }), 'a\\\\\\\\b');
  });

  it('joins several values as (a|b) and leaves a single one bare', () => {
    assert.equal(prometheusFormat(['a', 'b.c'], { multi: true }), '(a|b\\\\.c)');
    assert.equal(prometheusFormat(['only'], { multi: true }), 'only');
  });

  it('passes a non-string, non-array multi value through', () => {
    assert.equal(prometheusFormat(7, { multi: true }), 7);
  });
});

describe('interpolateDeep', () => {
  const { runner } = sceneWith({ queries: [] });

  it('interpolates every string, recursing into arrays and objects', () => {
    const out = interpolateDeep(runner, {
      expr: 'up{env="$env"}', alias: '[[env]]', nested: [{ q: '$env' }, 'x'], n: 3, flag: true, none: null,
    }, {});
    assert.deepEqual(out, {
      expr: 'up{env="prod"}', alias: 'prod', nested: [{ q: 'prod' }, 'x'], n: 3, flag: true, none: null,
    });
  });

  it('never touches identifier keys', () => {
    const target = {
      datasource: '$env', refId: '$env', key: '$env', hide: '$env', intervalMs: '$env', maxDataPoints: '$env',
    };
    assert.deepEqual(interpolateDeep(runner, target, {}), target);
  });

  it('returns a string with no variable reference unchanged', () => {
    assert.equal(interpolateDeep(runner, 'plain text', {}), 'plain text');
  });

  it('prefers scoped vars and applies the given format', () => {
    assert.equal(interpolateDeep(runner, '$env', { env: { text: 'X', value: 'X' } }), 'X');
    assert.equal(interpolateDeep(runner, 'host=~"$host"', {}, prometheusFormat), 'host=~"(a\\\\.b|c)"');
  });

  it('stops descending past eight levels instead of recursing forever', () => {
    const cyclic = { expr: '$env' };
    cyclic.self = cyclic;
    const out = interpolateDeep(runner, cyclic, {});
    assert.equal(out.expr, 'prod');
    let level = out;
    for (let i = 0; i < 9; i++) level = level.self;
    assert.equal(level.expr, '$env', 'the level past the depth limit is returned raw');
  });
});

describe('InterpolatingQueryRunner.prepareRequests', () => {
  const query = {
    refId: 'A', datasource: { uid: 'prom', type: 'prometheus' },
    expr: 'rate(up{host=~"$host",env="$env"}[$__interval])', legendFormat: '{{host}}',
  };

  it('interpolates Prometheus targets with alternation, leaving state raw', () => {
    const { runner, timeRange } = sceneWith({ queries: [query], maxDataPoints: 1000 });
    const { primary } = runner.prepareRequests(timeRange, PROM_DS);
    assert.equal(primary.targets[0].expr, 'rate(up{host=~"(a\\\\.b|c)",env="prod"}[20s])');
    assert.equal(primary.targets[0].legendFormat, '{{host}}');
    assert.equal(runner.state.queries[0].expr, query.expr, 'state keeps the raw query');
  });

  it('uses Scenes\' default formatting for a non-Prometheus datasource', () => {
    const { runner, timeRange } = sceneWith({
      queries: [{ refId: 'A', datasource: { uid: 'es', type: 'elasticsearch' }, query: 'host:$env' }],
    });
    const es = { uid: 'es', type: 'elasticsearch', meta: {}, getRef: () => ({ uid: 'es', type: 'elasticsearch' }) };
    const { primary } = runner.prepareRequests(timeRange, es);
    assert.equal(primary.targets[0].query, 'host:prod');
  });

  it('re-floors the step from minIntervalTiers before interpolating $__interval', () => {
    const { runner, timeRange } = sceneWith({
      queries: [query], maxDataPoints: 1000, minIntervalTiers: PROM_MIN_INTERVAL_TIERS,
    });
    const { primary } = runner.prepareRequests(timeRange, PROM_DS);
    assert.equal(primary.interval, '1m');
    assert.equal(primary.intervalMs, 60000);
    assert.deepEqual(primary.scopedVars.__interval, { text: '1m', value: '1m' });
    assert.deepEqual(primary.scopedVars.__interval_ms, { text: '60000', value: 60000 });
    assert.match(primary.targets[0].expr, /\[1m\]\)$/);
  });

  it('leaves the request alone when the tier floor changes nothing', () => {
    const { runner, timeRange } = sceneWith({
      queries: [query], maxDataPoints: 100, minIntervalTiers: PROM_MIN_INTERVAL_TIERS,
    }, { from: 'now-24h' });
    const { primary } = runner.prepareRequests(timeRange, PROM_DS);
    assert.equal(primary.interval, '15m');
    assert.match(primary.targets[0].expr, /\[15m\]\)$/);
  });

  it('interpolates secondaries, skips empty requests and survives a failing target', () => {
    const { runner, timeRange } = sceneWith({ queries: [] });
    const original = S.SceneQueryRunner.prototype.prepareRequests;
    const warn = mock.method(console, 'warn', () => {});
    const broken = { get expr() { throw new Error('unresolvable'); } };
    const emptyRequest = { targets: [], scopedVars: {} };
    S.SceneQueryRunner.prototype.prepareRequests = () => ({
      primary: { targets: [broken], scopedVars: {} },
      secondaries: [{ targets: [{ expr: '$env' }], scopedVars: {} }, emptyRequest, null],
    });
    try {
      const out = runner.prepareRequests(timeRange, PROM_DS);
      assert.equal(out.primary.targets[0], broken, 'raw target kept when interpolation throws');
      assert.equal(warn.mock.callCount(), 1);
      assert.match(warn.mock.calls[0].arguments[0], /variable interpolation failed/);
      assert.deepEqual(out.secondaries[0].targets, [{ expr: 'prod' }]);
      assert.equal(out.secondaries[1], emptyRequest);
    } finally {
      S.SceneQueryRunner.prototype.prepareRequests = original;
      warn.mock.restore();
    }
  });

  it('copes with a prepared request that has no secondaries list', () => {
    const { runner, timeRange } = sceneWith({ queries: [] });
    const original = S.SceneQueryRunner.prototype.prepareRequests;
    S.SceneQueryRunner.prototype.prepareRequests = () => ({ primary: { targets: [{ q: '$env' }], scopedVars: {} } });
    try {
      assert.deepEqual(runner.prepareRequests(timeRange, undefined).primary.targets, [{ q: 'prod' }]);
    } finally {
      S.SceneQueryRunner.prototype.prepareRequests = original;
    }
  });
});
