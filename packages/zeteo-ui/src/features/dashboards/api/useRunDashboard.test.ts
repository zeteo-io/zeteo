import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRunDashboard } from "./useRunDashboard";
import {
  DASHBOARD_ID,
  PANEL_A,
  PANEL_B,
  controlledStream,
  makeResult,
  okLine,
  streamOf,
} from "../testFixtures";

const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { post } })
);

describe("useRunDashboard", () => {
  beforeEach(() => post.mockReset());

  it("asks for the run as a stream, with only what was given", async () => {
    post.mockResolvedValue({ data: streamOf([]) });
    const { result } = renderHook(() => useRunDashboard(DASHBOARD_ID));
    await act(() => result.current.run({ timeRange: "last_7_days" }));
    expect(post).toHaveBeenCalledWith(
      `/v1/dashboards/${DASHBOARD_ID}/run`,
      { time_range: "last_7_days" },
      expect.objectContaining({ adapter: "fetch", responseType: "stream" })
    );
    await act(() => result.current.run({ panels: [PANEL_A] }));
    expect(post).toHaveBeenLastCalledWith(
      `/v1/dashboards/${DASHBOARD_ID}/run`,
      { panels: [PANEL_A] },
      expect.anything()
    );
  });

  it("updates each panel as its line arrives, even a line split across chunks", async () => {
    const body = controlledStream();
    post.mockResolvedValue({ data: body.stream });
    const { result } = renderHook(() => useRunDashboard(DASHBOARD_ID));
    let done!: Promise<void>;
    act(() => {
      done = result.current.run();
    });
    const a = JSON.stringify(okLine(PANEL_A));
    const b = JSON.stringify({
      panel_id: PANEL_B,
      state: "not_accessible",
      message: "No",
    });
    act(() => body.push(`${a}\n${b.slice(0, 10)}`));
    await waitFor(() =>
      expect(result.current.panels[PANEL_A]?.result).toEqual(makeResult())
    );
    expect(result.current.panels[PANEL_A]?.updatedAt).toBeDefined();
    expect(result.current.panels[PANEL_B]?.state).toBeUndefined();
    expect(result.current.running).toBe(true);

    act(() => {
      body.push(`${b.slice(10)}\n{"done":true}\n`);
      body.close();
    });
    await act(() => done);
    expect(result.current.panels[PANEL_B]?.state).toBe("not_accessible");
    expect(result.current.panels[PANEL_A]?.state).toBe("ok");
    expect(result.current.running).toBe(false);
  });

  it("keeps a panel's last result and marks it stale when its refresh fails", async () => {
    post.mockResolvedValueOnce({ data: streamOf([okLine(PANEL_A)]) });
    const { result } = renderHook(() => useRunDashboard(DASHBOARD_ID));
    await act(() => result.current.run());
    expect(result.current.panels[PANEL_A]?.staleSince).toBeUndefined();

    post.mockResolvedValueOnce({
      data: streamOf([
        {
          panel_id: PANEL_A,
          state: "ok",
          error: { error: "source_busy", error_description: "Busy" },
        },
      ]),
    });
    await act(() => result.current.run({ panels: [PANEL_A] }));
    const panel = result.current.panels[PANEL_A]!;
    expect(panel.result).toEqual(makeResult());
    expect(panel.staleSince).toBeDefined();
    expect(panel.error?.error_description).toBe("Busy");

    // A good run clears it.
    post.mockResolvedValueOnce({ data: streamOf([okLine(PANEL_A)]) });
    await act(() => result.current.run({ panels: [PANEL_A] }));
    expect(result.current.panels[PANEL_A]?.staleSince).toBeUndefined();
    expect(result.current.panels[PANEL_A]?.error).toBeUndefined();
  });

  it("marks the panels stale when the whole request fails", async () => {
    post.mockResolvedValueOnce({ data: streamOf([okLine(PANEL_A)]) });
    const { result } = renderHook(() => useRunDashboard(DASHBOARD_ID));
    await act(() => result.current.run());
    post.mockRejectedValueOnce({
      status: null,
      code: "network",
      message: "zeteo could not be reached",
    });
    await act(() => result.current.run());
    expect(result.current.panels[PANEL_A]?.result).toEqual(makeResult());
    expect(result.current.panels[PANEL_A]?.staleSince).toBeDefined();
    expect(result.current.error?.code).toBe("network");
  });

  it("treats a stream that ends without its done line as failed", async () => {
    post.mockResolvedValueOnce({ data: streamOf([okLine(PANEL_A)]) });
    const { result } = renderHook(() => useRunDashboard(DASHBOARD_ID));
    await act(() => result.current.run());
    const cut = controlledStream();
    cut.close();
    post.mockResolvedValueOnce({ data: cut.stream });
    await act(() => result.current.run());
    expect(result.current.panels[PANEL_A]?.staleSince).toBeDefined();
  });

  it("marks the dashboard's panels failed when its first run fails before any line", async () => {
    post.mockRejectedValueOnce({
      status: 500,
      code: "internal",
      message: "Something went wrong",
    });
    const { result } = renderHook(() =>
      useRunDashboard(DASHBOARD_ID, [PANEL_A])
    );
    await act(() => result.current.run());
    expect(result.current.panels[PANEL_A]).toMatchObject({
      loading: false,
      error: { error: "internal", error_description: "Something went wrong" },
    });
    expect(result.current.panels[PANEL_A]?.staleSince).toBeUndefined();
  });
});
