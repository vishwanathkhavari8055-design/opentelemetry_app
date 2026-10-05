// ---------------------------------------------------------------------------
// Standard field-config registry.
//
// THIS IS THE FIX FOR THE "doesn't look like Grafana" PROBLEM.
//
// Grafana core populates `standardFieldConfigEditorRegistry` at boot (it lives
// in grafana/public/app/core/components/OptionsUI/registry.tsx, which is NOT
// published in @grafana/ui). Standalone, that registry is EMPTY, and an empty
// registry silently destroys every dashboard's fieldConfig in two places:
//
//   1. getPanelOptionsWithDefaults() -> applyFieldConfigDefaults() ->
//      cleanProperties() deletes any key of fieldConfig.defaults that is not in
//      the registry. With an empty registry that is *every* key.
//   2. applyFieldOverrides() -> setFieldConfigDefaults() iterates
//      `fieldConfigRegistry.list()` to copy defaults onto each field. Empty
//      list => the loop body never runs => nothing is copied.
//      Likewise setDynamicConfigValue() drops every `overrides` entry.
//
// Net effect before this file existed: units, decimals, min/max, thresholds,
// colour modes and ALL custom graph styling (fillOpacity, lineWidth, spanNulls,
// stacking, showPoints, ...) were thrown away for every panel. Panels rendered
// as bare default-styled lines with raw unformatted numbers.
//
// So we rebuild the registry ourselves. Every entry must supply:
//   id           - the key as it appears in dashboard JSON ("unit",
//                  "custom.lineWidth"); used by cleanProperties() and by
//                  overrides lookup, so it MUST match Grafana exactly.
//   path         - where to write, relative to config (or config.custom).
//   process      - value transform, called with (value, context, settings).
//   shouldApply  - per-field predicate.
//   category     - required; createFieldConfigRegistry() reads category[0].
//   isCustom     - true => read from defaults.custom, write to config.custom.
// ---------------------------------------------------------------------------

import { FieldType, standardFieldConfigEditorRegistry } from '@grafana/data';

const identity = (value) => value;
const asNumber = (value) => (value == null ? undefined : Number.parseFloat(value));
const asString = (value) => value?.toString();

const isNumeric = (field) => field.type === FieldType.number;
const notTime = (field) => field.type !== FieldType.time;
const always = () => true;

const STANDARD_CATEGORY = ['Standard options'];
const GRAPH_CATEGORY = ['Graph styles'];
const TABLE_CATEGORY = ['Table'];

// The options UI is never rendered in this app, but PanelPlugin expects the
// shape, so every entry carries inert editors.
const noEditor = () => null;

function standard(id, { process = identity, shouldApply = always, defaultValue } = {}) {
  return {
    id,
    path: id,
    name: id,
    category: STANDARD_CATEGORY,
    editor: noEditor,
    override: noEditor,
    process,
    shouldApply,
    defaultValue,
  };
}

// Custom (panel-specific) options live under fieldConfig.defaults.custom.
// Note the id carries the "custom." prefix while the path does not — that split
// is exactly what setFieldConfigDefaults()/cleanProperties() expect.
function custom(key, defaultValue, category = GRAPH_CATEGORY) {
  return {
    id: `custom.${key}`,
    path: key,
    name: key,
    category,
    editor: noEditor,
    override: noEditor,
    process: identity,
    shouldApply: always,
    isCustom: true,
    defaultValue,
  };
}

// Table column options. Same mechanism, different visualization: without these
// a table's per-column widths, alignment and cell display modes (bar gauge
// cells, coloured backgrounds, JSON view) are stripped out of fieldConfig
// before the panel ever sees them.
//
// The registry is shared by every panel plugin, so a timeseries panel also gets
// these keys defaulted onto its fields. That is inert — GraphNG reads none of
// them — and it is the tradeoff that keeps one registry instead of one per
// plugin.
const TABLE_OPTIONS = [
  custom('align', 'auto', TABLE_CATEGORY),
  custom('cellOptions', undefined, TABLE_CATEGORY),
  custom('width', undefined, TABLE_CATEGORY),
  custom('minWidth', undefined, TABLE_CATEGORY),
  custom('hidden', undefined, TABLE_CATEGORY),
  custom('inspect', false, TABLE_CATEGORY),
  custom('filterable', undefined, TABLE_CATEGORY),
];

// --- Standard options, mirroring Grafana core's registry ------------------
// min/max/decimals/thresholds are number-only in core; unit and color apply to
// every field (getDisplayProcessor already forces time fields to a date format,
// so a "bytes" unit can never corrupt the X axis).
const STANDARD_OPTIONS = [
  standard('displayName', { process: asString }),
  standard('unit', { process: asString }),
  standard('min', { process: asNumber, shouldApply: isNumeric }),
  standard('max', { process: asNumber, shouldApply: isNumeric }),
  standard('fieldMinMax', { shouldApply: isNumeric }),
  standard('decimals', { process: asNumber, shouldApply: isNumeric }),
  standard('noValue', { process: asString }),
  standard('color'),
  standard('thresholds', { shouldApply: isNumeric }),
  standard('mappings', { shouldApply: notTime }),
  standard('links'),
  standard('filterable'),
];

// --- Custom options for the timeseries visualisation ----------------------
// Defaults match Grafana's own defaults so a panel that omits a key still
// renders identically to Grafana. The panel's own JSON always wins over these.
const GRAPH_OPTIONS = [
  custom('drawStyle', 'line'),
  custom('lineInterpolation', 'linear'),
  custom('lineWidth', 1),
  custom('lineStyle'),
  custom('fillOpacity', 0),
  custom('fillBelowTo'),
  custom('fillColor'),
  custom('gradientMode', 'none'),
  custom('showPoints', 'auto'),
  custom('pointSize', 5),
  custom('pointColor'),
  custom('pointSymbol'),
  custom('spanNulls', false),
  custom('insertNulls'),
  custom('barAlignment', 0),
  custom('barWidthFactor', 0.6),
  custom('barMaxWidth'),
  custom('stacking', { mode: 'none', group: 'A' }),
  custom('hideFrom', { tooltip: false, viz: false, legend: false }),
  custom('thresholdsStyle', { mode: 'off' }),
  custom('transform'),
  custom('axisPlacement', 'auto'),
  custom('axisColorMode', 'text'),
  custom('axisLabel', ''),
  custom('axisWidth'),
  custom('axisSoftMin'),
  custom('axisSoftMax'),
  custom('axisGridShow'),
  custom('axisBorderShow', false),
  custom('axisCenteredZero', false),
  custom('scaleDistribution', { type: 'linear' }),
];

let registered = false;

/**
 * Populate the standard field-config registry. MUST run before any PanelPlugin
 * is constructed — Registry.setInit() throws once the registry has been read.
 */
export function registerStandardFieldConfig() {
  if (registered) return;
  registered = true;
  standardFieldConfigEditorRegistry.setInit(() => [
    ...STANDARD_OPTIONS,
    ...GRAPH_OPTIONS,
    ...TABLE_OPTIONS,
  ]);
}
