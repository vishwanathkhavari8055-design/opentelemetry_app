/**
 * Guards the Grafana folder tree the Dashboards screens navigate.
 *
 * `/folders` and `/registry` come from the network, so the tree has to survive
 * what the network does: a folder deleted in Grafana, an ancestor filtered out
 * by permissions, a folders call that failed outright, a parent cycle. In
 * every case a registered dashboard must still be reachable — the worst
 * outcome is a dashboard that exists and cannot be clicked on.
 *
 * Also pinned: the pruning rule (the Dashboards screen shows a branch only if
 * something is registered under it; the register dialog keeps empty folders),
 * displayOrder before title, and the collapse of single-child chains that makes
 * `OpenObserver` the first screen without that name appearing in code.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFolderTree,
  collapseSingleChild,
  folderLabel,
  folderShape,
  pathToUid,
  resolvePath,
} from '../../../src/components/dashboards/folderTree.js';

const FOLDERS = [
  { uid: 'mon', title: 'Monitoring', path: 'Monitoring', depth: 0, parentUid: '' },
  { uid: 'oo', title: 'OpenObserver', path: 'Monitoring / OpenObserver', depth: 1, parentUid: 'mon' },
  { uid: 'dlh', title: 'DLH Services', path: 'Monitoring / OpenObserver / DLH Services', depth: 2, parentUid: 'oo' },
  { uid: 'kafka', title: 'Apache Kafka', path: 'Monitoring / OpenObserver / Apache Kafka', depth: 2, parentUid: 'oo' },
  { uid: 'empty', title: 'Empty', depth: 0 },
];

const reg = (uid, folderUid, extra = {}) => ({ uid, title: uid, folderUid, ...extra });

describe('folderLabel', () => {
  it('prefers the full path, then the title, then the uid', () => {
    assert.equal(folderLabel(FOLDERS[2]), 'Monitoring / OpenObserver / DLH Services');
    assert.equal(folderLabel({ uid: 'u', title: 'T' }), 'T');
    assert.equal(folderLabel({ uid: 'u' }), 'u');
    assert.equal(folderLabel(null), '');
  });

  it('exports a prop-types shape for a folder row', () => {
    assert.equal(typeof folderShape, 'function');
    assert.equal(typeof folderShape.isRequired, 'function');
  });
});

describe('buildFolderTree', () => {
  it('nests folders, counts dashboards through every level and prunes empty branches', () => {
    const { roots, byUid } = buildFolderTree(FOLDERS, [reg('d1', 'dlh'), reg('d2', 'dlh'), reg('k1', 'kafka')]);
    assert.deepEqual(roots.map((n) => n.uid), ['mon']);
    assert.equal(byUid.get('mon').total, 3);
    assert.equal(byUid.get('oo').total, 3);
    assert.deepEqual(byUid.get('oo').children.map((n) => n.uid), ['kafka', 'dlh'], 'children by title');
    assert.equal(byUid.get('empty').total, 0);
    assert.equal(byUid.get('empty').path, 'Empty', 'path falls back to the title');
    assert.equal(byUid.get('empty').depth, 0);
  });

  it('keeps empty folders when asked — you register INTO an empty folder', () => {
    const { roots, byUid } = buildFolderTree(FOLDERS, [], { keepEmpty: true });
    assert.deepEqual(roots.map((n) => n.uid), ['empty', 'mon']);
    assert.deepEqual(byUid.get('oo').children.map((n) => n.uid), ['kafka', 'dlh']);
  });

  it('orders dashboards by displayOrder, then title', () => {
    const { byUid } = buildFolderTree(FOLDERS, [
      reg('b', 'dlh', { displayOrder: 2 }), reg('z', 'dlh', { displayOrder: 1 }),
      reg('a', 'dlh', { displayOrder: 2 }), reg('none', 'dlh'), { uid: 'untitled', folderUid: 'dlh', displayOrder: 2 },
    ]);
    assert.deepEqual(byUid.get('dlh').dashboards.map((d) => d.uid), ['none', 'z', 'a', 'b', 'untitled']);
  });

  it('gives a registration in an unlisted folder a detached root, once per folder', () => {
    const { roots } = buildFolderTree(FOLDERS, [
      reg('x1', 'gone', { folderTitle: 'Deleted Folder' }), reg('x2', 'gone'), reg('g', undefined),
    ]);
    const gone = roots.find((n) => n.uid === 'gone');
    assert.equal(gone.detached, true);
    assert.equal(gone.title, 'Deleted Folder');
    assert.equal(gone.total, 2);
    const general = roots.find((n) => n.uid === '');
    assert.equal(general.title, 'Ungrouped');
  });

  it('degrades to one detached tile per folder when the folders call failed', () => {
    const { roots } = buildFolderTree(null, [reg('a', 'f1', { folderTitle: 'F1' }), reg('b', 'f2', { folderTitle: 'F2' })]);
    assert.deepEqual(roots.map((n) => [n.title, n.total, n.detached]), [['F1', 1, true], ['F2', 1, true]]);
  });

  it('keeps a folder whose parent was filtered out as a root', () => {
    const { roots } = buildFolderTree([{ uid: 'child', title: 'Child', parentUid: 'hidden' }], [reg('d', 'child')]);
    assert.deepEqual(roots.map((n) => n.uid), ['child']);
  });

  it('ignores folder rows without a uid', () => {
    const { byUid } = buildFolderTree([null, { title: 'no uid' }, FOLDERS[0]], [], { keepEmpty: true });
    assert.deepEqual([...byUid.keys()], ['mon']);
  });

  it('annotates the disabled count from the summary, never below zero', () => {
    const { byUid, roots } = buildFolderTree(FOLDERS, [reg('d', 'dlh'), reg('x', 'gone')], {
      summary: [
        { folderUid: 'dlh', total: 5, enabled: 3 },
        { folderUid: 'kafka', total: 1, enabled: 4 },
        { folderUid: 'gone', total: 2 },
        { folderUid: 'nowhere', total: 9, enabled: 0 },
        { total: 1, enabled: 1 },
      ],
    });
    assert.equal(byUid.get('dlh').disabled, 2);
    assert.equal(byUid.get('kafka').disabled, 0);
    assert.equal(roots.find((n) => n.uid === 'gone').disabled, 2);
  });

  it('terminates on a parent cycle', () => {
    const cyclic = [
      { uid: 'a', title: 'A', parentUid: 'b' },
      { uid: 'b', title: 'B', parentUid: 'a' },
      { uid: 'r', title: 'R' },
    ];
    const { roots, byUid } = buildFolderTree(cyclic, [reg('d', 'r')], { keepEmpty: true });
    assert.deepEqual(roots.map((n) => n.uid), ['r'], 'a cycle has no root to hang from');
    assert.equal(byUid.get('a').children[0].uid, 'b');
    assert.equal(byUid.get('a').total, 0, 'never measured, so never walked');
  });
});

describe('collapseSingleChild', () => {
  it('descends through single-child, dashboard-less levels and records the trail', () => {
    const { roots } = buildFolderTree(FOLDERS, [reg('d1', 'dlh'), reg('k1', 'kafka')]);
    const out = collapseSingleChild(roots);
    assert.deepEqual(out.trail.map((n) => n.uid), ['mon', 'oo']);
    assert.deepEqual(out.roots.map((n) => n.uid), ['kafka', 'dlh']);
  });

  it('stops at a level that holds a dashboard itself', () => {
    const { roots } = buildFolderTree(FOLDERS, [reg('top', 'mon'), reg('d1', 'dlh')]);
    const out = collapseSingleChild(roots);
    assert.deepEqual(out.trail, []);
    assert.deepEqual(out.roots.map((n) => n.uid), ['mon']);
  });

  it('stops at a leaf and accepts no roots', () => {
    const { roots } = buildFolderTree(FOLDERS, [reg('d1', 'dlh')]);
    assert.deepEqual(collapseSingleChild(roots).roots.map((n) => n.uid), ['dlh']);
    assert.deepEqual(collapseSingleChild(undefined), { trail: [], roots: [] });
  });
});

describe('resolvePath / pathToUid', () => {
  const { roots } = buildFolderTree(FOLDERS, [reg('d1', 'dlh'), reg('k1', 'kafka')]);

  it('resolves a uid path to the nodes along it', () => {
    assert.deepEqual(resolvePath(roots, ['mon', 'oo', 'dlh']).map((n) => n.title), ['Monitoring', 'OpenObserver', 'DLH Services']);
    assert.deepEqual(resolvePath(roots, []), []);
    assert.deepEqual(resolvePath(roots, undefined), []);
  });

  it('returns [] when any step of the path no longer exists', () => {
    assert.deepEqual(resolvePath(roots, ['mon', 'removed']), []);
    assert.deepEqual(resolvePath(null, ['mon']), []);
  });

  it('finds the uid path to a folder, and [] when it is absent', () => {
    assert.deepEqual(pathToUid(roots, 'kafka'), ['mon', 'oo', 'kafka']);
    assert.deepEqual(pathToUid(roots, 'mon'), ['mon']);
    assert.deepEqual(pathToUid(roots, 'empty'), [], 'pruned from this tree');
    assert.deepEqual(pathToUid(roots, ''), []);
    assert.deepEqual(pathToUid(null, 'kafka'), []);
  });

  it('round-trips with resolvePath', () => {
    const path = pathToUid(roots, 'dlh');
    assert.equal(resolvePath(roots, path).at(-1).uid, 'dlh');
  });
});
