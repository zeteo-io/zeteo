import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MAX_PAGES, useAllRelations } from "./useAllRelations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { makeRelation } from "../testFixtures";
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

const page = (n: number, next: string | null) => ({
  data: {
    data: [makeRelation({ id: `r${n}`, name: `r${n}` })],
    next_cursor: next,
  },
});

describe("useAllRelations", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("reads every page, 100 at a time, following the cursor", async () => {
    get
      .mockResolvedValueOnce(page(1, "c1"))
      .mockResolvedValueOnce(page(2, null));
    const { result } = renderHook(() => useAllRelations("s1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.relations).toHaveLength(2));
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toBe("/v1/sources/s1/relations");
    expect(get.mock.calls[0][1].params).toEqual({ limit: 100 });
    expect(get.mock.calls[1][1].params).toEqual({ limit: 100, cursor: "c1" });
    expect(result.current.relations.map((r) => r.name)).toEqual(["r1", "r2"]);
  });

  it("fails once with the API's description, without retrying", async () => {
    get.mockImplementation(async () => {
      throw new AxiosError("x", "ERR_BAD_RESPONSE", undefined, undefined, {
        status: 503,
        statusText: "x",
        headers: {},
        config: {} as never,
        data: { error: "unavailable", error_description: "Down" },
      });
    });
    const { result } = renderHook(() => useAllRelations("s1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.error?.message).toBe("Down"));
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.relations).toEqual([]);
  });

  it("stops at the page cap with an error", async () => {
    get.mockImplementation(async () => page(1, "more"));
    const { result } = renderHook(() => useAllRelations("s1"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() =>
      expect(result.current.error?.code).toBe("too_many_relations")
    );
    expect(get).toHaveBeenCalledTimes(MAX_PAGES);
  });
});
