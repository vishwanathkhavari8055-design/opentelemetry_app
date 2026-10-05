import { PERMISSIONS } from '../../auth/constants.js';

/**
 * The navigation table, and the three questions the shell asks of it.
 *
 * ─── Why this is a module and not a const in App.jsx ────────────────────────
 *
 * The rail used to be a flat list, and "which entry is selected" was `item.key
 * === tab`. Now that entries can hold sections, three separate answers depend on
 * walking the table: which entry owns this tab, which entry should be lit, and
 * where does asking for a group actually land. Those are pure functions of the
 * table and nothing else — no React, no state — so they live next to it, where
 * they can be read and tested without mounting the app.
 *
 * App.jsx keeps every piece of behaviour that is genuinely about the running
 * shell: the permission filtering, the redirect-to-Home guard, the org reload.
 * This file is the map those decisions are made against.
 */

// ── The Logs group's sections ────────────────────────────────────────────────
//
// Logs, Analytics, Traces and Metrics were four sibling entries on the rail.
// They are now one rail entry that opens into this list, rendered as a second
// vertical column by SectionNav.
//
// They were never really siblings of Alerts and Settings. All four are readings
// of the same telemetry — the same services, the same time window, the same
// Product Catalog deciding what is in scope — and an operator crosses between
// them repeatedly while holding one question: the Analytics error count leads to
// the Logs rows, a log line leads to its trace, the trace leads to the service's
// metrics. On a flat rail each of those was the same kind of move as opening
// Settings, which is exactly what this grouping corrects.
//
// ── The keys are the OLD top-level tab keys, unchanged ──────────────────────
//
// Deliberately, and it is the whole reason this restructure touches so little.
// 'logs', 'analytics', 'traces' and 'metrics' are still what `tab` holds and
// still what every navigation call site passes: the alert drawer's View
// logs/traces/metrics buttons, the Analytics count drill-through, the Summary
// card's service drill and the Home tiles. None of them had to learn that a
// group now exists, and none of them can end up on a screen that no longer has a
// route.
//
// Order is Logs → Analytics → Traces → Metrics: the three telemetry signals,
// with the count that summarises the first sitting directly beneath it.
export const LOGS_SECTIONS = [
  { key: 'logs',      label: 'Logs',          icon: 'logs'       },
  // Directly BELOW Logs, because that is what it counts. It reads the Product
  // Catalog for its rows and the logs stream for its numbers, so it belongs next
  // to the screen whose volume it summarises rather than in a dashboards section.
  { key: 'analytics', label: 'Analytics',     icon: 'dashboards' },
  { key: 'traces',    label: 'Traces',        icon: 'traces'     },
  { key: 'metrics',   label: 'Metrics',       icon: 'metrics'    },
];

// Top-level nav definitions, rendered as the left icon rail (SideNav). The
// trace drill-down isn't an entry — it lives inside the Logs screen, reached by
// clicking a trace ID in LogsView. Keeping it scoped means switching to Home
// then back to Logs preserves whatever drill-down state the user was in.
//
// Home is listed first AND is the initial screen — it's the at-a-glance
// dashboard, the right landing page for someone opening the UI cold.
//
// ── Two levels, not one ─────────────────────────────────────────────────────
//
// An entry with a `sections` array is a GROUP: the rail shows one item, and
// opening it reveals a second vertical column (SectionNav) listing the screens
// inside. Only the Logs group uses this today — see LOGS_SECTIONS above for what
// it holds and why those four belong together.
//
// A group is nothing more than that array. The rail, the permission filter, the
// render switch and the three helpers below all read it from here, so moving a
// screen in or out of a group is an edit to this table and nothing else.
//
// 'metrics' hosts the four summary cards (logs severity mix, trace latency,
// per-service metrics, services uptime + the vitals drawer). They used to sit on
// Home; Home is now the org's ingest posture only, so they moved to their own
// entry rather than becoming unreachable.
//
// Order matches the reference rail. Five keys have a real screen (home / logs /
// metrics / traces / rum, plus analytics inside the Logs group); the placeholder
// keys are OpenObserve features with no data source on this backend, and route to
// PlaceholderView via PLACEHOLDERS in App.jsx rather than dead-ending.
//
// Product Catalog is NOT here any more: it moved into IAM, under Organizations.
// It is a per-tenant inventory keyed by org, so at the top level it sat beside
// Logs and Traces with nothing to say that switching organization changed what it
// contained. Everything it controls is unchanged — what it lists and enables still
// decides what Logs, Traces and Metrics return, via the same registry API.
//
// ── Access control lives in the DEFINITION, not in the rail ──────────────────
//
// An optional `permission` on an entry means "only show this to someone who holds
// it". The rail is then filtered from this table, so gating a screen is a property
// on one line here rather than a condition inside SideNav — which is what keeps
// SideNav ignorant of roles entirely, and what makes the next gated tab a data
// change. Entries without a `permission` are visible to every signed-in user.
// A `permission` on a SECTION works the same way and is filtered by App.jsx
// before SectionNav sees it.
export const NAV_ITEMS = [
  { key: 'home',        label: 'Home',            icon: 'home'    },
  // One entry, four screens. `sections` is what makes it a group: the rail
  // highlights this entry for any of them, and the second column lists them.
  { key: 'logs',        label: 'Logs',         icon: 'logs',
    sections: LOGS_SECTIONS },
  // AIOps — machine-side reading of the same telemetry the Logs group holds.
  //
  // A top-level entry directly below Logs rather than a fifth section inside it,
  // deliberately. The Logs group's four screens are all the operator ASKING the
  // telemetry a question — a query, a count, a trace, a series — and they share a
  // service/time-window frame the section column is built around. AIOps is the
  // other direction: what the system says without being asked. Sitting under the
  // group keeps it next to what it reads, without implying it answers the same
  // filters.
  //
  // NO `permission`: it is a read of telemetry every signed-in user can already
  // reach through Logs, so gating it here would only hide the summary of data the
  // user can open row by row.
  { key: 'aiops',       label: 'AIOps',        icon: 'aiops'       },
  { key: 'rum',         label: 'RUM',          icon: 'rum'         },
  // Grafana dashboards, rendered natively by @grafana/scenes — no iframe and no
  // Grafana chrome. Registered per-UID in Settings → Dashboard Catalog; nothing
  // appears here that an administrator has not registered.
  //
  // A top-level entry rather than a section inside the Logs group, deliberately.
  // The Logs group's four screens are readings of THIS deployment's telemetry,
  // scoped by the same Product Catalog, and an operator crosses between them
  // holding one question. A Grafana dashboard is another system's view of a
  // different scope — infrastructure, other teams' estates — so putting it in
  // that column would imply a continuity that is not there.
  //
  // NO `permission`. Viewing is for everyone; WHAT is viewable is an
  // administrator's decision, and the screen that makes it already sits behind
  // VIEW_IAM. Gating this as well would mean operators could not open the
  // dashboards that were registered for them.
  { key: 'dashboards',  label: 'Dashboards',   icon: 'dashboards'  },
  { key: 'reports',     label: 'Reports',      icon: 'reports'     },
  { key: 'alerts',      label: 'Alerts',       icon: 'alerts'      },
  // Users, organizations, the Product Catalog AND the Resource Analysis section
  // live behind this one entry, so a single grant covers all of them. Operators do
  // not hold it. The key stays 'iam' — it is what VIEW_IAM, the deep links and the
  // persisted tab all key on; only the label reads "Settings".
  { key: 'iam',         label: 'Settings',     icon: 'iam',
    permission: PERMISSIONS.VIEW_IAM },
];

/**
 * The rail entry a tab belongs to — itself, or the group that holds it.
 *
 * <p>Every lookup that used to be `NAV_ITEMS.find(i => i.key === tab)` goes
 * through this. Without it, `tab === 'traces'` would match no rail entry at all
 * now that Traces is a section, and the two things that depend on the lookup
 * would quietly stop working: the rail would show nothing selected, and the
 * permission guard would treat a gated screen as ungated because it could not
 * find the entry carrying the requirement.</p>
 *
 * <p>Returns undefined for a key that is in neither place — the placeholder tabs
 * (`rum`, `reports`) ARE rail entries, so the only undefined answers are keys
 * with no route at all, which callers already treat as "no permission needed".</p>
 */
export const navItemForTab = (key, items = NAV_ITEMS) => items.find(
  (item) => item.key === key || item.sections?.some((s) => s.key === key),
);

/**
 * The group a tab sits inside, or undefined for a plain top-level tab.
 *
 * <p>Distinct from {@link navItemForTab}, which answers for a top-level key with
 * that key's own entry. This one answers only when the tab is genuinely one level
 * down, which is the question "should a second column be showing".</p>
 */
export const groupForTab = (key, items = NAV_ITEMS) => items.find(
  (item) => item.sections?.some((s) => s.key === key),
);

/**
 * Where a navigation request should actually land.
 *
 * <p>Asking for a GROUP lands on its first section, because a group is a heading
 * and there is no screen behind it. This is currently a no-op for the Logs group,
 * whose key is also its first section's key — but relying on that coincidence
 * means renaming the group, or adding a second one, silently produces an empty
 * content column.</p>
 *
 * <p>Anything else is returned unchanged, including keys this table has never
 * heard of: 'catalog' is translated by App.jsx before it gets here, and the
 * placeholder tabs are top-level entries that route themselves.</p>
 */
export const resolveNavTarget = (target, items = NAV_ITEMS) => {
  const item = navItemForTab(target, items);
  if (item?.sections && !item.sections.some((sec) => sec.key === target)) {
    return item.sections[0].key;
  }
  return target;
};
