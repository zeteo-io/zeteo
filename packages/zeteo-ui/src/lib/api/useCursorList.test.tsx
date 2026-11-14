import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import { useCursorList } from "./useCursorList";
import type { ReactNode } from "react";

const get = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ api: { get } }));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

describe("useCursorList", () => {
  beforeEach(() => {
    get.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it("follows next_cursor on loadMore and stops at null", async () => {
    get
      .mockResolvedValueOnce({ data: { data: [{ id: 1 }], next_cursor: "c2" } })
      .mockResolvedValueOnce({
        data: { data: [{ id: 2 }], next_cursor: null },
      });
    const { result } = renderHook(
      () => useCursorList<{ id: number }>(["sources"], "/v1/sources"),
      { wrapper }
    );

    await waitFor(() => expect(result.current.items).toEqual([{ id: 1 }]));
    expect(result.current.hasMore).toBe(true);
    expect(get.mock.calls[0][1].params).toEqual({ limit: 50 });

    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(result.current.items).toEqual([{ id: 1 }, { id: 2 }])
    );
    expect(get.mock.calls[1][1].params).toEqual({ limit: 50, cursor: "c2" });
    expect(result.current.hasMore).toBe(false);
  });

  it("drops a row repeated on a later page and keeps items stable", async () => {
    get
      .mockResolvedValueOnce({
        data: { data: [{ id: "a" }, { id: "b" }], next_cursor: "c2" },
      })
      .mockResolvedValueOnce({
        data: { data: [{ id: "b" }, { id: "c" }], next_cursor: null },
      });
    const { result, rerender } = renderHook(
      () => useCursorList<{ id: string }>(["dup"], "/v1/dup"),
      { wrapper }
    );
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    const before = result.current.items;
    rerender();
    expect(result.current.items).toBe(before);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("passes filters and drops undefined params", async () => {
    get.mockResolvedValue({ data: { data: [], next_cursor: null } });
    renderHook(
      () =>
        useCursorList(["runs"], "/v1/runs", {
          status: "failed",
          archived: true,
          source: undefined,
        }),
      { wrapper }
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls[0][1].params).toEqual({
      status: "failed",
      archived: true,
      limit: 50,
    });
  });

  it("reports an ApiError", async () => {
    const failure = new AxiosError("x", "ERR_BAD_REQUEST", undefined, null, {
      status: 403,
      statusText: "",
      data: { error: "forbidden", error_description: "No" },
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
    get.mockImplementation(async () => {
      throw failure;
    });
    const { result } = renderHook(() => useCursorList(["x"], "/v1/x"), {
      wrapper,
    });
    await waitFor(() => expect(result.current.error?.code).toBe("forbidden"));
  });

  it("does not fetch while disabled", () => {
    renderHook(
      () => useCursorList(["x"], "/v1/x", undefined, { enabled: false }),
      { wrapper }
    );
    expect(get).not.toHaveBeenCalled();
  });
});
