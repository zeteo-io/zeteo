import type { SharePrincipal } from "../types/savedQueries.js";
import { send, type CallContext } from "../send.js";
import type {
  ListMeasuresResponse,
  Measure,
  MeasureEditors,
  MeasureInput,
  PreviewMeasureRequest,
  PreviewMeasureResponse,
  UpdateMeasureRequest,
} from "../types/measures.js";

export const measuresCalls = (ctx: CallContext) => ({
  /** The source's measures as the caller may see them, some of them redacted. */
  list: (sourceId: string): Promise<ListMeasuresResponse> =>
    send(ctx, { op: "listMeasures", params: { sourceId } }),
  /**
   * Refused as a `ZeteoError` when the measure does not plan (400 with the
   * query error code and `path`), or with `measure_name_taken` (409).
   */
  create: (sourceId: string, body: MeasureInput): Promise<Measure> =>
    send(ctx, {
      op: "createMeasure",
      params: { sourceId },
      body,
      once: true,
    }),
  get: (sourceId: string, measureId: string): Promise<Measure | null> =>
    send(ctx, {
      op: "getMeasure",
      params: { sourceId, measureId },
      nullOn404: true,
    }),
  /** A change that would break measures using this one is `measure_in_use` (409), naming them in `dependents`. */
  update: (
    sourceId: string,
    measureId: string,
    body: UpdateMeasureRequest
  ): Promise<Measure> =>
    send(ctx, {
      op: "updateMeasure",
      params: { sourceId, measureId },
      body,
      once: true,
    }),
  /** Refused with `measure_in_use` (409) while other measures use it. */
  delete: async (sourceId: string, measureId: string): Promise<void> => {
    await send(ctx, {
      op: "deleteMeasure",
      params: { sourceId, measureId },
      once: false,
    });
  },
  /**
   * Runs a draft measure, not saved. Read-only, so it may be repeated after a
   * 5xx; a run is recorded each time.
   */
  preview: (
    sourceId: string,
    body: PreviewMeasureRequest,
    options?: { signal?: AbortSignal }
  ): Promise<PreviewMeasureResponse> =>
    send(ctx, {
      op: "previewMeasure",
      params: { sourceId },
      body,
      once: false,
      signal: options?.signal,
    }),
  /** The users and groups that may change the source's measures. */
  editors: (sourceId: string): Promise<MeasureEditors> =>
    send(ctx, { op: "listMeasureEditors", params: { sourceId } }),
  /** Replaces the whole editor list; repeating it after a 5xx is harmless. */
  replaceEditors: (
    sourceId: string,
    principals: SharePrincipal[]
  ): Promise<MeasureEditors> =>
    send(ctx, {
      op: "replaceMeasureEditors",
      params: { sourceId },
      body: { principals },
      once: false,
    }),
});
