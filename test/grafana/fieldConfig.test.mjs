/**
 * Guards the standard field-config registry this app fills in.
 *
 * @grafana/data leaves `standardFieldConfigEditorRegistry` empty (Grafana core
 * fills it at boot), and applyFieldOverrides() silently DROPS any option whose
 * id is not registered — units, decimals, thresholds and every graph style
 * vanish from every panel without an error. So the assertions here run real
 * fieldConfig through applyFieldOverrides and check the options survive,
 * processed to the right type, and only on the field types they apply to.
 *
 * Run with `npm test` — Node's own runner, no dependency.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../support/dom.mjs';

const data = await import('@grafana/data');
const { registerStandardFieldConfig } = await import('../../src/grafana/fieldConfig.js');

registerStandardFieldConfig();

const { standardFieldConfigEditorRegistry: registry, FieldType } = data;
const theme = data.createTheme();

const frame = () => data.toDataFrame({
  fields: [
    { name: 'time', type: FieldType.time, values: [1, 2] },
    { name: 'value', type: FieldType.number, values: [1.234, 5.678] },
    { name: 'label', type: FieldType.string, values: ['a', 'b'] },
  ],
});

const apply = (defaults) => data.applyFieldOverrides({
  data: [frame()],
  fieldConfig: { defaults, overrides: [] },
  replaceVariables: (v) => v,
  theme,
  timeZone: 'utc',
})[0].fields;

describe('registerStandardFieldConfig', () => {
  it('registers the standard options, the graph styles and the table options', () => {
    for (const id of ['unit', 'decimals', 'min', 'max', 'thresholds', 'mappings', 'color', 'links',
      'custom.lineWidth', 'custom.fillOpacity', 'custom.stacking', 'custom.align', 'custom.cellOptions']) {
      assert.ok(registry.getIfExists(id), id);
    }
  });

  it('declares custom options by path, with Grafana\'s defaults', () => {
    const lineWidth = registry.get('custom.lineWidth');
    assert.equal(lineWidth.path, 'lineWidth');
    assert.equal(lineWidth.isCustom, true);
    assert.equal(lineWidth.defaultValue, 1);
    assert.deepEqual(registry.get('custom.stacking').defaultValue, { mode: 'none', group: 'A' });
    assert.deepEqual(registry.get('custom.align').category, ['Table']);
    assert.equal(registry.get('custom.align').editor(), null);
  });

  it('coerces standard option values to the type Grafana expects', () => {
    assert.equal(registry.get('decimals').process('2'), 2);
    assert.equal(registry.get('min').process(null), undefined);
    assert.equal(registry.get('unit').process(5), '5');
    assert.equal(registry.get('displayName').process(undefined), undefined);
    const color = { mode: 'fixed' };
    assert.equal(registry.get('color').process(color), color);
  });

  it('is safe to call again', () => {
    assert.doesNotThrow(() => registerStandardFieldConfig());
  });
});

describe('fieldConfig through applyFieldOverrides', () => {
  it('keeps unit, decimals and graph styles instead of silently dropping them', () => {
    const [, value] = apply({ unit: 'ms', decimals: '1', custom: { lineWidth: 3, fillOpacity: 20 } });
    assert.equal(value.config.unit, 'ms');
    assert.equal(value.config.decimals, 1);
    assert.equal(value.config.custom.lineWidth, 3);
    assert.equal(value.config.custom.fillOpacity, 20);
    assert.equal(value.display(1.234).text, '1.2');
  });

  it('applies numeric-only options to numeric fields only', () => {
    const [time, value, label] = apply({ min: '0', max: 10, unit: 'ms' });
    assert.equal(value.config.min, 0);
    assert.equal(value.config.max, 10);
    assert.equal(label.config.min, undefined);
    assert.equal(time.config.min, undefined);
    assert.equal(label.config.unit, 'ms', 'unit applies to every field');
  });

  it('never applies value mappings to the time field', () => {
    const mappings = [{ type: 'value', options: { a: { text: 'Alpha' } } }];
    const [time, , label] = apply({ mappings });
    assert.deepEqual(time.config.mappings ?? [], []);
    assert.equal(label.display('a').text, 'Alpha');
  });
});
