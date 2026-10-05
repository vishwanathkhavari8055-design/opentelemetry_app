import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { formatDurationUs, formatCount } from '../../utils/format';

/**
 * The three panels above the Spans / Traces tables: Rate, Errors, Duration.
 *
 * All three read the SAME bucket series from one `GROUP BY histogram(...)`, so
 * they cannot disagree about the x axis — which is the whole reason for
 * putting them side by side.
 *
 * The Duration panel used to plot its own scatter of the newest N spans. That
 * was measurably broken: on a 6-hour window the newest 2,000 spans covered
 * 2.5 minutes, so the entire cloud sat in the last 0.7% of the axis while Rate
 * and Errors spanned the full width. It now plots p50/p95/max per bucket,
 * which covers the window by construction and says more than a sample of
 * individual spans would.
 *
 * Plain inline SVG, matching LogHistogram: a charting library would be the
 * largest thing in this bundle to draw one line, one bar series and three
 * point series.
 */

const PLOT_W = 100;   // viewBox units; preserveAspectRatio="none" stretches x
const PLOT_H = 100;

/** Five gridline fractions, matching the reference's y-axis density. */
const GRID = [0, 0.25, 0.5, 0.75, 1];

/**
 * Duration axis labels, all in the SAME unit.
 *
 * formatDurationUs picks a unit per value, which is right for a single reading
 * and wrong for an axis: a scale running 22.05s / 16.54s / 11.02s / 5.51s /
 * "0.00ns" mixes two units across five labels and reads as a bug. The unit is
 * chosen once from the peak and every tick is rendered in it.
 */
const durationAxis = (peakUs) => {
  let div, unit;
  if (peakUs >= 60_000_000) { div = 60_000_000; unit = 'm'; }
  else if (peakUs >= 1_000_000) { div = 1_000_000; unit = 's'; }
  else if (peakUs >= 1_000) { div = 1_000; unit = 'ms'; }
  else { div = 1; unit = 'us'; }
  return GRID.slice().reverse().map((f) => ({
    id: `dur-${f}`,
    label: `${((peakUs * f) / div).toFixed(2)}${unit}`,
  }));
};

const parseTs = (s) => {
  if (!s) return Number.NaN;
  // Bucket timestamps come back as naive local-time strings from histogram()
  // ("2026-08-03T13:44:30"). Date.parse treats the naive form as local, which
  // is what we want — the x axis is labelled in the viewer's clock.
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : Number.NaN;
};

const clockLabel = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Shared frame: title, optional legend/subtitle, y labels, gridlines, x labels. */
function Panel({ title, subtitle, legend, yLabels, xLabels, children, empty }) {
  return (
    <div className="tc-panel">
      <div className="tc-title">
        {title}
        {legend?.map((l) => (
          <span className={`tc-legend ${l.cls}`} key={l.label}>
            <span className="tc-legend-dot" />{l.label}
          </span>
        ))}
        {/* Inline rather than absolutely positioned. The bucket-width label
            used to sit at top:-1.05rem on the chart row, which put it on top
            of the pagination controls above. */}
        {subtitle && <span className="tc-subtitle">{subtitle}</span>}
      </div>

      {empty ? (
        <div className="tc-empty">No data in this window.</div>
      ) : (
        <>
          <div className="tc-plot">
            <div className="tc-yaxis" aria-hidden="true">
              {yLabels.map((l) => <span key={l.id ?? l}>{l.label ?? l}</span>)}
            </div>
            <svg
              className="tc-svg"
              viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={title}
            >
              {GRID.map((f) => (
                <line
                  key={f}
                  className="tc-grid"
                  x1="0" x2={PLOT_W}
                  y1={PLOT_H - f * PLOT_H} y2={PLOT_H - f * PLOT_H}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {children}
            </svg>
          </div>
          <div className="tc-xaxis" aria-hidden="true">
            {xLabels.map((l) => <span key={l.id ?? l}>{l.label ?? l}</span>)}
          </div>
        </>
      )}
    </div>
  );
}
Panel.propTypes = {
  title: PropTypes.string.isRequired,
  subtitle: PropTypes.string,
  legend: PropTypes.array,
  yLabels: PropTypes.array,
  xLabels: PropTypes.array,
  children: PropTypes.node,
  empty: PropTypes.bool,
};
Panel.defaultProps = { yLabels: [], xLabels: [] };

/** Evenly spaced x labels across the window. */
const xLabelsFor = (min, max) => {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  return GRID.map((f) => ({ id: `x-${f}`, label: clockLabel(min + (max - min) * f) }));
};

/** The three duration series, drawn back-to-front so p50 sits on top. */
const DURATION_SERIES = [
  { key: 'max', cls: 'is-max', label: 'max' },
  { key: 'p95', cls: 'is-p95', label: 'p95' },
  { key: 'p50', cls: 'is-p50', label: 'p50' },
];

export default function TraceCharts({ buckets, loading, interval }) {
  const model = useMemo(() => {
    const bs = (buckets || [])
      .map((b) => ({
        t: parseTs(b.timestamp),
        n: Number(b.count) || 0,
        e: Number(b.errors) || 0,
        p50: Number(b.p50Us) || 0,
        p95: Number(b.p95Us) || 0,
        max: Number(b.maxUs) || 0,
      }))
      .filter((b) => Number.isFinite(b.t))
      .sort((a, b) => a.t - b.t);

    // One series → one x domain, shared by all three panels automatically.
    const min = bs.length ? bs[0].t : Number.NaN;
    const max = bs.length ? bs[bs.length - 1].t : Number.NaN;

    return {
      bs,
      min,
      max,
      peakRate: Math.max(1, ...bs.map((b) => b.n)),
      peakErr: Math.max(1, ...bs.map((b) => b.e)),
      peakDur: Math.max(1, ...bs.map((b) => b.max)),
    };
  }, [buckets]);

  const { bs, min, max, peakRate, peakErr, peakDur } = model;
  const span = max - min;
  const xOf = (t) => (span > 0 ? ((t - min) / span) * PLOT_W : PLOT_W / 2);
  const xLabels = xLabelsFor(min, max);

  if (loading && bs.length === 0) {
    return (
      <div className="trace-charts">
        {['Rate', 'Errors', 'Duration'].map((t) => (
          <div className="tc-panel" key={t}>
            <div className="tc-title">{t}</div>
            <div className="tc-empty">Loading…</div>
          </div>
        ))}
      </div>
    );
  }

  const ratePath = bs.length
    ? bs.map((b, i) => `${i === 0 ? 'M' : 'L'}${xOf(b.t).toFixed(2)},${(PLOT_H - (b.n / peakRate) * PLOT_H).toFixed(2)}`).join(' ')
    : '';
  const rateY = GRID.slice().reverse().map((f) => ({ id: `rate-${f}`, label: formatCount(Math.round(peakRate * f)) }));
  const errY = GRID.slice().reverse().map((f) => ({ id: `err-${f}`, label: formatCount(Math.round(peakErr * f)) }));
  const durY = durationAxis(peakDur);
  const barW = bs.length > 1 ? Math.max(0.6, (PLOT_W / bs.length) * 0.7) : 2;

  return (
    <div className="trace-charts">
      <Panel title="Rate" yLabels={rateY} xLabels={xLabels} empty={bs.length === 0}>
        <path className="tc-line" d={ratePath} vectorEffect="non-scaling-stroke" fill="none" />
      </Panel>

      <Panel title="Errors" yLabels={errY} xLabels={xLabels} empty={bs.length === 0}>
        {bs.map((b) => {
          if (!b.e) return null;
          const h = (b.e / peakErr) * PLOT_H;
          return (
            <rect
              key={b.t}
              className="tc-bar"
              x={Math.max(0, xOf(b.t) - barW / 2)}
              y={PLOT_H - h}
              width={barW}
              height={h}
            >
              <title>{`${clockLabel(b.t)} — ${b.e} error${b.e === 1 ? '' : 's'} of ${b.n}`}</title>
            </rect>
          );
        })}
      </Panel>

      <Panel
        title="Duration"
        subtitle={interval ? `${interval}/bucket` : null}
        legend={DURATION_SERIES.map((sr) => ({ label: sr.label, cls: sr.cls }))}
        yLabels={durY}
        xLabels={xLabels}
        empty={bs.length === 0}
      >
        {DURATION_SERIES.map((sr) => bs.map((b) => (b[sr.key] > 0 ? (
          <circle
            key={`${sr.key}-${b.t}`}
            className={`tc-dot ${sr.cls}`}
            cx={xOf(b.t)}
            cy={PLOT_H - (b[sr.key] / peakDur) * PLOT_H}
            /* r=1 in viewBox units, then given a fixed on-screen size by the
               non-scaling stroke in CSS — preserveAspectRatio="none" would
               otherwise stretch a circle into a wide ellipse. */
            r={1}
          >
            <title>{`${clockLabel(b.t)} — ${sr.label} ${formatDurationUs(b[sr.key])}`}</title>
          </circle>
        ) : null)))}
      </Panel>
    </div>
  );
}

TraceCharts.propTypes = {
  /** `[{ timestamp, count, errors, p50Us, p95Us, maxUs }]` from
   *  GET /api/traces/histogram — one series behind all three panels. */
  buckets: PropTypes.array,
  loading: PropTypes.bool,
  /** Bucket width the backend chose, e.g. "30 seconds". */
  interval: PropTypes.string,
};
