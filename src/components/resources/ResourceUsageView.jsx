import React from 'react';
import PropTypes from 'prop-types';
import NavIcon from '../common/NavIcons';
import useResourceUsage, { formatGb, formatPct } from './useResourceUsage';

/**
 * Settings → Resource: CPU, Memory, Disk and NFS Storage.
 *
 * Served by one backend call, `GET /api/infrastructure/utilization`. See
 * useResourceUsage for why the previous PromQL chain was replaced — in short, its
 * pod-discovery query read a metric OpenObserve stopped writing days ago, and a
 * single dead stream blanked three of the four cards.
 *
 * NUMBERS ONLY. No charts, no gauges beyond the capacity bar — every figure is a
 * printed number, by request. Two rules follow from that and are worth keeping:
 * every percentage sits next to the two numbers it was divided from, so a reader
 * can check it; and a missing reading prints an em dash rather than 0, so an
 * absent metric can never be misread as an idle CPU or an empty disk.
 *
 * ─── THE FOUR CARDS DO NOT ALL MEASURE THE SAME THING ──────────────────────
 *
 * The single most important thing about this screen, and the one it has twice got
 * wrong:
 *
 *   • CPU and MEMORY are POD-scoped. Each is one percentage of the
 *     `tiotopenobserve` pods' configured limit, produced by one SQL statement in
 *     `infrastructure.cpu.sql` / `infrastructure.memory.sql`.
 *   • DISK and NFS STORAGE are CLUSTER-scoped, aggregated across nodes.
 *
 * So the scope is printed in every card header, and it comes from `tile.scope` on
 * the wire rather than from a constant here. Those queries are configuration: a
 * label hard-coded in this file goes stale the moment someone repoints one, and a
 * card confidently announcing the wrong scope is worse than one announcing none.
 *
 * There is NO per-node breakdown and no node picker. Both existed to open up the
 * CPU and Memory cluster averages, and with those two now measuring named pods
 * there is no average to open up — a node column against a pod reading is not a
 * detail view, it is a category error.
 *
 * ─── What the two storage figures actually count ───────────────────────────
 *
 * Recorded here because neither fact is derivable from the labels:
 *
 *   • DISK counts real filesystems only. `tmpfs` and `overlay` mounts are
 *     excluded by the backend — included, the figure would describe container
 *     images rather than the disk that can actually fill up.
 *   • NFS STORAGE folds claims that share one export into a single backing store.
 *     Counting each claim separately would report the export's size once per pod
 *     that mounted it.
 *
 * The 20s poll and its pause on a hidden tab are POLL_MS in useResourceUsage,
 * 1024-based GB is formatGb, and per-card sample age is readingAge below.
 */

/**
 * How stale a reading is, in words.
 *
 * Worth the code because these metrics genuinely stop being scraped for long
 * stretches — the kubelet volume scraper runs about twelve minutes behind the
 * host metrics on this cluster. A wall-clock timestamp alone lets a stale number
 * pass as current; "12 min old" does not.
 */
const STALE_AFTER_MIN = 30;

const readingAge = (t) => {
  if (!Number.isFinite(t)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - t) / 60000));
  const stale = minutes >= STALE_AFTER_MIN;
  if (minutes < 1) return { text: 'just now', stale };
  if (minutes < 60) return { text: `${minutes} min old`, stale };
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return { text: rem ? `${hours}h ${rem}m old` : `${hours}h old`, stale };
};

/** Seconds → `just now` / `4 min` / `1h 2m`, for the per-tile age. */
const shortAge = (sec) => {
  if (!Number.isFinite(sec)) return null;
  if (sec < 60) return 'just now';
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
};

/**
 * The Windows Explorer drive-capacity bar: a bordered track filled left-to-right
 * in proportion to what is consumed, captioned with the two numbers behind it.
 *
 * Three details make it read as that control rather than a generic progress bar,
 * and all three are load-bearing:
 *
 * IT REPORTS FREE SPACE, NOT USED, when it is reporting bytes. The bar fills with
 * what is CONSUMED while the caption names what REMAINS. That inversion is the
 * whole point of the Windows widget — the bar answers "how bad is it" at a glance
 * and the caption answers "how much have I got left" — so the default caption
 * must not be switched to used.
 *
 * IT COLOURS BY SEVERITY, sharing the exact thresholds and tone classes as the
 * utilization percentage above it. One card must never show an amber number over
 * a green bar.
 *
 * THE FILL IS CLAMPED to 0–100. A reading can exceed its capacity — a throttled
 * pod genuinely runs past its CPU limit — and an unclamped width would overflow
 * the track and paint outside the card's rounded corner. Only the BAR is clamped;
 * the printed percentage above it still says 118%, because that is the reading
 * worth acting on.
 */
function CapacityBar({
  used, total, pct, format, tone, caption,
}) {
  // Without a percentage there is nothing to fill the track to, and a track
  // filled to an unknown fraction is worse than no track.
  if (!Number.isFinite(pct)) return null;

  // A card with byte counts writes its own "X free of Y"; a card without them
  // (CPU, Memory) supplies the caption its statement already formatted. Neither
  // available means no bar, rather than a bar over an unexplained number.
  const free = Number.isFinite(total) && Number.isFinite(used) ? total - used : null;
  const text = caption || (free == null ? null : `${format(free)} free of ${format(total)}`);
  if (!text) return null;

  const fill = Math.min(100, Math.max(0, pct));

  return (
    <div className="rs-cap">
      <progress
        aria-valuenow={Math.round(fill)}
        className={`rs-cap-track rs-cap-fill ${tone}`}
        value={Number(fill.toFixed(1))}
        max={100}
        aria-label={`${fill.toFixed(1)} percent used`}
      />
      <span className="rs-cap-caption">{text}</span>
    </div>
  );
}
CapacityBar.propTypes = {
  used: PropTypes.number,
  total: PropTypes.number,
  /** Percentage consumed — drives the fill width, not recomputed from used/total. */
  pct: PropTypes.number,
  /** Unit formatter for the default byte caption. */
  format: PropTypes.func.isRequired,
  tone: PropTypes.string,
  /** Replaces the "X free of Y" caption. Used where there are no byte counts. */
  caption: PropTypes.string,
};

/** A label/value line inside a card. `strong` marks the figure that matters. */
function Stat({ label, value, note, strong }) {
  return (
    <li className={`rs-stat ${strong ? 'is-strong' : ''}`}>
      <span className="rs-stat-label">{label}</span>
      {note && <span className="rs-stat-note">{note}</span>}
      <span className="rs-stat-value">{value}</span>
    </li>
  );
}
Stat.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  note: PropTypes.node,
  strong: PropTypes.bool,
};

const toneFor = (pct) => {
  if (!Number.isFinite(pct)) return '';
  if (pct >= 90) return 'is-critical';
  if (pct >= 75) return 'is-warn';
  return 'is-ok';
};

/** How old the card's reading is, and whether that age is itself the news. */
function CardFooter({ age, stale, lastSeen, detail }) {
  return (
    <div
      className={`rs-card-foot ${stale ? 'is-stale' : ''}`}
      title={lastSeen || undefined}
    >
      Reading {age === 'just now' ? 'just now' : `${age} old`}
      {stale ? ' — collector has gone quiet' : ''}
      {detail ? ` · ${detail}` : ''}
    </div>
  );
}
CardFooter.propTypes = {
  age: PropTypes.string.isRequired,
  stale: PropTypes.bool,
  lastSeen: PropTypes.string,
  detail: PropTypes.string,
};

/**
 * One resource: a headline figure, its utilization, and the numbers behind it.
 *
 * A tile the backend marked unavailable renders its REASON in place of the
 * numbers. That is the whole reason `message` is plumbed through: the old screen
 * showed four em dashes with no explanation, which is indistinguishable from a
 * cluster that is doing nothing.
 */
function ResourceCard({
  title, scope, headline, headlineLabel, tile, format, caption, hideFooterDetail,
  loading, children,
}) {
  const pct = tile?.pct;
  const tone = toneFor(pct);
  const age = shortAge(tile?.lastSeenAgoSec);

  // The pod cards put `detail` in their headline, so repeating it here would
  // print the same string twice on one card.
  const footerDetail = hideFooterDetail ? '' : tile?.detail;

  // A reading this old IS the answer to "why is this number not moving", so the
  // card has to draw the eye to it instead of printing it in the same grey as
  // everything else. Amber, not red: an old reading is a caveat on the figure,
  // not a failure of it — it was true when it was taken.
  const stale = Number.isFinite(tile?.lastSeenAgoSec)
    && tile.lastSeenAgoSec >= STALE_AFTER_MIN * 60;

  let content;
  if (loading) {
    content = <div className="rs-card-state">Loading…</div>;
  } else if (!tile?.available) {
    content = (
      <div className="rs-card-state">
        {tile?.message || 'No reading available.'}
      </div>
    );
  } else {
    content = (
      <>
        <div className="rs-headline">
          <span className="rs-headline-value">{headline}</span>
          <span className="rs-headline-label">{headlineLabel}</span>
          <span className={`rs-headline-pct ${tone}`}>{formatPct(pct)}</span>
        </div>
        <CapacityBar
          used={tile.used}
          total={tile.total}
          pct={pct}
          format={format}
          tone={tone}
          caption={caption}
        />
        {/* Omitted rather than left empty on the pod cards: they have two facts
            to show and both are above, so a stats list would only be able to
            reprint them. An empty <ul> would still take its margin. */}
        {children && <ul className="rs-stats">{children}</ul>}
        {age && (
          <CardFooter age={age} stale={stale} lastSeen={tile.lastSeen} detail={footerDetail} />
        )}
      </>
    );
  }

  return (
    <section className="rs-card">
      <header className="rs-card-head">
        <h2 className="rs-card-title">{title}</h2>
        <span className="rs-card-scope" title={scope}>{scope}</span>
      </header>
      {content}
    </section>
  );
}
ResourceCard.propTypes = {
  title: PropTypes.string.isRequired,
  /** What the card measures, from the backend. See the scope note at the top. */
  scope: PropTypes.string,
  headline: PropTypes.node,
  headlineLabel: PropTypes.string,
  /** The normalized tile from useResourceUsage; null until the first load. */
  tile: PropTypes.shape({
    available: PropTypes.bool,
    pct: PropTypes.number,
    used: PropTypes.number,
    total: PropTypes.number,
    detail: PropTypes.string,
    scope: PropTypes.string,
    message: PropTypes.string,
    lastSeen: PropTypes.string,
    lastSeenAgoSec: PropTypes.number,
  }),
  format: PropTypes.func.isRequired,
  /** Bar caption for a tile with no byte counts. */
  caption: PropTypes.string,
  /** Set where the card already shows `detail` above the fold. */
  hideFooterDetail: PropTypes.bool,
  loading: PropTypes.bool,
  children: PropTypes.node,
};

/**
 * The caption under a limit bar: what is left before the limit is reached.
 *
 * Mirrors the capacity bar's rule — the bar fills with what is CONSUMED, the
 * caption names what REMAINS — so a limit card reads the same way as a disk card
 * without needing byte counts it does not have.
 *
 * Past 100% there is no headroom left to name. Printing "-18.4% headroom" would
 * bury the one reading on this screen worth acting on, so it is stated plainly.
 */
const limitCaption = (pct) => {
  if (!Number.isFinite(pct)) return undefined;
  if (pct > 100) return `over limit by ${formatPct(pct - 100)}`;
  return `${formatPct(100 - pct)} headroom`;
};

export default function ResourceUsageView({ activeOrg }) {
  const {
    cpu, memory, disk, nfs, asOf, fetchedAt, pollMs, loading, error, refresh,
  } = useResourceUsage({ activeOrg });

  const age = readingAge(asOf);

  // TWO different ages, and conflating them is what makes this screen look broken.
  //
  //   `age`     — how old the DATA is. Governed by the collector, and on this
  //               cluster it can sit at forty minutes while a pod is replaced.
  //   `checked` — when this SCREEN last read the API. Governed by POLL_MS.
  //
  // Only the second answers "is this page live". Without it a viewer watching an
  // unchanging number has no way to tell a quiet collector from a dead page, and
  // those call for completely different actions — chase the pod, or reload.
  // It re-renders on every poll because each response replaces `meta`.
  const checked = Number.isFinite(fetchedAt)
    ? shortAge(Math.round((Date.now() - fetchedAt) / 1000))
    : null;

  return (
    <section className="rs-view">
      <header className="rs-head">
        <span className="ov-panel-icon" aria-hidden="true">
          <NavIcon name="streams" size={18} />
        </span>
        {/* Matches the Settings tab that opens it. */}
        <h1 className="page-heading">Resources</h1>
        <span className="rs-head-sub">CPU, memory, disk and NFS storage</span>

        <div className="rs-head-right">
          {age && (
            <span
              className={`rs-asof ${age.stale ? 'is-stale' : ''}`}
              title={`Newest sample behind these figures: ${new Date(asOf).toLocaleString()}`}
            >
              Reading {age.text}
            </span>
          )}
          {checked && (
            <span
              className="rs-asof"
              title={`This screen re-reads automatically every ${Math.round(pollMs / 1000)}s`
                + ` (paused while the tab is hidden). Last read:`
                + ` ${new Date(fetchedAt).toLocaleTimeString()}.`
                + ' The figures only change when the collector writes new samples.'}
            >
              · auto-refresh {Math.round(pollMs / 1000)}s, checked{' '}
              {checked === 'just now' ? 'just now' : `${checked} ago`}
            </span>
          )}
          <button
            type="button"
            className="results-bar-btn"
            onClick={refresh}
            title="Refresh now"
            aria-label="Refresh resource figures"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
        </div>
      </header>

      {error && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">{error}</span>
        </div>
      )}

      <div className="rs-body">
        <div className="rs-split">
          {/* CPU and Memory have exactly TWO facts each: the percentage and the
              two numbers it was divided from (`detail`, e.g. "2.05 / 5 cores").
              Both arrive finished from one SQL statement apiece, so nothing here
              recomputes either — the headline prints the pair, the badge prints
              the percentage, and the bar caption is the only derived figure.
              There is deliberately no stats list: with two facts it could only
              reprint what is already above it.

              See the scope note at the top of this file before adding a node
              column to either of these. */}
          <ResourceCard
            title="CPU"
            scope={cpu?.scope || 'pods'}
            headline={cpu?.detail || '—'}
            headlineLabel="of limit"
            tile={cpu}
            caption={limitCaption(cpu?.pct)}
            hideFooterDetail
            // No byte capacity on this card, so the formatter is never reached —
            // `caption` replaces the "X free of Y" it would otherwise write.
            format={formatPct}
            loading={loading}
          />

          <ResourceCard
            title="Memory"
            scope={memory?.scope || 'pods'}
            headline={memory?.detail || '—'}
            headlineLabel="of limit"
            tile={memory}
            caption={limitCaption(memory?.pct)}
            hideFooterDetail
            format={formatPct}
            loading={loading}
          />

          {/* Disk and NFS: cluster-wide byte counts, aggregated server-side. These
              two keep the "X free of Y" capacity caption. */}
          <ResourceCard
            title="Disk"
            scope={disk?.scope || 'real filesystems'}
            headline={formatGb(disk?.used)}
            headlineLabel="used"
            tile={disk}
            format={formatGb}
            loading={loading}
          >
            <Stat label="Used" value={formatGb(disk?.used)} strong />
            <Stat label="Free" value={formatGb(disk?.free)} />
            <Stat label="Capacity" value={formatGb(disk?.total)} note="used + free" />
            <Stat label="Utilization" value={formatPct(disk?.pct)} note="used ÷ capacity" />
          </ResourceCard>

          <ResourceCard
            title="NFS Storage"
            scope={nfs?.scope || 'persistent volume claims'}
            headline={formatGb(nfs?.used)}
            headlineLabel="used"
            tile={nfs}
            format={formatGb}
            loading={loading}
          >
            <Stat label="Used" value={formatGb(nfs?.used)} strong />
            <Stat label="Free" value={formatGb(nfs?.free)} />
            <Stat label="Capacity" value={formatGb(nfs?.total)} note="shared export" />
            <Stat label="Utilization" value={formatPct(nfs?.pct)} note="used ÷ capacity" />
          </ResourceCard>
        </div>
      </div>
    </section>
  );
}

ResourceUsageView.propTypes = {
  /** Not filtered on — these are cluster and platform-pod figures, not a tenant's.
   *  Kept as a refetch trigger so switching org re-reads rather than showing a
   *  reading taken under the previous scope. */
  activeOrg: PropTypes.string,
};
