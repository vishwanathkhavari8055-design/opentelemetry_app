/**
 * A Scenes RuntimeDataSource whose every query goes through this application's
 * backend, which forwards it to Grafana's `/api/ds/query`.
 *
 * SceneQueryRunner resolves a datasource by UID, so registering one of these per
 * UID a dashboard references is what makes every panel query flow
 *
 *     panel -> SceneQueryRunner -> this -> /api/dashboards/query -> Grafana -> datasource
 *
 * Live data, and no Grafana credential anywhere in the browser.
 *
 * ─── One class for every datasource type ────────────────────────────────────
 *
 * There is no Prometheus-specific or Elasticsearch-specific code here, and there
 * does not need to be: Grafana executes the query, so whatever the dashboard's
 * panels reference — Prometheus, Elasticsearch, MSSQL, InfluxDB, Loki — travels
 * this same path. `pluginId` is carried only so the request names the type
 * Grafana expects to see.
 *
 * ─── Series colours are deliberately NOT touched ────────────────────────────
 *
 * They come from the panel's own fieldConfig (`color.mode`, default
 * palette-classic), applied by VizPanel.applyFieldConfig — which works because
 * ./fieldConfig.js populates the registry Grafana core normally fills. Assigning
 * a colour here would override the dashboard's own rules.
 */

import { dataFrameFromJSON, LoadingState } from '@grafana/data';
import { RuntimeDataSource } from '@grafana/scenes';
import { Observable } from 'rxjs';

import { runDashboardQuery, fetchDashboardLabelValues } from '../services/dashboardsApi';
import { isInfinityQuery, unparsedFrameReason, withInfinityBackendParser } from './infinity';
import { applyPrometheusTableFormat } from './promTable';
import { PROM_LIKE, interpolateDeep, prometheusFormat } from './queryRunner';
import {
  filterMetricNames,
  framesToVariableValues,
  infinityLegacyText,
  infinityLegacyValues,
  parsePrometheusVariableQuery,
  promInstantToVariableValues,
  prometheusVariableText,
  variableTarget,
} from './variableQuery';

/** Every frame of a /api/ds/query response, in Grafana's wire format. */
const framesOf = (response) => Object.values(response?.results ?? {})
  .flatMap((result) => result?.frames ?? []);

export class ProxyDataSource extends RuntimeDataSource {
  constructor(pluginId, uid, { mixed = false } = {}) {
    super(pluginId, uid);
    this.uid = uid;
    this.pluginType = pluginId;

    // `meta.mixed` is not decoration — SceneQueryRunner READS it.
    //
    // Before sending a request it walks the targets and rewrites any whose
    // datasource uid differs from the runner's own... unless the runner's
    // datasource declares itself mixed. Without this flag, a panel holding one
    // Infinity target and four Prometheus targets has all five sent to
    // Infinity: four queries silently execute against the wrong datasource and
    // come back empty, so the panel renders — with most of its numbers missing.
    // See getMixedProxyDataSource() in ./datasources.js.
    if (mixed) {
      this.meta = { ...this.meta, mixed: true };
    }
  }

  query(request) {
    // An Observable, not a Promise: Scenes subscribes and CANCELS. Without the
    // teardown below, changing the time range on a twelve-panel dashboard would
    // leave twelve in-flight requests racing the twelve new ones, and whichever
    // landed last would win — panels showing the previous window at random.
    //
    // The teardown does two things, and both matter. `cancelled` stops a late
    // response being pushed into a panel that has moved on; the AbortController
    // actually cancels the HTTP request, so the abandoned query stops costing
    // Grafana anything. Flagging without aborting would fix the display and leave
    // a fourteen-panel dashboard hammering Grafana on every range change.
    return new Observable((subscriber) => {
      let cancelled = false;
      const controller = new AbortController();

      const payload = {
        from: String(request.range.from.valueOf()),
        to: String(request.range.to.valueOf()),
        queries: request.targets.map((target, index) => withInfinityBackendParser({
          refId: target?.refId || String.fromCodePoint(65 + index),
          ...target,
          datasource: target.datasource ?? { type: this.pluginType, uid: this.uid },
          intervalMs: request.intervalMs,
          maxDataPoints: request.maxDataPoints,
          // Some plugins parse the response in the BROWSER and hand the raw body
          // back from /api/ds/query untouched. That plugin is not loaded here, so
          // the query has to ask for server-side parsing or the panel renders
          // "No data" over a perfectly good response. See ./infinity.js.
        }, this.pluginType)),
      };

      subscriber.next({ data: [], state: LoadingState.Loading, key: request.requestId });

      runDashboardQuery(payload, { signal: controller.signal })
        .then((response) => {
          if (cancelled) return;
          const data = [];
          // Sent queries by refId, so a frame can be read against the query that
          // produced it — which is where its root_selector lives.
          const sent = new Map(payload.queries.map((query) => [query.refId, query]));
          // Deduped: one message however many frames report the same thing.
          const unparsed = new Set();
          const results = response?.results ?? {};
          for (const refId of Object.keys(results)) {
            const result = results[refId];
            if (result?.error) {
              throw new Error(`${refId}: ${result.error}`);
            }
            for (const frameJson of result?.frames ?? []) {
              // Grafana's own wire format -> a DataFrame. Doing this here rather
              // than on the backend is what keeps the backend a pass-through.
              const frame = dataFrameFromJSON(frameJson);
              frame.refId = frame.refId ?? refId;
              // A frame with no fields over a response that plainly carried rows
              // is the one failure that LOOKS like success: the panel just says
              // "No data", and the only way to find out otherwise is to open the
              // same panel in Grafana and compare. Reported on the panel, not to
              // the console, because the console is not where anyone is looking
              // when a dashboard comes up empty.
              if (!frame.fields?.length) {
                const why = unparsedFrameReason(frameJson, sent.get(refId));
                if (why) unparsed.add(why);
              }
              data.push(frame);
            }
          }
          // `format: "table"` is applied HERE, not by the backend: Grafana's Go
          // code answers every Prometheus query as one frame per series and
          // leaves the label-to-column step to its browser plugin, which is not
          // loaded here. Without this, a table-format panel gets skinny
          // time-series frames and any transformation that joins on a label
          // silently matches nothing. See ./promTable.js.
          const framed = applyPrometheusTableFormat(data, sent, this.pluginType);
          if (unparsed.size) {
            const message = [...unparsed].join(' ');
            console.warn(`[dashboards] datasource "${this.uid}": ${message}`);
            // Whatever DID parse is still handed over — a panel with one broken
            // target of three should keep the other two rather than blank itself.
            subscriber.next({
              data: framed,
              state: LoadingState.Error,
              errors: [{ message }],
              error: { message },
              key: request.requestId,
            });
          } else {
            subscriber.next({ data: framed, state: LoadingState.Done, key: request.requestId });
          }
          subscriber.complete();
        })
        .catch((err) => {
          // An abort is not a failure — it is this panel being told its answer is
          // no longer wanted. Reporting it would flash a spurious error on every
          // panel each time the time range changes.
          if (cancelled || err?.name === 'AbortError') return;
          const message = err?.message || 'Query failed';
          // Reported as panel state rather than thrown: one panel whose query is
          // broken must show its own error and cost nothing else on the screen.
          subscriber.next({
            data: [],
            state: LoadingState.Error,
            errors: [{ message }],
            error: { message },
            key: request.requestId,
          });
          subscriber.complete();
        });

      return () => {
        cancelled = true;
        controller.abort();
      };
    });
  }

  /**
   * Backs a dashboard's template variables (Scenes' QueryVariable calls this),
   * for EVERY datasource type — see ./variableQuery.js for why that takes no
   * per-datasource code beyond Prometheus' own variable functions.
   *
   * Nothing here throws: a variable that cannot resolve leaves its picker empty
   * and lets the dependent panels report their own errors. Failing would blank
   * the whole dashboard over one dropdown.
   */
  async metricFindQuery(query, options) {
    // Interpolated FIRST, and here, because nothing else will. Scenes hands the
    // query over raw, and in Grafana it is each datasource's browser plugin that
    // expands `$namespace` — so a chained variable (`Pod` filtered by
    // `$namespace`, `Category` by `${Company:regex}`) used to go out with the
    // literal `$namespace` in it and match nothing.
    const interpolated = this.interpolateVariableQuery(query, options);
    try {
      if (PROM_LIKE.has(this.pluginType)) {
        return await this.prometheusVariableValues(interpolated, options);
      }
      const legacy = isInfinityQuery(this.pluginType) ? infinityLegacyText(interpolated) : null;
      if (legacy != null) {
        const values = infinityLegacyValues(legacy);
        if (values) return values;
      }
      return await this.variableValuesViaQuery(interpolated, options, options?.variable?.name);
    } catch (err) {
      if (err?.name === 'AbortError') return [];
      console.warn(
        `[dashboards] could not resolve variable values for ${JSON.stringify(query)}`,
        err,
      );
      return [];
    }
  }

  /** The variable query with every `$var` expanded against the live scene. */
  interpolateVariableQuery(query, options) {
    const scopedVars = options?.scopedVars;
    const sceneObject = scopedVars?.__sceneObject?.valueOf?.();
    if (!sceneObject) return query;
    try {
      return interpolateDeep(
        sceneObject,
        query,
        scopedVars,
        PROM_LIKE.has(this.pluginType) ? prometheusFormat : undefined,
      );
    } catch (err) {
      console.warn('[dashboards] variable interpolation failed for a variable query', err);
      return query;
    }
  }

  /** Grafana's Prometheus variable functions, which are not PromQL. */
  async prometheusVariableValues(query, options) {
    const parsed = parsePrometheusVariableQuery(prometheusVariableText(query));
    if (!parsed) return [];
    const range = options?.range;
    const from = range ? String(range.from.valueOf()) : undefined;
    const to = range ? String(range.to.valueOf()) : undefined;

    switch (parsed.kind) {
      case 'label_values': {
        const values = await fetchDashboardLabelValues({
          uid: this.uid, label: parsed.label, metric: parsed.metric, from, to,
        });
        return values.map((value) => ({ text: value, value }));
      }
      case 'metrics': {
        const names = await fetchDashboardLabelValues({
          uid: this.uid, label: '__name__', from, to,
        });
        return filterMetricNames(names, parsed.regex).map((value) => ({ text: value, value }));
      }
      case 'query_result':
      case 'series': {
        const response = await runDashboardQuery({
          from: from ?? String(Date.now() - 3600000),
          to: to ?? String(Date.now()),
          queries: [{
            refId: 'A',
            datasource: { type: this.pluginType, uid: this.uid },
            expr: parsed.expr,
            instant: true,
            range: false,
          }],
        });
        return promInstantToVariableValues(
          framesOf(response),
          { seriesOnly: parsed.kind === 'series' },
        );
      }
      default:
        console.warn(`[dashboards] Prometheus variable function "${parsed.kind}" is not supported`);
        return [];
    }
  }

  /**
   * Any other datasource: the variable query is sent to Grafana like a panel
   * query, and the frames that come back become the options.
   */
  async variableValuesViaQuery(query, options, name) {
    const target = variableTarget(query, {
      name,
      datasource: { type: this.pluginType, uid: this.uid },
    });
    if (!target) return [];
    const range = options?.range;
    const now = Date.now();
    const response = await runDashboardQuery({
      from: String(range ? range.from.valueOf() : now - 6 * 3600000),
      to: String(range ? range.to.valueOf() : now),
      queries: [withInfinityBackendParser(target, this.pluginType)],
    });
    const results = response?.results ?? {};
    for (const refId of Object.keys(results)) {
      if (results[refId]?.error) throw new Error(`${refId}: ${results[refId].error}`);
    }
    return framesToVariableValues(framesOf(response));
  }

  testDatasource() {
    return Promise.resolve({ status: 'success', message: 'Proxy datasource ready' });
  }
}
