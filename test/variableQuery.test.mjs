/**
 * Guards template-variable resolution for every datasource type.
 *
 * Before this, only Prometheus `label_values(...)` produced options; a Neo4j
 * variable saved as `{ cypherQuery }` went out as an empty string and its picker
 * stayed empty, blanking every panel that filtered on it. The fixtures below are
 * real /api/ds/query responses captured from this deployment's Grafana, so the
 * shapes pinned here are the shapes that actually arrive.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterMetricNames,
  framesToVariableValues,
  infinityLegacyText,
  infinityLegacyValues,
  parsePrometheusVariableQuery,
  promInstantToVariableValues,
  prometheusVariableText,
  variableTarget,
} from '../src/grafana/variableQuery.js';

const NEO4J = { type: 'kniepdennis-neo4j-datasource', uid: 'cfik63hwwkmpsb' };

/** iot-device-mongo-dash's `Company` variable, as Grafana answered it. */
const NEO4J_FRAME = {
  schema: {
    name: 'response',
    refId: 'A',
    fields: [{ name: 'Company', type: 'string', typeInfo: { frame: 'string', nullable: true } }],
  },
  data: { values: [['ADCDA', 'Harish', 'smartCity']] },
};

/** One series of a Prometheus instant query, as Grafana answered it. */
const PROM_INSTANT_FRAME = {
  schema: {
    refId: 'A',
    fields: [
      { name: 'Time', type: 'time', config: { interval: 30000 } },
      {
        name: 'kube_namespace_status_phase',
        type: 'number',
        labels: {
          __name__: 'kube_namespace_status_phase', namespace: 'kube-node-lease', phase: 'Active',
        },
        config: {},
      },
    ],
  },
  data: { values: [[1790320410460], [1]] },
};

describe('parsePrometheusVariableQuery', () => {
  it('reads label_values with and without a selector', () => {
    assert.deepEqual(
      parsePrometheusVariableQuery('label_values(kube_pod_status_phase{namespace=~"a|b"}, pod)'),
      { kind: 'label_values', metric: 'kube_pod_status_phase{namespace=~"a|b"}', label: 'pod' },
    );
    assert.deepEqual(
      parsePrometheusVariableQuery('label_values(job)'),
      { kind: 'label_values', metric: undefined, label: 'job' },
    );
  });

  it('reads metrics, query_result and label_names', () => {
    assert.deepEqual(parsePrometheusVariableQuery('metrics(node_.*)'), { kind: 'metrics', regex: 'node_.*' });
    assert.deepEqual(
      parsePrometheusVariableQuery('query_result(topk(5, up))'),
      { kind: 'query_result', expr: 'topk(5, up)' },
    );
    assert.equal(parsePrometheusVariableQuery('label_names()').kind, 'label_names');
  });

  it('treats anything else as a series selector rather than nothing', () => {
    assert.deepEqual(parsePrometheusVariableQuery('up{job="x"}'), { kind: 'series', expr: 'up{job="x"}' });
    assert.equal(parsePrometheusVariableQuery('   '), null);
  });

  it('takes the text from the current editor\'s object shape', () => {
    assert.equal(
      prometheusVariableText({ qryType: 1, query: 'label_values(job)', refId: 'X' }),
      'label_values(job)',
    );
    assert.equal(prometheusVariableText('label_values(job)'), 'label_values(job)');
    assert.equal(prometheusVariableText(null), '');
  });
});

describe('filterMetricNames', () => {
  it('matches unanchored, as Grafana does', () => {
    assert.deepEqual(filterMetricNames(['node_cpu', 'up', 'x_node_y'], 'node_'), ['node_cpu', 'x_node_y']);
  });
  it('offers nothing for an invalid regex instead of throwing', () => {
    assert.deepEqual(filterMetricNames(['a'], '('), []);
  });
});

describe('promInstantToVariableValues', () => {
  it('spells query_result rows exactly as Grafana does', () => {
    assert.deepEqual(promInstantToVariableValues([PROM_INSTANT_FRAME]), [{
      text: 'kube_namespace_status_phase{namespace="kube-node-lease", phase="Active"} 1 1790320410460',
      value: 'kube_namespace_status_phase{namespace="kube-node-lease", phase="Active"} 1 1790320410460',
    }]);
  });
  it('gives the bare selector for a series query', () => {
    assert.equal(
      promInstantToVariableValues([PROM_INSTANT_FRAME], { seriesOnly: true })[0].value,
      'kube_namespace_status_phase{namespace="kube-node-lease",phase="Active"}',
    );
  });
});

describe('infinity legacy helpers', () => {
  it('answers Collection with name/value pairs', () => {
    assert.deepEqual(infinityLegacyValues('Collection(Prod,p, Dev ,d)'), [
      { text: 'Prod', value: 'p' },
      { text: 'Dev', value: 'd' },
    ]);
  });
  it('answers CollectionLookup with the one matching value', () => {
    assert.deepEqual(infinityLegacyValues('CollectionLookup(Prod,p,Dev,d,Dev)'), [{ text: 'd', value: 'd' }]);
    assert.deepEqual(infinityLegacyValues('CollectionLookup(Prod,p,Missing)'), []);
  });
  it('leaves everything else to the real query path', () => {
    assert.equal(infinityLegacyValues('https://example/api'), null);
    assert.equal(infinityLegacyText({ queryType: 'infinity', infinityQuery: {} }), null);
    assert.equal(infinityLegacyText({ queryType: 'legacy', query: 'Collection(a,b)' }), 'Collection(a,b)');
  });
});

describe('variableTarget', () => {
  it('sends an object query as saved, with the datasource attached', () => {
    const query = { cypherQuery: 'MATCH (n) RETURN n.x' };
    assert.deepEqual(variableTarget(query, { name: 'Company', datasource: NEO4J }), {
      cypherQuery: 'MATCH (n) RETURN n.x',
      refId: 'variable-Company',
      datasource: NEO4J,
    });
  });

  it('unwraps Infinity\'s infinityQuery', () => {
    const target = variableTarget(
      { queryType: 'infinity', infinityQuery: { type: 'json', url: 'u', root_selector: 'hits' } },
      { name: 'svc', datasource: { type: 'yesoreyeram-infinity-datasource', uid: 'x' } },
    );
    assert.equal(target.url, 'u');
    assert.equal(target.root_selector, 'hits');
    assert.equal(target.infinityQuery, undefined);
  });

  it('offers a string query under the keys SQL-style datasources read', () => {
    const target = variableTarget('SELECT name FROM t', { name: 'n', datasource: NEO4J });
    assert.equal(target.rawSql, 'SELECT name FROM t');
    assert.equal(target.query, 'SELECT name FROM t');
    assert.equal(variableTarget('  ', { name: 'n', datasource: NEO4J }), null);
  });
});

describe('framesToVariableValues', () => {
  it('uses the single string column of a real Neo4j answer', () => {
    assert.deepEqual(framesToVariableValues([NEO4J_FRAME]).map((v) => v.value), ['ADCDA', 'Harish', 'smartCity']);
  });

  it('honours text / value columns', () => {
    const frame = {
      schema: { fields: [
        { name: '__value', type: 'string' },
        { name: '__text', type: 'string' },
      ] },
      data: { values: [['id-1', 'id-2'], ['One', 'Two']] },
    };
    assert.deepEqual(framesToVariableValues([frame]), [
      { text: 'One', value: 'id-1' },
      { text: 'Two', value: 'id-2' },
    ]);
  });

  it('falls back to a non-time column when nothing is a string', () => {
    const frame = {
      schema: { fields: [{ name: 'ts', type: 'time' }, { name: 'id', type: 'number' }] },
      data: { values: [[1, 2], [7, 8]] },
    };
    assert.deepEqual(framesToVariableValues([frame]).map((v) => v.value), ['7', '8']);
  });

  it('skips empty frames and null cells', () => {
    assert.deepEqual(framesToVariableValues([{ schema: { fields: [] } }]), []);
    const frame = { schema: { fields: [{ name: 'x', type: 'string' }] }, data: { values: [['a', null]] } };
    assert.deepEqual(framesToVariableValues([frame]).map((v) => v.value), ['a']);
  });
});
