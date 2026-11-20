import type { QueryResult } from "../types/query.js";
import { send, type CallContext } from "../send.js";
import type {
  ListMetricsResponse,
  Metric,
  MetricInput,
  PreviewMetricRequest,
  UpdateMetricRequest,
} from "../types/measures.js";

export const metricsCalls = (ctx: CallContext) => ({
  /** The source's metrics as the caller may see them, some of them redacted. */
  list: (sourceId: string): Promise<ListMetricsResponse> =>
    send(ctx, { op: "listMetrics", params: { sourceId } }),
  /**
   * Refused as a `ZeteoError` when the formula does not plan (400 with the
   * query error code and `path`), or with `measure_name_taken` (409).
   */
  create: (sourceId: string, body: MetricInput): Promise<Metric> =>
    send(ctx, {
      op: "createMetric",
      params: { sourceId },
      body,
      once: true,
    }),
  get: (sourceId: string, metricId: string): Promise<Metric | null> =>
    send(ctx, {
      op: "getMetric",
      params: { sourceId, metricId },
      nullOn404: true,
    }),
  update: (
    sourceId: string,
    metricId: string,
    body: UpdateMetricRequest
  ): Promise<Metric> =>
    send(ctx, {
      op: "updateMetric",
      params: { sourceId, metricId },
      body,
      once: true,
    }),
  delete: async (sourceId: string, metricId: string): Promise<void> => {
    await send(ctx, {
      op: "deleteMetric",
      params: { sourceId, metricId },
      once: false,
    });
  },
  /**
   * Runs a draft metric, not saved, as a metric query. Read-only, so it may
   * be repeated after a 5xx; a run is recorded each time.
   */
  preview: (
    sourceId: string,
    body: PreviewMetricRequest,
    options?: { signal?: AbortSignal }
  ): Promise<QueryResult> =>
    send(ctx, {
      op: "previewMetric",
      params: { sourceId },
      body,
      once: false,
      signal: options?.signal,
    }),
});
