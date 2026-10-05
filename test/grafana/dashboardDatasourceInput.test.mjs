/**
 * Guards expandDashboardDatasourcePanels against dashboard JSON that is not a
 * dashboard: a failed fetch (null), an error body, a string, or a dashboard
 * whose `panels` is missing or not an array. The builder calls this on every
 * dashboard it loads, so throwing here would replace "this dashboard has no
 * panels" with a crashed screen. Input is returned exactly as given.
 * (The expansion itself is in test/dashboardDatasource.test.mjs.)
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expandDashboardDatasourcePanels } from '../../src/grafana/dashboardDatasource.js';

describe('expandDashboardDatasourcePanels on malformed input', () => {
  it('returns non-objects unchanged', () => {
    for (const input of [null, undefined, '', 'dashboard', 0]) {
      assert.equal(expandDashboardDatasourcePanels(input), input, String(input));
    }
  });

  it('returns a dashboard without a panels array as the same object', () => {
    for (const input of [{}, { panels: null }, { panels: { 0: {} } }, { message: 'Dashboard not found' }]) {
      assert.equal(expandDashboardDatasourcePanels(input), input);
    }
  });

  it('returns an empty dashboard as the same object', () => {
    const empty = { panels: [] };
    assert.equal(expandDashboardDatasourcePanels(empty), empty);
  });
});
