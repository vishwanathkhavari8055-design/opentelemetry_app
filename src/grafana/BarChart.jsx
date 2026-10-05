/**
 * The bar chart visualization, drawn in SVG.
 *
 * ─── Why this exists instead of @grafana/ui's BarChart ──────────────────────
 *
 * It does not have one. Same story as ./PieChart.jsx: grep the published bundle
 * for `BarChart` and there are ZERO hits — the component lives in
 * grafana/public/app/plugins/panel/barchart and is not part of @grafana/ui at
 * all. So a `barchart` panel had no renderer to register and every one fell
 * through to the unsupported placeholder tile, leaving a grey box in the middle
 * of an otherwise complete dashboard.
 *
 * ─── It is not a reimplementation of Grafana's field pipeline ───────────────
 *
 * Everything per-field arrives already computed, exactly as in ./PieChart.jsx
 * and ./ArcGauge.jsx. VizPanel has run applyFieldOverrides() before this
 * renders, so each numeric field carries its own display processor (unit,
 * decimals, value mappings), its colour mode and its thresholds. This component
 * asks those for text and colour; it only decides where to put ink.
 *
 * The two things it does compute are properties of the SET, which no per-field
 * pipeline can produce:
 *
 *   · the CATEGORY AXIS — the union of x values across every frame, in
 *     first-seen order (see prepareBars: that union IS the join), and
 *   · the STACK offsets, when the panel asks for stacking.
 *
 * ─── Multi-frame input is joined, not rejected ──────────────────────────────
 *
 * Grafana's own barchart wants a single frame and warns when it gets more. That
 * warning would be useless here: a Prometheus query with a label dimension
 * returns ONE FRAME PER SERIES, which is the ordinary case on these dashboards,
 * and refusing it would leave the same empty tile the placeholder already left.
 * So frames are joined on their x values instead — a category missing from one
 * frame becomes a gap in that series, never a bar shifted into another's slot.
 */

// The propTypes below are loose for the same reason as in ./PieChart.jsx and
// ./panelsExtra.jsx: every prop is part of a THIRD PARTY's contract — `series`
// is Grafana DataFrame[], `options` and `fieldConfig` are the panel's own JSON,
// `theme` is a GrafanaTheme2. Restating those shapes in full would be a second,
// immediately-stale copy of Grafana's own types.

import { useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  FieldType,
  formattedValueToString,
  getFieldColorModeForField,
  getFieldDisplayName,
  getFieldSeriesColor,
  reduceField,
} from '@grafana/data';
import { LegendDisplayMode } from '@grafana/schema';
import { VizLegend } from '@grafana/ui';

// Grafana's own barchart defaults, so a panel that omits a key renders the way
// it does in Grafana.
const DEFAULT_GROUP_WIDTH = 0.7;   // share of a category slot the bars occupy
const DEFAULT_BAR_WIDTH = 0.97;    // share of its own share a bar fills
/**
 * Grafana's barchart fill, in percent. Exported because the PanelPlugin in
 * ./panelsExtra.jsx has to declare the SAME number as its field-config default —
 * see the note there for why the shared registry's 0 will not do.
 */
export const BAR_FILL_OPACITY = 80;

const AXIS_FONT_SIZE = 11;
/** Average glyph advance at AXIS_FONT_SIZE. Only ever used to SIZE gutters. */
const CHAR_WIDTH = 6;
const VALUE_TICK_TARGET = 4;
const AXIS_GUTTER = 8;
const AXIS_LABEL_BAND = 20;

/** Below this a value label does not fit against its bar. */
const MIN_LABEL_THICKNESS = 13;

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

const numberOr = (value, fallback) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/** Whether this field asked to be hidden from the viz or from the legend. */
function hiddenFrom(field, where) {
  return field?.config?.custom?.hideFrom?.[where] === true;
}

/**
 * A field's value at row `i`.
 *
 * Grafana 10+ hands fields a plain array, but a DataFrame that came through an
 * older code path can still carry a Vector with .get() — and reading `[i]` off
 * one of those yields undefined for every row, which draws an EMPTY chart rather
 * than throwing. Two lines to never debug that.
 */
function valueAt(field, i) {
  const values = field?.values;
  if (!values) return undefined;
  return typeof values.get === 'function' ? values.get(i) : values[i];
}

/**
 * A field's value at row `i` as a number, or null when there is no value.
 *
 * The explicit null/'' test is the point. `Number(null)` is 0 and `Number('')`
 * is 0, so a plain `Number()` turns every GAP in a series into a bar sitting at
 * zero — which on a "failures by service" chart reads as "measured, and it was
 * none" when the truth is "not measured at all". Grafana draws a gap; so does
 * this.
 */
function numericAt(field, i) {
  const raw = valueAt(field, i);
  if (raw === null || raw === undefined || raw === '') return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function rowCountOf(frame) {
  if (typeof frame?.length === 'number') return frame.length;
  return frame?.fields?.[0]?.values?.length ?? 0;
}

/** Formatted text for a value, through the field's OWN display processor. */
function textOf(field, value) {
  if (field?.display) {
    try {
      return formattedValueToString(field.display(value));
    } catch {
      // A display processor that throws costs this one label its formatting,
      // not the panel its chart.
    }
  }
  return value == null ? '' : String(value);
}

/**
 * The field whose values label the category axis.
 *
 * `options.xField` wins when the panel names one. Otherwise the first string
 * field, then the first time field — Grafana's own order, and the reason a
 * "count by status" frame bars by status rather than by row number.
 *
 * `xField` is matched against the DISPLAY name as well as the raw one, because
 * that is the name the dashboard author saw when they picked it: a panel whose
 * `organize` transformation renames `x_axis_1` to "DAG" saves `xField: "DAG"`,
 * and a raw-name-only match would miss it and silently bar by the wrong column.
 *
 * Returns null when the frame has neither a string nor a time field, where
 * Grafana warns "Bar charts requires a string or time field". Falling back to row
 * ordinals instead is strictly more useful: an all-numeric frame still draws, and
 * the alternative is the empty tile this whole file exists to remove.
 */
function pickXField(frame, frames, wanted) {
  const fields = frame.fields || [];
  if (wanted) {
    const named = fields.find((f) => f.name === wanted
      || f.config?.displayName === wanted
      || getFieldDisplayName(f, frame, frames) === wanted);
    if (named) return named;
  }
  return fields.find((f) => f.type === FieldType.string)
    ?? fields.find((f) => f.type === FieldType.time)
    ?? null;
}

/**
 * Category keys for one frame's rows, registering any not seen before.
 * First-seen order is deliberate: it keeps the order the query returned,
 * which a sort would throw away for a "count by region" chart.
 */
function registerRowCategories(xField, rowCount, categories, categoryIndex) {
  const rowCategory = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    const key = xField ? textOf(xField, valueAt(xField, i)) : String(i + 1);
    rowCategory[i] = key;
    if (!categoryIndex.has(key)) {
      categoryIndex.set(key, categories.length);
      categories.push(key);
    }
  }
  return rowCategory;
}

/** One numeric field -> one bar series, its values already aligned to the categories. */
function makeBar(field, frame, frames, theme, values, id) {
  return {
    id,
    field,
    name: getFieldDisplayName(field, frame, frames),
    color: getFieldSeriesColor(field, theme).color,
    // A by-value colour mode (thresholds, or any continuous-* scale) colours
    // each BAR by its own value; every other mode gives the series one
    // colour. The same split Grafana makes — asked of Grafana's own registry
    // rather than matched against a list of mode ids that will grow.
    byValue: getFieldColorModeForField(field).isByValue === true,
    hideFromLegend: hiddenFrom(field, 'legend'),
    values,
  };
}

/**
 * Frames -> { categories, bars }.
 *
 * `bars` is one entry per numeric field across every frame, each carrying values
 * aligned to `categories` BY INDEX (null where that series has no value for a
 * category). Everything downstream indexes by position, so the alignment done
 * here is the only place the join can go wrong.
 */
function prepareBars(series, options, theme) {
  const frames = (series || []).filter((f) => Array.isArray(f?.fields) && f.fields.length);

  const categories = [];
  const categoryIndex = new Map();
  const bars = [];

  for (const frame of frames) {
    const rowCount = rowCountOf(frame);
    if (!rowCount) continue;

    const xField = pickXField(frame, frames, options?.xField);
    const valueFields = frame.fields.filter(
      (f) => f !== xField && f.type === FieldType.number && !hiddenFrom(f, 'viz'),
    );
    if (!valueFields.length) continue;

    const rowCategory = registerRowCategories(xField, rowCount, categories, categoryIndex);

    for (const field of valueFields) {
      const values = new Array(categories.length).fill(null);
      for (let i = 0; i < rowCount; i += 1) {
        values[categoryIndex.get(rowCategory[i])] = numericAt(field, i);
      }
      bars.push(makeBar(field, frame, frames, theme, values, `series-${bars.length}`));
    }
  }

  // Bars built before a later frame widened the axis are short; pad them so
  // every series is indexable at every category.
  for (const bar of bars) {
    for (let i = bar.values.length; i < categories.length; i += 1) bar.values[i] = null;
  }

  return { categories, bars };
}

/**
 * Stacking mode, from wherever this panel keeps it.
 *
 * barchart puts it in panel OPTIONS (unlike timeseries, which puts it in each
 * field's custom config) — but a dashboard converted from a graph panel can
 * carry the field-config form instead, and reading only one of the two silently
 * unstacks a chart that asked to be stacked.
 */
function stackingMode(options, fieldConfig) {
  const raw = options?.stacking ?? fieldConfig?.defaults?.custom?.stacking;
  const mode = typeof raw === 'string' ? raw : raw?.mode;
  return mode === 'normal' || mode === 'percent' ? mode : 'none';
}

/**
 * Per-category, per-series segments in VALUE space: { value, start, end }.
 *
 * Unstacked, every segment starts at the baseline. Stacked, positives and
 * negatives accumulate SEPARATELY — sharing one cursor would draw a -5 on top of
 * a +5 as though it cancelled the bar, which is not what either value means.
 * Percent divides by the category's total magnitude, so a category summing to
 * zero contributes flat segments rather than dividing by it.
 */
function computeSegments(categories, bars, stacking) {
  return categories.map((_, ci) => {
    const totalMagnitude = stacking === 'percent'
      ? bars.reduce((sum, bar) => sum + Math.abs(bar.values[ci] ?? 0), 0)
      : 0;

    let up = 0;
    let down = 0;

    return bars.map((bar) => {
      const raw = bar.values[ci];
      if (raw == null || !Number.isFinite(raw)) return null;

      if (stacking === 'none') {
        return { value: raw, start: 0, end: raw };
      }

      let scaled = raw;
      if (stacking === 'percent') scaled = totalMagnitude ? raw / totalMagnitude : 0;
      if (!scaled) return { value: raw, start: 0, end: 0 };

      if (scaled > 0) {
        const start = up;
        up += scaled;
        return { value: raw, start, end: up };
      }
      const start = down;
      down += scaled;
      return { value: raw, start, end: down };
    });
  });
}

/**
 * The value axis domain.
 *
 * ALWAYS includes the baseline: an axis starting at 900 for values of 900-1000
 * would draw one bar ten times the height of its neighbour for a 10% difference,
 * which is the classic way to lie with a bar chart. Explicit min/max in the field
 * config still win — a dashboard that asked for a zoomed axis gets one.
 */
function valueDomain(segments, bars, stacking) {
  let min = 0;
  let max = 0;
  for (const row of segments) {
    for (const segment of row) {
      if (!segment) continue;
      min = Math.min(min, segment.start, segment.end);
      max = Math.max(max, segment.start, segment.end);
    }
  }

  const config = bars[0]?.field?.config ?? {};
  const custom = config.custom ?? {};
  if (stacking !== 'percent') {
    min = numberOr(config.min, Math.min(min, numberOr(custom.axisSoftMin, min)));
    max = numberOr(config.max, Math.max(max, numberOr(custom.axisSoftMax, max)));
  }

  // All zero (or one flat series) leaves no extent to scale against.
  if (max <= min) return { min, max: min + 1 };
  return { min, max };
}

/** Text anchor for a category label tilted by `rotation` degrees. */
function rotatedAnchor(rotation) {
  if (!rotation) return 'middle';
  return rotation < 0 ? 'end' : 'start';
}

/** The 1-2-5 step, scaled to 1..10, that a rough step rounds up to. */
function niceStepFactor(normalized) {
  if (normalized <= 1) return 1;
  if (normalized <= 2) return 2;
  if (normalized <= 5) return 5;
  return 10;
}

/** Round, human tick values covering [min, max]. */
function niceTicks(min, max, target) {
  const span = max - min;
  if (span <= 0) return [min];

  const rough = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = niceStepFactor(normalized) * magnitude;

  const ticks = [];
  // The epsilon is what keeps the top tick when `max` lands exactly on a step and
  // floating point puts it a fraction above.
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks.length ? ticks : [min, max];
}

/**
 * The longest string in a list, in characters.
 *
 * A loop rather than `Math.max(...list.map(...))` because the category list is
 * one entry PER DATA POINT — spreading a few thousand arguments is how that
 * idiom turns a wide chart into a RangeError.
 */
function longestLength(list) {
  let longest = 0;
  for (const item of list) longest = Math.max(longest, item.length);
  return longest;
}

/** Ellipsised to `max` characters, or unchanged when max is not set. */
function truncate(text, max) {
  if (!max || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Legend rows, in the shape @grafana/ui's VizLegend wants. */
function legendItems(bars, calcs) {
  const wanted = Array.isArray(calcs) ? calcs : [];
  return bars
    .filter((bar) => !bar.hideFromLegend)
    .map((bar, i) => ({
      label: bar.name,
      color: bar.color,
      yAxis: 1,
      getItemKey: () => `${bar.name}-${i}`,
      // Only table mode renders these, and only when the dashboard asked for
      // calcs — reducing every series on every render otherwise would be work
      // nothing displays.
      getDisplayValues: wanted.length
        ? () => {
          const reduced = reduceField({ field: bar.field, reducers: wanted });
          return wanted.map((calc) => {
            const value = reduced[calc];
            const display = bar.field.display?.(value);
            return {
              title: calc,
              text: display ? formattedValueToString(display) : String(value ?? ''),
              numeric: Number(value),
            };
          });
        }
        : undefined,
    }));
}

function chartColors(theme) {
  return {
    mutedColor: theme?.colors?.text?.secondary || 'rgba(255, 255, 255, 0.62)',
    inkColor: theme?.colors?.text?.primary || '#ffffff',
    gridColor: theme?.colors?.border?.weak || 'rgba(255, 255, 255, 0.12)',
  };
}

/** The legend's items and placement, and the chart area left beside it. */
function legendLayout(options, bars, width, height) {
  const legend = options?.legend ?? {};
  const showLegend = legend.showLegend !== false && legend.displayMode !== 'hidden';
  const legendOnRight = legend.placement === 'right';
  const items = showLegend ? legendItems(bars, legend.calcs) : [];
  const hasLegend = items.length > 0;
  const legendExtent = legendExtentFor(hasLegend, legendOnRight, items.length, width, height);
  return {
    legend,
    legendOnRight,
    items,
    hasLegend,
    legendExtent,
    chartWidth: legendOnRight ? width - legendExtent : width,
    chartHeight: legendOnRight ? height : height - legendExtent,
  };
}

/**
 * Grafana's "auto": bars run ACROSS a tile that is taller than it is wide, and
 * UP one that is wider than it is tall.
 */
function isHorizontal(orientation, chartWidth, chartHeight) {
  if (orientation === 'horizontal') return true;
  return orientation !== 'vertical' && chartWidth < chartHeight;
}

/** The plotting area inside the chart, once both axes' gutters are taken out. */
function plotBox(horizontal, categoryGutter, valueGutter, chartWidth, chartHeight) {
  const plotLeft = horizontal ? categoryGutter : valueGutter;
  const plotTop = 6;
  return {
    plotLeft,
    plotTop,
    plotWidth: chartWidth - plotLeft - AXIS_GUTTER,
    plotHeight: chartHeight - plotTop - (horizontal ? AXIS_LABEL_BAND : categoryGutter),
  };
}

/** A bar's thickness: grouped bars share their group, stacked ones each fill it. */
function barThickness(stacking, groupExtent, barCount, barFraction) {
  return stacking === 'none'
    ? Math.max(1, (groupExtent / barCount) * barFraction)
    : Math.max(1, groupExtent * barFraction);
}

function legendDisplayMode(displayMode) {
  return displayMode === 'table' ? LegendDisplayMode.Table : LegendDisplayMode.List;
}

/**
 * Category labels are dropped WHOLE rather than overlapped: half a label is
 * worse than none, and the tooltip still names every bar.
 */
function categoryLabelStride(everyLabel, longestCategory, slot) {
  if (everyLabel) return 1;
  return Math.max(1, Math.ceil((longestCategory + 4) / Math.max(1, slot)));
}

/**
 * How much of the tile the legend takes. A FRACTION rather than a row count: a
 * twelve-series legend in a short tile would otherwise take the whole height
 * and leave a chart three pixels tall.
 */
function legendExtentFor(hasLegend, legendOnRight, itemCount, width, height) {
  if (!hasLegend) return 0;
  if (legendOnRight) return clamp(Math.round(width * 0.3), 80, 200);
  const legendRows = Math.ceil(itemCount / Math.max(1, Math.floor(width / 140)));
  return clamp(legendRows * 18 + 4, 22, Math.round(height * 0.4));
}

/** Room reserved for the category labels, allowing for their rotation. */
function categoryGutterFor(horizontal, rotation, longestCategory, chartWidth, chartHeight) {
  if (horizontal) {
    return clamp(longestCategory + AXIS_GUTTER, 40, Math.round(chartWidth * 0.45));
  }
  if (!rotation) return AXIS_LABEL_BAND;
  return clamp(
    Math.abs(Math.sin((rotation * Math.PI) / 180)) * longestCategory + AXIS_GUTTER + 6,
    AXIS_LABEL_BAND,
    Math.round(chartHeight * 0.4),
  );
}

function tickLabel(tick, asPercent, field) {
  return asPercent ? `${Math.round(tick * 100)}%` : textOf(field, tick);
}

function shouldDrawValues(showValue, thickness) {
  if (showValue === 'always') return true;
  return showValue !== 'never' && thickness >= MIN_LABEL_THICKNESS;
}

/** A bar segment's fill colour, fill opacity (0-1) and outline width. */
function barPaint(bar, value, inkColor) {
  const own = bar.byValue ? bar.field.display?.(value)?.color : bar.color;
  const custom = bar.field.config?.custom;
  return {
    color: own || bar.color || inkColor,
    fillOpacity: clamp(numberOr(custom?.fillOpacity, BAR_FILL_OPACITY), 0, 100) / 100,
    lineWidth: clamp(numberOr(custom?.lineWidth, 1), 0, 10),
  };
}

/**
 * Where a bar's value label sits: past the bar's end when the bars are grouped,
 * centred inside the segment when they are stacked.
 */
function valueLabelPlacement({ horizontal, stacked, positive, rect, offset, valueFontSize }) {
  if (horizontal) {
    return {
      x: horizontalLabelX(stacked, positive, rect),
      y: offset,
      textAnchor: horizontalLabelAnchor(stacked, positive),
      dominantBaseline: 'middle',
    };
  }
  return {
    x: offset,
    y: verticalLabelY(stacked, positive, rect, valueFontSize),
    textAnchor: 'middle',
    dominantBaseline: stacked ? 'middle' : 'auto',
  };
}

function horizontalLabelX(stacked, positive, rect) {
  if (stacked) return rect.x + rect.width / 2;
  return positive ? rect.x + rect.width + 4 : rect.x - 4;
}

function horizontalLabelAnchor(stacked, positive) {
  if (stacked) return 'middle';
  return positive ? 'start' : 'end';
}

function verticalLabelY(stacked, positive, rect, valueFontSize) {
  if (stacked) return rect.y + rect.height / 2;
  return positive ? rect.y - 4 : rect.y + rect.height + valueFontSize;
}

export function BarChart({ series, width, height, options, fieldConfig, theme }) {
  const { categories, bars } = useMemo(
    () => prepareBars(series, options, theme),
    [series, options, theme],
  );

  const stacking = stackingMode(options, fieldConfig);
  const segments = useMemo(
    () => computeSegments(categories, bars, stacking),
    [categories, bars, stacking],
  );

  const { mutedColor, inkColor, gridColor } = chartColors(theme);

  if (!categories.length || !bars.length) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: mutedColor,
          fontSize: 13,
        }}
      >
        No data
      </div>
    );
  }

  const {
    legend, legendOnRight, items, hasLegend, legendExtent, chartWidth, chartHeight,
  } = legendLayout(options, bars, width, height);

  const horizontal = isHorizontal(options?.orientation, chartWidth, chartHeight);

  const { min, max } = valueDomain(segments, bars, stacking);
  const ticks = niceTicks(min, max, VALUE_TICK_TARGET);
  const asPercent = stacking === 'percent';
  const tickLabels = ticks.map((tick) => tickLabel(tick, asPercent, bars[0]?.field));

  const valueGutter = clamp(
    longestLength(tickLabels) * CHAR_WIDTH + AXIS_GUTTER,
    28,
    Math.round(chartWidth * 0.4),
  );

  const categoryLabels = categories.map((c) => truncate(c, options?.xTickLabelMaxLength ?? 0));
  const rotation = numberOr(options?.xTickLabelRotation, 0);
  const longestCategory = longestLength(categoryLabels) * CHAR_WIDTH;

  const categoryGutter = categoryGutterFor(
    horizontal, rotation, longestCategory, chartWidth, chartHeight,
  );

  const { plotLeft, plotTop, plotWidth, plotHeight } = plotBox(
    horizontal, categoryGutter, valueGutter, chartWidth, chartHeight,
  );

  // A tile too small to draw in is not an error — react-grid-layout reports a
  // width of 0 for a beat on mount, and a negative-dimension <rect> is a DOM
  // error in every browser.
  if (plotWidth <= 0 || plotHeight <= 0) {
    return <div style={{ width, height }} />;
  }

  // Category axis geometry. `slot` is one category's share of the axis; the
  // group is what the bars may use inside it, and the gap between groups is
  // whatever is left — which is why groupWidth is a fraction, not a pixel count.
  const [categoryExtent, valueExtent] = horizontal
    ? [plotHeight, plotWidth]
    : [plotWidth, plotHeight];
  const slot = categoryExtent / categories.length;
  const groupExtent = slot * clamp(numberOr(options?.groupWidth, DEFAULT_GROUP_WIDTH), 0.1, 1);
  const barFraction = clamp(numberOr(options?.barWidth, DEFAULT_BAR_WIDTH), 0.1, 1);
  const thickness = barThickness(stacking, groupExtent, bars.length, barFraction);
  const barRadius = clamp(numberOr(options?.barRadius, 0), 0, 0.5) * thickness;

  /** Value -> pixels along the value axis (already flipped for vertical). */
  const valuePos = (value) => {
    const fraction = (value - min) / (max - min);
    return horizontal
      ? plotLeft + fraction * valueExtent
      : plotTop + plotHeight - fraction * valueExtent;
  };

  /** Category index -> the centre of its slot, along the category axis. */
  const categoryPos = (index) => (horizontal
    ? plotTop + (index + 0.5) * slot
    : plotLeft + (index + 0.5) * slot);

  const baseline = valuePos(clamp(0, min, max));

  const valueFontSize = numberOr(options?.text?.valueSize, AXIS_FONT_SIZE);
  const drawValues = shouldDrawValues(options?.showValue ?? 'auto', thickness);

  const labelStride = categoryLabelStride(rotation || horizontal, longestCategory, slot);

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: legendOnRight ? 'row' : 'column',
        overflow: 'hidden',
      }}
    >
      <svg width={chartWidth} height={chartHeight} aria-label="Bar chart">
        {/* Value axis: one grid line and one label per tick. */}
        {ticks.map((tick, i) => {
          const pos = valuePos(tick);
          return (
            <g key={`tick-${tick}`}>
              <line
                x1={horizontal ? pos : plotLeft}
                y1={horizontal ? plotTop : pos}
                x2={horizontal ? pos : plotLeft + plotWidth}
                y2={horizontal ? plotTop + plotHeight : pos}
                stroke={gridColor}
                strokeWidth={1}
              />
              <text
                x={horizontal ? pos : plotLeft - 6}
                y={horizontal ? plotTop + plotHeight + 13 : pos}
                fill={mutedColor}
                fontSize={AXIS_FONT_SIZE}
                textAnchor={horizontal ? 'middle' : 'end'}
                dominantBaseline={horizontal ? 'auto' : 'middle'}
              >
                {tickLabels[i]}
              </text>
            </g>
          );
        })}

        {/* Category axis labels. */}
        {categoryLabels.map((label, ci) => {
          if (!horizontal && ci % labelStride !== 0) return null;
          const pos = categoryPos(ci);

          if (horizontal) {
            return (
              <text
                key={`cat-${categories[ci]}`}
                x={plotLeft - 6}
                y={pos}
                fill={mutedColor}
                fontSize={AXIS_FONT_SIZE}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {label}
              </text>
            );
          }

          const y = plotTop + plotHeight + 13;
          return (
            <text
              key={`cat-${categories[ci]}`}
              x={pos}
              y={y}
              fill={mutedColor}
              fontSize={AXIS_FONT_SIZE}
              textAnchor={rotatedAnchor(rotation)}
              dominantBaseline={rotation ? 'middle' : 'auto'}
              transform={rotation ? `rotate(${rotation} ${pos} ${y})` : undefined}
            >
              {label}
            </text>
          );
        })}

        {/* Bars. */}
        {segments.map((row, ci) => {
          const centre = categoryPos(ci);
          const groupStart = centre - groupExtent / 2;

          return row.map((segment, bi) => {
            if (!segment) return null;
            const bar = bars[bi];

            const offset = stacking === 'none'
              ? groupStart + (bi + 0.5) * (groupExtent / bars.length)
              : centre;
            const from = valuePos(segment.start);
            const to = valuePos(segment.end);
            const near = Math.min(from, to);
            // A zero-extent <rect> draws nothing at all, so a real-but-tiny value
            // keeps one pixel: the difference between "no bar" and "almost no
            // bar" is the whole reason for plotting it.
            const extent = Math.max(Math.abs(to - from), segment.value ? 1 : 0);

            const rect = horizontal
              ? { x: near, y: offset - thickness / 2, width: extent, height: thickness }
              : { x: offset - thickness / 2, y: near, width: thickness, height: extent };

            const { color, fillOpacity, lineWidth } = barPaint(bar, segment.value, inkColor);

            const valueText = textOf(bar.field, segment.value);
            const label = valueLabelPlacement({
              horizontal,
              stacked: stacking !== 'none',
              positive: segment.end >= segment.start,
              rect,
              offset,
              valueFontSize,
            });

            return (
              <g key={`bar-${categories[ci]}-${bar.id}`}>
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  rx={barRadius}
                  fill={color}
                  fillOpacity={fillOpacity}
                  stroke={lineWidth ? color : 'none'}
                  strokeWidth={lineWidth}
                />
                {/* Native hover text. Grafana's own tooltip is a portal-and-uPlot
                    affair this component has no equivalent of; a <title> says the
                    same thing and costs nothing. */}
                <title>{`${categories[ci]} · ${bar.name}: ${valueText}`}</title>
                {drawValues && (
                  <text
                    x={label.x}
                    y={label.y}
                    fill={inkColor}
                    fontSize={valueFontSize}
                    textAnchor={label.textAnchor}
                    dominantBaseline={label.dominantBaseline}
                  >
                    {valueText}
                  </text>
                )}
              </g>
            );
          });
        })}

        {/* The baseline, drawn last so no bar sits on top of it. */}
        <line
          x1={horizontal ? baseline : plotLeft}
          y1={horizontal ? plotTop : baseline}
          x2={horizontal ? baseline : plotLeft + plotWidth}
          y2={horizontal ? plotTop + plotHeight : baseline}
          stroke={mutedColor}
          strokeWidth={1}
        />
      </svg>

      {hasLegend && (
        <div
          style={{
            width: legendOnRight ? legendExtent : chartWidth,
            maxHeight: legendOnRight ? height : legendExtent,
            overflow: 'auto',
          }}
        >
          {/* @grafana/ui's own legend, so this panel's series list reads exactly
              like the timeseries panel's. `readonly` because toggling a series
              would need visibility state this renderer does not keep — and a
              legend that swallowed clicks would read as broken. */}
          <VizLegend
            items={items}
            displayMode={legendDisplayMode(legend.displayMode)}
            placement={legendOnRight ? 'right' : 'bottom'}
            readonly
          />
        </div>
      )}
    </div>
  );
}
BarChart.propTypes = {
  series: PropTypes.array,
  width: PropTypes.number,
  height: PropTypes.number,
  options: PropTypes.object,
  fieldConfig: PropTypes.object,
  theme: PropTypes.object,
};
