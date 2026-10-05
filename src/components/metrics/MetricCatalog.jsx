import React, { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';

/**
 * Left-hand metric picker.
 *
 * This instance reports 3,215 metrics, which rules out two obvious designs: a
 * <select> (unusable) and rendering every row (3,215 DOM nodes rebuilt on each
 * keystroke). Instead the list is filtered, then sliced to PAGE_SIZE with a
 * "show more" — cheap, and it keeps the match count visible so you can tell a
 * narrow search from an empty one.
 *
 * ── Why there are facets above the search box ──────────────────────────────
 *
 * Length was never the real problem: MIXING was. Those 3,215 names are five
 * unrelated populations in one alphabetical list — our own services (~350),
 * third-party middleware (~1,900 of it, mostly WSO2/Carbon JMX beans),
 * Kubernetes and hosts (~450), the observability stack watching itself (~280),
 * and shared runtime metrics. Sorted by name, `jvm_memory_used_bytes` lands
 * between `java_nio_bufferpool_totalcapacity` and `kafka_consumer_commit_rate`,
 * so finding your own service's heap means knowing its metric name in advance —
 * which defeats the point of a catalogue.
 *
 * So the picker filters on two axes before the name search applies: GROUP (who
 * owns the fix when the number is bad) and, within a group, TECHNOLOGY (which
 * product it came from). Both come from the backend already counted — see
 * MetricClassifier — because which exporters exist is a server-side fact.
 *
 * With no group selected the list is rendered under technology headings rather
 * than flat, so even the unfiltered view says what you are looking at.
 *
 * Clicking a metric writes it into the query as a bare selector. It does NOT
 * run it: on a counter a bare selector plots a monotonically rising line that
 * tells you nothing, and the user usually wants to wrap it in rate() first.
 * The type badge is there to make that choice obvious.
 */

const PAGE_SIZE = 60;

/** Prometheus type → short badge text and class. */
const TYPE_BADGE = {
  counter: { text: 'C', title: 'counter — monotonically increasing; usually wrap in rate()' },
  gauge: { text: 'G', title: 'gauge — a value that goes up and down' },
  histogram: { text: 'H', title: 'histogram — bucketed; try histogram_quantile()' },
  summary: { text: 'S', title: 'summary — precomputed quantiles' },
  unknown: { text: '?', title: 'type not declared by the exporter' },
};

/**
 * What each group means, in one line, on the facet's tooltip.
 *
 * Kept here and not on the server: these are explanations for a person reading
 * this screen, and they change with the UI's wording, not with the deployment's
 * exporters. The group KEYS and counts are the server's.
 */
const GROUP_HINT = {
  microservice: 'Metrics emitted from inside our own services — Micrometer and the OTel SDK.',
  middleware: 'Third-party products we run: databases, brokers, integration servers.',
  platform: 'Kubernetes objects, containers and the machines underneath.',
  observability: 'The telemetry pipeline itself — OpenObserve, the collector, exporters, scrape health.',
  runtime: 'Emitted by many producers at once (process_*, system_*, go_*, up). '
    + 'The name alone does not say whose it is — filter the query by service_name.',
  other: 'No classification rule matched these names. Add one via '
    + 'metrics.classification.extra-rules on the backend.',
};

export default function MetricCatalog({
  // Default parameters rather than defaultProps — React warns that
  // defaultProps on function components is going away.
  items = [], groups = [], loading, error, selected, onSelect, total = 0,
}) {
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  const [group, setGroup] = useState('');
  const [tech, setTech] = useState('');

  // A technology only exists inside its group, so changing group has to clear
  // it — otherwise picking "Microservices" while "PostgreSQL" is still selected
  // filters to the empty intersection and reads as a broken catalogue.
  useEffect(() => { setTech(''); }, [group]);

  const activeGroup = useMemo(
    () => groups.find((g) => g.key === group) || null,
    [groups, group],
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((m) => {
      if (group && m.group !== group) return false;
      if (tech && m.technology !== tech) return false;
      if (!term) return true;
      // Match the help text and the technology too — "how much heap" finds
      // jvm_memory_used_bytes by its description when you don't know the
      // metric's name, and "postgres" finds pg_* without knowing the prefix.
      return m.name.toLowerCase().includes(term)
        || (m.help || '').toLowerCase().includes(term)
        || (m.technology || '').toLowerCase().includes(term);
    });
  }, [items, q, group, tech]);

  const visible = filtered.slice(0, shown);

  /**
   * Rows to render: either a flat list, or technology-headed sections.
   *
   * Headings are added whenever the visible slice spans more than one
   * technology. Once one technology is selected every row shares it, and a
   * heading repeating the chip above it is noise.
   *
   * `groups.length` gates them too: a backend that predates the classification
   * sends items with no technology, and heading a flat list "Unclassified"
   * would be worse than the flat list it replaced.
   */
  const rows = useMemo(() => {
    const out = [];
    let lastTech = null;
    const headed = !tech && groups.length > 0;
    visible.forEach((m) => {
      const t = m.technology || 'Unclassified';
      if (headed && t !== lastTech) {
        out.push({ kind: 'head', key: `h:${t}`, label: t, group: m.group });
        lastTech = t;
      }
      out.push({ kind: 'metric', key: m.name, metric: m });
    });
    return out;
  }, [visible, tech, groups.length]);

  const resetPaging = () => setShown(PAGE_SIZE);

  return (
    <aside className="mv-catalog">
      <div className="mv-catalog-head">
        {/* Group facets. Rendered from the server's list, so a deployment with
            no Kubernetes is never offered an empty Kubernetes filter. */}
        {groups.length > 0 && (
          <fieldset className="mv-facets" aria-label="Filter metrics by source">
            <button
              type="button"
              className={`mv-facet ${group === '' ? 'is-on' : ''}`}
              onClick={() => { setGroup(''); resetPaging(); }}
              title="Every metric this instance exposes, grouped by source"
            >
              {'All '}
              <span className="mv-facet-count">{total.toLocaleString()}</span>
            </button>
            {groups.map((g) => (
              <button
                type="button"
                key={g.key}
                className={`mv-facet is-${g.key} ${group === g.key ? 'is-on' : ''}`}
                onClick={() => { setGroup(g.key === group ? '' : g.key); resetPaging(); }}
                title={GROUP_HINT[g.key] || g.label}
              >
                {g.label}
                {' '}
                <span className="mv-facet-count">{g.count.toLocaleString()}</span>
              </button>
            ))}
          </fieldset>
        )}

        {/* Technology sub-filter, only once a group narrows it to a readable
            number of options. Unfiltered this would be 40+ chips. */}
        {activeGroup && activeGroup.technologies.length > 1 && (
          <fieldset className="mv-subfacets" aria-label={`Filter ${activeGroup.label} by technology`}>
            {activeGroup.technologies.map((t) => (
              <button
                type="button"
                key={t.name}
                className={`mv-subfacet ${tech === t.name ? 'is-on' : ''}`}
                onClick={() => { setTech(t.name === tech ? '' : t.name); resetPaging(); }}
                title={`${t.name} — ${t.count.toLocaleString()} metric${t.count === 1 ? '' : 's'}`}
              >
                {t.name}
                {' '}
                <span className="mv-subfacet-count">{t.count.toLocaleString()}</span>
              </button>
            ))}
          </fieldset>
        )}

        {activeGroup && GROUP_HINT[activeGroup.key] && (
          <p className="mv-facet-hint">{GROUP_HINT[activeGroup.key]}</p>
        )}

        <input
          className="mv-catalog-search"
          type="search"
          value={q}
          onChange={(e) => { setQ(e.target.value); resetPaging(); }}
          placeholder={activeGroup ? `Search ${activeGroup.label}…` : 'Search metrics…'}
          aria-label="Search metrics by name, description or technology"
        />
        <div className="mv-catalog-count">
          {(() => {
            if (loading) return 'Loading…';
            if (q || group || tech) return `${filtered.length.toLocaleString()} of ${total.toLocaleString()}`;
            return `${total.toLocaleString()} metrics`;
          })()}
        </div>
      </div>

      {error && (
        <div className="mv-catalog-error">
          Catalogue unavailable — {error}
        </div>
      )}

      <div className="mv-catalog-list">
        {!loading && filtered.length === 0 && !error && (
          <div className="mv-catalog-empty">
            {(() => {
              if (q) {
                let suffix = '';
                if (activeGroup) suffix = ` in ${activeGroup.label}`;
                return `No metric matches “${q}”${suffix}.`;
              }
              return 'No metric in this group.';
            })()}
          </div>
        )}

        {rows.map((row) => {
          if (row.kind === 'head') {
            return (
              <div className={`mv-group-head is-${row.group}`} key={row.key}>{row.label}</div>
            );
          }
          const m = row.metric;
          const badge = TYPE_BADGE[m.type] || TYPE_BADGE.unknown;
          
          const titleParts = [
            m.name,
            m.type + (m.unit ? ` · ${m.unit}` : ''),
            m.technology ? `from ${m.technology}` : ''
          ];
          if (m.help) {
            titleParts.push('', m.help);
          }

          return (
            <button
              type="button"
              key={row.key}
              className={`mv-metric ${selected === m.name ? 'is-on' : ''}`}
              onClick={() => onSelect(m)}
              title={titleParts.filter((p) => p !== '').join('\n')}
            >
              <span className={`mv-metric-type is-${m.type}`} title={badge.title}>{badge.text}</span>
              <span className="mv-metric-name">{m.name}</span>
            </button>
          );
        })}

        {filtered.length > visible.length && (
          <button
            type="button"
            className="mv-catalog-more"
            onClick={() => setShown((n) => n + PAGE_SIZE * 4)}
          >
            Show more — {(filtered.length - visible.length).toLocaleString()} remaining
          </button>
        )}
      </div>
    </aside>
  );
}

MetricCatalog.propTypes = {
  /** `[{name, type, help, unit, group, technology, shared}]`, sorted by the backend. */
  items: PropTypes.array,
  /** Facets: `[{key, label, count, technologies: [{name, count}]}]`, in display order. */
  groups: PropTypes.array,
  loading: PropTypes.bool,
  error: PropTypes.string,
  selected: PropTypes.string,
  /** (metric) — called with the whole catalogue entry, not just the name. */
  onSelect: PropTypes.func.isRequired,
  total: PropTypes.number,
};
