# Alert definitions

Importable alert documents for the Alerts screen (**Alerts → Import → File Upload /
JSON**, or `POST /api/alerts/import`). A file may hold one alert object or an array
of them; import is per-document, so one bad entry does not discard the rest.

## Files

| File | Covers |
| --- | --- |
| `iotopscim-cpu-ram.json` | `IoTOpsCIMService` process CPU and JVM heap pressure |

## Choosing the right metric — read before adapting these

The metric names below were verified against this instance by querying for rows
with `service_name = 'IoTOpsCIMService'`. Several plausible-looking alternatives
have **no data** for the JVM services here and would produce an alert that can
never fire — the worst possible outcome, because it looks configured:

| Metric | Status for IoTOpsCIMService |
| --- | --- |
| `process_cpu_usage` | ✅ has data — Micrometer, fraction 0–1 |
| `jvm_cpu_recent_utilization` | ✅ has data — OTel SDK equivalent |
| `system_cpu_usage` | ✅ has data — HOST cpu, not the service's |
| `jvm_memory_used_bytes` | ✅ has data — per pool, `area` + `id` labels |
| `jvm_memory_used` | ✅ has data — OTel variant, `jvm_memory_pool_name` label |
| `process_cpu_utilization` | ❌ no data |
| `process_memory_usage` | ❌ no data |
| `system_memory_utilization` | ❌ no data |
| `k8s_pod_cpu_usage`, `k8s_pod_memory_usage` | ❌ no data for this service |

Re-check with a query like this before trusting any metric name:

```sql
SELECT * FROM "process_cpu_usage"
WHERE service_name = '<YourService>'
```

## Why CPU is a fraction, not a percent

`process_cpu_usage` is Micrometer's `process.cpu.usage`: the JVM process's recent
CPU as a value between 0 and 1. **`0.85` means 85%.** Writing `85` would create an
alert that can never fire, since the metric never exceeds 1.

## Why the heap alert targets G1 Old Gen specifically

`jvm_memory_used_bytes` is reported **per memory pool**, so a bare
`value >= threshold` compares every pool independently. G1 Eden Space routinely
fills to near capacity and is then collected — that is healthy GC behaviour, and
alerting on it pages constantly for nothing.

Sustained **G1 Old Gen** growth is the signal that actually indicates memory
pressure, so the condition pins `area = heap` and `id = G1 Old Gen`.

Threshold is 80% of the observed max heap:

```
max heap (G1 Old Gen jvm_memory_max_bytes) = 4294967296  (4 GiB)
80%                                        = 3435973836
```

If the service's `-Xmx` changes, **this number must change with it.** It is an
absolute byte count because an OpenObserve `custom` condition compares one column
against a literal — it cannot divide used by max. For a true ratio, switch the
alert's Query Type to PromQL and express it as one expression.

## Why these are scheduled, not realtime

OpenObserve accepts `is_real_time: true` on a metrics stream, but a realtime alert
is evaluated per ingested record and has no window or threshold — and whether the
metrics ingestion path runs realtime evaluation at all on this build is
**unverified**. A scheduled alert evaluating every minute over a 5-minute window is
near-realtime in practice and its behaviour is exactly the SQL you can run by hand.

`threshold: 3` (not 1) requires three breaching samples inside the window, so a
single momentary spike — a GC pause, one busy scrape — does not page anyone.

## Adapting to another service

1. Change `service_name` in both conditions and the alert `name`.
2. **Re-derive the heap threshold** for that service's `-Xmx`; do not copy 4 GiB.
3. Confirm the metric has rows for that service using the query above.
