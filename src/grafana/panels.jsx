// ---------------------------------------------------------------------------
// Panel renderers, backed by Grafana's OWN visualization components from
// @grafana/ui (uPlot-based TimeSeries, and BigValue for stat). These are
// registered under the core panel ids ("timeseries", "stat") so Scenes'
// VizPanel renders them exactly as if the dashboard asked for the real panels.
//
// Both plugins call .useFieldConfig() — without it PanelPlugin builds an EMPTY
// fieldConfigRegistry and Grafana silently discards the dashboard's units,
// thresholds, colour modes and graph styling. See ./fieldConfig.js.
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

import {
  PanelPlugin,
  FieldColorModeId,
  VizOrientation,
  getFieldDisplayValues,
  getDisplayValueAlignmentFactors,
  ReducerID,
} from '@grafana/data';
// TooltipDisplayMode/SortOrder are runtime enums that live in @grafana/schema;
// @grafana/ui only re-exports them as types.
import { TooltipDisplayMode, SortOrder } from '@grafana/schema';
import {
  TimeSeries,
  TooltipPlugin,
  ZoomPlugin,
  BigValue,
  BigValueColorMode,
  BigValueGraphMode,
  BigValueJustifyMode,
  BigValueTextMode,
  VizRepeater,
  useTheme2,
} from '@grafana/ui';

import { registerStandardFieldConfig } from './fieldConfig.js';
import { panelPropTypes, centeredPropTypes } from './panelPropTypes.js';

// Must happen before the PanelPlugins below build their fieldConfigRegistry.
// (Registry.setInit() throws once the registry has been read, and the plugins
// read it lazily on first render — so registering here is both safe and early
// enough regardless of module import order.)
registerStandardFieldConfig();

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
function Centered({ width, height, children, tone }) {
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

function errorMessage(data) {
  return data?.error?.message || data?.errors?.[0]?.message || 'Query error';
}

function hasError(data) {
  return data?.state === 'Error' || !!data?.error || !!data?.errors?.length;
}

// A frame is graphable only if it has a time field AND a numeric field.
// Prometheus returns an empty (zero-field) frame when a series has no data;
// passing that to GraphNG crashes it (unguarded xField.name), so filter first.
function graphableFrames(series) {
  return (series || []).filter(
    (f) =>
      f?.fields?.length &&
      f.fields.some((x) => x.type === 'time') &&
      f.fields.some((x) => x.type === 'number')
  );
}

// ---- timeseries ----------------------------------------------------------
const DEFAULT_LEGEND = { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] };
const DEFAULT_TOOLTIP = { mode: TooltipDisplayMode.Single, sort: SortOrder.None };

function TimeSeriesPanel({ data, width, height, options, timeRange, timeZone, onChangeTimeRange }) {
  if (hasError(data)) {
    return (
      <Centered width={width} height={height} tone="error">
        {errorMessage(data)}
      </Centered>
    );
  }
  const frames = graphableFrames(data?.series);
  if (!frames.length) {
    return <Centered width={width} height={height}>No data</Centered>;
  }

  // Use the time range explicitly set in setRunRequest (data.timeRange) so the
  // X-axis always zooms to exactly the selected window (15 min, 1 h, etc.).
  const effectiveRange = data?.timeRange ?? data?.request?.range ?? timeRange;

  // Resolve range boundaries safely whether they are Moment/DateTime objects
  // or raw string properties from a fallback SceneTimeRange state.
  const fromVal = effectiveRange?.from ?? effectiveRange?.state?.from;
  const toVal = effectiveRange?.to ?? effectiveRange?.state?.to;
  const fromStr = typeof fromVal?.valueOf === 'function' ? fromVal.valueOf() : String(fromVal ?? '');
  const toStr = typeof toVal?.valueOf === 'function' ? toVal.valueOf() : String(toVal ?? '');
  const rangeKey = `${fromStr}-${toStr}`;

  const legend = options?.legend ?? DEFAULT_LEGEND;
  const tooltip = options?.tooltip ?? DEFAULT_TOOLTIP;
  const tz = timeZone || 'browser';

  return (
    <TimeSeries
      key={rangeKey}
      frames={frames}
      width={width}
      height={height}
      timeRange={effectiveRange}
      timeZone={tz}
      legend={legend}
    >
      {(uplotConfig, alignedFrame) => (
        <>
          {/* Hover tooltip — Grafana's own, honouring the panel's tooltip mode. */}
          <TooltipPlugin
            config={uplotConfig}
            data={alignedFrame}
            frames={frames}
            mode={tooltip.mode ?? TooltipDisplayMode.Single}
            sortOrder={tooltip.sort ?? SortOrder.None}
            timeZone={tz}
          />
          {/* Drag-to-zoom on the X axis, like a real Grafana panel. */}
          {onChangeTimeRange && <ZoomPlugin config={uplotConfig} onZoom={onChangeTimeRange} />}
        </>
      )}
    </TimeSeries>
  );
}
TimeSeriesPanel.propTypes = panelPropTypes;

// ---- stat ----------------------------------------------------------------
const DEFAULT_REDUCE_OPTIONS = { calcs: [ReducerID.lastNotNull], fields: '', values: false };

function statTextMode(options, displayCount) {
  switch (options?.textMode) {
    case 'value_and_name':
      return BigValueTextMode.ValueAndName;
    case 'name':
      return BigValueTextMode.Name;
    case 'none':
      return BigValueTextMode.None;
    case 'value':
      return BigValueTextMode.Value;
    default:
      // Grafana's "auto": with one value the panel header already carries the
      // name, so show just the number; with several, label each one.
      return displayCount > 1 ? BigValueTextMode.ValueAndName : BigValueTextMode.Value;
  }
}

function statColorMode(options) {
  switch (options?.colorMode) {
    case 'background':
      return BigValueColorMode.Background;
    case 'background_solid':
      return BigValueColorMode.BackgroundSolid;
    case 'none':
      return BigValueColorMode.None;
    default:
      return BigValueColorMode.Value;
  }
}

function statGraphMode(options) {
  return options?.graphMode === 'none' ? BigValueGraphMode.None : BigValueGraphMode.Area;
}

function statOrientation(options) {
  switch (options?.orientation) {
    case 'horizontal':
      return VizOrientation.Horizontal;
    case 'vertical':
      return VizOrientation.Vertical;
    default:
      return VizOrientation.Auto;
  }
}

function StatPanel({ data, width, height, options, fieldConfig, timeZone, replaceVariables, renderCounter }) {
  const theme = useTheme2();

  if (hasError(data)) {
    return (
      <Centered width={width} height={height} tone="error">
        {errorMessage(data)}
      </Centered>
    );
  }

  const graphMode = statGraphMode(options);

  // Grafana's own reducer pipeline: honours options.reduceOptions (calcs,
  // fields filter, values-vs-series, limit) and produces one FieldDisplay per
  // value — so a multi-series stat panel shows every series, exactly like
  // Grafana, instead of only the first one.
  const getValues = () =>
    getFieldDisplayValues({
      data: data?.series ?? [],
      reduceOptions: options?.reduceOptions ?? DEFAULT_REDUCE_OPTIONS,
      fieldConfig: fieldConfig ?? { defaults: {}, overrides: [] },
      replaceVariables: replaceVariables ?? ((v) => v),
      sparkline: graphMode !== BigValueGraphMode.None,
      percentChange: options?.showPercentChange ?? false,
      theme,
      timeZone,
    });

  const values = getValues();
  if (!values.length) {
    return <Centered width={width} height={height}>No data</Centered>;
  }

  const colorMode = statColorMode(options);
  const textMode = statTextMode(options, values.length);
  const justifyMode =
    options?.justifyMode === 'center' ? BigValueJustifyMode.Center : BigValueJustifyMode.Auto;

  return (
    <VizRepeater
      getValues={getValues}
      getAlignmentFactors={getDisplayValueAlignmentFactors}
      width={width}
      height={height}
      source={data}
      itemSpacing={3}
      renderCounter={renderCounter ?? 0}
      autoGrid
      orientation={statOrientation(options)}
      renderValue={({ value, width: w, height: h, alignmentFactors, count }) => (
        <BigValue
          value={value.display}
          sparkline={graphMode === BigValueGraphMode.None ? undefined : value.sparkline}
          colorMode={colorMode}
          graphMode={graphMode}
          justifyMode={justifyMode}
          textMode={textMode}
          alignmentFactors={alignmentFactors}
          text={options?.text}
          width={w}
          height={h}
          theme={theme}
          count={count}
        />
      )}
    />
  );
}
StatPanel.propTypes = panelPropTypes;

// Grafana's timeseries panel defaults every series to the classic palette;
// stat defaults to threshold-based colouring. Without these defaults a
// dashboard that omits `color` would render every series the same colour.
export const timeseriesPanelPlugin = new PanelPlugin(TimeSeriesPanel).useFieldConfig({
  standardOptions: {
    color: { defaultValue: { mode: FieldColorModeId.PaletteClassic } },
  },
});

export const statPanelPlugin = new PanelPlugin(StatPanel).useFieldConfig({
  standardOptions: {
    color: { defaultValue: { mode: FieldColorModeId.Thresholds } },
  },
});
