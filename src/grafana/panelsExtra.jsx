// ---------------------------------------------------------------------------
// Additional panel renderers: table, gauge, bar gauge, pie chart, bar chart,
// text — plus the controlled placeholder used for plugin ids this app has no
// renderer for.
//
// These sit alongside ./panels.jsx (timeseries + stat) rather than inside it,
// so the original two renderers keep their exact identity and exports. Adding
// a new panel type means adding a plugin here and one line in
// ./panelRegistry.js — no dashboard-specific code anywhere.
//
// As in ./panels.jsx, every plugin calls .useFieldConfig(): without it Grafana
// silently discards the dashboard's units, thresholds and colour modes.
//
//
// ─── propTypes ──────────────────────────────────────────────────────────────
//
// These components are not called by anything in this application. They are
// PanelPlugin render functions: Grafana's VizPanel constructs their props from
// the PanelProps contract (data, width, height, options, fieldConfig, timeRange,
// timeZone, replaceVariables, renderCounter, …), where `options` and
// `fieldConfig` are whatever the dashboard's JSON put there. So their propTypes
// (./panelPropTypes.js) describe that contract loosely instead of restating a
// third party's types, and a prop Grafana adds later is not rejected.
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import {
  PanelPlugin,
  FieldColorModeId,
  VizOrientation,
  getFieldDisplayValues,
  getDisplayValueAlignmentFactors,
  ReducerID,
} from '@grafana/data';
import { BarGaugeDisplayMode, BarGaugeValueMode, TableCellDisplayMode }
  from '@grafana/schema';
// NOTE: @grafana/ui's own `Gauge` is deliberately NOT imported. It draws with
// jquery.flot, which Grafana core loads from its `vendor/` tree and @grafana/ui
// does not ship — so in any standalone app it throws
// "jquery.default.plot is not a function" on every render and the panel is blank.
// ./ArcGauge below replaces it. See the note on that component.
import { BarGauge, Table, VizRepeater, useTheme2 } from '@grafana/ui';

import { registerStandardFieldConfig } from './fieldConfig.js';
import { panelPropTypes, centeredPropTypes } from './panelPropTypes.js';
import { ArcGauge } from './ArcGauge.jsx';
import { PieChart } from './PieChart.jsx';
import { BarChart, BAR_FILL_OPACITY } from './BarChart.jsx';
import { renderPanelText } from './panelText.js';

// Same reasoning as in ./panels.jsx — the registry must be populated before any
// PanelPlugin below builds its fieldConfigRegistry.
registerStandardFieldConfig();

const DEFAULT_REDUCE_OPTIONS = { calcs: [ReducerID.lastNotNull], fields: '', values: false };

// "No data" / "Query error" filler, sized to the tile it replaces.
//
// The colour comes from the theme rather than a literal so these two states sit
// in the scene palette like everything else: `useTheme2()` resolves to the theme
// bootstrap.js installed on `config.theme2`, which is built from the --scene-*
// properties. A hardcoded grey here was the one place a panel could still show a
// tone that is not one of the six.
//
// `tone` picks which: 'muted' for an empty result (a fact, not a fault) and
// 'error' for a failed query, which keeps its own hue for the reason set out in
// theme.js — no grey in the palette reads as "this broke".
export function Centered({ width, height, children, tone }) {
  const theme = useTheme2();
  const color = tone === 'error' ? theme.colors.error.text : theme.colors.text.secondary;
  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        fontSize: 13,
        textAlign: 'center',
        padding: 8,
      }}
    >
      {children}
    </div>
  );
}
Centered.propTypes = centeredPropTypes;

export function hasError(data) {
  return data?.state === 'Error' || !!data?.error || !!data?.errors?.length;
}

export function errorMessage(data) {
  return data?.error?.message || data?.errors?.[0]?.message || 'Query error';
}

function orientationOf(options) {
  switch (options?.orientation) {
    case 'horizontal':
      return VizOrientation.Horizontal;
    case 'vertical':
      return VizOrientation.Vertical;
    default:
      return VizOrientation.Auto;
  }
}

/** Shared guard: bail out early on an error or an empty result set. */
function renderGuard(data, width, height) {
  if (hasError(data)) {
    return (
      <Centered width={width} height={height} tone="error">
        {errorMessage(data)}
      </Centered>
    );
  }
  if (!data?.series?.length) {
    return <Centered width={width} height={height}>No data</Centered>;
  }
  return null;
}

// ---- table ---------------------------------------------------------------
// Grafana's own Table. VizPanel has already run applyFieldOverrides on the
// data, so every field arrives with its display processor, unit and thresholds
// attached — the table formats values exactly as the dashboard specifies.

/**
 * The panel-level fieldConfig, with `defaults.custom.cellOptions` guaranteed.
 *
 * @grafana/ui's `guessLongestField` — the row-height estimator, called on every
 * Table render — checks that `defaults.custom` is defined and then reads
 * `defaults.custom.cellOptions.wrapText` without checking `cellOptions`. A table
 * panel whose JSON carries `"custom": {}` (which is what Grafana writes when the
 * panel has no field customisations) therefore throws
 * "Cannot read properties of undefined (reading 'wrapText')" and the panel is
 * replaced by an error boundary.
 *
 * Grafana itself never hits this: `getPanelOptionsWithDefaults` fills
 * `defaults.custom` from the table plugin's own fieldConfig registry before the
 * panel renders, so `cellOptions` is always there. We hand the Table the
 * dashboard's fieldConfig as saved, so the gap is ours to close.
 *
 * Closing it cannot change how anything looks. `Table` reads the panel-level
 * fieldConfig in exactly two places — `defaults.noValue` and this height guess —
 * and the CELLS get their options per-field from `getCellOptions(field)`, which
 * already falls back to the same `{ type: 'auto' }` and already migrates the
 * legacy `custom.displayMode`. So this supplies a value the library was going to
 * default to anyway, one call earlier.
 */
function withCellOptions(fieldConfig) {
  const defaults = fieldConfig?.defaults;
  // No `custom` at all is the case the library already guards, so leave the
  // object identity alone rather than manufacturing config it did not have.
  if (!defaults?.custom || defaults.custom.cellOptions) return fieldConfig;
  return {
    ...fieldConfig,
    defaults: {
      ...defaults,
      custom: { ...defaults.custom, cellOptions: { type: TableCellDisplayMode.Auto } },
    },
  };
}

// One React key per frame for the frame picker: refId and name, with a counter
// only where two frames share both.
function frameKeys(frames) {
  const seen = new Map();
  return frames.map((f) => {
    const base = `${f?.refId ?? ''}|${f?.name ?? ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

function TablePanel({ data, width, height, options, fieldConfig, timeRange }) {
  const frames = data?.series ?? [];
  const [frameIndex, setFrameIndex] = useState(0);
  // Memoised so the Table is not handed a new object on every render — it feeds
  // the virtualised row-height cache, which resets when its input changes.
  const safeFieldConfig = useMemo(() => withCellOptions(fieldConfig), [fieldConfig]);

  const guard = renderGuard(data, width, height);
  if (guard) return guard;

  // A query can return several frames (one per series). Grafana shows a frame
  // selector rather than silently dropping the rest; so do we.
  const index = Math.min(options?.frameIndex ?? frameIndex, frames.length - 1);
  const frame = frames[index];
  if (!frame?.fields?.length) {
    return <Centered width={width} height={height}>No data</Centered>;
  }

  const showPicker = frames.length > 1;
  const pickerKeys = showPicker ? frameKeys(frames) : [];
  const pickerHeight = showPicker ? 26 : 0;

  return (
    <div style={{ width, height }}>
      <Table
        data={frame}
        width={width}
        height={height - pickerHeight}
        noHeader={options?.showHeader === false}
        showTypeIcons={options?.showTypeIcons ?? false}
        resizable
        initialSortBy={options?.sortBy}
        footerOptions={options?.footer}
        enablePagination={options?.footer?.enablePagination ?? false}
        cellHeight={options?.cellHeight}
        fieldConfig={safeFieldConfig}
        timeRange={timeRange}
      />
      {showPicker && (
        <div className="viz-frame-picker">
          {frames.map((f, i) => (
            <button
              key={pickerKeys[i]}
              type="button"
              className={i === index ? 'on' : ''}
              onClick={() => setFrameIndex(i)}
              title={f.name || `Series ${i + 1}`}
            >
              {f.name || `Series ${i + 1}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
TablePanel.propTypes = panelPropTypes;

// ---- gauge ---------------------------------------------------------------

// The reduced, formatted values a gauge, bar gauge or pie draws — one per
// field (or per row, with reduceOptions.values), from Grafana's own pipeline.
function displayValues({ data, options, fieldConfig, replaceVariables, theme, timeZone }) {
  return getFieldDisplayValues({
    data: data?.series ?? [],
    reduceOptions: options?.reduceOptions ?? DEFAULT_REDUCE_OPTIONS,
    fieldConfig: fieldConfig ?? { defaults: {}, overrides: [] },
    replaceVariables: replaceVariables ?? ((v) => v),
    theme,
    timeZone,
  });
}

function GaugePanel({ data, width, height, options, fieldConfig, timeZone, replaceVariables }) {
  const theme = useTheme2();

  const guard = renderGuard(data, width, height);
  if (guard) return guard;

  const getValues = () =>
    displayValues({ data, options, fieldConfig, replaceVariables, theme, timeZone });

  const values = getValues();
  if (!values.length) {
    return <Centered width={width} height={height}>No data</Centered>;
  }

  return (
    <VizRepeater
      getValues={getValues}
      getAlignmentFactors={getDisplayValueAlignmentFactors}
      width={width}
      height={height}
      source={data}
      itemSpacing={4}
      autoGrid
      orientation={orientationOf(options)}
      renderValue={({ value, width: w, height: h }) => (
        // ArcGauge, not @grafana/ui's Gauge — see the import note at the top of
        // this file. Same inputs: `value.display` and `value.field` are what
        // Grafana's own field-config pipeline produced, so the number, unit,
        // decimals, colour and thresholds are the dashboard's, not ours.
        <ArcGauge
          value={value.display}
          width={w}
          height={h}
          field={value.field}
          text={options?.text}
          showThresholdLabels={options?.showThresholdLabels ?? false}
          showThresholdMarkers={options?.showThresholdMarkers ?? true}
          theme={theme}
        />
      )}
    />
  );
}
GaugePanel.propTypes = panelPropTypes;

// ---- bar gauge -----------------------------------------------------------

function barGaugeDisplayMode(options) {
  switch (options?.displayMode) {
    case 'lcd':
      return BarGaugeDisplayMode.Lcd;
    case 'basic':
      return BarGaugeDisplayMode.Basic;
    default:
      return BarGaugeDisplayMode.Gradient;
  }
}

function BarGaugePanel({ data, width, height, options, fieldConfig, timeZone, replaceVariables }) {
  const theme = useTheme2();

  const guard = renderGuard(data, width, height);
  if (guard) return guard;

  const getValues = () =>
    displayValues({ data, options, fieldConfig, replaceVariables, theme, timeZone });

  const values = getValues();
  if (!values.length) {
    return <Centered width={width} height={height}>No data</Centered>;
  }

  const orientation = orientationOf(options);

  return (
    <VizRepeater
      getValues={getValues}
      getAlignmentFactors={getDisplayValueAlignmentFactors}
      width={width}
      height={height}
      source={data}
      itemSpacing={4}
      orientation={orientation}
      renderValue={({ value, width: w, height: h, alignmentFactors, orientation: o }) => (
        <BarGauge
          value={value.display}
          width={w}
          height={h}
          field={value.field}
          orientation={o ?? orientation}
          theme={theme}
          text={options?.text}
          alignmentFactors={alignmentFactors}
          displayMode={barGaugeDisplayMode(options)}
          valueDisplayMode={options?.valueMode === 'hidden'
            ? BarGaugeValueMode.Hidden
            : BarGaugeValueMode.Color}
          showUnfilled={options?.showUnfilled ?? true}
          itemSpacing={options?.minVizWidth ? undefined : 8}
        />
      )}
    />
  );
}
BarGaugePanel.propTypes = panelPropTypes;

// ---- pie chart -----------------------------------------------------------
// One chart for ALL the values, which is what makes this the only panel here
// that does not go through VizRepeater: a pie is a part-of-whole chart, so the
// series are one figure rather than N tiles side by side.

function PieChartPanel({ data, width, height, options, fieldConfig, timeZone, replaceVariables }) {
  const theme = useTheme2();

  const guard = renderGuard(data, width, height);
  if (guard) return guard;

  const values = displayValues({ data, options, fieldConfig, replaceVariables, theme, timeZone });

  if (!values.length) {
    return <Centered width={width} height={height}>No data</Centered>;
  }

  // ./PieChart.jsx rather than @grafana/ui — it ships no pie chart at all. See
  // that file's header.
  return (
    <PieChart
      values={values}
      width={width}
      height={height}
      options={options}
      theme={theme}
    />
  );
}
PieChartPanel.propTypes = panelPropTypes;

// ---- bar chart -----------------------------------------------------------
// The other chart here that draws ALL the series at once rather than repeating a
// tile per value — and the only one that does not reduce them first. A bar chart
// plots the frame's ROWS against a category axis, so reducing each series to a
// single number (what getFieldDisplayValues does for gauge, bar gauge and pie)
// would throw away exactly the dimension being charted. ./BarChart.jsx therefore
// takes the frames as they arrive; VizPanel has already applied every field
// override to them.

function BarChartPanel({ data, width, height, options, fieldConfig }) {
  const theme = useTheme2();

  const guard = renderGuard(data, width, height);
  if (guard) return guard;

  return (
    <BarChart
      series={data?.series ?? []}
      width={width}
      height={height}
      options={options}
      fieldConfig={fieldConfig}
      theme={theme}
    />
  );
}
BarChartPanel.propTypes = panelPropTypes;

// ---- text ----------------------------------------------------------------
// Rendered per the panel's `mode` (markdown / html / code) and SANITISED — see
// ./panelText.js for why both halves of that matter. Variables are interpolated
// first, so `$host`-style text reads correctly.

function TextPanel({ width, height, options, replaceVariables }) {
  const rendered = useMemo(() => {
    const raw = options?.content ?? '';
    let interpolated = raw;
    try {
      interpolated = replaceVariables ? replaceVariables(raw) : raw;
    } catch {
      // An unresolvable variable costs this panel its substitution, not its text.
      interpolated = raw;
    }
    return renderPanelText(interpolated, options?.mode);
  }, [options?.content, options?.mode, replaceVariables]);

  if (!rendered.html && !rendered.text) {
    return <Centered width={width} height={height}>No content</Centered>;
  }

  return (
    <div className="viz-text-panel" style={{ width, height }}>
      {/* dangerouslySetInnerHTML is safe HERE and only here: the string comes
          straight back from DOMPurify.sanitize (see ./panelText.js), which is the
          only thing permitted to produce input for this attribute anywhere in the
          application. Do not widen that. */}
      {rendered.html !== undefined
        ? <div className="viz-text-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        : <pre>{rendered.text}</pre>}
    </div>
  );
}
TextPanel.propTypes = panelPropTypes;

// ---- unsupported ---------------------------------------------------------
// The controlled fallback. A dashboard that uses a plugin we do not render
// keeps its layout, its title and every other panel; only this tile is
// substituted, and the plugin id is logged once so it can be added later.

const reportedUnsupported = new Set();

export function reportUnsupportedPanel(pluginId, panelTitle) {
  const key = String(pluginId);
  if (reportedUnsupported.has(key)) return;
  reportedUnsupported.add(key);
  console.warn(
    `[panels] unsupported panel plugin "${key}"` +
    (panelTitle ? ` (first seen on "${panelTitle}")` : '') +
    ' — rendering a placeholder. Add a renderer in grafana/panelsExtra.jsx and ' +
    'register it in grafana/panelRegistry.js to support it.'
  );
}

export const UNSUPPORTED_PLUGIN_ID = 'app-unsupported-panel';

function UnsupportedPanel({ width, height, options }) {
  const pluginId = options?.originalPluginId || 'unknown';
  return (
    <div className="viz-unsupported" style={{ width, height }}>
      <span className="viz-unsupported-icon" aria-hidden="true">◻</span>
      <span className="viz-unsupported-title">Panel type not supported</span>
      <code className="viz-unsupported-id">{pluginId}</code>
      <span className="viz-unsupported-hint">
        The rest of this dashboard is unaffected.
      </span>
    </div>
  );
}
UnsupportedPanel.propTypes = panelPropTypes;

// ---- plugins -------------------------------------------------------------

export const tablePanelPlugin = new PanelPlugin(TablePanel).useFieldConfig({
  standardOptions: {
    color: { defaultValue: { mode: FieldColorModeId.Thresholds } },
  },
});

export const gaugePanelPlugin = new PanelPlugin(GaugePanel).useFieldConfig({
  standardOptions: {
    color: { defaultValue: { mode: FieldColorModeId.Thresholds } },
  },
});

export const barGaugePanelPlugin = new PanelPlugin(BarGaugePanel).useFieldConfig({
  standardOptions: {
    color: { defaultValue: { mode: FieldColorModeId.Thresholds } },
  },
});

// Grafana's piechart defaults to the classic palette, not to thresholds: a pie
// coloured by threshold would paint every slice the same colour, which is the
// one thing a part-of-whole chart must never do.
export const pieChartPanelPlugin = new PanelPlugin(PieChartPanel).useFieldConfig({
  standardOptions: {
    color: { defaultValue: { mode: FieldColorModeId.PaletteClassic } },
  },
});

// Two defaults, both Grafana's barchart's own rather than the timeseries ones
// the shared registry carries:
//
//  · palette-classic, so a grouped chart gets one colour per series instead of
//    every bar in the same threshold colour, and
//  · fillOpacity 80. This one is not cosmetic: ./fieldConfig.js defaults
//    `custom.fillOpacity` to 0 because that IS the timeseries default (a line
//    with no fill), and a bar drawn at 0 opacity is an invisible bar — the panel
//    would render its axes, its legend and its tooltips over an empty plot.
//    Setting it here rather than in the shared registry keeps every other panel
//    type on the default it already had.
export const barChartPanelPlugin = new PanelPlugin(BarChartPanel).useFieldConfig({
  standardOptions: {
    color: { defaultValue: { mode: FieldColorModeId.PaletteClassic } },
    'custom.fillOpacity': { defaultValue: BAR_FILL_OPACITY },
  },
});

export const textPanelPlugin = new PanelPlugin(TextPanel);

export const unsupportedPanelPlugin = new PanelPlugin(UnsupportedPanel);
