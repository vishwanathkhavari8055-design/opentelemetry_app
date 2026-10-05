import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLogServiceCounts, fetchServiceCatalog } from '../../../services/api';

/**
 * Which registered services are actually PRODUCING telemetry, per signal.
 *
 * The catalog says what someone registered. This says what is arriving. Step 1
 * of the alert wizard needs both, because they disagree often enough to matter:
 * a resource can be registered, enabled, and emitting nothing — and an alert on
 * it would sit at zero forever without ever looking broken.
 *
 * ─── Two sources, deliberately not unioned into one list ────────────────────
 *
 * Logs come from GET /api/logs/services (one `GROUP BY service_name` over the
 * logs stream); traces from GET /api/traces/catalog (per-service span volume).
 * They are kept as SEPARATE per-signal counts rather than merged into a single
 * "is it live" flag, because the answer differs by signal and step 2 asks about
 * one signal at a time. A service that logs but emits no spans can never
 * satisfy a trace query, and the merged flag would have promised it could.
 *
 * This mirrors what LogsView and TracesView each already do for their own
 * sidebars — see the notes there on why neither view unions in the
 * /services/uptime heartbeat inventory, which lists services under their
 * heartbeat name and includes ones that emit nothing.
 *
 * ─── Names are compared EXACTLY ─────────────────────────────────────────────
 *
 * No case folding. This deployment genuinely runs both `IoTOpsApiSvc` and
 * `iotopsapisvc` as separate services, and folding them hides one behind the
 * other. The key is the catalog's `resolvedName` — the spelling telemetry uses —
 * not the operator's label.
 *
 * ─── "Absent" and "unknown" are different answers ───────────────────────────
 *
 * An empty discovery result is NOT evidence a service is gone; far more often
 * the query failed or has not returned. `status` reports which of the two the
 * caller is looking at, so the UI can say "nothing in this window" where that is
 * true and stay quiet where it cannot tell. Conflating them paints every
 * registered resource as missing and sends people to fix the wrong thing.
 */

/**
 * Discovery window.
 *
 * <p>Fixed, unlike the Logs and Traces sidebars, which scope discovery to the
 * range their table is showing. The wizard has no range — nothing on this screen
 * is asking about a period — so one has to be chosen, and the question here is
 * "does this service emit at all", not "did it emit during the window I am
 * reading". 24h is wide enough that a nightly batch job still registers as live
 * and narrow enough that OpenObserve can scan it.</p>
 */
export const TELEMETRY_WINDOW = 'now-24h';

/** Human form of the window above, for the one place the UI names it. */
export const TELEMETRY_WINDOW_LABEL = 'last 24h';

/** Same cadence as useCatalog's, so registrations and telemetry refresh together. */
const POLL_MS = 60_000;

/** Trace discovery returns these for spans it could not attribute. */
const isPlaceholderName = (name) => !name || name === 'unknown-service' || name === '-';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] false parks the hook without fetching — for a
 *   step that is not on screen, so a wizard on step 3 is not polling discovery.
 * @returns {{
 *   byName: Map<string, {logs: number|null, traces: number|null}>,
 *   status: 'loading' | 'ready' | 'unavailable',
 *   logsStatus: 'loading' | 'ready' | 'unavailable',
 *   tracesStatus: 'loading' | 'ready' | 'unavailable',
 *   reload: Function,
 * }}
 */
export default function useServiceTelemetry({ enabled = true } = {}) {
  const [logs, setLogs] = useState(null);
  const [traces, setTraces] = useState(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let cancelled = false;

    /* Settled, not all: one signal being down must not blank the other. Traces
       can be unsupported on a deployment that has logs, and a rejected Promise.all
       would have reported "no telemetry anywhere" for every service. */
    Promise.allSettled([
      fetchLogServiceCounts({ startTime: TELEMETRY_WINDOW, signal: controller.signal }),
      fetchServiceCatalog({
        startTime: TELEMETRY_WINDOW, size: 1000, signal: controller.signal,
      }),
    ]).then(([logsRes, tracesRes]) => {
      if (cancelled) return;

      setLogs(logsRes.status === 'fulfilled'
        ? (logsRes.value || []).map((r) => ({ name: (r.name || '').trim(), count: r.count ?? null }))
        : null);

      setTraces(tracesRes.status === 'fulfilled'
        ? ((tracesRes.value?.items) || []).map((r) => ({
          name: (r.serviceName || '').trim(),
          count: r.requests ?? null,
        }))
        : null);
    });

    return () => { cancelled = true; controller.abort(); };
  }, [enabled, tick]);

  /* Keep it current without polling a hidden tab — same shape as useCatalog's
     poll, so a service registered in another tab and its first logs show up here
     within the same minute. */
  const reloadRef = useRef(reload);
  useEffect(() => { reloadRef.current = reload; }, [reload]);
  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    const tickOnce = () => reloadRef.current();
    const start = () => { if (timer == null) timer = setInterval(tickOnce, POLL_MS); };
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { tickOnce(); start(); } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled]);

  /**
   * One signal's state.
   *
   * <p>`null` is "we have not been told" — still in flight, or the call rejected.
   * An empty ARRAY is a real answer: the query ran and nothing matched.</p>
   */
  let logsStatus = 'loading';
  if (logs != null) logsStatus = logs.length ? 'ready' : 'unavailable';

  let tracesStatus = 'loading';
  if (traces != null) tracesStatus = traces.length ? 'ready' : 'unavailable';

  const byName = useMemo(() => {
    const map = new Map();
    const put = (rows, key) => {
      (rows || []).forEach(({ name, count }) => {
        if (isPlaceholderName(name)) return;
        if (!map.has(name)) map.set(name, { logs: null, traces: null });
        map.get(name)[key] = count;
      });
    };
    put(logs, 'logs');
    put(traces, 'traces');
    return map;
  }, [logs, traces]);

  /**
   * The combined state, for callers that only need "may I draw a conclusion".
   *
   * <p>`ready` as soon as EITHER signal answered: we can then legitimately say a
   * service is absent from that signal. Only when neither answered is the whole
   * question unanswerable.</p>
   */
  const status = (() => {
    if (logsStatus === 'ready' || tracesStatus === 'ready') return 'ready';
    if (logsStatus === 'loading' || tracesStatus === 'loading') return 'loading';
    return 'unavailable';
  })();

  return { byName, status, logsStatus, tracesStatus, reload };
}
