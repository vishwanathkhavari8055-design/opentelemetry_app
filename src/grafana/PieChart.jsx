/**
 * The pie / donut visualization, drawn in SVG.
 *
 * ─── Why this exists instead of @grafana/ui's PieChart ──────────────────────
 *
 * It does not have one. Grep the published bundle for `PieChart` and there are
 * ZERO hits — not an unexported internal, and not a broken export like `Gauge`
 * (see ./ArcGauge.jsx): the component lives in grafana/public/app/plugins/panel/
 * piechart and is not part of @grafana/ui at all. So a `piechart` panel had no
 * renderer to register, and every one fell through to the unsupported
 * placeholder tile.
 *
 * ─── It is not a reimplementation of Grafana's pie logic ────────────────────
 *
 * Everything numeric arrives already computed, exactly as in ./ArcGauge.jsx.
 * `values` is the FieldDisplay[] that getFieldDisplayValues() produced from the
 * panel's own reduceOptions and fieldConfig, so each slice's number, unit,
 * decimals, display name and COLOUR are what the dashboard specified, resolved
 * by Grafana's own code. A `byName` override pinning "Used" to orange arrives
 * here as an orange DisplayValue; this component only decides where to put ink.
 *
 * The one number it computes itself is each slice's share of the total, because
 * that is a property of the SET and no per-field pipeline can produce it.
 */

// The propTypes below are loose for the same reason as in ./ArcGauge.jsx and
// ./panelsExtra.jsx: every prop is part of a THIRD PARTY's contract — `values`
// is Grafana FieldDisplay[], `options` is the panel's own JSON, `theme` is a
// GrafanaTheme2. Restating those shapes in full would be a second,
// immediately-stale copy of Grafana's own types.

import { useMemo } from 'react';
import PropTypes from 'prop-types';

/**
 * Donut hole as a fraction of the outer radius. Grafana's donut is a fairly thin
 * ring; 0.6 is its ratio, and it matters more than it looks — at 0.4 the same
 * panel reads as a pie with a bite out of it rather than as a donut.
 */
const DONUT_INNER_RATIO = 0.6;

/** A full turn, less a hair, so a single 100% slice takes the circle path. */
const FULL_CIRCLE = 359.999;

/** Height of one legend row, in pixels. */
const LEGEND_ROW_HEIGHT = 16;

/** Cartesian point at `angle` degrees clockwise from twelve o'clock. */
function polar(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
}

/**
 * One slice, as an SVG path.
 *
 * `large-arc-flag` is computed rather than fixed: a slice covering more than 180°
 * needs it set or the browser draws the short way round, which turns a 70% slice
 * into a 30% one — plausible-looking and completely wrong.
 *
 * The inner arc is swept in the opposite direction (flag 0 rather than 1) so the
 * path closes as a ring segment instead of crossing itself.
 */
function slicePath(cx, cy, outer, inner, start, end) {
  const sweep = end - start;
  const large = sweep > 180 ? 1 : 0;
  const [x1, y1] = polar(cx, cy, outer, start);
  const [x2, y2] = polar(cx, cy, outer, end);

  if (inner <= 0) {
    return `M ${cx} ${cy} L ${x1} ${y1} A ${outer} ${outer} 0 ${large} 1 ${x2} ${y2} Z`;
  }

  const [x3, y3] = polar(cx, cy, inner, end);
  const [x4, y4] = polar(cx, cy, inner, start);
  return `M ${x1} ${y1} A ${outer} ${outer} 0 ${large} 1 ${x2} ${y2} `
    + `L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`;
}

/** Whether this field asked to be hidden from the viz or from the legend. */
function hiddenFrom(display, where) {
  return display?.field?.custom?.hideFrom?.[where] === true;
}

/**
 * Slices, with their angles.
 *
 * Non-positive and non-finite values are dropped rather than clamped: a pie is a
 * part-of-whole chart, so a negative share has no geometry, and letting a NaN
 * through would poison every subsequent angle in the accumulation.
 */
function computeSlices(values) {
  const usable = (values || [])
    .filter((v) => !hiddenFrom(v, 'viz'))
    .map((v) => ({ display: v.display, field: v.field, numeric: Number(v.display?.numeric) }))
    .filter((v) => Number.isFinite(v.numeric) && v.numeric > 0);

  const total = usable.reduce((sum, v) => sum + v.numeric, 0);
  if (!total) return { slices: [], total: 0 };

  let cursor = 0;
  const slices = usable.map((v) => {
    const fraction = v.numeric / total;
    const start = cursor;
    cursor += fraction * 360;
    return { ...v, fraction, start, end: cursor };
  });

  return { slices, total };
}

/** The label a slice or legend row shows for one requested value column. */
function valueColumn(slice, which) {
  if (which === 'percent') return `${(slice.fraction * 100).toFixed(1)}%`;
  // 'value' — and anything unrecognised, because the already-formatted display
  // text (unit and decimals applied) is the honest fallback for a column this
  // component does not implement, rather than a blank cell.
  return [slice.display?.prefix, slice.display?.text, slice.display?.suffix]
    .filter(Boolean).join('');
}

/**
 * Split the tile between chart and legend. Capped as a FRACTION rather than at
 * a fixed row count: a twelve-series pie in a short tile would otherwise give
 * its whole height to the legend and draw a chart three pixels tall.
 */
function legendExtentFor(onRight, asTable, rowCount, width, height) {
  if (onRight) return Math.min(Math.round(width * 0.45), 180);
  return Math.min(
    Math.round(height * 0.45),
    rowCount * LEGEND_ROW_HEIGHT + (asTable ? LEGEND_ROW_HEIGHT : 0),
  );
}

export function PieChart({ values, width, height, options, theme }) {
  const isDonut = options?.pieType === 'donut';
  const legend = options?.legend ?? {};
  const showLegend = legend.showLegend !== false;
  const onRight = legend.placement === 'right';
  const asTable = legend.displayMode === 'table';
  const legendValues = Array.isArray(legend.values) ? legend.values : [];
  const displayLabels = Array.isArray(options?.displayLabels) ? options.displayLabels : [];

  const { slices } = useMemo(() => computeSlices(values), [values]);

  // Legend rows are a DIFFERENT set from the slices: hideFrom.viz and
  // hideFrom.legend are independent flags, and a dashboard can set either.
  const legendRows = useMemo(
    () => slices.filter((s) => !hiddenFrom(s, 'legend')),
    [slices],
  );

  const mutedColor = theme?.colors?.text?.secondary || 'rgba(255, 255, 255, 0.62)';
  const inkColor = theme?.colors?.text?.primary || '#ffffff';
  const smallFont = theme?.typography?.bodySmall?.fontSize || '0.75rem';

  const hasLegend = showLegend && legendRows.length > 0;
  const legendExtent = hasLegend
    ? legendExtentFor(onRight, asTable, legendRows.length, width, height)
    : 0;

  const chartWidth = onRight ? width - legendExtent : width;
  const chartHeight = onRight ? height : height - legendExtent;

  const padding = 6;
  const outer = Math.max(
    8,
    Math.min(chartWidth - padding * 2, chartHeight - padding * 2) / 2,
  );
  const inner = isDonut ? outer * DONUT_INNER_RATIO : 0;
  const cx = chartWidth / 2;
  const cy = chartHeight / 2;

  if (!slices.length) {
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

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: onRight ? 'row' : 'column',
        alignItems: 'center',
        overflow: 'hidden',
      }}
    >
      <svg width={chartWidth} height={chartHeight} aria-label="Pie chart">
        {slices.map((slice) => {
          const [lx, ly] = polar(
            cx, cy,
            isDonut ? (outer + inner) / 2 : outer * 0.65,
            (slice.start + slice.end) / 2,
          );
          const label = displayLabels
            .map((which) => (which === 'name'
              ? slice.display?.title ?? ''
              : valueColumn(slice, which)))
            .filter(Boolean)
            .join(' ');

          return (
            <g key={`slice-${slice.start}`}>
              {/* A single 100% slice is drawn as a stroked circle, not a path: an
                  arc whose start and end points coincide is a ZERO-LENGTH arc, and
                  the browser draws nothing at all — the panel would come out blank
                  for the one case that ought to be easiest. */}
              {slice.fraction >= FULL_CIRCLE / 360 ? (
                <circle
                  cx={cx}
                  cy={cy}
                  r={isDonut ? (outer + inner) / 2 : outer / 2}
                  fill="none"
                  stroke={slice.display?.color || inkColor}
                  strokeWidth={isDonut ? outer - inner : outer}
                />
              ) : (
                <path
                  d={slicePath(cx, cy, outer, inner, slice.start, slice.end)}
                  fill={slice.display?.color || inkColor}
                />
              )}
              {/* Native hover text. Grafana's own tooltip is a portal-and-uPlot
                  affair this component has no equivalent of; a <title> says the
                  same thing and costs nothing. */}
              <title>
                {`${slice.display?.title ?? ''} ${valueColumn(slice, 'value')} `
                  + `(${valueColumn(slice, 'percent')})`}
              </title>
              {label && (
                <text
                  x={lx}
                  y={ly}
                  fill={inkColor}
                  fontSize={smallFont}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hasLegend && (
        <div
          style={{
            width: onRight ? legendExtent : '100%',
            maxHeight: onRight ? height : legendExtent,
            overflow: 'auto',
            fontSize: smallFont,
            padding: '0 4px',
          }}
        >
          {legendRows.map((slice) => (
            <div
              key={`legend-${slice.start}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: LEGEND_ROW_HEIGHT,
                color: mutedColor,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  flex: '0 0 auto',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: slice.display?.color || inkColor,
                }}
              />
              <span
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {slice.display?.title ?? ''}
              </span>
              {/* Table mode gets one right-aligned column per requested value;
                  list mode gets the same numbers inline. Same data either way —
                  the difference is alignment, which is the whole point of the
                  table mode a dashboard asked for. */}
              {legendValues.map((which) => (
                <span
                  key={which}
                  style={{
                    flex: '0 0 auto',
                    minWidth: asTable ? 52 : undefined,
                    textAlign: 'right',
                    color: inkColor,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {valueColumn(slice, which)}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
PieChart.propTypes = {
  values: PropTypes.array,
  width: PropTypes.number,
  height: PropTypes.number,
  options: PropTypes.object,
  theme: PropTypes.object,
};
