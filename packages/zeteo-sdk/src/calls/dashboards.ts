import { isObject, sendRaw, send, type CallContext } from "../send.js";
import type { Page } from "../types/common.js";
import type { Readable } from "node:stream";
import { ZeteoError } from "../errors.js";
import { lines } from "../ndjson.js";
import type {
  SavedPanel,
  SaveAsSavedPanelRequest,
} from "../types/savedPanels.js";
import type {
  CopyDashboardRequest,
  CreateDashboardRequest,
  Dashboard,
  DashboardShares,
  DashboardSummary,
  ListDashboardsOptions,
  Panel,
  PanelInput,
  PanelLine,
  RunDashboardOptions,
  SharePrincipal,
  TransferOwnerRequest,
  UpdateDashboardRequest,
  UpdatePanelRequest,
} from "../types/dashboards.js";

const interrupted = (message: string): ZeteoError =>
  new ZeteoError(`@zeteo-io/sdk: ${message}`, {
    status: null,
    code: "dashboard_run_interrupted",
  });

const isPanelLine = (value: unknown): value is PanelLine =>
  isObject(value) &&
  typeof value.panel_id === "string" &&
  typeof value.state === "string";

/**
 * The lines of one dashboard run. The request goes out when iteration starts,
 * and a failure before the stream (`404`, `400`) is thrown from the first
 * `next()`. A stream that ends without its `{ done: true }` line, or holds a
 * line that is neither a panel's nor that one, throws `ZeteoError` with code
 * `dashboard_run_interrupted`. Leaving the loop early (`break`) or aborting
 * the `signal` closes the connection.
 */
async function* runLines(
  ctx: CallContext,
  id: string,
  options: RunDashboardOptions | undefined
): AsyncGenerator<PanelLine> {
  const { panels, time_range: timeRange, signal } = options ?? {};
  const body =
    panels === undefined && timeRange === undefined
      ? undefined
      : {
          ...(panels !== undefined && { panels }),
          ...(timeRange !== undefined && { time_range: timeRange }),
        };
  const response = await sendRaw(ctx, {
    op: "runDashboard",
    params: { dashboardId: id },
    body,
    once: true,
    stream: true,
    signal,
    headers: { "Accept-Encoding": "gzip" },
  });
  const stream = response.data as Readable;
  try {
    let done = false;
    try {
      for await (const line of lines(stream)) {
        if (done) throw interrupted("the run held a line after its end");
        if (isObject(line) && line.done === true) {
          done = true;
        } else if (isPanelLine(line)) {
          yield line;
        } else {
          throw interrupted("the run held a line that is not a panel's");
        }
      }
    } catch (error) {
      if (error instanceof ZeteoError) throw error;
      throw interrupted(
        signal?.aborted
          ? "the run was aborted by the caller"
          : error instanceof SyntaxError
            ? "a line of the run was not valid JSON"
            : "the run's connection was cut"
      );
    }
    if (!done) throw interrupted("the run ended without its done line");
  } finally {
    stream.destroy();
  }
}

export const dashboardsCalls = (ctx: CallContext) => ({
  list: (options?: ListDashboardsOptions): Promise<Page<DashboardSummary>> =>
    send(ctx, { op: "listDashboards", query: { ...options } }),
  create: (body: CreateDashboardRequest): Promise<Dashboard> =>
    send(ctx, { op: "createDashboard", body, once: true }),
  get: (id: string): Promise<Dashboard | null> =>
    send(ctx, {
      op: "getDashboard",
      params: { dashboardId: id },
      nullOn404: true,
    }),
  update: (id: string, body: UpdateDashboardRequest): Promise<Dashboard> =>
    send(ctx, {
      op: "updateDashboard",
      params: { dashboardId: id },
      body,
      once: true,
    }),
  delete: async (id: string): Promise<void> => {
    await send(ctx, {
      op: "deleteDashboard",
      params: { dashboardId: id },
      once: false,
    });
  },
  copy: (id: string, body: CopyDashboardRequest): Promise<Dashboard> =>
    send(ctx, {
      op: "copyDashboard",
      params: { dashboardId: id },
      body,
      once: true,
    }),
  listShares: (id: string): Promise<DashboardShares> =>
    send(ctx, { op: "listDashboardShares", params: { dashboardId: id } }),
  // Never repeated: a second PUT would find the shares already made.
  replaceShares: (
    id: string,
    principals: SharePrincipal[]
  ): Promise<DashboardShares> =>
    send(ctx, {
      op: "replaceDashboardShares",
      params: { dashboardId: id },
      body: { principals },
      once: true,
    }),
  transfer: (id: string, body: TransferOwnerRequest): Promise<Dashboard> =>
    send(ctx, {
      op: "transferDashboard",
      params: { dashboardId: id },
      body,
      once: true,
    }),
  addPanel: (id: string, panel: PanelInput): Promise<Panel> =>
    send(ctx, {
      op: "addDashboardPanel",
      params: { dashboardId: id },
      body: panel,
      once: true,
    }),
  updatePanel: (
    id: string,
    panelId: string,
    body: UpdatePanelRequest
  ): Promise<Panel> =>
    send(ctx, {
      op: "updateDashboardPanel",
      params: { dashboardId: id, panelId },
      body,
      once: true,
    }),
  removePanel: async (id: string, panelId: string): Promise<void> => {
    await send(ctx, {
      op: "removeDashboardPanel",
      params: { dashboardId: id, panelId },
      once: false,
    });
  },
  /** Turns a linked panel into an own panel with the saved panel's settings. */
  detachPanel: (id: string, panelId: string): Promise<Panel> =>
    send(ctx, {
      op: "detachDashboardPanel",
      params: { dashboardId: id, panelId },
      once: true,
    }),
  /** Makes a saved panel of the caller's own from an own panel. */
  savePanel: (
    id: string,
    panelId: string,
    body: SaveAsSavedPanelRequest
  ): Promise<SavedPanel> =>
    send(ctx, {
      op: "saveDashboardPanel",
      params: { dashboardId: id, panelId },
      body,
      once: true,
    }),
  /**
   * Runs the dashboard's panels and yields a `PanelLine` per panel as it is
   * ready (not in the dashboard's order), until its `{ done: true }` line.
   * Never repeated after a failure: a run is long, and zeteo records each one.
   */
  run: (id: string, options?: RunDashboardOptions): AsyncIterable<PanelLine> =>
    runLines(ctx, id, options),
});
