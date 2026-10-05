/**
 * Category → product → services registry.
 *
 * Groups the raw `service_name` values OpenObserve reports into the products
 * people actually think in terms of, so someone can pick "trinityIoT" and get
 * its services rather than hunting for them among 110 alphabetical entries.
 *
 * ─── Why this lives in the frontend ────────────────────────────────────────
 *
 * This is organisational metadata, not observability data. OpenObserve has no
 * concept of a product and nothing in the telemetry carries one, so there is
 * nothing for the backend to read — it would just be serving this same static
 * table. Keeping it here makes adding a product a one-file data change with no
 * backend deploy. Move it behind an endpoint when products need to differ per
 * tenant or be edited without a release; the shape below is deliberately
 * JSON-serialisable so that move is a lift, not a rewrite.
 *
 * ─── One entry = one service_name. No merging. ─────────────────────────────
 *
 * An earlier version let one label claim several wire names, on the assumption
 * that `IoTOpsLingualSvc` and `iotopslingual` were the same service
 * instrumented twice. They are not. Checked against the live instance:
 *
 *   service_name       namespace/cluster   pods
 *   IoTOpsCIMService   (none)              tiotopscimsvc-*
 *   IoTOpsLingualSvc   (none)              iotopslingual-*
 *   IoTOpsApiSvc       (none)              iotopsapisvc-*
 *   IoTOpsSvc          (none)              iotopssvc-*
 *   tiotopscimsvc      dev / nightly       -
 *   iotopslingual      dev / nightly       -
 *   iotopsapisvc       dev / nightly       -
 *   iotopsapps         dev / nightly       -
 *
 * Two collection paths, not one service seen twice: the UPPERCASE names are
 * reported by the OTel SDK via `otel.service.name`, the lowercase ones by the
 * k8s pod-log scraper in the dev/nightly cluster. Same software, different
 * deployments — so folding them together would silently blend a dev
 * environment's logs into a production service's count.
 *
 * Hence `service` is a single string. The type makes the mistake unavailable
 * rather than merely discouraged. A product that genuinely spans environments
 * lists each one as its own entry, with `env` to tell them apart.
 *
 * Nothing here is inferred by pattern: prefix matching would swallow an
 * unrelated service the day someone deploys one with a similar name.
 *
 * ─── Products are PRODUCTION only ──────────────────────────────────────────
 *
 * The dev/nightly deployments were added at one point and then removed: a
 * product's log count means nothing if it silently sums production and a
 * nightly environment together, and "show me my product" almost always means
 * "show me what customers are hitting".
 *
 * They are not deleted from the system, only from the grouping — every one is
 * still listed and tickable under `service.name`, and still reachable from the
 * query editor. `env` stays in the type for the day a product genuinely needs
 * to span environments; no entry currently uses it.
 *
 * This rule is absolute and applies to the open-source engines too, which is
 * expensive: only Kafka runs in production, so every other engine under Tools
 * is declared with an empty service list. Each one names the services it would
 * hold in a comment, so re-enabling an engine is uncommenting lines rather than
 * re-identifying it. 55 of 69 mappings were removed by this rule.
 */

/**
 * @typedef {Object} ProductService
 * @property {string} label  Human name, as the product team refers to it.
 * @property {string} service Exact `service_name`, compared case-insensitively.
 *   Empty string = known service, not yet located in telemetry.
 * @property {string} [env]  Deployment this entry refers to, when a product has
 *   more than one.
 */

/**
 * @typedef {Object} Product
 * @property {string} key
 * @property {string} [family] Brand several products share, e.g. "trinityIoT".
 *   Kept separate from `name` so two products under one brand are
 *   distinguishable in the picker rather than reading as duplicates.
 * @property {string} name    What distinguishes this product within its family.
 * @property {string} description
 * @property {ProductService[]} services
 */

export const PRODUCTS = [
  {
    key: 'trinity-iot-provisioning',
    family: 'trinityIoT',
    name: 'IoT Provisioning & Administration Tool',
    description: 'Device provisioning, CIM and the operations console.',
    services: [
      { label: 'IoTOpsService',        service: 'IoTOpsSvc' },
      { label: 'IoTOpsLingualService', service: 'IoTOpsLingualSvc' },
      { label: 'IoTOpsAPIService',     service: 'IoTOpsApiSvc' },
      { label: 'IoTOpsCIMService',     service: 'IoTOpsCIMService' },
      // Production only. The dev/nightly counterparts (iotopsapps,
      // tiotopscimsvc, iotopslingual, iotopsapisvc) were deliberately removed
      // from this product — see the note above PRODUCTS. They remain queryable
      // under service.name; they are just not part of the product grouping.
    ],
  },

  {
    key: 'trinity-iot-hub',
    family: 'trinityIoT',
    name: 'IoT Hub System and IoT SDK',
    description: 'Ingest hub, protocol adapters and stream monitoring.',
    services: [
      { label: 'StreamMonitorService', service: 'StreamMonitorService' },
      { label: 'DataFlowSvc',          service: 'DataFlowSvc' },
      { label: 'HttpProtAdapterSvc',   service: 'HttpProtAdapterSvc' },
      // Production only — the dev/nightly counterparts (tiotstreammonitorsvc,
      // tiothubdataflowsvc, thttpprotadaptorsvc) were removed along with the
      // other dev entries. tiothubauthservice, tiothubbridgesvc and
      // streamapisvc were never claimed by any product.
    ],
  },
  // ─── The rest of the trinity product line ──────────────────────────────
  //
  // Service membership was NOT supplied with these product names, so each
  // mapping below is evidence-based rather than inferred from spelling: the
  // log body and `k8s_deployment_name` of every candidate were sampled on the
  // live instance first. Where the evidence was thin the entry is left empty
  // rather than filled with a plausible guess — an empty product is obviously
  // incomplete, whereas a wrong one silently returns the wrong logs.

  {
    key: 'trinity-iot-api-esb',
    family: 'trinityIoT',
    name: 'API and ESB System',
    description: 'WSO2 API Manager and Enterprise Service Bus.',
    services: [
      // Removed as dev/nightly:
      // tiotapi, tiotesb
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'trinity-iot-gis',
    family: 'trinityIoT',
    name: 'GIS Integration with 3D Engine',
    description: 'Map integration API. GeoServer itself is listed under Tools as an open-source engine.',
    services: [
      // Removed as dev/nightly:
      // tiotegisapi
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'trinity-iot-security',
    family: 'trinityIoT',
    name: 'Security System',
    description: 'Single sign-on. LDAP is listed under Tools as an open-source engine.',
    // SSOservice only, per the product owner. tiotidam (WSO2 Identity Server,
    // SAML SSO) was grouped here on subject-matter alone in an earlier pass
    // and has been removed; it remains queryable under service.name.
    //
    // Spelled `SSOservice` — lowercase "service" — which is how it reports.
    // The match is exact-first, so the wire spelling is the one to keep here.
    services: [
      { label: 'SSOservice', service: 'SSOservice' },
    ],
  },
  {
    key: 'trinity-notify',
    family: 'trinityNOTIFY',
    name: 'Notification System',
    description: 'Notification delivery across channels.',
    // NotifyService only, per the product owner. tiotnotifyservice and
    // tiotntfn were grouped here on name alone in an earlier pass and have
    // been removed — they are dev/nightly deployments that are not part of
    // this product. Both remain queryable under service.name.
    services: [
      { label: 'NotifyService', service: 'NotifyService' },
    ],
  },
  {
    key: 'trinity-dpa',
    family: 'trinityDPA',
    name: 'DPA Tool',
    description: 'Digital process automation — Camunda BPM engine.',
    services: [
      // Removed as dev/nightly:
      // tiotdpasvc
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'trinity-dashboard',
    family: null,
    name: 'trinityDashBoard',
    description: 'Dashboard tier.',
    // Only tiotssodashboardservice names itself a dashboard; superappsvc,
    // superappadminsvc and unifiedappsvc are also plausible members but
    // nothing in their logs says so, so they are left unclaimed.
    services: [
      // Removed as dev/nightly:
      // tiotssodashboardservice
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'trinity-report',
    family: null,
    name: 'trinity Report',
    description: 'Reporting and analytics.',
    // com.trinity.analyst.* — the closest thing to a reporting backend in the
    // telemetry. Unconfirmed: "Analytika" may be its own product.
    services: [
      // Removed as dev/nightly:
      // analytikaservice
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'trinity-iccc-operator',
    family: 'trinityICCC',
    name: 'ICCC Operator & Administrator',
    description: 'Integrated command and control centre — operator and admin applications.',
    // COC = command operations centre. cocappsvc runs com.trinity.security.*,
    // coclistener is a Kafka consumer feeding it. The -poc pair are the
    // proof-of-concept deployments of the same two.
    services: [
      { label: 'cocappsvcpoc',   service: 'cocappsvcpoc' },
      // Removed as dev/nightly:
      // cocappsvc, coclistener, coclistenerpoc
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'trinity-iccc-digital-twin',
    family: 'trinityICCC',
    name: 'Digital Twin Application',
    description: 'Digital twin service.',
    services: [
      // Removed as dev/nightly:
      // tiotdigitaltwinsvc
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'trinity-engage',
    family: 'trinityENGAGE',
    name: 'Case Management System',
    description: 'Citizen engagement and case management portal.',
    // PHP portal — "POST /index.php". cepgrievancesvc handles grievances and
    // may belong here too, but it sits with the CEP services in the telemetry.
    services: [
      // Removed as dev/nightly:
      // tiotengageportal
      // Re-add here if this product should span environments.
    ],
  },

  // ─── Open-source engines ───────────────────────────────────────────────
  //
  // Third-party infrastructure, one product per engine rather than ~55 loose
  // service names. `druid-middlemanager-3` means nothing on its own; under
  // "Apache Druid" next to its coordinator and broker it does.
  //
  // ENVIRONMENT: every engine except Kafka runs ONLY in dev/nightly, so the
  // production-only rule above empties all of them. They were mapped once with
  // `env: 'dev/nightly'` badges and then stripped on instruction — the rule
  // won. Each engine keeps its declaration and a comment naming exactly which
  // services it had, so restoring one is re-adding lines, not redoing the
  // research.
  //
  // Verified against the live instance (24h, k8s_namespace_name / k8s_cluster):
  // kafka1/2/3 and kafkaconnector report with no k8s metadata — the signature
  // of the production OTel path. kafka1/2/3 also have a handful of dev rows
  // (40 / 27 / 66 against 77K / 255K / 411K), so their counts are production
  // to three decimal places but not exclusively so.

  {
    key: 'oss-kafka',
    family: 'Apache',
    name: 'Kafka',
    description: 'Event streaming backbone — brokers, Connect, UI and exporter.',
    services: [
      { label: 'kafka1',         service: 'kafka1' },
      { label: 'kafka2',         service: 'kafka2' },
      { label: 'kafka3',         service: 'kafka3' },
      { label: 'kafkaconnector', service: 'kafkaconnector' },
      // Removed as dev/nightly:
      // kafkaui, kafkaexporter
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-nifi',
    family: 'Apache',
    name: 'NiFi',
    description: 'Dataflow automation cluster.',
    services: [
      // Removed as dev/nightly:
      // nifi-1, nifi-2, nifi-3, nifi-token-refresh
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-druid',
    family: 'Apache',
    name: 'Druid',
    description: 'Real-time analytics database — all eight process roles.',
    services: [
      // Removed as dev/nightly:
      // druid-coordinator, druid-broker, druid-router, druid-historical,
      //   druid-middlemanager, druid-middlemanager-2,
      //   druid-middlemanager-3, druid-middlemanager-4
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-redis',
    family: null,
    name: 'Redis',
    description: 'Master/replica set with Sentinel, HAProxy and a Redis Stack node.',
    services: [
      // Removed as dev/nightly:
      // redis-master, redis-slave1, redis-slave2, redis-sentinel1,
      //   redis-sentinel2, redis-sentinel3, redishaproxy,
      //   tiotredisstack
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-milvus',
    family: null,
    name: 'Milvus',
    description: 'Vector database, with the etcd and MinIO nodes it depends on.',
    services: [
      // Removed as dev/nightly:
      // tiotmilvusstandalone, tiotmilvusetcd, tiotmilvusminio
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-mongodb',
    family: null,
    name: 'MongoDB',
    description: 'Document store.',
    services: [
      // Removed as dev/nightly:
      // mongodb
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-apisix',
    family: 'Apache',
    name: 'APISIX',
    description: 'API gateway, its etcd config store and the httpbin test upstream.',
    services: [
      // Removed as dev/nightly:
      // tiotapisix, tiotapisixetcd, tiotapisixhttpbin
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-ldap',
    family: null,
    name: 'LDAP',
    description: 'Directory service backing authentication.',
    services: [
      // Removed as dev/nightly:
      // tiotldap
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-hazelcast',
    family: null,
    name: 'Hazelcast',
    description: 'In-memory data grid behind the CEP workers.',
    services: [
      // Removed as dev/nightly:
      // cephazelcast
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-geoserver',
    family: null,
    name: 'GeoServer',
    description: 'Geospatial data server.',
    services: [
      // Removed as dev/nightly:
      // tiotgeoserversvc
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-kibana',
    family: null,
    name: 'Kibana',
    description: 'Elastic-stack UI.',
    services: [
      // Removed as dev/nightly:
      // kibana
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-uptime-kuma',
    family: null,
    name: 'Uptime Kuma',
    description: 'Self-hosted uptime monitoring.',
    services: [
      // Removed as dev/nightly:
      // uptime-kuma
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-otel-collector',
    family: null,
    name: 'OpenTelemetry Collector',
    description: 'Telemetry pipeline feeding OpenObserve.',
    services: [
      // Removed as dev/nightly:
      // tiotopentelemetry
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-prometheus-exporters',
    family: 'Prometheus',
    name: 'Exporters',
    description: 'Metric exporters. The Kafka exporter is listed under Kafka, with the engine it exports.',
    services: [
      // Removed as dev/nightly:
      // mssqlexporter
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-openmetadata',
    family: null,
    name: 'OpenMetadata',
    description: 'Metadata catalogue and lineage — ingestion worker.',
    services: [
      // Removed as dev/nightly:
      // tiotopenmetadata-ingestion
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-livekit',
    family: null,
    name: 'LiveKit',
    description: 'WebRTC media server — egress worker and its Redis.',
    services: [
      // Removed as dev/nightly:
      // tiotlivekitegress, tiotlivekitredis
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-openvidu',
    family: null,
    name: 'OpenVidu',
    description: 'Video conferencing server.',
    services: [
      // Removed as dev/nightly:
      // tiotopenvidu-server
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-langfuse',
    family: null,
    name: 'Langfuse',
    description: 'LLM observability and tracing.',
    services: [
      // Removed as dev/nightly:
      // tiotlangfuseworker
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-n8n',
    family: null,
    name: 'n8n',
    description: 'Workflow automation engine.',
    // Missed in the first engine sweep — the service name spells the digit
    // out ("neightn"), so it reads as first-party until you look at the logs,
    // which carry n8n's Langfuse workflow-tracing warning.
    services: [
      // Removed as dev/nightly:
      // tiotneightn
      // Re-add here if this product should span environments.
    ],
  },
  {
    key: 'oss-litellm',
    family: null,
    name: 'LiteLLM',
    description: 'Unified proxy across model providers.',
    services: [
      // Removed as dev/nightly:
      // tiotlitellm
      // Re-add here if this product should span environments.
    ],
  },
];

/**
 * ─── Categories: the top level of the tree ─────────────────────────────────
 *
 * Products alone were one flat list. Categories are the layer above, so the
 * sidebar reads Applications → IoT Hub System → StreamMonitorService rather
 * than dropping every product at the root.
 *
 * A category holds EITHER products, OR services directly, OR both:
 *
 *   Applications  → products (each expands to its own services)
 *   DLH           → one service, no intervening product
 *
 * Both shapes are real, not a special case for DLH. "Applications" groups
 * multi-service products people name as products; "Databases" or "Tools" will
 * hold individual services that no product owns. Forcing DLH through a
 * single-service wrapper product would put `dlhbackendservice` a level deeper
 * than it belongs and read as a naming duplicate.
 *
 * Platform / AI Services / Databases are declared with no members yet
 * — deliberately. They are the agreed taxonomy, and an empty category that
 * says so is more useful than a category that appears the day someone
 * remembers to add it. Each renders with a "no services mapped yet" note.
 *
 * @typedef {Object} Category
 * @property {string} key
 * @property {string} name
 * @property {string} description
 * @property {string[]} products  Product keys, in display order.
 * @property {ProductService[]} services Services belonging to the category
 *   itself rather than to any of its products.
 */
export const CATEGORIES = [
  {
    key: 'applications',
    name: 'Applications',
    description: 'Customer-facing product suites and their services.',
    // Grouped by brand so the three trinityIoT products and the two
    // trinityICCC ones sit together — the tree shows each product's own name,
    // with the family only in the tooltip, so adjacency is what conveys it.
    products: [
      'trinity-iot-provisioning', 'trinity-iot-hub', 'trinity-iot-api-esb',
      'trinity-iot-gis', 'trinity-iot-security',
      'trinity-notify', 'trinity-dpa',
      'trinity-dashboard', 'trinity-report',
      'trinity-iccc-operator', 'trinity-iccc-digital-twin',
      'trinity-engage',
    ],
    services: [],
  },
  {
    key: 'platform',
    name: 'Platform',
    description: 'Shared platform and infrastructure services.',
    products: [],
    services: [],
  },
  {
    key: 'ai-services',
    name: 'AI Services',
    description: 'Model serving, inference and ML pipelines.',
    products: [],
    services: [],
  },
  {
    key: 'tools',
    name: 'Tools',
    description: 'Open-source engines the platform runs on.',
    // Ordered by role — streaming and integration, then datastores, then
    // gateway and directory, then observability, then AI and realtime media —
    // rather than by traffic, which would put a 2M-log dev vector database
    // above the production event bus.
    products: [
      'oss-kafka', 'oss-nifi',
      'oss-druid', 'oss-redis', 'oss-milvus', 'oss-mongodb',
      'oss-apisix', 'oss-ldap', 'oss-hazelcast', 'oss-geoserver',
      'oss-kibana', 'oss-uptime-kuma', 'oss-otel-collector',
      'oss-prometheus-exporters', 'oss-openmetadata',
      'oss-langfuse', 'oss-litellm', 'oss-n8n',
      'oss-livekit', 'oss-openvidu',
    ],
    services: [],
  },
  {
    key: 'databases',
    name: 'Databases',
    description: 'Datastores and persistence services.',
    products: [],
    services: [],
  },
  {
    key: 'dlh',
    name: 'DLH',
    description: 'Data Lake House.',
    products: [],
    services: [
      { label: 'dlhbackendservice', service: 'dlhbackendservice' },
      // Production only. `tiotdlhsvc` is the same software in the dev/nightly
      // cluster (k8s_namespace_name=dev, k8s_cluster=nightly) and is left out
      // for the reason given above PRODUCTS — it is still tickable under
      // service.name. dlhbackendservice carries no k8s metadata at all, which
      // is the signature of the OTel-SDK-reported production services.
    ],
  },
];

/** Case-insensitive set of every wire name a service list claims. Used only by
 *  unclaimedServices, where a loose match is right: a service is 'covered' if
 *  anything names it, whatever the casing. */
const claimedIn = (list) => new Set(
  (list || []).map((s) => s.service).filter(Boolean).map((n) => n.toLowerCase()),
);

/** Normalises the caller's service list to {name, count}. */
const asEntries = (available) => (available || [])
  .map((s) => (typeof s === 'string' ? { name: s, count: null } : { name: s?.name, count: s?.count ?? null }))
  .filter((s) => s.name);

/** @returns {object|null} the product entry for a key. */
export const getProduct = (key) => PRODUCTS.find((p) => p.key === key) || null;

/**
 * Resolve a product to the service names that actually exist right now.
 *
 * Delegates to describeProductServices so the FILTER APPLIED and the COVERAGE
 * LIST SHOWN can never disagree. They did: resolving by a case-insensitive set
 * pulled in `iotopsapisvc` for a product that only declares `IoTOpsApiSvc`, so
 * the query silently included a dev/nightly service the UI listed as absent.
 *
 * Returns the DISCOVERED spelling, not the registry's: the value goes straight
 * into a `service_name='…'` clause and the backend compares it exactly.
 */
export const resolveProductServices = (key, available) =>
  describeProductServices(key, available)
    .filter((r) => r.present)
    .map((r) => r.name);

/**
 * Per-service breakdown for a product, including entries that resolved to
 * nothing — the UI greys those out so a stale mapping stays visible.
 *
 * @returns {Array<{label, service, env, name, count, present}>}
 */
export const describeProductServices = (key, available) => {
  const product = getProduct(key);
  if (!product) return [];
  return describeServiceList(product.services, available);
};

/**
 * Resolve a declared service list against what telemetry reports.
 *
 * Shared by products and by categories that own services directly, so the two
 * cannot drift into matching by different rules — the exact-then-fold-case
 * order below is load-bearing and must not be reimplemented per caller.
 *
 * @returns {Array<{label, service, env, name, count, present}>}
 */
const describeServiceList = (list, available) => {
  const entries = asEntries(available);

  return (list || []).map((svc) => {
    // Exact, case-insensitive, single match. `IoTOpsApiSvc` and `iotopsapisvc`
    // lowercase identically, so the real-name comparison below is what keeps
    // the right one — matching on the lowercase key alone would pick whichever
    // happened to come first.
    const found = svc.service
      ? entries.find((e) => e.name === svc.service)
        || entries.find((e) => e.name.toLowerCase() === svc.service.toLowerCase())
      : null;
    return {
      label: svc.label,
      service: svc.service,
      env: svc.env || null,
      name: found?.name || null,
      count: found?.count ?? null,
      present: !!found,
    };
  });
};

/** @returns {object|null} the category entry for a key. */
export const getCategory = (key) => CATEGORIES.find((c) => c.key === key) || null;

/** The Product objects a category lists, in declared order. Unknown keys are
 *  dropped rather than rendered as blanks — a typo in CATEGORIES.products
 *  should lose one row, not break the tree. */
export const categoryProducts = (key) => {
  const category = getCategory(key);
  if (!category) return [];
  return (category.products || []).map(getProduct).filter(Boolean);
};

/**
 * Per-service breakdown for the services a category owns DIRECTLY — those not
 * belonging to any of its products. Same shape as describeProductServices, so
 * the tree renders both with one code path.
 */
export const describeCategoryServices = (key, available) => {
  const category = getCategory(key);
  if (!category) return [];
  return describeServiceList(category.services, available);
};

/**
 * Every service name in a category that exists right now — its products' plus
 * its own, de-duplicated. Selecting a whole category goes through here.
 */
export const resolveCategoryServices = (key, available) => {
  const category = getCategory(key);
  if (!category) return [];
  const names = [
    ...(category.products || []).flatMap((k) => resolveProductServices(k, available)),
    ...describeCategoryServices(key, available).filter((r) => r.present).map((r) => r.name),
  ];
  return Array.from(new Set(names));
};

/**
 * Services present in telemetry that NOTHING in the registry claims — surfaced
 * in the picker so the registry's gaps are visible instead of hiding data.
 *
 * Counts category-owned services as claimed too. Without that, every service
 * hung directly off a category (dlhbackendservice today) would be reported as
 * unclaimed despite being right there in the tree.
 */
export const unclaimedServices = (available) => {
  const claimed = new Set();
  PRODUCTS.forEach((p) => claimedIn(p.services).forEach((m) => claimed.add(m)));
  CATEGORIES.forEach((c) => claimedIn(c.services).forEach((m) => claimed.add(m)));
  return asEntries(available)
    .filter((s) => !claimed.has(s.name.toLowerCase()))
    .map((s) => s.name);
};
