import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { fetchAnalyticsLogCounts, fetchAnalyticsScope } from '../../services/api';
import { formatCount, exactCount } from './analyticsFormat';
import { buildLogsDrill, drillHint } from './analyticsDrill';

/**
 * Analytics Dashboard, DRILL TABLE face — log volume, drilled through the Product
 * Catalog.
 *
 * ─── One of two faces ───────────────────────────────────────────────────────
 *
 * This is the "Category Table" tab of AnalyticsShell; AnalyticsCategoryBoardView is
 * the "Category Board" tab beside it. Both read the same endpoint and report the same
 * numbers — this one as a sortable table steered by three pickers, the other as
 * category cards you click through. The shell mounts exactly one face at a time, so
 * the face you cannot see is not polling OpenObserve behind the one you can.
 *
 * (AnalyticsFlipDeck showed the same two faces behind a flip before that shell landed
 * and still works; this view is mounted by whichever one is in use, and needs to know
 * about neither.)
 *
 * ─── Nothing about the estate is written down here ──────────────────────────
 *
 * There is no list of categories, products or microservices in this file. Every
 * row comes from the backend, which derives them from what is REGISTERED. Register
 * a microservice under "trinityIoT - IoT Hub System and IoT SDK" and that product
 * appears with a count; remove the last one and the row goes away. That is the whole
 * point of the catalog being the registry rather than a table someone maintains.
 *
 * ─── Three levels, one table ────────────────────────────────────────────────
 *
 * Category → Product → Microservice. The columns never change — Total, Info, Warn,
 * Error, Debug — so the same renderer serves all three and a drill is a fetch, not a
 * different screen. The backend decides what level it returned, so the UI cannot
 * disagree with it about what a click means.
 *
 * ─── Counts are fetched per level, not all at once ──────────────────────────
 *
 * Opening a category asks for that category's products. Pre-computing every
 * microservice of every product would query the entire estate to render seven
 * collapsed rows, and the leaf level is the expensive one.
 *
 * ─── Total is not Info + Warn + Error + Debug ───────────────────────────────
 *
 * Deliberately. The logs stream also carries TRACE and a large bucket whose severity
 * is unset — the biggest single group on this deployment. Making Total the sum of the
 * named columns would hide most of the data, so Total is every line and the remainder
 * is reported as Other. Only ENABLED catalog resources are counted. That was stated
 * in a footnote under the table until it was removed by request — anyone reading
 * these columns as a sum that should balance needs this paragraph.
 */

/** Windows offered. Values are what the backend's parser already accepts. */
const WINDOWS = [
  { value: 'now-15m', label: 'Last 15 minutes' },
  { value: 'now-1h', label: 'Last hour' },
  { value: 'now-6h', label: 'Last 6 hours' },
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
];

const REFRESH_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
];

const LS_WINDOW = 'observability-ui:analytics:window:v1';

const readStoredWindow = () => {
  try {
    const stored = localStorage.getItem(LS_WINDOW);
    return WINDOWS.some((w) => w.value === stored) ? stored : 'now-24h';
  } catch { return 'now-24h'; }
};

/** The top of the drill: no category, no product. A fresh object on every call. */
const emptyPath = () => ({ category: null, categoryLabel: null, product: null, productLabel: null });

/**
 * The rows to render, sorted. The microservice step narrows what is already
 * loaded; every other step is a fetch. Matched on key so it survives a refresh
 * that reorders the rows.
 */
const sortedRows = (data, sort, microservice) => {
  const source = microservice
    ? (data?.items || []).filter((r) => r.key === microservice)
    : (data?.items || []);
  const items = [...source];
  const dir = sort.dir === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    if (sort.key === 'label') return dir * String(a.label).localeCompare(String(b.label));
    return dir * ((a[sort.key] || 0) - (b[sort.key] || 0));
  });
  return items;
};

/**
 * The third step's options.
 *
 * <p>A product's microservices when a product is chosen, and the category's
 * product-less ones otherwise — which is what makes Tools and Databases skip
 * straight from category to microservice instead of showing an empty middle step.
 */
const microserviceOptionsFor = (selectedProduct, selectedCategory, productOptions) => {
  if (selectedProduct) return selectedProduct.microservices;
  return selectedCategory && productOptions.length === 0 ? selectedCategory.microservices : [];
};

const microservicePlaceholder = (microserviceOptions, selectedCategory) => {
  if (microserviceOptions.length) return 'All microservices';
  return selectedCategory ? 'Select a product first' : 'Select a category first';
};

const LEVEL_HEADINGS = new Map([['CATEGORY', 'Category'], ['PRODUCT', 'Product']]);

export default function AnalyticsDashboardView({ activeOrg, onNavigate, onDrillToLogs }) {
  const [timeWindow, setTimeWindow] = useState(readStoredWindow);
  useEffect(() => {
    try { localStorage.setItem(LS_WINDOW, timeWindow); } catch { /* not persisted */ }
  }, [timeWindow]);

  // The drill path. Two values are enough for three levels, which is why the
  // backend takes exactly these two parameters: no path means categories, a
  // category means its products, both means its microservices.
  const [path, setPath] = useState(emptyPath);

  /**
   * The third step, held separately from `path`.
   *
   * <p>It is a FILTER, not a drill: category and product change what the backend
   * groups by, while choosing a microservice narrows the leaf rows it already
   * returned. Putting it in `path` would make it a query parameter the counts
   * endpoint has no level for, and would refetch to display a row already on
   * screen.</p>
   */
  const [microservice, setMicroservice] = useState(null);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshMs, setRefreshMs] = useState(60_000);
  const [tick, setTick] = useState(0);
  const [sort, setSort] = useState({ key: 'total', dir: 'desc' });

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // The catalog's shape, for the pickers. One request, no telemetry queries — see
  // fetchAnalyticsScope. Refetched only when the tenant changes or the operator
  // presses refresh, because it changes when somebody registers something, not on
  // the polling interval.
  const [scope, setScope] = useState({ categories: [], catalogEmpty: false });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetchAnalyticsScope({ signal: controller.signal })
      .then((res) => { if (!cancelled) setScope(res); })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // Non-fatal: the table still works by row-clicking. The pickers just have
        // nothing to offer, which is visible without needing its own error.
      });
    return () => { cancelled = true; controller.abort(); };
  }, [activeOrg, tick]);


  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (data) setRefreshing(true); else setLoading(true);

    fetchAnalyticsLogCounts({
      category: path.category || undefined,
      product: path.product || undefined,
      window: timeWindow,
      signal: controller.signal,
    })
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError('');
      })
      .catch((err) => {
        if (cancelled || err.name === 'AbortError') return;
        // Keep the previous rows on screen. Blanking the table on a transient
        // failure would read as "no logs", which is the one thing a volume
        // dashboard must never say by accident.
        setError(err.message || 'Could not load analytics.');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => { cancelled = true; controller.abort(); };
    // `data` is deliberately not a dependency — it is read only to choose between
    // the skeleton and the dimmed refresh, and including it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path.category, path.product, timeWindow, tick, activeOrg]);

  // Auto-refresh, paused while the tab is hidden — a background dashboard polling
  // OpenObserve forever is pure cost.
  useEffect(() => {
    if (!refreshMs) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  // Each step's options come from the step before it. Nothing is hardcoded and
  // nothing is fetched per change: the whole shape is already in `scope`.
  const selectedCategory = useMemo(
    () => scope.categories.find((c) => c.code === path.category) || null,
    [scope, path.category],
  );
  // Memoised so the `|| []` fallback does not hand the next useMemo a fresh array
  // identity on every render and defeat its memoisation.
  const productOptions = useMemo(
    () => selectedCategory?.products || [],
    [selectedCategory],
  );
  const selectedProduct = useMemo(
    () => productOptions.find((p) => p.code === path.product) || null,
    [productOptions, path.product],
  );

  const microserviceOptions = microserviceOptionsFor(selectedProduct, selectedCategory, productOptions);

  const level = data?.level || 'CATEGORY';
  const canDrill = level !== 'MICROSERVICE';

  const rows = useMemo(() => sortedRows(data, sort, microservice), [data, sort, microservice]);

  const toggleSort = (key) => setSort((s) => (
    s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));

  /** Drill into a row, if this level has anything below it. */
  const openRow = (row) => {
    if (!canDrill) return;
    setMicroservice(null);
    if (level === 'CATEGORY') {
      setPath({ category: row.key, categoryLabel: row.label, product: null, productLabel: null });
    } else if (row.childCount > 0) {
      // A product. A product-less row at this level is a resource with nothing
      // beneath it, so it is left alone rather than drilling into an empty table.
      setPath((p) => ({ ...p, product: row.key, productLabel: row.label }));
    }
  };

  const rowIsDrillable = (row) => canDrill && (level === 'CATEGORY' || row.childCount > 0);

  /**
   * The drill props for one count cell.
   *
   * <p>Built here rather than in Num so the row's six cells share one window and one
   * callback, and so a cell knows nothing about how a filter is assembled — that lives
   * in analyticsDrill, which the Category Board uses too. Returns props for a plain
   * cell when this count is not openable.</p>
   */
  const cell = (row, bucketKey) => ({
    row,
    bucketKey,
    drill: onDrillToLogs ? buildLogsDrill({ row, bucketKey, window: timeWindow }) : null,
    onDrill: onDrillToLogs,
  });

  const totals = data?.totals;

  return (
    <div className="an-view">
      <header className="an-head">
        <div className="an-head-title">
          <h1 className="an-title">Analytics</h1>
          <Crumbs path={path} setPath={setPath} />
        </div>

        <div className="an-head-right">
          <select
            className="ae-select an-select"
            value={timeWindow}
            aria-label="Time range"
            onChange={(e) => setTimeWindow(e.target.value)}
          >
            {WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>

          <label className="an-refresh">
            <span className="an-refresh-label">Auto</span>
            <select
              className="ae-select an-select an-select--narrow"
              value={refreshMs}
              aria-label="Auto-refresh interval"
              onChange={(e) => setRefreshMs(Number(e.target.value))}
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="results-bar-btn"
            onClick={reload}
            disabled={refreshing}
            title="Re-run the counts now"
            aria-label="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className={refreshing ? 'alerts-spin' : undefined}>
              <path d="M20 11a8 8 0 1 0-2.3 5.7" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
        </div>
      </header>

      {/* STEP BY STEP. Three selects, each populated from the one before it and all
          three from the catalog — there is no list of categories, products or
          services in this file.

          They are the same state the row-clicking drill uses, so the two can never
          disagree: choosing a product here and clicking that product's row do the
          identical thing, and the breadcrumb reflects either. Row-clicking was kept
          because it is faster once you can see the row you want. */}
      <fieldset className="an-steps native-el" aria-label="Choose what to count">
        <Step
          n={1}
          label="Category"
          value={path.category || ''}
          placeholder={scope.categories.length ? 'All categories' : 'Nothing registered'}
          disabled={scope.categories.length === 0}
          options={scope.categories.map((c) => ({ value: c.code, label: c.label }))}
          onChange={(value) => {
            // Clearing a step clears everything below it — a product from the old
            // category is not a valid selection under the new one.
            setMicroservice(null);
            const picked = scope.categories.find((c) => c.code === value);
            setPath({
              category: picked ? picked.code : null,
              categoryLabel: picked ? picked.label : null,
              product: null,
              productLabel: null,
            });
          }}
        />

        {/* Step 2 is omitted entirely for the categories with no product tier —
            Tools, Databases, Platform, DLH — rather than shown empty and disabled.
            A dead control reads as a broken one. */}
        {(!selectedCategory || productOptions.length > 0) && (
          <Step
            n={2}
            label="Product"
            value={path.product || ''}
            placeholder={selectedCategory ? 'All products' : 'Select a category first'}
            disabled={!selectedCategory || productOptions.length === 0}
            options={productOptions.map((p) => ({
              value: p.code,
              label: `${p.label} (${p.microservices.length})`,
            }))}
            onChange={(value) => {
              setMicroservice(null);
              const picked = productOptions.find((p) => p.code === value);
              setPath((prev) => ({
                ...prev,
                product: picked ? picked.code : null,
                productLabel: picked ? picked.label : null,
              }));
            }}
          />
        )}

        <Step
          n={selectedCategory && productOptions.length === 0 ? 2 : 3}
          label="Microservice"
          value={microservice || ''}
          placeholder={microservicePlaceholder(microserviceOptions, selectedCategory)}
          disabled={microserviceOptions.length === 0}
          options={microserviceOptions.map((m) => ({ value: m.id, label: m.label }))}
          onChange={(value) => setMicroservice(value || null)}
        />

        {(path.category || microservice) && (
          <button
            type="button"
            className="alerts-btn-ghost an-steps-clear"
            onClick={() => {
              setMicroservice(null);
              setPath(emptyPath());
            }}
          >Clear</button>
        )}
      </fieldset>

      {error && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">{error}</span>
          <button type="button" className="alerts-banner-x" onClick={reload} aria-label="Retry">↻</button>
        </div>
      )}

      {/* A partial answer is stated, not rounded into a confident number. Counts
          from a window OpenObserve could only partly scan are a floor, and a
          dashboard that hides that is how somebody concludes a service went quiet. */}
      {data && !data.complete && (
        <output className="alerts-banner alerts-banner--warn native-el">
          <span className="alerts-banner-text">
            {data.message || 'OpenObserve served only part of this range — these counts are a '
              + 'floor, not a total.'}
          </span>
        </output>
      )}

      {data && !data.supported && (
        <div className="alerts-banner alerts-banner--error" role="alert">
          <span className="alerts-banner-text">{data.message}</span>
        </div>
      )}

      {/* Scope totals. Big numbers, because the first question a volume dashboard
          is opened to answer is "how much, and how much of it is bad". */}
      {totals && (
        <div className="an-stats">
          <StatTile label="Total logs" value={totals.total} tone="total" />
          <StatTile label="Info" value={totals.info} tone="info" />
          <StatTile label="Warn" value={totals.warn} tone="warn" />
          <StatTile label="Error" value={totals.error} tone="error" />
          <StatTile
            label="Debug"
            value={totals.debug}
            tone="debug"
            hint="DEBUG lines. Counted in Total, and no longer pooled with Other — a service left at DEBUG in production is usually why its total dwarfs its peers'."
          />
          <StatTile
            label="Other"
            value={totals.other}
            tone="other"
            hint="Trace and logs whose severity is unset. Counted in Total."
          />
        </div>
      )}

      <div className="an-table">
        <tr className="an-row an-row--head" role="row">
          <button type="button" className="an-sort" onClick={() => toggleSort('label')}>
            {LEVEL_HEADINGS.get(level) ?? 'Microservice'}
            <Caret active={sort.key === 'label'} dir={sort.dir} />
          </button>
          <button type="button" className="an-sort an-num" onClick={() => toggleSort('total')}>
            Total Logs<Caret active={sort.key === 'total'} dir={sort.dir} />
          </button>
          <button type="button" className="an-sort an-num" onClick={() => toggleSort('info')}>
            Info<Caret active={sort.key === 'info'} dir={sort.dir} />
          </button>
          <button type="button" className="an-sort an-num" onClick={() => toggleSort('warn')}>
            Warn<Caret active={sort.key === 'warn'} dir={sort.dir} />
          </button>
          <button type="button" className="an-sort an-num" onClick={() => toggleSort('error')}>
            Error<Caret active={sort.key === 'error'} dir={sort.dir} />
          </button>
          {/* Sortable like the other severities, not a trailing read-only column:
              "which of these is drowning us in debug" is a question you answer by
              sorting, and it is the reason the column was split out of Other. */}
          <button type="button" className="an-sort an-num" onClick={() => toggleSort('debug')}>
            Debug<Caret active={sort.key === 'debug'} dir={sort.dir} />
          </button>
          <span className="an-num">Other</span>
        </tr>

        <div className="an-body">
          {loading && (!data || rows.length === 0) && Array.from({ length: 6 }, (_, i) => (
            <div className="an-row an-row--skeleton" key={`sk-${i}`} aria-hidden="true">
              {Array.from({ length: 7 }, (unused, j) => (
                <span key={j}><span className="alerts-skel" /></span>
              ))}
            </div>
          ))}

          {/* Three different empty states, deliberately not merged: "register
              something", "nothing at this level", and "registered but silent" are
              different problems with different fixes. */}
          {!loading && data?.catalogEmpty && (
            <div className="iam-state">
              Nothing is registered in the Product Catalog yet, so there is nothing to count.
              {onNavigate && (
                <>
                  {' '}
                  <button type="button" className="pt-note-link" onClick={() => onNavigate('catalog')}>
                    Open Product Catalog
                  </button>
                  {' to register a microservice.'}
                </>
              )}
            </div>
          )}

          {/* Only when the request actually SUCCEEDED and returned nothing. Without
              the `data &&` guard a failed fetch left this saying "nothing registered
              at this level" underneath an error banner — two contradictory statements,
              and the wrong one was the reassuring one. "The query failed" and
              "nothing is registered" are different problems with different fixes. */}
          {!loading && data && !data.catalogEmpty && rows.length === 0 && (
            <div className="iam-state">
              {microservice
                ? 'That microservice is not in the current results. Clear the filter to see them all.'
                : (data.message || 'Nothing registered at this level yet.')}
            </div>
          )}

          {!loading && rows.map((row) => (
            <CountRow
              key={row.key}
              row={row}
              drillable={rowIsDrillable(row)}
              onOpen={openRow}
              cell={cell}
            />
          ))}
        </div>
      </div>

      <footer className="an-foot">
        {data?.windowStart && (
          <span className="an-foot-range" title={`${data.windowStart} → ${data.windowEnd}`}>
            {new Date(data.windowStart).toLocaleString()} → {new Date(data.windowEnd).toLocaleTimeString()}
          </span>
        )}
      </footer>
    </div>
  );
}

/** The drill path as a breadcrumb; each ancestor is a button that climbs back to it. */
function Crumbs({ path, setPath }) {
  return (
    <nav className="an-crumbs" aria-label="Drill path">
      <button
        type="button"
        className={`an-crumb ${!path.category ? 'is-current' : ''}`}
        onClick={() => setPath(emptyPath())}
      >All categories</button>
      {path.category && (
        <>
          <span className="an-crumb-sep" aria-hidden="true">›</span>
          <button
            type="button"
            className={`an-crumb ${!path.product ? 'is-current' : ''}`}
            onClick={() => setPath((p) => ({ ...p, product: null, productLabel: null }))}
          >{path.categoryLabel || path.category}</button>
        </>
      )}
      {path.product && (
        <>
          <span className="an-crumb-sep" aria-hidden="true">›</span>
          <span className="an-crumb is-current">{path.productLabel || path.product}</span>
        </>
      )}
    </nav>
  );
}
Crumbs.propTypes = {
  /** { category, categoryLabel, product, productLabel } — nulls at the top. */
  path: PropTypes.object.isRequired,
  setPath: PropTypes.func.isRequired,
};

/** A warn/error/debug count is toned only when it is non-zero — a red 0 is a false alarm. */
const toneIfAny = (value, tone) => (value > 0 ? tone : undefined);

/** One row of the drill table. `cell` builds each count's drill props. */
function CountRow({ row, drillable, onOpen, cell }) {
  return (
    <tr
      className={`an-row ${drillable ? 'is-drillable' : ''}`}
      role="row"
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (drillable && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen(row);
        }
      }}
      tabIndex={drillable ? 0 : undefined}
      title={row.matchedOn?.length
        ? `Counted from ${row.matchedOn.join(', ')}`
        : 'No telemetry identifier recorded for this row'}
    >
      <span className="an-label">
        {drillable && <span className="an-caret" aria-hidden="true">›</span>}
        <span className="an-label-text">{row.label}</span>
        {row.childCount > 0 && (
          <span className="an-childcount">({row.childCount})</span>
        )}
      </span>
      {/* The counts are links to the lines they counted, wherever that can be
          expressed exactly — in practice the MICROSERVICE level, plus any
          category or product that happens to hold a single service. A row
          summing several services is not a link: the Logs screen intersects
          multiple services at trace grain, so it would answer with a smaller
          number than the cell shows. analyticsDrill decides; the tooltip on a
          non-link cell says which of those reasons applies.

          Each is a button inside a row that is ALSO clickable, so Num stops
          the event — otherwise one click would open Logs and drill the table
          underneath it, and coming back would land somewhere unexpected. */}
      <Num value={row.total} strong {...cell(row, 'total')} />
      <Num value={row.info} {...cell(row, 'info')} />
      <Num value={row.warn} tone={toneIfAny(row.warn, 'warn')} {...cell(row, 'warn')} />
      <Num value={row.error} tone={toneIfAny(row.error, 'error')} {...cell(row, 'error')} />
      <Num value={row.debug} tone={toneIfAny(row.debug, 'debug')} {...cell(row, 'debug')} />
      <Num value={row.other} dim {...cell(row, 'other')} />
    </tr>
  );
}
CountRow.propTypes = {
  row: PropTypes.object.isRequired,
  drillable: PropTypes.bool,
  onOpen: PropTypes.func.isRequired,
  cell: PropTypes.func.isRequired,
};

/**
 * One step of the cascade.
 *
 * <p>A numbered label rather than a bare select, because the three only make sense
 * in order — the second cannot be answered before the first. The number is what
 * makes that legible without a tooltip.</p>
 *
 * <p>The empty option is always present and always means "all of them": that is how
 * a step is undone, and a cascade with no way back up traps whoever used it.</p>
 */
function Step({ n, label, value, placeholder, options, disabled, onChange }) {
  return (
    <label className={`an-step ${disabled ? 'is-disabled' : ''}`}>
      <span className="an-step-label">
        <span className="an-step-n" aria-hidden="true">{n}</span>
        {label}
      </span>
      <select
        className="ae-select an-step-select"
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
Step.propTypes = {
  n: PropTypes.number.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.string,
  placeholder: PropTypes.string,
  options: PropTypes.array.isRequired,
  disabled: PropTypes.bool,
  onChange: PropTypes.func.isRequired,
};

/**
 * A scope total.
 *
 * <p>`is-quiet` at zero. The Warn and Error tiles colour their figure, and a red 0
 * is a false alarm — it reads as a finding from across the room, which is exactly
 * how these tiles are meant to be read. The tile keeps its coloured left edge
 * either way, because that is what says WHICH tile this is; only the figure goes
 * neutral. This matches the table below, where a zero cell is never toned.</p>
 */
function StatTile({ label, value, tone, hint }) {
  const quiet = (Number(value) || 0) <= 0;
  return (
    <div
      className={`an-stat an-stat--${tone} ${quiet ? 'is-quiet' : ''}`}
      title={hint || undefined}
    >
      <span className="an-stat-label">{label}</span>
      <span className="an-stat-value">{formatCount(value)}</span>
    </div>
  );
}
StatTile.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.number,
  tone: PropTypes.string,
  hint: PropTypes.string,
};

/**
 * One numeric cell — a button when the count can be opened in Logs, plain text when
 * it cannot.
 *
 * <p>Exact value in the title either way: a dashboard number gets pasted into tickets,
 * and "1.4M" is not a figure anybody can act on. When the cell is not a link the title
 * says why, because a number that is clickable one row up and not on this one has to
 * account for itself.</p>
 *
 * <p>The click is stopped from propagating. This table's rows are themselves clickable
 * — that is the drill from category to product — so without it one click on a count
 * would both open Logs and change the level underneath, and returning to the dashboard
 * would land somewhere the operator never asked to be.</p>
 */
function Num({ value, strong, dim, tone, row, bucketKey, drill, onDrill }) {
  const n = value || 0;
  const toneClass = tone ? `an-num--${tone}` : '';
  const className = `an-num ${strong ? 'is-strong' : ''} ${dim ? 'is-dim' : ''} ${toneClass}`;
  const title = row && bucketKey
    ? drillHint({ row, bucketKey, drill, exact: exactCount(n) })
    : exactCount(n);

  if (!drill || !onDrill) {
    return <span className={className} title={title}>{formatCount(n)}</span>;
  }
  return (
    <button
      type="button"
      className={`${className} is-link`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onDrill(drill);
      }}
      // Enter and Space on a focused button would otherwise bubble to the row's own
      // key handler and drill it as well.
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >{formatCount(n)}</button>
  );
}
Num.propTypes = {
  value: PropTypes.number,
  strong: PropTypes.bool,
  dim: PropTypes.bool,
  tone: PropTypes.string,
  /** The row this cell belongs to — only needed for the drill and its tooltip. */
  row: PropTypes.object,
  bucketKey: PropTypes.string,
  /** Prebuilt filter from buildLogsDrill, or null when this cell is not a link. */
  drill: PropTypes.object,
  onDrill: PropTypes.func,
};

function caretGlyph(active, dir) {
  if (!active) return '↕';
  return dir === 'asc' ? '↑' : '↓';
}

function Caret({ active, dir }) {
  return (
    <span className="an-sort-caret" aria-hidden="true">
      {caretGlyph(active, dir)}
    </span>
  );
}
Caret.propTypes = { active: PropTypes.bool, dir: PropTypes.string };

AnalyticsDashboardView.propTypes = {
  /** Remounts on tenant change — the catalog, and therefore every row, is per-org. */
  activeOrg: PropTypes.string,
  /** (tab) — used for the "Open Product Catalog" jump from the empty state. */
  onNavigate: PropTypes.func,
  /** ({services, severity, range}) — opens Logs filtered to a clicked count. Absent,
   *  the counts render as plain text rather than as links that go nowhere. */
  onDrillToLogs: PropTypes.func,
};
