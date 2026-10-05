/**
 * Centralized auth configuration + RBAC vocabulary.
 *
 * Everything the auth module needs to be reconfigured lives here so there are
 * no magic strings scattered across the codebase. Roles, permissions, storage
 * keys, token lifetimes and the login-screen chrome (version/copyright) are all
 * defined once.
 */

/** The only two roles this platform recognises. */
export const ROLES = Object.freeze({
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR',
});

/**
 * Permission vocabulary. Screens/actions check these rather than checking the
 * role directly, so a future third role only touches the PERMISSION_MATRIX.
 */
export const PERMISSIONS = Object.freeze({
  // Viewing (read-only) — both roles
  VIEW_APPLICATIONS: 'applications:view',
  VIEW_LOGS: 'logs:view',
  VIEW_METRICS: 'metrics:view',
  VIEW_TRACES: 'traces:view',
  /** The Alerts SECTION — in practice, what has fired. Reading the RULES behind
   *  those firings is a separate grant; see VIEW_ALERT_RULES below. */
  VIEW_ALERTS: 'alerts:view',
  VIEW_NOTIFICATIONS: 'notifications:view',
  SEARCH: 'data:search',
  FILTER: 'data:filter',
  EXPORT: 'data:export',


  /**
   * Read the alert RULES — the configuration behind the firings.
   *
   * <p>Separate from {@link VIEW_ALERTS} because "what is wrong right now" and
   * "how is this monitored" are different questions with different audiences. An
   * operator who should watch firings without seeing the rule set is a normal
   * arrangement, and it is the one this platform ships with.</p>
   *
   * <p>Granting this alone gives a READ-ONLY rules list: every control that
   * writes is gated on CONFIGURE_ALERTS instead, so the two compose.</p>
   */
  VIEW_ALERT_RULES: 'alerts:rules:view',

  /**
   * Acknowledge or resolve a fired alert.
   *
   * <p>Its own permission because it is the one WRITE that lives inside an
   * otherwise read-only screen. Viewing firings and changing their state are
   * routinely granted to different people, and folding this into
   * CONFIGURE_ALERTS would tie "can ack an alert" to "can rewrite the rules".</p>
   */
  MANAGE_ALERT_STATE: 'alerts:state:manage',

  // Configuration — admin only
  CONFIGURE_APPLICATIONS: 'applications:configure',
  CONFIGURE_MONITORING: 'monitoring:configure',
  /** Create, edit, delete or import alert rules, folders and destinations. */
  CONFIGURE_ALERTS: 'alerts:configure',
  CONFIGURE_INTEGRATIONS: 'integrations:configure',

  // User & org administration — admin only
  CREATE_USERS: 'users:create',
  DELETE_USERS: 'users:delete',
  MANAGE_USERS: 'users:manage',
  MANAGE_PERMISSIONS: 'permissions:manage',
  MANAGE_ORGANIZATIONS: 'organizations:manage',
  ACCESS_SETTINGS: 'settings:access',

  /**
   * Reach the IAM section at all — users, organizations and the Product Catalog.
   *
   * <p>A VISIBILITY grant, distinct from the MANAGE_* permissions that authorise
   * the actions inside it. The nav rail needs to answer "should this entry exist"
   * before anything can ask "may this button be pressed", and answering it with a
   * role comparison in the rail is exactly the hardcoding this vocabulary
   * exists to avoid.</p>
   */
  VIEW_IAM: 'iam:view',
});

/** Wildcard granted to the administrator: matches every permission check. */
export const ALL_PERMISSIONS = '*';

/**
 * Role → permissions. THE single source of truth for what each role may do.
 *
 * <h3>This table is the only place a role's reach is decided</h3>
 *
 * No screen compares a role name. Every gate in the app asks
 * {@code can(PERMISSIONS.X)}, so changing what an operator may do is an edit to
 * this list and nothing else — no component, no nav definition, no conditional.
 * Adding a third role is adding a third entry here.
 *
 * <h3>What each role gets</h3>
 *
 * ADMINISTRATOR holds {@link ALL_PERMISSIONS}, so every check passes, including
 * permissions added later. Full access is the default and stays that way without
 * anyone remembering to extend a list.
 *
 * OPERATOR is read-only everywhere EXCEPT alert triage: view + search/filter/export,
 * plus acknowledging and resolving a firing. Everything absent from this list is
 * denied, which is what makes the deny side of the model safe — a new write
 * permission is unavailable to the operator the moment it is defined, rather than
 * only once somebody remembers to exclude it.
 *
 * {@code MANAGE_ALERT_STATE} is the one write they hold, and it is deliberately
 * narrow: it governs the state of a firing that already happened, never the rules
 * that produce firings. An operator can say "I have this" and "this is over"; they
 * cannot change what alerts in the first place.
 *
 * Two deliberate omissions, each one the answer to a specific requirement:
 *
 *   • {@code VIEW_IAM}            — no IAM section: no users, no organizations,
 *                                   no Product Catalog registration.
 *   • {@code VIEW_ALERT_RULES}    — the Alerts screen opens on Fired and the Rules
 *                                   sub-tab does not exist for them.
 *
 * <h3>Loosening it later</h3>
 *
 * Each of these is a ONE-LINE change here, with no code edit anywhere:
 *
 *   • operators should SEE the rules read-only → add {@code VIEW_ALERT_RULES}.
 *     The list renders; every create/edit/delete/import control stays hidden,
 *     because those are gated on CONFIGURE_ALERTS, which is still absent.
 *   • operators should read the Product Catalog → add {@code VIEW_IAM}. The
 *     section appears; registering and enabling remain admin-only.
 *
 * <h3>Tightening it back</h3>
 *
 *   • fired alerts should be read-only for operators again → remove
 *     {@code MANAGE_ALERT_STATE}. The Actions cell reverts to reporting the state
 *     as plain text and the bulk bar disappears; nothing else in Alerts changes.
 */
export const PERMISSION_MATRIX = Object.freeze({
  [ROLES.ADMIN]: [ALL_PERMISSIONS],
  [ROLES.OPERATOR]: Object.freeze([
    PERMISSIONS.VIEW_APPLICATIONS,
    PERMISSIONS.VIEW_LOGS,
    PERMISSIONS.VIEW_METRICS,
    PERMISSIONS.VIEW_TRACES,
    // The Alerts section itself — the Fired list. Not the rules.
    PERMISSIONS.VIEW_ALERTS,
    // Triage is the operator's actual job: they are the people watching when
    // something fires, and routing every acknowledge through an administrator
    // leaves the alert unowned until one is free. This grants the row-level
    // transitions and nothing else — CONFIGURE_ALERTS is still absent, so an
    // operator still cannot author, edit or delete a rule.
    PERMISSIONS.MANAGE_ALERT_STATE,
    PERMISSIONS.VIEW_NOTIFICATIONS,
    PERMISSIONS.SEARCH,
    PERMISSIONS.FILTER,
    PERMISSIONS.EXPORT,
  ]),
});

/**
 * Human-friendly labels shown in the UI (role badge, etc.).
 */
export const ROLE_LABELS = Object.freeze({
  [ROLES.ADMIN]: 'Administrator',
  [ROLES.OPERATOR]: 'Operator',
});

/** Storage keys. Namespaced so they don't collide with anything the host sets. */
export const STORAGE_KEYS = Object.freeze({
  ACCESS_TOKEN: 'lnm.auth.accessToken',
  REFRESH_TOKEN: 'lnm.auth.refreshToken',
  USER: 'lnm.auth.user',
  REMEMBER: 'lnm.auth.remember',
});

/** Token lifetimes (seconds). Access is short-lived; refresh is the session. */
export const TOKEN_CONFIG = Object.freeze({
  ACCESS_TTL_SECONDS: 15 * 60, // 15 minutes
  REFRESH_TTL_SECONDS: 8 * 60 * 60, // 8 hours (a working session)
  REFRESH_TTL_REMEMBER_SECONDS: 30 * 24 * 60 * 60, // 30 days when "remember me"
  ISSUER: 'lnm-auth-mock',
});

/**
 * ─── SSO (portal hand-off) ────────────────────────────────────────────────
 *
 * There is no login form. The app is opened by the portal with the identity
 * context on the query string:
 *
 *   /OpentelemetryApp/?role=superadministrator&tenantCode=Primary
 *                     &lang=en&refKey=qgit6fmspn7ebu
 *
 * The landing page reads those parameters and hands them to the "login by SSO"
 * endpoint, which is the ONLY authority on whether the caller may enter and as
 * what. See ssoParams.js (extraction) and authService.js (the call).
 */
export const SSO_CONFIG = Object.freeze({
  /**
   * Where the "login by SSO" call goes.
   *
   * <p>Defaults to OUR backend, not the tiotSSO service directly, because the
   * upstream call needs a bearer token that must not ship in a browser bundle.
   * The backend holds that credential and proxies through to
   * `/tiotSSO/1.0.0/sso-role-validation/validateRole`.</p>
   */
  ENDPOINT: import.meta.env?.VITE_SSO_API_URL || ((import.meta.env?.VITE_API_BASE_URL || '/OpentelemetryService/api') + '/auth/login-by-sso'),

  /**
   * While the backend endpoint does not exist yet, the call is answered by a
   * hardcoded in-file response (see mockSsoResponse in authService.js).
   *
   * <p>Set `VITE_SSO_MOCK=false` to make it a real network call — that single
   * flag is the whole switch-over.</p>
   */
  MOCK: (import.meta.env?.VITE_SSO_MOCK ?? 'true') !== 'false',

  /**
   * Artificial delay on the mock round trip (ms).
   *
   * <p>ZERO on purpose. It was 600ms so the landing spinner would be visible,
   * which is precisely backwards: opening the portal link should land on Home,
   * not on a screen about landing on Home. Raise it only to inspect the
   * in-flight state deliberately.</p>
   */
  MOCK_DELAY_MS: 0,

  /** Give up on a hung SSO call rather than spinning forever. */
  TIMEOUT_MS: 15_000,
});

/**
 * SSO role name → this app's role.
 *
 * <p>Keys are normalised (lowercased, non-alphanumerics stripped, any
 * `tenant/` prefix removed) before lookup, so `smartDomain/administrator`,
 * `Administrator` and `ADMIN` all land on the same entry. Anything not listed
 * — and not matched by the loose fallback in {@link mapSsoRole} — is REFUSED
 * rather than defaulted, because defaulting an unknown role is how a viewer
 * ends up with write access.</p>
 */
export const SSO_ROLE_MAP = Object.freeze({
  superadministrator: ROLES.ADMIN,
  administrator: ROLES.ADMIN,
  superadmin: ROLES.ADMIN,
  admin: ROLES.ADMIN,
  operator: ROLES.OPERATOR,
  viewer: ROLES.OPERATOR,
  readonly: ROLES.OPERATOR,
  reader: ROLES.OPERATOR,
  user: ROLES.OPERATOR,
});

/** Landing-screen chrome. */
export const APP_META = Object.freeze({
  NAME: 'Logging & Monitoring Platform',
  SHORT_NAME: 'LnM Platform',
  SUBTITLE: 'Unified Observability · Logs, Metrics & Traces',
  VERSION: 'v1.0.0',
  COMPANY: 'Honeywell',
  get COPYRIGHT() {
    // Year is intentionally static text — no runtime Date needed and it keeps
    // the footer stable in the WC/inline builds.
    return `© 2026 ${this.COMPANY}. All rights reserved.`;
  },
});
