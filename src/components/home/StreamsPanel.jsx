import React from 'react';
import PropTypes from 'prop-types';

/**
 * The Streams panel: five headline figures for the org's ingest — stream count,
 * total events, and the three storage sizes.
 *
 * A missing figure renders "—", never "0". The backend returns null for anything
 * it couldn't compute, and showing a zero there would read as "nothing ingested"
 * rather than "we don't know".
 */

const ICONS = {
  streams: (
    <>
      <path d="m9 8 -4 4 4 4" />
      <path d="m15 8 4 4-4 4" />
    </>
  ),
  events: (
    <>
      <path d="M4 19V5" />
      <path d="M9 19v-7" />
      <path d="M14 19V8" />
      <path d="M19 19v-4" />
    </>
  ),
  ingested: (
    <>
      <path d="M12 3v11" />
      <path d="m8 10.5 4 4 4-4" />
      <path d="M4 20h16" />
    </>
  ),
  compressed: (
    <>
      <path d="M4 7h16" />
      <path d="M4 17h16" />
      <path d="m9 11.5 3-2.5 3 2.5" />
      <path d="m9 12.5 3 2.5 3-2.5" />
    </>
  ),
  index: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 4v6l4-2 4 2V4" />
    </>
  ),
};

const StatIcon = ({ name }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name]}
  </svg>
);

StatIcon.propTypes = { name: PropTypes.string.isRequired };

/** 632 / 47.8M / 1.2B — compact, like the reference. */
export const formatCount = (n) => {
  if (n == null) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
};

/**
 * Raw bytes → "105.74 GB". 1024-based, which is what storage tooling reports;
 * the unit suffix is the conventional short form for the binary multiple.
 */
export const formatBytes = (bytes) => {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  // Bytes are whole; everything above gets two decimals so 392.95 MB reads
  // exactly as it does in OpenObserve rather than rounding to 393 MB.
  return `${exp === 0 ? Math.round(value) : value.toFixed(2)} ${units[exp]}`;
};

const StreamsPanel = ({ streams, loading, onOpen }) => {
  const tiles = [
    { key: 'streams',    label: 'Streams',         value: formatCount(streams?.count) },
    { key: 'events',     label: 'Events',          value: formatCount(streams?.events) },
    { key: 'ingested',   label: 'Ingested Size',   value: formatBytes(streams?.ingestedBytes) },
    { key: 'compressed', label: 'Compressed Size', value: formatBytes(streams?.compressedBytes) },
    { key: 'index',      label: 'Index Size',      value: formatBytes(streams?.indexBytes) },
  ];

  return (
    <section className="ov-panel">
      <header className="ov-panel-head">
        <span className="ov-panel-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 9v12" />
          </svg>
        </span>
        <h2 className="ov-panel-title">Streams</h2>
        {loading && <span className="home-panel-spinner" aria-label="Loading" />}
        {onOpen && (
          <button
            type="button"
            className="home-panel-open"
            onClick={onOpen}
            title="Open the Logs screen"
            aria-label="Open the Logs screen"
          >
            →
          </button>
        )}
      </header>

      <div className="ov-tiles">
        {tiles.map((t) => (
          <div className="ov-tile" key={t.key}>
            <span className="ov-tile-top">
              <span className="ov-tile-label">{t.label}</span>
              <span className="ov-tile-chip" aria-hidden="true">
                <StatIcon name={t.key} />
              </span>
            </span>
            <span className="ov-tile-value">{t.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
};

StreamsPanel.propTypes = {
  streams: PropTypes.shape({
    count:           PropTypes.number,
    events:          PropTypes.number,
    ingestedBytes:   PropTypes.number,
    compressedBytes: PropTypes.number,
    indexBytes:      PropTypes.number,
  }),
  loading: PropTypes.bool,
  /** Renders the header arrow when provided. */
  onOpen: PropTypes.func,
};

export default StreamsPanel;
