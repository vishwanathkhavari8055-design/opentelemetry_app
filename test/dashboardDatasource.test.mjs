/**
 * Guards Grafana's `-- Dashboard --` datasource: a panel reusing another panel's
 * query. Its reference has `type: "datasource"`, which is how Grafana spells its
 * own built-ins, so without this the panel's targets were dropped as unqueryable
 * and it rendered empty.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  expandDashboardDatasourcePanels,
  isDashboardDatasourceRef,
} from '../src/grafana/dashboardDatasource.js';

const PROM = { type: 'prometheus', uid: 'PBFA97CFB590B2093' };
const DASH = { type: 'datasource', uid: '-- Dashboard --' };

const source = {
  id: 1,
  type: 'timeseries',
  datasource: PROM,
  targets: [{ refId: 'A', expr: 'up', datasource: PROM }],
  transformations: [{ id: 'reduce', options: {} }],
  interval: '1m',
};

describe('expandDashboardDatasourcePanels', () => {
  it('returns the same object when no panel reuses another', () => {
    const dashboard = { panels: [source] };
    assert.equal(expandDashboardDatasourcePanels(dashboard), dashboard);
  });

  it('gives a reusing panel its source\'s datasource and targets', () => {
    const reuser = { id: 2, type: 'stat', datasource: DASH, targets: [{ refId: 'A', panelId: 1, datasource: DASH }] };
    const out = expandDashboardDatasourcePanels({ panels: [source, reuser] });
    const panel = out.panels[1];
    assert.deepEqual(panel.datasource, PROM);
    assert.deepEqual(panel.targets, source.targets);
    assert.deepEqual(panel.transformations, []);
    assert.equal(panel.interval, '1m');
    assert.equal(out.panels[0], source, 'the source panel is untouched');
  });

  it('applies the source\'s transformations first with withTransforms', () => {
    const own = { id: 'organize', options: {} };
    const reuser = {
      id: 2, datasource: DASH, transformations: [own],
      targets: [{ panelId: 1, withTransforms: true, datasource: DASH }],
    };
    const panel = expandDashboardDatasourcePanels({ panels: [source, reuser] }).panels[1];
    assert.deepEqual(panel.transformations, [...source.transformations, own]);
  });

  it('finds a source inside a collapsed row and follows a chain', () => {
    const row = { id: 10, type: 'row', collapsed: true, panels: [source] };
    const middle = { id: 3, datasource: DASH, targets: [{ panelId: 1 }] };
    const last = { id: 4, datasource: DASH, targets: [{ panelId: 3 }] };
    const out = expandDashboardDatasourcePanels({ panels: [row, middle, last] });
    assert.deepEqual(out.panels[2].datasource, PROM);
    assert.deepEqual(out.panels[2].targets, source.targets);
  });

  it('leaves a dangling or looping reference as it was', () => {
    const dangling = { id: 5, datasource: DASH, targets: [{ panelId: 99 }] };
    const a = { id: 6, datasource: DASH, targets: [{ panelId: 7 }] };
    const b = { id: 7, datasource: DASH, targets: [{ panelId: 6 }] };
    const out = expandDashboardDatasourcePanels({ panels: [dangling, a, b] });
    assert.equal(out.panels[0], dangling);
    assert.deepEqual(out.panels[1].datasource, DASH);
  });

  it('recognises both spellings of the reference', () => {
    assert.equal(isDashboardDatasourceRef(DASH), true);
    assert.equal(isDashboardDatasourceRef('-- Dashboard --'), true);
    assert.equal(isDashboardDatasourceRef(PROM), false);
    assert.equal(isDashboardDatasourceRef({ type: 'datasource', uid: 'grafana' }), false);
  });
});
