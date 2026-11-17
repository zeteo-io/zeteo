import type { Dashboard, Panel, PanelLine, PanelResult } from "./api/types";
import { TEST_ME } from "@/test/authMock";

export const DASHBOARD_ID = "a1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const PANEL_A = "b1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const PANEL_B = "b2222222-1c7a-4a53-9d0e-6a3b1f2c4d01";
export const QUERY_ID = "c1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";

export const makePanel = (over: Partial<Panel> = {}): Panel => ({
  id: PANEL_A,
  kind: "own",
  x: 0,
  y: 0,
  w: 6,
  h: 4,
  title: "Revenue",
  state: "ok",
  chart: { type: "table", version: 1 },
  saved_query_id: QUERY_ID,
  ...over,
});

/** Owned by the signed-in test user unless `owner` says otherwise. */
export const makeDashboard = (over: Partial<Dashboard> = {}): Dashboard => ({
  id: DASHBOARD_ID,
  name: "Sales",
  description: "How sales are going",
  owner: { id: TEST_ME.id, name: "Test Admin" },
  time_range: "last_30_days",
  refresh_seconds: null,
  theme: "auto",
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-02T10:00:00.000Z",
  share_count: 0,
  panels: [makePanel()],
  ...over,
});

export const makeResult = (over: Partial<PanelResult> = {}): PanelResult => ({
  columns: [
    { name: "region", type: "text" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["north", 10],
    ["south", 20],
  ],
  truncated: false,
  ...over,
});

export const okLine = (
  panelId: string,
  result: PanelResult = makeResult()
): PanelLine => ({ panel_id: panelId, state: "ok", result });

/** A response body that sends `chunks` (text) as they are pushed, until closed. */
export const controlledStream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (err: unknown) => controller.error(err),
  };
};

/** A whole NDJSON body of `lines`, then the done line. */
export const streamOf = (lines: PanelLine[]) => {
  const s = controlledStream();
  for (const line of lines) s.push(`${JSON.stringify(line)}\n`);
  s.push(`${JSON.stringify({ done: true })}\n`);
  s.close();
  return s.stream;
};
