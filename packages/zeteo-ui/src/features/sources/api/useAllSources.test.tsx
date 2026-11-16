import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { makeSource } from "@/features/sources/testFixtures";
import { useAllSources } from "./useAllSources";
import type { ReactNode } from "react";
import { AxiosError } from "axios";

const get = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get } })
);

const makeWrapper = () => {
  const client = new QueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};
const failure = (status: number) =>
  new AxiosError("x", "ERR_BAD_RESPONSE", undefined, undefined, {
    status,
    statusText: "x",
    headers: {},
    config: {} as never,
    data: { error: "failed", error_description: "failed" },
  });
const page = (slug: string, next: string | null) => ({
  data: { data: [makeSource({ slug })], next_cursor: next },
});

describe("useAllSources", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("reads every page, archived sources included, 100 at a time", async () => {
    get
      .mockResolvedValueOnce(page("one", "c1"))
      .mockResolvedValueOnce(page("two", null));
    const { result } = renderHook(() => useAllSources(true), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.sources).toHaveLength(2));
    expect(get.mock.calls).toHaveLength(2);
    expect(get.mock.calls[0][1].params).toMatchObject({
      limit: 100,
      include_archived: true,
    });
    expect(get.mock.calls[1][1].params.cursor).toBe("c1");
    expect(get.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("fails once, with two requests in all, when page two fails", async () => {
    get
      .mockResolvedValueOnce(page("one", "c1"))
      .mockImplementation(async () => {
        throw failure(503);
      });
    const { result, rerender } = renderHook(() => useAllSources(true), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => {
      if (result.current.error?.status !== 503) throw new Error("not yet");
    });
    rerender();
    rerender();
    expect(result.current.isLoading).toBe(false);
    expect(get.mock.calls).toHaveLength(2);
  });

  it("reports a 403 on page one and stops", async () => {
    get.mockImplementation(async () => {
      throw failure(403);
    });
    const { result, rerender } = renderHook(() => useAllSources(true), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => {
      if (result.current.error?.status !== 403) throw new Error("not yet");
    });
    rerender();
    await new Promise((r) => setTimeout(r, 50));
    expect(get.mock.calls).toHaveLength(1);
  });

  it("asks for nothing when switched off", () => {
    renderHook(() => useAllSources(false), { wrapper: makeWrapper() });
    expect(get).not.toHaveBeenCalled();
  });
});
