/**
 * Guards the navigation table's three questions: which rail entry owns a tab,
 * which group (if any) a tab sits inside, and where a navigation request lands.
 *
 * The failures are all "the shell went somewhere else": a section tab that
 * matches no rail entry leaves nothing lit and its permission unguarded; a
 * request for a GROUP that is not redirected to its first section renders an
 * empty content column. The live table is asserted, and a synthetic table
 * whose group key is NOT its first section's key covers the case the live
 * Logs group only hides by coincidence.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOGS_SECTIONS,
  NAV_ITEMS,
  groupForTab,
  navItemForTab,
  resolveNavTarget,
} from '../../../src/components/common/navModel.js';
import { PERMISSIONS } from '../../../src/auth/constants.js';

/** A group whose key names no section of its own. */
const SYNTHETIC = [
  { key: 'home', label: 'Home' },
  { key: 'telemetry', label: 'Telemetry', sections: [{ key: 'spans' }, { key: 'series' }] },
];

describe('the live navigation table', () => {
  it('holds every telemetry screen as a section of the Logs group', () => {
    const logs = NAV_ITEMS.find((i) => i.key === 'logs');
    assert.equal(logs.sections, LOGS_SECTIONS);
    assert.deepEqual(LOGS_SECTIONS.map((s) => s.key), ['logs', 'analytics', 'traces', 'metrics']);
  });

  it('gates Settings on the IAM visibility grant', () => {
    assert.equal(NAV_ITEMS.find((i) => i.key === 'iam').permission, PERMISSIONS.VIEW_IAM);
  });
});

describe('navItemForTab', () => {
  it('answers a top-level tab with itself and a section with its group', () => {
    assert.equal(navItemForTab('home').key, 'home');
    assert.equal(navItemForTab('traces').key, 'logs');
    assert.equal(navItemForTab('alerts').key, 'alerts');
    assert.equal(navItemForTab('nope'), undefined);
  });
});

describe('groupForTab', () => {
  it('answers only for a tab genuinely one level down', () => {
    assert.equal(groupForTab('metrics').key, 'logs');
    assert.equal(groupForTab('logs').key, 'logs', 'the Logs section is inside the Logs group');
    assert.equal(groupForTab('home'), undefined);
    assert.equal(groupForTab('dashboards'), undefined);
    assert.equal(groupForTab('nope'), undefined);
  });

  it('works against another table', () => {
    assert.equal(groupForTab('series', SYNTHETIC).key, 'telemetry');
    assert.equal(groupForTab('telemetry', SYNTHETIC), undefined);
  });
});

describe('resolveNavTarget', () => {
  it('lands a request for a group on its first section', () => {
    assert.equal(resolveNavTarget('telemetry', SYNTHETIC), 'spans');
  });

  it('leaves sections, top-level tabs and unknown keys unchanged', () => {
    assert.equal(resolveNavTarget('series', SYNTHETIC), 'series');
    assert.equal(resolveNavTarget('home', SYNTHETIC), 'home');
    assert.equal(resolveNavTarget('catalog', SYNTHETIC), 'catalog');
    assert.equal(resolveNavTarget('logs'), 'logs');
    assert.equal(resolveNavTarget('traces'), 'traces');
    assert.equal(resolveNavTarget('rum'), 'rum');
  });
});
