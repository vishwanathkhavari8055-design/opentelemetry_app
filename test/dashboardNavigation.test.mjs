/**
 * Guards the parser that decides whether a click drills down or does nothing.
 *
 * Both directions of getting this wrong are silent. Too narrow and a topology
 * node stops navigating — which reads as a dead control, with nothing in the UI
 * to say why. Too wide and this application swallows clicks on links that were
 * never dashboards at all, so an ordinary anchor stops working and a "dashboard
 * not registered" toast appears instead.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  onDashboardNavigation,
  parseDashboardTarget,
  requestDashboardNavigation,
} from '../src/grafana/dashboardNavigation.js';

describe('parseDashboardTarget', () => {
  it('reads the form a panel script actually writes', () => {
    // `locationService.push('/d/' + uid)` — the OSS Engine Overview topology.
    assert.equal(parseDashboardTarget('/d/afint-cc').uid, 'afint-cc');
  });

  it('accepts the same path relative, rooted, and absolute', () => {
    for (const url of [
      'd/afint-cc',
      '/d/afint-cc',
      'https://grafana.example.com/d/afint-cc',
    ]) {
      assert.equal(parseDashboardTarget(url)?.uid, 'afint-cc', url);
    }
  });

  it('keeps the uid when a slug follows it', () => {
    const target = parseDashboardTarget('/d/oss-engine-overview/oss-engines');
    assert.equal(target.uid, 'oss-engine-overview');
    assert.equal(target.slug, 'oss-engines');
  });

  it('carries the drill-down time window', () => {
    // The whole point of honouring it: "that service DURING THIS incident".
    const target = parseDashboardTarget('/d/kafka-cc/kafka?orgId=1&from=now-1h&to=now');
    assert.deepEqual(target.range, { from: 'now-1h', to: 'now' });
    assert.equal(target.params.get('orgId'), '1');
  });

  it('leaves the range null unless BOTH ends are given', () => {
    // Half a range is not a range. Applying `from` alone would silently pair it
    // with the wrong `to` and show a window nobody asked for.
    assert.equal(parseDashboardTarget('/d/kafka-cc?from=now-1h').range, null);
    assert.equal(parseDashboardTarget('/d/kafka-cc?to=now').range, null);
  });

  it('does not mistake a hash for a query string', () => {
    const target = parseDashboardTarget('/d/afint-cc?var-pod=x#panel-2');
    assert.equal(target.uid, 'afint-cc');
    assert.equal(target.params.get('var-pod'), 'x');
  });

  it('refuses everything that is not a dashboard link', () => {
    for (const url of [
      '/explore?left=x',
      // Grafana's legacy slug-based URL. It names no uid, and guessing one from
      // the slug would open the wrong dashboard rather than none.
      '/dashboard/db/some-slug',
      // The `d/` has to be a whole path segment.
      'https://example.com/notd/uid',
      'https://example.com/downloads/uid',
      '',
      '   ',
      null,
      undefined,
    ]) {
      assert.equal(parseDashboardTarget(url), null, String(url));
    }
  });
});

describe('requestDashboardNavigation', () => {
  it('delivers the parsed target to a listener and reports success', () => {
    const seen = [];
    const off = onDashboardNavigation((target) => seen.push(target));
    try {
      assert.equal(requestDashboardNavigation('/d/afint-cc'), true);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].uid, 'afint-cc');
    } finally {
      off();
    }
  });

  it('reports failure when nothing is listening', () => {
    // False is what tells the caller its click went nowhere, so it can leave the
    // click alone rather than swallow it.
    assert.equal(requestDashboardNavigation('/d/afint-cc'), false);
  });

  it('reports failure for a url that names no dashboard', () => {
    const off = onDashboardNavigation(() => {
      assert.fail('a non-dashboard url must not reach a listener');
    });
    try {
      assert.equal(requestDashboardNavigation('/explore'), false);
    } finally {
      off();
    }
  });

  it('gives every listener the request even when one throws', () => {
    // One screen's bug must not cost another screen the navigation.
    let reached = false;
    const offBad = onDashboardNavigation(() => { throw new Error('boom'); });
    const offGood = onDashboardNavigation(() => { reached = true; });
    try {
      assert.equal(requestDashboardNavigation('/d/afint-cc'), true);
      assert.equal(reached, true);
    } finally {
      offBad();
      offGood();
    }
  });

  it('stops delivering after unsubscribe', () => {
    let count = 0;
    const off = onDashboardNavigation(() => { count += 1; });
    requestDashboardNavigation('/d/afint-cc');
    off();
    requestDashboardNavigation('/d/afint-cc');
    assert.equal(count, 1);
  });
});
