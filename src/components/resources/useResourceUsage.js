import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchInfrastructureUtilization } from '../../services/api';

/**
 * CPU, memory, disk and NFS figures for Settings → Resource.
 *
 * ONE backend call — `GET /api/infrastructure/utilization` — replacing the nine
 * PromQL range queries and two discovery queries this hook used to issue.
 *
 * <h3>Why the PromQL chain was replaced rather than repaired</h3>
 *
 * It had a single point of failure that took out three of the four cards. Pod
 * discovery read `zo_node_disk_usage`, an OpenObserve self-monitoring metric,
 * which has stopped being written: 13 rows in seven days, newest ~2.8 days old.
 * An empty discovery result produced an empty pod selector, an empty selector
 * made `k8s_pod_cpu_usage{k8s_pod_name=~""}` match nothing, and so CPU, Memory
 * and Disk all rendered em dashes while `k8s_pod_cpu_usage` itself was a minute
 * fresh. Only NFS survived, because it was the one query needing no discovery.
 *
 * Stream selection, the time window and the arithmetic now live on the server
 * (InfrastructureMetricsServiceImpl), so a stream that moves or dies is a
 * configuration change there rather than a release here.
 *
 * <h3>Nothing here computes anything</h3>
 *
 * Not an accident, and worth defending. Every card's percentage and every
 * caption arrives finished: CPU and Memory come out of one SQL statement each
 * that divides by the pods' limit and formats "1.59 / 5 cores" in the same
 * breath, and Disk and NFS are aggregated server-side. This module normalizes
 * nulls and polls. That is the whole job.
 *
 * The alternative — re-deriving a caption here from separate numbers — is what
 * the old chain did, and its failure mode was a caption that disagreed with the
 * percentage above it because the two were read over different windows. They
 * disagreed precisely during the spikes someone was looking at.
 *
 * What is KEPT from the old implementation, because it was right: every figure is
 * a printed number; a missing reading is an em dash and never a zero; and the age
 * of the reading is shown, because these metrics genuinely stop updating for long
 * stretches and a wall-clock timestamp alone lets a stale number pass as current.
 */

/**
 * How often the tiles re-read, in ms.
 *
 * The screen previously had NO polling at all — the only refetch triggers were
 * the refresh button and an org change — which is the whole of "it is not
 * updating dynamically". The backend holds a short cache of its own
 * (`infrastructure.cache-seconds`, 15s), so this interval is what the user sees
 * while that cache is what protects OpenObserve from several viewers at once.
 */
const POLL_MS = 20_000;

const BYTES_PER_GB = 1024 ** 3;

/** Bytes → a number of GB, or null when there is no reading at all. */
export const toGb = (bytes) => (Number.isFinite(bytes) ? bytes / BYTES_PER_GB : null);

/**
 * Bytes → `10.92 GB`, 1024-based to match OpenObserve's own "bytes" unit.
 * Decimal GB (1e9) would be the stricter reading of the name but would print
 * different numbers from the dashboards this screen sits alongside, and a user
 * comparing the two would reasonably conclude one is broken. Do not "fix" this.
 *
 * Used by the Disk and NFS cards, which report byte counts. The CPU and Memory
 * cards do NOT go through here — their sizes arrive already formatted by the
 * statement that produced the percentage, and reformatting them here would be
 * the round trip through floats this design exists to avoid.
 */
export const formatGb = (bytes, decimals = 2) => {
  const gb = toGb(bytes);
  if (gb == null) return '—';
  return `${gb.toFixed(decimals)} GB`;
};

/**
 * Cores → `2.34 cores`.
 *
 * Retained although no tile is denominated in cores any more: it is part of this
 * module's public surface and costs nothing to keep, whereas removing it would
 * break any embedding host that imports it.
 */
export const formatCores = (cores, decimals = 2) => {
  if (!Number.isFinite(cores)) return '—';
  return `${cores.toFixed(decimals)} ${cores === 1 ? 'core' : 'cores'}`;
};

/** An already-computed percentage → `46.7%`. */
export const formatPct = (pct, decimals = 1) => {
  if (!Number.isFinite(pct)) return '—';
  return `${pct.toFixed(decimals)}%`;
};

/** A finite number, or null. Keeps the API's nulls out of arithmetic. */
const num = (value) => (Number.isFinite(value) ? value : null);

/**
 * One backend tile → the shape the cards render.
 *
 * `available` and `message` are carried through rather than collapsed into "has
 * numbers": a tile whose stream is missing has a REASON, and showing it is the
 * difference between "that collector is down" and four inexplicable dashes.
 *
 * `scope` is carried for the same reason in reverse. The four cards do not all
 * measure the same thing — CPU and Memory are scoped to a set of pods, Disk and
 * NFS to the cluster — and the backend is the only place that knows which,
 * because the query behind each one is configuration. A card labelled from a
 * constant in this file would keep claiming the old scope after the query was
 * repointed, which is exactly how this screen came to show node averages under
 * pod headings.
 */
const normalizeTile = (item) => ({
  kind: item?.kind || '',
  label: item?.label || '',
  unit: item?.unit || 'PERCENT',
  available: item?.available === true,
  pct: num(item?.usedPercent),
  used: num(item?.usedBytes),
  free: num(item?.freeBytes),
  total: num(item?.totalBytes),
  detail: item?.detail || '',
  scope: item?.scope || '',
  message: item?.message || '',
  window: item?.window || '',
  lastSeen: item?.lastSeen || null,
  lastSeenAgoSec: num(item?.lastSeenAgoSec),
});

/** Tiles keyed by kind, so a card can ask for its own without index juggling. */
const byKind = (tiles) => Object.fromEntries(tiles.map((t) => [t.kind, t]));

/**
 * @param {object} opts
 * @param {string} opts.activeOrg  refetch trigger; the backend scopes by org.
 */
export default function useResourceUsage({ activeOrg } = {}) {
  const [tiles, setTiles] = useState([]);
  const [meta, setMeta] = useState({
    capturedAt: null, cached: false, supported: true, fetchedAt: null,
  });
  // Only the FIRST load shows the cards as loading. A poll that swapped them back
  // to "Loading…" every twenty seconds would make the screen flicker and be
  // unreadable, so later fetches replace the numbers in place.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  /** True once any response has been applied — see the `loading` note above. */
  const loadedOnce = useRef(false);

  const refresh = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    /**
     * @param {boolean} force bypass the backend cache. False for the automatic
     *   poll, so the 15s server cache can absorb several viewers; true when the
     *   user asks, because a refresh button that returns a cached answer reads
     *   as a broken button.
     */
    const load = (force) => fetchInfrastructureUtilization({
      refresh: force, signal: controller.signal,
    })
      .then((res) => {
        if (cancelled) return;

        // A transport failure is the only thing worth a banner. `supported:false`
        // is the backend saying OpenObserve is off, and it still returns all four
        // tiles carrying that reason — the tiles state it better than a banner.
        setError(res.error || '');

        setTiles((res.items || []).map(normalizeTile));
        // fetchedAt is when the SCREEN last succeeded in reading, which is a
        // different fact from how old the DATA is, and the screen needs both. These
        // metrics can sit unchanged for forty minutes while the pod behind them is
        // being replaced; without a poll timestamp there is no way for a viewer to
        // tell "the collector went quiet" from "this page stopped refreshing", and
        // the two call for completely different actions.
        setMeta({
          capturedAt: res.capturedAt,
          cached: res.cached,
          supported: res.supported,
          fetchedAt: Date.now(),
        });

        loadedOnce.current = true;
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        setError(err.message || 'Resource metrics request failed.');
        setLoading(false);
      });

    if (!loadedOnce.current) setLoading(true);
    load(reloadTick > 0);

    // Polling pauses while the tab is hidden: a background tab querying
    // OpenObserve every twenty seconds is load for nobody's benefit. The
    // visibility handler re-reads immediately on return, so what the user sees
    // when they come back is current rather than however old the last poll was.
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      load(false);
    };
    const timer = setInterval(tick, POLL_MS);

    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) load(false);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, [activeOrg, reloadTick]);

  const kinds = useMemo(() => byKind(tiles), [tiles]);

  /**
   * The freshest reading behind any tile, as epoch ms.
   *
   * The MINIMUM age across the tiles, i.e. the newest sample — the header answers
   * "is this screen live", and taking the oldest would let one slow collector (the
   * volume scraper runs ~12 min behind) report the whole screen as stale. Each
   * tile still carries its own age for the reader who needs it.
   */
  const asOf = useMemo(() => {
    const ages = tiles
      .filter((t) => t.available && Number.isFinite(t.lastSeenAgoSec))
      .map((t) => t.lastSeenAgoSec);
    if (!ages.length) return null;
    return Date.now() - Math.min(...ages) * 1000;
  }, [tiles]);

  return {
    /** The four tiles, by kind. */
    cpu: kinds.CPU || null,
    memory: kinds.MEMORY || null,
    disk: kinds.DISK || null,
    nfs: kinds.NFS_STORAGE || null,
    tiles,
    asOf,
    /** When this screen last read the API — proof it is still polling. */
    fetchedAt: meta.fetchedAt,
    /** The poll interval, so the UI can state its own cadence rather than guess. */
    pollMs: POLL_MS,
    cached: meta.cached,
    supported: meta.supported,
    loading,
    error,
    refresh,
  };
}
