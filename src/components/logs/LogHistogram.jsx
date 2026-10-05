import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * Event-volume-over-time chart above the logs table: stacked bars per time
 * bucket, one segment per severity, with a clickable legend.
 *
 * Built from the sample rows the container fetches (the newest N matching logs),
 * not a server-side aggregation — the lib has no time-bucketed log-count
 * endpoint, so the honest scope of this chart is "the sampled window". The
 * caption states the sample size and its actual time span so nobody reads it as
 * a count over the full retention period.
 *
 * Plain inline SVG: a charting library would be the single largest thing in this
 * bundle, and this is one chart type with no interaction beyond hover + legend.
 *
 * Severity colours come from the --sev-* custom properties in index.css, the same
 * scale the row's left edge, the summary breakdown and the Analytics columns
 * read. They are handed to SVG `fill` as var() references rather than resolved
 * here: a literal in this file is a literal that drifts the moment the scale is
 * retuned, and the whole point of the scale is that a bar segment and the row it
 * counts are never two different reds.
 *
 * WARN/WARNING and FATAL/CRITICAL are both spelled out because emitters disagree
 * about which they write, and a level with no entry falls through to the muted
 * --sev-other, where it reads as "severity unset" instead of as itself.
 */

const SEVERITY_COLORS = {
  TRACE: 'var(--sev-trace)',
  DEBUG: 'var(--sev-debug)',
  INFO: 'var(--sev-info)',
  WARN: 'var(--sev-warn)',
  WARNING: 'var(--sev-warn)',
  ERROR: 'var(--sev-error)',
  ERR: 'var(--sev-error)',
  FATAL: 'var(--sev-fatal)',
  CRITICAL: 'var(--sev-fatal)',
};

/* Stack order, lowest severity at the bottom — errors ride on top where they're
   visible against the axis-less background even when the bar is one pixel tall. */
const STACK_ORDER = [
  'TRACE', 'DEBUG', 'INFO', 'WARN', 'WARNING', 'ERR', 'ERROR', 'CRITICAL', 'FATAL',
];

const BUCKET_COUNT = 60;
const CHART_H = 96;      // plot area height in SVG user units
                         // (the y-axis gutter is CSS padding on .histo, not SVG)

const formatTick = (ms, spanMs) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  // Sub-day spans read as clock time; wider spans need the date to disambiguate.
  if (spanMs <= 24 * 3_600_000) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatCount = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
};

const formatDurationMs = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = ms / 60_000;
  if (min < 1) return `${Math.round(ms / 1000)}s`;
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
};

export default function LogHistogram({ rows, loading, sampleLimit, onSeverityClick, activeSeverity }) {
  // Severities muted via shift-click. Purely visual — muting does not
  // re-query, so it stays local to the chart.
  //
  // Plain click now FILTERS instead of muting. A legend where the obvious
  // gesture only greyed out a bar, and you had to discover a double-click to
  // actually filter, read as a passive chart; filtering is what people reach
  // for. Muting is still available on shift-click for comparing two levels
  // without changing the query.
  const [muted, setMuted] = useState(() => new Set());

  const model = useMemo(() => {
    const stamped = (rows || [])
      .map((r) => ({ t: Date.parse(r.timestamp), sev: (r.severity || 'INFO').toUpperCase() }))
      .filter((r) => Number.isFinite(r.t));

    if (stamped.length === 0) return null;

    let min = Infinity;
    let max = -Infinity;
    stamped.forEach((r) => {
      if (r.t < min) min = r.t;
      if (r.t > max) max = r.t;
    });
    // A degenerate span (all rows in the same millisecond) would divide by zero;
    // give it an artificial 1s width so the single bar still renders.
    const span = Math.max(1000, max - min);
    const bucketMs = span / BUCKET_COUNT;

    const buckets = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
      start: min + i * bucketMs,
      total: 0,
      bySev: {},
    }));

    const present = new Set();
    stamped.forEach(({ t, sev }) => {
      const idx = Math.min(BUCKET_COUNT - 1, Math.floor((t - min) / bucketMs));
      const b = buckets[idx];
      b.bySev[sev] = (b.bySev[sev] || 0) + 1;
      b.total += 1;
      present.add(sev);
    });

    // Peak is computed over *unmuted* severities so muting the dominant level
    // rescales the chart instead of flattening everything that's left.
    const peak = Math.max(
      1,
      ...buckets.map((b) =>
        Object.entries(b.bySev).reduce((sum, [sev, n]) => (muted.has(sev) ? sum : sum + n), 0)),
    );

    // Legend order follows STACK_ORDER, with anything unexpected appended so an
    // unknown severity is still visible rather than silently dropped.
    const known = STACK_ORDER.filter((s) => present.has(s));
    const extra = Array.from(present).filter((s) => !STACK_ORDER.includes(s)).sort((a, b) => a.localeCompare(b));

    return {
      buckets, peak, min, max, span, bucketMs,
      severities: [...known, ...extra],
      totalsBySev: stamped.reduce((acc, { sev }) => {
        acc[sev] = (acc[sev] || 0) + 1;
        return acc;
      }, {}),
      sampled: stamped.length,
    };
  }, [rows, muted]);

  /** True when the query is currently narrowed to this severity. */
  const isActive = (sev) =>
    !!activeSeverity && String(activeSeverity).toUpperCase() === String(sev).toUpperCase();

  const toggleMuted = (sev) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev); else next.add(sev);
      return next;
    });
  };

  if (!model) {
    return (
      <div className="histo histo--empty">
        {loading ? 'Building event distribution…' : 'No events to chart for the current filters.'}
      </div>
    );
  }

  const { buckets, peak, min, max, span, bucketMs, severities, totalsBySev, sampled } = model;
  const barW = 100 / BUCKET_COUNT;
  const spanLabel = formatDurationMs(max - min);

  return (
    <div className="histo">
      <svg
        className="histo-svg"
        viewBox={`0 0 100 ${CHART_H}`}
        preserveAspectRatio="none"
        aria-label={`Event volume by severity across ${BUCKET_COUNT} time buckets`}
      >
        {/* Gridlines at 0 / 50 / 100% of peak, with the value labels rendered
            outside the SVG (below) so they aren't stretched by the non-uniform
            preserveAspectRatio scaling. */}
        {[0, 0.5, 1].map((f) => (
          <line
            key={f}
            className="histo-grid"
            x1="0" x2="100"
            y1={CHART_H - f * CHART_H}
            y2={CHART_H - f * CHART_H}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {buckets.map((b, i) => {
          let y = CHART_H;
          const segs = [];
          severities.forEach((sev) => {
            if (muted.has(sev)) return;
            const n = b.bySev[sev] || 0;
            if (!n) return;
            const h = (n / peak) * CHART_H;
            y -= h;
            segs.push(
              <rect
                key={sev}
                x={i * barW + barW * 0.12}
                y={y}
                width={barW * 0.76}
                height={h}
                fill={SEVERITY_COLORS[sev] || 'var(--sev-other)'}
              />,
            );
          });
          if (segs.length === 0) return null;
          return (
            <g key={b.start}>
              <title>
                {`${formatTick(b.start, span)} — ${b.total} event${b.total === 1 ? '' : 's'}`}
              </title>
              {segs}
            </g>
          );
        })}
      </svg>

      {/* y-axis labels: absolutely positioned against the plot box, matching the
          three gridlines above. */}
      <div className="histo-yaxis" aria-hidden="true">
        <span>{formatCount(peak)}</span>
        <span>{formatCount(Math.round(peak / 2))}</span>
        <span>0</span>
      </div>

      <div className="histo-xaxis">
        <span>{formatTick(min, span)}</span>
        <span className="histo-xaxis-mid">{formatTick(min + span / 2, span)}</span>
        <span>{formatTick(max, span)}</span>
      </div>

      <div className="histo-legend">
        {severities.map((sev) => (
          <button
            type="button"
            key={sev}
            className={`histo-legend-item ${muted.has(sev) ? 'is-muted' : ''} ${
              isActive(sev) ? 'is-active' : ''}`}
            aria-pressed={isActive(sev)}
            onClick={(e) => {
              if (e.shiftKey) { toggleMuted(sev); return; }
              if (onSeverityClick) onSeverityClick(sev);
            }}
            title={`${totalsBySev[sev]} ${sev} events in the sample — click to ${
              isActive(sev) ? 'clear this filter' : 'filter to this severity'
            }, shift-click to mute`}
          >
            <span
              className="histo-legend-swatch"
              style={{ background: SEVERITY_COLORS[sev] || 'var(--sev-other)' }}
            />
            {sev}
            <span className="histo-legend-n">{formatCount(totalsBySev[sev])}</span>
          </button>
        ))}

        <span className="histo-caption">
          {`newest ${sampled.toLocaleString()} matching events`}
          {sampled >= sampleLimit ? ' (sample limit)' : ''}
          {spanLabel ? ` · ${spanLabel} span` : ''}
          {` · ${formatDurationMs(bucketMs) || '<1s'}/bar`}
        </span>
      </div>
    </div>
  );
}

LogHistogram.propTypes = {
  /** Sample rows: need `timestamp` (ISO) and `severity`. */
  rows: PropTypes.array,
  loading: PropTypes.bool,
  /** Row cap the container requested — drives the "(sample limit)" note. */
  sampleLimit: PropTypes.number.isRequired,
  /** Click on a legend entry — container wires this to the severity filter. */
  onSeverityClick: PropTypes.func,
  /** Severity the active query is narrowed to, so the legend can highlight it. */
  activeSeverity: PropTypes.string,
};
