/**
 * Analytics → Logs drill-through.
 *
 * ─── What a clicked number has to promise ───────────────────────────────────
 *
 * Clicking "1,062" under Error on the IoTOpsSvc row means "show me those 1,062
 * lines". If the Logs screen then opens on a different time range, or filtered to a
 * service the operator was looking at yesterday, the count they land on will not be
 * the count they clicked — and a dashboard whose numbers change when you follow them
 * is worse than one you cannot click at all.
 *
 * So a drill carries THREE things, and all three are non-negotiable:
 *   • the services the row aggregated,
 *   • the severity of the column,
 *   • the analytics window, translated into the Logs screen's own range shape.
 *
 * ─── Why the mapping is a module and not two inline handlers ────────────────
 *
 * Both faces drill, and they must drill identically — the same click on the same
 * service from the Drill Table and from the Category Board has to land on the same
 * query. Building the filter in each component is how the two quietly diverge.
 */

/**
 * Severity buckets a click can express as a Logs filter, mapped to the severity the
 * query dialect uses.
 *
 * ─── `total` and `other` are deliberately different cases ───────────────────
 *
 * `total` maps to no severity clause at all: every line for that service, which is
 * exactly what Total counts. It is a drill, not an absence of one.
 *
 * `other` is absent from this table on purpose. It is TRACE plus the lines whose
 * severity is unset — a UNION of two conditions — and the query dialect supports
 * neither OR nor "is null" (see `applyClause`: OR, IN, LIKE and NOT are all rejected).
 * A drill that quietly filtered to TRACE alone would send an operator to 213 rows
 * while the cell they clicked said 429, so the cell is left unclickable instead.
 */
const BUCKET_SEVERITY = {
  total: '',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

/** The Logs screen's relative-range presets, so a drill lands on a highlighted one.
 *
 *  24h and 7d are the same durations as 1d and 1w, but only the latter are in the
 *  picker's grid (hours stop at 12, days at 6). Sending `24h` would work — the
 *  backend parses it — and then show a range picker with nothing selected, which
 *  reads as though the range were unknown rather than an hour-for-hour match. */
const WINDOW_TO_RELATIVE = {
  '15m': '15m',
  '1h': '1h',
  '6h': '6h',
  '24h': '1d',
  '7d': '1w',
};

/**
 * The telemetry column the Logs query dialect can actually filter on.
 *
 * <p>A catalog resource may be bound by `k8s_deployment_name` or `db_name` instead;
 * those reach the dialect's `default` branch, which degrades them to a free-text
 * search across every column and says so in a warning. That is not a filter worth
 * navigating to under the promise of an exact count, so such rows do not offer a
 * drill.</p>
 */
const DRILLABLE_COLUMN = 'service_name';

/**
 * ONE service per drill, and the reason is not a simplification.
 *
 * <p>Verified against the backend: repeated `serviceNames` do NOT mean "logs from any
 * of these". `LogsServiceImpl.queryLogsCore` resolves the set of traces whose service
 * set ⊇ the selection and restricts rows to those traces — documented there as
 * "AND-at-trace-grain", i.e. only logs from traces that cross EVERY selected service.
 * It is a deliberate feature of that screen and useful on its own terms.</p>
 *
 * <p>It is also the opposite of what an aggregated count means. The Applications
 * category's 2,279 errors is a SUM over six services; opening it with all six selected
 * would show only the errors on traces touching all six at once — a far smaller number
 * than the cell that was clicked. A link that lands on a contradicting figure is worse
 * than no link, so rows aggregating more than one service are not clickable and their
 * tooltip says to drill into a specific service instead.</p>
 */
const MAX_DRILL_SERVICES = 1;

/**
 * The service names a row's counts came from.
 *
 * <p>Read out of `matchedOn`, which the backend fills with the identifiers it counted
 * — `service_name=IoTOpsSvc`. That is the same list the count was computed from, so
 * the drill filters on exactly what was counted rather than on a name re-derived from
 * the row's label, which is a display string and not an identifier.</p>
 */
export function serviceNamesFrom(row) {
  const out = [];
  for (const identifier of row?.matchedOn || []) {
    const split = String(identifier).indexOf('=');
    if (split < 0) continue;
    const column = String(identifier).slice(0, split).trim();
    const value = String(identifier).slice(split + 1).trim();
    if (column === DRILLABLE_COLUMN && value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** An analytics window expression → the Logs screen's range object. */
export function windowToLogsRange(window) {
  const raw = String(window || '').trim().replace(/^now-/, '');
  const relative = WINDOW_TO_RELATIVE[raw]
    // Anything the table does not list is passed through if it is a shape the Logs
    // picker and the backend both understand, so adding a window to the analytics
    // dropdown does not silently break the drill.
    || (/^\d+[mhdwM]$/.test(raw) ? raw : '15m');
  return { mode: 'relative', relative, from: '', to: '' };
}

/**
 * The filter a clicked cell should open the Logs screen with, or null when the cell
 * is not a link.
 *
 * <p>Returns null for four distinct reasons, all of which mean "do not render this as
 * clickable": the column cannot be expressed as a severity filter, the row has no
 * `service_name` to filter on, the row aggregates more than one service (see
 * {@link MAX_DRILL_SERVICES}), or the count is zero. Zero is excluded because
 * following it can only ever land on an empty table — the number already told the
 * whole story, and a link that leads to nothing teaches an operator to distrust the
 * other links.</p>
 *
 * @param {object}  args.row       an analytics row (category, product or microservice)
 * @param {string}  args.bucketKey 'total' | 'info' | 'warn' | 'error' | 'debug'
 * @param {string}  args.window    the analytics window, e.g. 'now-24h'
 * @returns {{services: string[], severity: string, range: object, count: number}|null}
 */
export function buildLogsDrill({ row, bucketKey, window }) {
  if (!row || !(bucketKey in BUCKET_SEVERITY)) return null;

  const count = Number(row[bucketKey]) || 0;
  if (count <= 0) return null;

  const services = serviceNamesFrom(row);
  if (!services.length || services.length > MAX_DRILL_SERVICES) return null;

  return {
    services,
    severity: BUCKET_SEVERITY[bucketKey],
    range: windowToLogsRange(window),
    count,
  };
}

/**
 * The cell's tooltip.
 *
 * <p>Says what the click does and what it will filter to, because a number that is
 * suddenly a link needs to explain itself — and when it is NOT a link, why not. The
 * three non-drillable cases have three different explanations, and "nothing happens"
 * is not one of them.</p>
 */
export function drillHint({ row, bucketKey, drill, exact }) {
  if (drill) {
    const what = drill.severity ? `${drill.severity} logs` : 'logs';
    return `Open these ${exact} ${what} for ${drill.services[0]} in Logs`;
  }
  if (bucketKey === 'other') {
    return `${exact} — trace and logs with no severity set. `
      + 'Not openable as one filter: the logs query supports no OR.';
  }
  if ((Number(row?.[bucketKey]) || 0) <= 0) return `${exact} — nothing to open`;

  const services = serviceNamesFrom(row);
  if (!services.length) {
    return `${exact} — this row is not counted from a service_name, so Logs cannot `
      + 'filter to it exactly';
  }
  if (services.length > MAX_DRILL_SERVICES) {
    return `${exact} — a sum over ${services.length} services. Logs filters several `
      + 'services as an intersection at trace level, which would show a smaller '
      + 'number than this. Open a single service to see its logs.';
  }
  return exact;
}
