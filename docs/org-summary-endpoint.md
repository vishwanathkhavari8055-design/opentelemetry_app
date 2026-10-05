# `GET /api/org/summary` — contract for the Home screen

The Home screen (`src/components/HomeView.jsx`) renders the org's ingest posture:
a **Streams** panel of five headline figures, then **Functions**, **Alerts**,
**Pipelines** and **Dashboards** cards.

Every figure on that screen comes from this one endpoint. It does **not** exist in
the observability lib yet — until it ships, the screen renders an informational
notice naming the path and the HTTP status it got back (today: `500`, which is
what this backend answers for an unmapped path). The UI never queries
OpenObserve directly; the single-backend contract in `src/services/api.js` still
holds.

## Request

```
GET /api/org/summary
```

No parameters. These are whole-org totals, not windowed aggregates, so there is
no `window` argument and the UI offers no time-range control on this screen.

## Response

```json
{
  "supported": true,
  "backend": "openobserve",
  "org": "default",

  "streams": {
    "count":           632,
    "events":          47800000,
    "ingestedBytes":   113500000000,
    "compressedBytes": 412000000,
    "indexBytes":      347000000
  },

  "functions":  { "count": 0 },
  "dashboards": { "count": 8 },

  "alerts":     { "scheduled": 0, "realTime": 0, "items": [] },
  "pipelines":  { "scheduled": 0, "realTime": 0, "items": [] }
}
```

### Fields

| Field | Type | Notes |
| --- | --- | --- |
| `supported` | bool | `false` → the UI shows "not supported on this backend" instead of the panels. Matches the convention of the other summary endpoints. |
| `backend` | string | `"openobserve"` / `"elasticsearch"`, as elsewhere. |
| `org` | string | Rendered as a chip next to the page title. |
| `streams.count` | number | Number of streams. |
| `streams.events` | number | Σ `doc_num` across streams. |
| `streams.ingestedBytes` | number | Σ `storage_size`. **Raw bytes.** |
| `streams.compressedBytes` | number | Σ `compressed_size`. **Raw bytes.** |
| `streams.indexBytes` | number | Σ `index_size`. **Raw bytes.** |
| `functions.count` | number | |
| `dashboards.count` | number | |
| `alerts` / `pipelines` `.scheduled`, `.realTime` | number | The two counts shown side by side on those cards. |
| `alerts` / `pipelines` `.items` | array | **Optional.** Absent or empty renders "No data available", as the reference UI does. When present, each item is read for `name` \| `title` \| `id`, and optionally `streamName` \| `type` as a secondary label. |

### Two things the UI depends on

1. **Sizes are raw bytes, never pre-formatted strings.** `"105.74 GB"` is a
   presentation choice and is made client-side (`formatBytes` in
   `src/components/home/StreamsPanel.jsx`).

2. **`null` means "not computed", and is not the same as `0`.** The UI renders
   `—` for `null` and the actual digit for `0`. Please don't coalesce a failed
   sub-query to zero — "0 streams" and "we couldn't count the streams" lead an
   operator to opposite conclusions.

## Implementation note

All five stream figures come from a **single** OpenObserve call:

```
GET {openobserve}/api/{org}/summary
```

which answers with pre-aggregated totals — `num_streams`, `total_records`, and
`total_storage_size` / `total_compressed_size` / `total_index_size` (megabytes,
scaled to bytes on the way out) — alongside the `trigger_status` blocks behind
the Alerts and Pipelines health bars. Functions, alerts, pipelines and dashboards
are one call each against their respective OpenObserve endpoints, and the whole
set runs concurrently, so the endpoint costs the slowest one rather than the sum.

**Don't go back to summing `/api/{org}/streams`.** That was the original
implementation: every stream with its full schema, one count plus four sums over
the result. On this instance it is a 19 MB, ~10 second response — 19,735 streams
— and because it was the slowest task in the fan-out it set the latency of the
whole endpoint, leaving Home blank for 20+ seconds. The `/summary` figures are
also the ones OpenObserve's own Home shows for the org, which is the screen this
one mirrors. The stream walk survives in `OrgServiceImpl.fillStreams` purely as a
fallback for an OpenObserve whose summary reports no stream block.

## Field-name tolerance

`fetchOrgSummary` in `src/services/api.js` reads fields tolerantly, because
whoever implements this may pass OpenObserve's own snake_case stat names straight
through. All of these are accepted for the same value:

- `streams.ingestedBytes` / `ingested_bytes` / `ingestedSize` / `ingested_size` / `storageSize` / `storage_size`
- `streams.events` / `eventCount` / `docNum` / `doc_num`
- `alerts.realTime` / `real_time` / `realtime` / `realTimeCount` / `real_time_count`

A flat top-level shape (`streamCount`, `functionCount`, …) is accepted alongside
the nested one. The nested camelCase shape above is the preferred form.
