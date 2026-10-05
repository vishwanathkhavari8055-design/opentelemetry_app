/**
 * When a dynamic text panel's script runs.
 *
 * Every new document is a full run of the panel's script, and on a real
 * dashboard a run is expensive: the OSS Engine Overview topology script fires
 * ~40 queries of its own each time. The document used to be rebuilt on every
 * change of the panel's data, and a first load changes it three times —
 *
 *   { Done, [] }  Scenes' placeholder before the query has even started
 *   { Loading }   the query started
 *   { Done, … }   the answer
 *
 * — so the script ran three times, and the first two runs' ~80 queries sat in
 * front of the real ones. Over HTTP/1.1 only six requests are in flight at once,
 * so that alone was most of the wait. Every refresh added a Loading run on top of
 * the real one.
 *
 * So the script runs once per ANSWER. Until the first answer the panel shows its
 * `defaultContent` with no script, which is what that content is for; while a
 * refresh is loading it keeps showing the previous answer, as Grafana does.
 *
 * No imports, so test/panelAnswer.test.mjs can load it under plain Node.
 */

/**
 * Set by the scene builder on a panel that HAS a query runner.
 *
 * A panel needs to be told, because it cannot work it out: Scenes gives a panel
 * whose query has not run yet exactly what it gives a panel with no query at all
 * — `{ state: Done, series: [] }`. Without the flag a query-less panel would wait
 * forever for an answer that is never coming, so the default is "do not wait".
 */
export const AWAITS_QUERY_OPTION = '__dtAwaitsQuery';

// @grafana/data's LoadingState values. Spelled out rather than imported to keep
// this module dependency-free; they are the strings Grafana puts on the wire.
const LOADING = 'Loading';
const ERROR = 'Error';

/** Is this data an answer the panel's script should run against? */
export function isAnswer(data, awaitsQuery) {
  if (!data) return !awaitsQuery;
  if (data.state === LOADING) return false;
  if (!awaitsQuery) return true;
  // `request` is set on every result a query produced; the placeholder has
  // none. Rows or an error prove the same thing on their own.
  return Boolean(data.request)
    || (data.series?.length ?? 0) > 0
    || data.state === ERROR;
}
