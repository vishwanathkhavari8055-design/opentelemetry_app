/**
 * The gauge visualization, drawn in SVG.
 *
 * ─── Why this exists instead of @grafana/ui's Gauge ─────────────────────────
 *
 * `Gauge` from @grafana/ui draws with **jquery.flot**. Grafana core loads flot
 * and its gauge plugin from its own `vendor/` tree; @grafana/ui neither bundles
 * them nor declares them, so in a standalone application `$.plot` is simply not a
 * function and every gauge panel throws on mount:
 *
 *     TypeError: import_jquery.default.plot is not a function
 *         at Gauge.draw
 *
 * The panel renders as an empty tile — no error text, because the throw happens
 * in componentDidMount rather than in render.
 *
 * Installing `jquery.flot` and `jquery.flot.gauge` would mean adding two
 * unmaintained packages, in CommonJS, that work by mutating a shared jQuery
 * global — and getting Vite's interop to hand all three the SAME jQuery
 * instance. Drawing an arc is a hundred lines of SVG. So we draw the arc.
 *
 * ─── It is not a reimplementation of Grafana's gauge logic ──────────────────
 *
 * Everything numeric arrives already computed. `value` is a `DisplayValue` that
 * VizPanel produced through `getFieldDisplayValues` — so the number, its unit,
 * its decimals, its colour and the field's thresholds are exactly what the
 * dashboard's fieldConfig specified, resolved by Grafana's own code. This
 * component only decides where to put ink.
 */

// The propTypes below are loose for the same reason as in ./panelsExtra.jsx:
// every prop is part of a THIRD PARTY's contract. `value` is a Grafana
// DisplayValue, `field` a Grafana Field, `theme` a GrafanaTheme2 — all handed in
// by VizRepeater. Restating those shapes in full would be a second,
// immediately-stale copy of Grafana's own types.

import { useMemo } from 'react';
import PropTypes from 'prop-types';

/** Degrees of sweep, and where it starts. Grafana's gauge is a 220° arc. */
const SWEEP = 220;
const START = 90 + (360 - SWEEP) / 2;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Point on the arc at `fraction` (0–1) of the sweep. */
function pointAt(cx, cy, radius, fraction) {
  const angle = toRadians(START + SWEEP * fraction);
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

/**
 * An SVG arc path along the gauge's sweep, from `from` to `to` (both 0–1).
 *
 * `large-arc-flag` is computed rather than fixed at 0: the sweep is 220°, so a
 * band covering more than 180° of it needs the flag set or the browser draws the
 * short way round and the gauge reads as nearly empty when it is nearly full.
 */
function arcPath(cx, cy, radius, from, to) {
  const [x1, y1] = pointAt(cx, cy, radius, from);
  const [x2, y2] = pointAt(cx, cy, radius, to);
  const largeArc = SWEEP * (to - from) > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;
}

/**
 * Threshold bands as fractions of the sweep.
 *
 * Grafana's thresholds are `[{value: null|number, color}]`, ascending, where the
 * first step's `value` is null meaning "the base". Percentage mode expresses them
 * as 0–100 of the min..max span rather than as absolute values.
 */
function thresholdBands(field, min, max) {
  const steps = field?.thresholds?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const isPercentage = field.thresholds.mode === 'percentage';
  const span = max - min || 1;

  const absolute = steps.map((step) => {
    if (step.value == null || !Number.isFinite(step.value)) return { at: min, color: step.color };
    return {
      at: isPercentage ? min + (step.value / 100) * span : step.value,
      color: step.color,
    };
  });

  const bands = [];
  for (let i = 0; i < absolute.length; i += 1) {
    const from = Math.max(min, Math.min(max, absolute[i].at));
    const to = i + 1 < absolute.length
      ? Math.max(min, Math.min(max, absolute[i + 1].at))
      : max;
    if (to <= from) continue;
    bands.push({
      from: (from - min) / span,
      to: (to - min) / span,
      color: absolute[i].color,
    });
  }
  return bands;
}

export function ArcGauge({
  value, width, height, field, theme,
  showThresholdMarkers = true, showThresholdLabels = false, text,
}) {
  const numeric = Number(value?.numeric);
  const min = Number.isFinite(field?.min) ? field.min : 0;
  const max = Number.isFinite(field?.max) ? field.max : 100;
  const span = max - min || 1;

  // Clamped, because a value outside min..max is common (a percentage that hits
  // 100.4, a counter above its configured ceiling) and an unclamped fraction
  // would draw the arc past its own end.
  const fraction = Number.isFinite(numeric)
    ? Math.max(0, Math.min(1, (numeric - min) / span))
    : 0;

  const bands = useMemo(() => thresholdBands(field, min, max), [field, min, max]);

  // Geometry. The arc is inscribed in the tile with room for the value text under
  // it; `size` keeps it circular whichever way the tile is stretched.
  const padding = 6;
  const labelRoom = showThresholdLabels ? 14 : 0;
  const size = Math.max(40, Math.min(width - padding * 2, (height - padding * 2 - labelRoom) * 1.6));
  const radius = size / 2.4;
  const cx = width / 2;
  const cy = padding + radius + (size / 6);
  const thickness = Math.max(4, radius * 0.22);

  // `value.color` is the threshold colour the dashboard's own fieldConfig
  // resolved — that stays as authored, so a gauge past its critical step still
  // goes red. Everything else is chrome and comes from the theme, which is built
  // from the --scene-* palette. The literals are only reached if `theme` is
  // absent entirely, and they are that palette's values rather than the app's
  // greys: the one path that skips the theme should not be the one path that
  // leaves the palette.
  const valueColor = value?.color || theme?.colors?.text?.primary || '#ffffff';
  const trackColor = theme?.colors?.background?.secondary || '#404040';
  const mutedColor = theme?.colors?.text?.secondary || 'rgba(255, 255, 255, 0.58)';

  // Font sizes scale with the tile: a gauge in a 4-column row and one filling a
  // whole dashboard row are the same component.
  const valueFontSize = text?.valueSize ?? Math.max(11, Math.min(radius * 0.55, 34));
  const titleFontSize = text?.titleSize ?? Math.max(9, Math.min(radius * 0.28, 14));

  const displayText = [value?.prefix, value?.text, value?.suffix].filter(Boolean).join('');

  return (
    <svg width={width} height={height} aria-label={`Gauge: ${displayText}`}>
      {/* Unfilled track, so a low value still reads as "a gauge at 5%" rather
          than as a stray line. */}
      <path
        d={arcPath(cx, cy, radius, 0, 1)}
        fill="none"
        stroke={trackColor}
        strokeWidth={thickness}
        strokeLinecap="butt"
      />

      {/* Threshold markers: Grafana draws these as a thin ring OUTSIDE the arc.
          Outside rather than on it, so they never obscure the value band. */}
      {showThresholdMarkers && bands.map((band) => (
        <path
          key={`band-${band.from}-${band.to}`}
          d={arcPath(cx, cy, radius + thickness * 0.75, band.from, band.to)}
          fill="none"
          stroke={band.color}
          strokeWidth={Math.max(2, thickness * 0.22)}
          strokeLinecap="butt"
        />
      ))}

      {/* The value itself, in the colour Grafana's field config resolved. Only
          drawn when there is something to draw — a zero-length arc with a round
          cap would otherwise render as a dot at the origin, which reads as a
          small value rather than as none. */}
      {fraction > 0.001 && (
        <path
          d={arcPath(cx, cy, radius, 0, fraction)}
          fill="none"
          stroke={valueColor}
          strokeWidth={thickness}
          strokeLinecap="butt"
        />
      )}

      {showThresholdLabels && (
        <>
          <text
            x={cx - radius} y={cy + thickness * 1.6}
            fill={mutedColor} fontSize={titleFontSize} textAnchor="middle"
          >{min}</text>
          <text
            x={cx + radius} y={cy + thickness * 1.6}
            fill={mutedColor} fontSize={titleFontSize} textAnchor="middle"
          >{max}</text>
        </>
      )}

      <text
        x={cx} y={cy + valueFontSize * 0.35}
        fill={valueColor}
        fontSize={valueFontSize}
        fontWeight="500"
        textAnchor="middle"
      >{displayText}</text>

      {/* The series name, when the panel is showing more than one gauge and the
          panel header cannot carry every label. */}
      {value?.title && (
        <text
          x={cx} y={cy + valueFontSize * 0.5 + titleFontSize * 1.5}
          fill={mutedColor}
          fontSize={titleFontSize}
          textAnchor="middle"
        >{value.title}</text>
      )}
    </svg>
  );
}
ArcGauge.propTypes = {
  value: PropTypes.object,
  width: PropTypes.number,
  height: PropTypes.number,
  field: PropTypes.object,
  theme: PropTypes.object,
  showThresholdMarkers: PropTypes.bool,
  showThresholdLabels: PropTypes.bool,
  text: PropTypes.object,
};
