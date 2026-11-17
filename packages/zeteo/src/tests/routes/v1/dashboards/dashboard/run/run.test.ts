// @module-tag int
// @module-tag platform
import { clearDashboardKeys } from "../../../../../support/dashboardRuns.js";
import type { SourceConnection } from "../../../../../../adapters/types.js";
import { closeAllSourcePools } from "../../../../../../sources/pools.js";
import { removeSources } from "../../../../../support/sources.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { TABLE } from "../../../../../support/dashboards.js";
import { ENGINES } from "../../../../../support/engines.js";
import type { IncomingMessage } from "node:http";
import {
  dashboardWith,
  removeDashboardsOf,
  savedQueryRow,
} from "../../../../../support/panelDecisions.js";
import {
  SavedQueryNotAccessibleError,
  SourceUnreachableError,
} from "../../../../../../utils/errors.js";
import {
  eventually,
  ndjsonLines,
  openExport,
  postExport,
} from "../../../../../support/exports.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Counts the runs that reach a source: the routes run in this process.
const opened = vi.hoisted(() => ({ count: 0 }));

vi.mock(
  import("../../../../../../sources/pools.js"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      withSourceConnection: <T>(
        id: string,
        fn: (conn: SourceConnection) => Promise<T>
      ) => {
        opened.count += 1;
        return actual.withSourceConnection(id, fn);
      },
    };
  }
);

// A run-time failure of every panel's run, when set: what changed between
// the decision and the run.
const failing = vi.hoisted(() => ({ err: undefined as Error | undefined }));

vi.mock(import("../../../../../../engine/index.js"), async (importOriginal) => {
  const actual = await importOriginal();
  const runQuery = ((input: Parameters<typeof actual.runQuery>[0]) =>
    failing.err
      ? Promise.reject(failing.err)
      : actual.runQuery(input as never)) as typeof actual.runQuery;
  return { ...actual, runQuery };
});

interface PanelLine {
  panel_id: string;
  state: string;
  message?: string;
  result?: {
    columns: { name: string; type: string }[];
    rows: unknown[][];
    truncated: boolean;
    truncated_by?: string;
    notice?: string;
  };
  cached_at?: string;
  error?: { error: string; error_description: string };
}

const NOTICE =
  "Showing the first 5,000 rows; aggregate the saved query to see everything.";

describe("POST /v1/dashboards/:dashboardId/run", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const owner = newQueryUser();

  /** The run's lines: each panel's, then `{ done: true }` last. */
  const run = async (dashboardId: string, body: unknown = {}) => {
    const res = await postExport({
      token: owner.token,
      body,
      baseUrl: app.url,
      path: `/v1/dashboards/${dashboardId}/run`,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson");
    expect(res.headers["cache-control"]).toBe("no-store");
    const lines = ndjsonLines(res.text);
    expect(lines.at(-1)).toEqual({ done: true });
    return lines.slice(0, -1) as PanelLine[];
  };
  const byPanel = (lines: PanelLine[]) =>
    new Map(lines.map((l) => [l.panel_id, l]));

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(
      ENGINES[0]!,
      { schemas: ["sales", "probe"] },
      "dashrun"
    );
    for (const table of [
      "orders",
      "customers",
      "typed_values",
      "wide_rows",
      "trickle",
    ]) {
      await grantTo(owner.principal, source.tables[table]!, "all");
    }
  });
  afterEach(async () => {
    await clearDashboardKeys();
    opened.count = 0;
    failing.err = undefined;
  });
  afterAll(async () => {
    await removeRunsOf([owner.id]);
    await removeDashboardsOf([owner.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await app.close();
  });

  /** Four panels: two the same, one with a time column, one over 5,000 rows. */
  const fourPanels = async () => {
    const orders = await savedQueryRow(owner.id, source, {
      from: "orders",
      select: ["id", "status"],
      orderBy: [{ id: "asc" }],
    });
    const wide = await savedQueryRow(owner.id, source, {
      from: "wide_rows",
      select: ["id"],
      orderBy: [{ id: "asc" }],
      limit: 10_000,
    });
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: orders.id, chart: TABLE },
      { kind: "own", savedQueryId: orders.id, chart: TABLE },
      {
        kind: "own",
        savedQueryId: orders.id,
        chart: TABLE,
        timeColumn: "created_at",
      },
      { kind: "own", savedQueryId: wide.id, chart: TABLE },
    ]);
    const [same1, same2, timed, big] = dash.panels.map((p) => p.id);
    return { dash, same1: same1!, same2: same2!, timed: timed!, big: big! };
  };

  it("streams a line per panel then done, running identical panels once", async () => {
    const { dash, same1, same2, timed, big } = await fourPanels();
    const lines = await run(dash.id);
    expect(lines).toHaveLength(4);
    const seen = byPanel(lines);
    expect([...seen.keys()].sort()).toEqual([same1, same2, timed, big].sort());
    for (const line of lines) {
      expect(line.state).toBe("ok");
      expect(line).not.toHaveProperty("error");
      // Never the chart or the query.
      expect(line).not.toHaveProperty("chart");
      expect(JSON.stringify(line)).not.toContain(source.slug);
    }
    expect(seen.get(same1)!.result).toEqual(seen.get(same2)!.result);
    expect(seen.get(same1)!.result!.rows).toHaveLength(12);
    // No time range: the timed panel is not narrowed.
    expect(seen.get(timed)!.result!.rows).toHaveLength(12);
    // With no range, the timed panel's query is theirs too: two distinct
    // queries, the three panels on the saved query run once.
    expect(seen.get(timed)!.result).toEqual(seen.get(same1)!.result);
    expect(opened.count).toBe(2);
  });

  it("shows a panel over 5,000 rows truncated, with the notice", async () => {
    const { dash, big } = await fourPanels();
    const line = byPanel(await run(dash.id)).get(big)!;
    expect(line.result).toMatchObject({
      truncated: true,
      truncated_by: "rows",
      notice: NOTICE,
    });
    expect(line.result!.rows).toHaveLength(5000);
  });

  it("gives no notice when the saved query limited itself", async () => {
    const limited = await savedQueryRow(owner.id, source, {
      from: "orders",
      select: ["id"],
      orderBy: [{ id: "asc" }],
      limit: 2,
    });
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: limited.id, chart: TABLE },
    ]);
    const line = byPanel(await run(dash.id)).get(dash.panels[0]!.id)!;
    expect(line.result!.rows).toHaveLength(2);
    expect(line.result).not.toHaveProperty("notice");
  });

  it("runs only the panels named", async () => {
    const { dash, timed } = await fourPanels();
    const lines = await run(dash.id, { panels: [timed] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ panel_id: timed, state: "ok" });
    expect(opened.count).toBe(1);
  });

  it("gzips the stream when the client accepts it", async () => {
    const { dash, same1 } = await fourPanels();
    const res = await postExport({
      token: owner.token,
      body: { panels: [same1] },
      acceptEncoding: "gzip",
      baseUrl: app.url,
      path: `/v1/dashboards/${dash.id}/run`,
    });
    expect(res.headers["content-encoding"]).toBe("gzip");
    const lines = ndjsonLines(res.text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ panel_id: same1, state: "ok" });
    expect(lines[1]).toEqual({ done: true });
  });

  it("narrows a panel with a time column to the time range, and leaves one without unchanged", async () => {
    const { dash, same1, timed } = await fourPanels();
    // The fixture's orders are from January to June 2026.
    const narrowed = byPanel(
      await run(dash.id, { panels: [same1, timed], time_range: "last_7_days" })
    );
    expect(narrowed.get(timed)!.result!.rows).toHaveLength(0);
    expect(narrowed.get(same1)!.result!.rows).toHaveLength(12);
    await clearDashboardKeys();
    const wide = byPanel(
      await run(dash.id, { panels: [timed], time_range: "last_2_years" })
    );
    expect(wide.get(timed)!.result!.rows).toHaveLength(12);
  });

  it("uses the dashboard's own time range when none is given, and none for null", async () => {
    const { dash, timed } = await fourPanels();
    await prisma.dashboard.update({
      where: { id: dash.id },
      data: { timeRange: "last_7_days" },
    });
    const byDefault = await run(dash.id, { panels: [timed] });
    expect(byDefault[0]!.result!.rows).toHaveLength(0);
    const none = await run(dash.id, { panels: [timed], time_range: null });
    expect(none[0]!.result!.rows).toHaveLength(12);
  });

  it("runs two panels on one saved query with different time columns apart", async () => {
    const typed = await savedQueryRow(owner.id, source, {
      from: "typed_values",
      select: ["id"],
      orderBy: [{ id: "asc" }],
    });
    const dash = await dashboardWith(owner.id, [
      {
        kind: "own",
        savedQueryId: typed.id,
        chart: TABLE,
        timeColumn: "day",
      },
      {
        kind: "own",
        savedQueryId: typed.id,
        chart: TABLE,
        timeColumn: "aware",
      },
    ]);
    const lines = await run(dash.id, { time_range: "last_2_years" });
    expect(lines.map((l) => l.state)).toEqual(["ok", "ok"]);
    expect(opened.count).toBe(2);
  });

  it("serves a second run of the same panels from the cache, with cached_at", async () => {
    const { dash, same1 } = await fourPanels();
    await run(dash.id, { panels: [same1] });
    const [again] = await run(dash.id, { panels: [same1] });
    expect(again!.cached_at).toEqual(expect.any(String));
    expect(opened.count).toBe(1);
  });

  it("shows a refusal at run time as not accessible, like a refusal at the decision", async () => {
    const { dash, same1 } = await fourPanels();
    failing.err = new SavedQueryNotAccessibleError();
    const lines = await run(dash.id, { panels: [same1] });
    expect(lines).toEqual([
      {
        panel_id: same1,
        state: "not_accessible",
        message: new SavedQueryNotAccessibleError().message,
      },
    ]);
  });

  it("shows another failure at run time as the panel's error, with no result", async () => {
    const { dash, same1, same2 } = await fourPanels();
    failing.err = new SourceUnreachableError();
    const lines = await run(dash.id, { panels: [same1, same2] });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toEqual({
        panel_id: line.panel_id,
        state: "ok",
        error: {
          error: "source_unreachable",
          error_description:
            "The source could not be reached or refused the login",
        },
      });
    }
  });

  it("stops the panels' queries on the source when the client goes away", async () => {
    const trickle = await savedQueryRow(owner.id, source, {
      from: "trickle",
      select: ["id", "filler"],
      orderBy: [{ id: "asc" }],
    });
    const dash = await dashboardWith(owner.id, [
      { kind: "own", savedQueryId: trickle.id, chart: TABLE },
    ]);
    const res: IncomingMessage = await openExport({
      token: owner.token,
      body: {},
      baseUrl: app.url,
      path: `/v1/dashboards/${dash.id}/run`,
    });
    expect(res.statusCode).toBe(200);
    await eventually(async () =>
      (await ENGINES[0]!.runningOn("trickle")) > 0 ? true : undefined
    );
    res.on("error", () => undefined);
    res.socket.destroy();
    await eventually(async () =>
      (await ENGINES[0]!.runningOn("trickle")) === 0 ? true : undefined
    );
    const run = await eventually(async () =>
      (await runsOf([owner.id])).find(
        (r) => r.dashboardId === dash.id && r.savedQueryId === trickle.id
      )
    );
    expect(run).toMatchObject({
      entryPoint: "dashboard",
      outcome: "failed",
      errorCode: "client_closed",
    });
  }, 30_000);
});
