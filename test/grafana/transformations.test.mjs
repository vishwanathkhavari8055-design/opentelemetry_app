/**
 * Guards the transformation registry and the partitionByValues supplement.
 *
 * @grafana/data ships the standard transformers but leaves the registry empty,
 * and a missing id THROWS inside transformDataFrame() — taking the panel's
 * visualization with it while its title still renders. Three failures of that
 * kind are pinned here:
 *  - `partitionByValues` lives in Grafana core, not @grafana/data; without the
 *    supplement every graph on "Microservice Monitoring - Trends" came up empty.
 *  - `seriesToColumns` is only an ALIAS of joinByField; dropping aliasIds while
 *    de-duplicating left "IoT Devices Inventory" a titled empty box.
 *  - registering twice (or duplicate ids) must not throw "Duplicate Key".
 *
 * The partition semantics are asserted on real frames, including the rule that
 * `asLabels` keeps every output frame's name identical (Grafana prefixes the
 * frame name to the legend as soon as names differ) and that the cached
 * `state.displayName` is cleared rather than copied.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../support/dom.mjs';

const { firstValueFrom, of } = await import('rxjs');
const { standardTransformersRegistry, transformDataFrame, FieldType } = await import('@grafana/data');
const { registerStandardTransformations, supportedTransformationIds } = await import('../../src/grafana/transformations.js');

registerStandardTransformations();

const field = (name, values, extra = {}) => ({ name, type: extra.type ?? FieldType.number, values, config: {}, ...extra });

/** One frame: time, service, value — the shape the Trends dashboards partition. */
const trends = () => ({
  name: 'A',
  refId: 'A',
  length: 4,
  fields: [
    field('time', [1, 2, 3, 4], { type: FieldType.time }),
    field('service', ['api', 'db', 'api', 'db'], { type: FieldType.string, labels: { env: 'prod' } }),
    field('value', [10, 20, 30, 40], { state: { displayName: 'stale' } }),
  ],
});

const partition = (frames, options) => {
  const { transformation } = standardTransformersRegistry.get('partitionByValues');
  return firstValueFrom(transformation.operator(options)(of(frames)));
};

describe('registerStandardTransformations', () => {
  it('registers the standard transformers, the partition supplement and legacy aliases', () => {
    for (const id of ['organize', 'reduce', 'joinByField', 'partitionByValues']) {
      assert.equal(standardTransformersRegistry.get(id).id, id);
    }
    assert.equal(standardTransformersRegistry.get('seriesToColumns').id, 'joinByField');
  });

  it('gives every item a name, a description and an inert editor', () => {
    for (const item of standardTransformersRegistry.list()) {
      assert.equal(typeof item.name, 'string', item.id);
      assert.equal(typeof item.description, 'string', item.id);
      assert.equal(item.editor(), null);
      assert.equal(typeof item.transformation.operator, 'function');
    }
  });

  it('is safe to call again', () => {
    const before = standardTransformersRegistry.list().length;
    assert.doesNotThrow(() => registerStandardTransformations());
    assert.equal(standardTransformersRegistry.list().length, before);
  });

  it('lets a real dashboard transformation run through transformDataFrame', async () => {
    const out = await firstValueFrom(transformDataFrame(
      [{ id: 'partitionByValues', options: { fields: ['service'] } }],
      [trends()],
    ));
    assert.deepEqual(out.map((f) => f.name), ['api', 'db']);
  });
});

describe('supportedTransformationIds', () => {
  it('lists canonical and alias ids, sorted and unique', () => {
    const ids = supportedTransformationIds();
    assert.ok(ids.includes('partitionByValues'));
    assert.ok(ids.includes('seriesToColumns'));
    assert.ok(ids.includes('joinByField'));
    assert.deepEqual(ids, [...new Set(ids)].sort());
  });
});

describe('partitionByValues', () => {
  it('splits rows by the key field, dropping it and naming frames by value', async () => {
    const [api, db] = await partition([trends()], { fields: ['service'] });
    assert.equal(api.name, 'api');
    assert.equal(api.length, 2);
    assert.deepEqual(api.fields.map((f) => f.name), ['time', 'value']);
    assert.deepEqual(api.fields[1].values, [10, 30]);
    assert.deepEqual(db.fields[0].values, [2, 4]);
    assert.equal(api.fields[1].state, undefined, 'the pre-split display-name cache is cleared');
  });

  it('keeps the key fields when asked', async () => {
    const [api] = await partition([trends()], { fields: ['service'], keepFields: true });
    assert.deepEqual(api.fields.map((f) => f.name), ['time', 'service', 'value']);
    assert.deepEqual(api.fields[1].values, ['api', 'api']);
    assert.deepEqual(api.fields[1].labels, { env: 'prod' });
  });

  it('with asLabels keeps the frame name and puts the value on every field\'s labels', async () => {
    const out = await partition([trends()], { fields: ['service'], naming: { asLabels: true } });
    assert.deepEqual(out.map((f) => f.name), ['A', 'A']);
    assert.deepEqual(out[1].fields[1].labels, { service: 'db' });
  });

  it('with withNames names frames field=value, joined across several keys', async () => {
    const frame = trends();
    frame.fields.push(field('zone', ['a', 'a', 'b', 'a'], { type: FieldType.string }));
    const out = await partition([frame], { fields: ['service', 'zone'], naming: { withNames: true } });
    assert.deepEqual(out.map((f) => f.name), ['service=api zone=a', 'service=db zone=a', 'service=api zone=b']);
    assert.deepEqual(out[1].fields.find((f) => f.name === 'value').values, [20, 40]);
  });

  it('passes a frame through untouched when it lacks a key field or no keys are named', async () => {
    const frame = trends();
    for (const options of [{ fields: ['missing'] }, { fields: [] }, {}, undefined]) {
      const out = await partition([frame], options);
      assert.equal(out.length, 1);
      assert.equal(out[0], frame);
    }
  });

  it('reads the row count from the fields when the frame has no length', async () => {
    const frame = trends();
    delete frame.length;
    assert.equal((await partition([frame], { fields: ['service'] })).length, 2);
    const empty = { name: 'E', fields: [field('service', [], { type: FieldType.string })] };
    delete empty.length;
    assert.deepEqual(await partition([empty], { fields: ['service'] }), []);
  });
});
