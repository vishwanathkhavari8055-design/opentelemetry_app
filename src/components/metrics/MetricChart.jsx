import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { formatCount } from '../../utils/format';

/**
 * Multi-series time chart for a PromQL result.
 *
 * Plain inline SVG, matching LogHistogram and TraceCharts. A charting library
 * would be the largest thing in this bundle to draw some polylines, and the
 * two existing charts already set the pattern.
 *
 * Two things here are not obvious:
 *
 * NULL POINTS BREAK THE LINE. Prometheus emits gaps where a target was down,
 * and api.js turns unparseable values into null. Joining across a gap draws a
 * straight line through an outage, which is the one moment you most need to
 * see. Each run of consecutive real points becomes its own `M` subpath, so a
 * gap renders as a gap.
 *
 * SERIES ARE CAPPED. A bare metric name can match hundreds of series; past a
 * few dozen the chart is unreadable and the DOM is enormous. The top
 * MAX_SERIES by peak value are drawn and the remainder are reported rather
 * than silently dropped.
 */

const PLOT_W = 1000;
const PLOT_H = 260;
const PAD = { top: 8, right: 8, bottom: 20, left: 56 };
const MAX_SERIES = 24;
const GRID = [0, 0.25, 0.5, 0.75, 1];

/** Stable colour per series, derived from its label set. */
const PALETTE = [
  '#5b8def', '#2ecc9b', '#ffa726', '#ef5f6b', '#a78bfa', '#4dd0e1',
  '#f06292', '#9ccc65', '#ffd54f', '#7986cb', '#4db6ac', '#ff8a65',
];
const colourOf = (key) => {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.codePointAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

/**
 * A short name for a series: the labels that actually differ across the
 * result. Printing every label makes each legend row 300 characters of mostly
 * identical text; printing only __name__ makes ten series look identical.
 */
export const seriesLabel = (labels, varying) => {
  const name = labels.__name__ || '';
  const parts = varying
    .filter((k) => k !== '__name__' && labels[k])
    .map((k) => `${k}="${labels[k]}"`);
  if (!parts.length) return name || '{}';
  return `${name}{${parts.join(', ')}}`;
};

/** Label keys whose value is not the same across every series. */
export const varyingLabels = (series) => {
  const seen = new Map();
  series.forEach((s) => {
    Object.entries(s.labels || {}).forEach(([k, v]) => {
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(v);
    });
  });
  const keys = [];
  seen.forEach((values, k) => {
    if (k !== '__name__' && (values.size > 1 || series.length === 1)) keys.push(k);
  });
  return keys.sort((a, b) => String(a).localeCompare(String(b)));
};

/** Drops a trailing run of zeros, and the `.` right before it (`"1.50"` → `"1.5"`, `"2.00"` → `"2"`). */
const stripTrailingZeros = (s) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === '0') end -= 1;
  if (end === s.length) return s;
  if (s[end - 1] === '.') end -= 1;
  return s.slice(0, end);
};

/** Y-axis tick text — one unit chosen from the peak, so ticks never mix units. */
const axisTicks = (min, max) => {
  const span = max - min || Math.abs(max) || 1;
  return GRID.slice().reverse().map((f) => {
    const v = min + span * f;
    if (Math.abs(v) >= 1000) return formatCount(Math.round(v));
    if (Number.isInteger(v)) return String(v);
    return stripTrailingZeros(v.toPrecision(3));
  });
};

const clock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export default function MetricChart({ series, loading, error, resultType }) {
  const [hidden, setHidden] = useState(() => new Set());

  const model = useMemo(() => {
    const withPeak = (series || []).map((s) => {
      const vals = s.points.map((p) => p.v).filter((v) => v !== null);
      return { ...s, peak: vals.length ? Math.max(...vals.map(Math.abs)) : 0 };
    });
    // Cap by peak, so the loudest series survive rather than the first N.
    const sorted = withPeak.slice().sort((a, b) => b.peak - a.peak);
    const shown = sorted.slice(0, MAX_SERIES);
    const varying = varyingLabels(shown);

    const keyed = shown.map((s, i) => {
      const label = seriesLabel(s.labels, varying);
      return { ...s, label, key: `${label}#${i}`, colour: colourOf(label) };
    });

    const visible = keyed.filter((s) => !hidden.has(s.key));
    let tMin = Infinity; let tMax = -Infinity;
    let vMin = Infinity; let vMax = -Infinity;
    visible.forEach((s) => s.points.forEach((p) => {
      if (p.t < tMin) tMin = p.t;
      if (p.t > tMax) tMax = p.t;
      if (p.v === null) return;
      if (p.v < vMin) vMin = p.v;
      if (p.v > vMax) vMax = p.v;
    }));
    if (!Number.isFinite(tMin)) { tMin = 0; tMax = 1; }
    if (!Number.isFinite(vMin)) { vMin = 0; vMax = 1; }
    // A flat series would otherwise divide by zero and vanish.
    if (vMax === vMin) { vMax = vMin + Math.abs(vMin || 1) * 0.1; }
    // Anchor to zero when the data is all positive — a chart that starts at
    // 4.1M makes a 1% wobble look like a cliff.
    if (vMin > 0 && vMin / vMax > 0.5) vMin = 0;

    return {
      keyed, visible, tMin, tMax, vMin, vMax, total: withPeak.length, capped: withPeak.length - shown.length,
    };
  }, [series, hidden]);

  const {
    keyed, visible, tMin, tMax, vMin, vMax, total, capped,
  } = model;

  const innerW = PLOT_W - PAD.left - PAD.right;
  const innerH = PLOT_H - PAD.top - PAD.bottom;
  const xOf = (t) => PAD.left + (tMax > tMin ? ((t - tMin) / (tMax - tMin)) * innerW : innerW / 2);
  const yOf = (v) => PAD.top + innerH - ((v - vMin) / (vMax - vMin)) * innerH;

  /** Path with a break at every null run — see the note at the top. */
  const pathOf = (points) => {
    let d = '';
    let pen = false;
    points.forEach((p) => {
      if (p.v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const toggle = (key) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  if (loading && !keyed.length) {
    return <div className="mv-chart-empty">Running query…</div>;
  }
  if (error) {
    return (
      <div className="mv-chart-empty mv-chart-empty--error">
        <strong>Query failed</strong>
        <span>{error}</span>
      </div>
    );
  }
  if (!keyed.length) {
    return <div className="mv-chart-empty">No series matched. Try a wider time range or a different metric.</div>;
  }

  const yTicks = axisTicks(vMin, vMax);

  return (
    <div className="mv-chart">
      <svg
        className="mv-chart-svg"
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${visible.length} of ${total} series`}
      >
        {GRID.map((f, i) => {
          const y = PAD.top + innerH - f * innerH;
          return (
            <g key={f}>
              <line
                className="mv-grid" x1={PAD.left} x2={PLOT_W - PAD.right} y1={y} y2={y}
                vectorEffect="non-scaling-stroke"
              />
              <text className="mv-ytick" x={PAD.left - 6} y={y + 3} textAnchor="end">
                {yTicks[yTicks.length - 1 - i]}
              </text>
            </g>
          );
        })}

        {GRID.map((f) => (
          <text
            key={`x${f}`}
            className="mv-xtick"
            x={PAD.left + f * innerW}
            y={PLOT_H - 6}
            textAnchor={{ 0: 'start', 1: 'end' }[f] || 'middle'}
          >
            {clock(tMin + (tMax - tMin) * f)}
          </text>
        ))}

        {visible.map((s) => (
          <path
            key={s.key}
            className="mv-line"
            d={pathOf(s.points)}
            stroke={s.colour}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="mv-legend">
        {keyed.map((s) => {
          const off = hidden.has(s.key);
          const last = [...s.points].reverse().find((p) => p.v !== null);
          return (
            <button
              type="button"
              key={s.key}
              className={`mv-legend-item ${off ? 'is-off' : ''}`}
              onClick={() => toggle(s.key)}
              title={`${s.label}\nClick to ${off ? 'show' : 'hide'}`}
            >
              <span className="mv-legend-dot" style={{ background: s.colour }} />
              <span className="mv-legend-label">{s.label}</span>
              {last && <span className="mv-legend-value">{formatCount(last.v)}</span>}
            </button>
          );
        })}
      </div>

      {capped > 0 && (
        <div className="mv-chart-note">
          Showing the {MAX_SERIES} largest of {total} series — {capped} not plotted.
          Narrow the query with a label filter to see the rest.
        </div>
      )}
      {resultType === 'vector' && (
        <div className="mv-chart-note">
          Instant query — one point per series. Use a range query to see it over time.
        </div>
      )}
    </div>
  );
}

MetricChart.propTypes = {
  /** `[{ labels: {}, points: [{t, v}] }]` — v is null at gaps. */
  series: PropTypes.array,
  loading: PropTypes.bool,
  error: PropTypes.string,
  resultType: PropTypes.string,
};
