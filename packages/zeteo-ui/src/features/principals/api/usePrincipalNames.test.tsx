import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePrincipalNames } from "./usePrincipalNames";
import type { PrincipalRef } from "./usePrincipalNames";
import type { ReactNode } from "react";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api/errors")>(
    "@/lib/api/errors"
  )),
  api: { post },
}));

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const makeWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

describe("usePrincipalNames", () => {
  beforeEach(() => {
    post.mockReset().mockImplementation(async (_url, body) => ({
      data: {
        data: (body as { principals: PrincipalRef[] }).principals.map((p) => ({
          ...p,
          name: `name-${p.id}`,
          status: "active",
        })),
      },
    }));
  });

  it("looks up 150 refs with duplicates in two requests of at most 100 distinct refs", async () => {
    const refs: PrincipalRef[] = [];
    for (let i = 0; i < 120; i++) refs.push({ type: "user", id: uuid(i) });
    for (let i = 0; i < 30; i++) refs.push({ type: "user", id: uuid(i) });

    const { result } = renderHook(() => usePrincipalNames(refs), {
      wrapper: makeWrapper(),
    });

    await waitFor(() =>
      expect(result.current.get({ type: "user", id: uuid(119) })).toBeDefined()
    );
    expect(post).toHaveBeenCalledTimes(2);
    const sizes = post.mock.calls.map((c) => c[1].principals.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(120);
    expect(result.current.get({ type: "user", id: uuid(3) })?.name).toBe(
      `name-${uuid(3)}`
    );
    expect(result.current.unavailable).toBe(false);
  });

  it("does not ask again for refs already known when the list changes", async () => {
    const first = [{ type: "user", id: uuid(1) }] as PrincipalRef[];
    const both = [...first, { type: "group", id: uuid(2) }] as PrincipalRef[];
    const { result, rerender } = renderHook(
      ({ refs }) => usePrincipalNames(refs),
      { wrapper: makeWrapper(), initialProps: { refs: first } }
    );
    await waitFor(() => expect(result.current.get(first[0])).toBeDefined());
    rerender({ refs: both });
    await waitFor(() => expect(result.current.get(both[1])).toBeDefined());
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1].principals).toEqual([both[1]]);
  });

  it("sets unavailable on a 502 tereo_unreachable", async () => {
    post.mockReset().mockRejectedValue({
      status: 502,
      code: "tereo_unreachable",
      message: "down",
    });
    const refs: PrincipalRef[] = [{ type: "user", id: uuid(1) }];
    const { result } = renderHook(() => usePrincipalNames(refs), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.get(refs[0])).toBeUndefined();
  });
});
