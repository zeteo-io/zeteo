import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { MAX_PAGES, useAllTables } from "./useAllTables";
import { AxiosError, CanceledError } from "axios";
import { makeTable } from "../testFixtures";
import type { ReactNode } from "react";

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

const page = (n: number, next: string | null) => ({
  data: {
    data: [makeTable({ id: `t${n}`, name: `t${n}` })],
    next_cursor: next,
  },
});

describe("useAllTables", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("reads every page, 100 at a time, with one request each", async () => {
    get
      .mockResolvedValueOnce(page(1, "c1"))
      .mockResolvedValueOnce(page(2, "c2"))
      .mockResolvedValueOnce(page(3, null));
    const { result } = renderHook(() => useAllTables("s1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.tables).toHaveLength(3));
    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls[0][1].params).toEqual({
      limit: 100,
      include_missing: true,
    });
    expect(get.mock.calls[1][1].params.cursor).toBe("c1");
    expect(result.current.labelFor("t2")).toBe("public.t2");
    expect(result.current.labelFor("other")).toBe("other");
  });

  it("fails once when a later page fails, without refetching", async () => {
    get.mockResolvedValueOnce(page(1, "c1")).mockImplementation(async () => {
      throw new AxiosError("x", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 503,
        statusText: "x",
        headers: {},
        config: {} as never,
        data: { error: "unavailable", error_description: "Down" },
      });
    });
    const { result, rerender } = renderHook(() => useAllTables("s1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.error?.message).toBe("Down"));
    rerender();
    rerender();
    await new Promise((r) => setTimeout(r, 50));
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.current.isLoading).toBe(false);
  });

  it("stops at the page cap with an error", async () => {
    get.mockImplementation(async () => page(1, "more"));
    const { result } = renderHook(() => useAllTables("s1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() =>
      expect(result.current.error?.code).toBe("too_many_tables")
    );
    expect(get).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it("stops reading pages once unmounted", async () => {
    // Like axios: an aborted signal sends nothing.
    const sent: { signal?: AbortSignal }[] = [];
    let answer!: (value: unknown) => void;
    get.mockImplementation((_url: string, config: { signal?: AbortSignal }) => {
      if (config.signal?.aborted) return Promise.reject(new CanceledError());
      sent.push(config);
      return sent.length === 1
        ? new Promise((r) => (answer = r))
        : Promise.resolve(page(sent.length, "more"));
    });
    const { unmount } = renderHook(() => useAllTables("s1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(sent).toHaveLength(1));

    unmount();
    expect(sent[0].signal?.aborted).toBe(true);
    answer(page(1, "c1"));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });
});
