import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrincipalRef } from "../api/usePrincipalNames";
import { PrincipalLabel } from "./PrincipalLabel";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api/errors")>(
    "@/lib/api/errors"
  )),
  api: { post },
}));

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const refsOf = (n: number): PrincipalRef[] =>
  Array.from({ length: n }, (_, i) => ({ type: "user", id: uuid(i) }));

const renderRows = (refs: PrincipalRef[]) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {refs.map((ref, i) => (
        <PrincipalLabel key={i} refValue={ref} />
      ))}
    </QueryClientProvider>
  );

const requested = () =>
  post.mock.calls.map((c) => c[1].principals as PrincipalRef[]);

describe("PrincipalLabel batching", () => {
  beforeEach(() => {
    post.mockReset().mockImplementation(async (_url, body) => ({
      data: {
        data: (body as { principals: PrincipalRef[] }).principals.map((p) => ({
          ...p,
          name: `name-${p.id.slice(-3)}`,
          status: "active",
        })),
      },
    }));
  });

  it("looks up 50 labels in one request", async () => {
    renderRows(refsOf(50));
    await waitFor(() =>
      expect(screen.getByText("name-049")).toBeInTheDocument()
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(requested()[0]).toHaveLength(50);
  });

  it("looks up 150 distinct labels in two requests", async () => {
    renderRows(refsOf(150));
    await waitFor(() =>
      expect(screen.getByText("name-149")).toBeInTheDocument()
    );
    expect(
      requested()
        .map((r) => r.length)
        .sort((a, b) => a - b)
    ).toEqual([50, 100]);
  });

  it("asks once for a principal shown in ten rows", async () => {
    renderRows(Array.from({ length: 10 }, () => refsOf(1)[0]));
    await waitFor(() =>
      expect(screen.getAllByText("name-000")).toHaveLength(10)
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(requested()[0]).toHaveLength(1);
  });

  it("marks only the refs of a failed chunk unavailable", async () => {
    post.mockReset().mockImplementation(async (_url, body) => {
      const principals = (body as { principals: PrincipalRef[] }).principals;
      if (principals.length === 50) {
        throw { status: 502, code: "tereo_unreachable", message: "down" };
      }
      return {
        data: {
          data: principals.map((p) => ({
            ...p,
            name: "known",
            status: "active",
          })),
        },
      };
    });
    renderRows(refsOf(150));
    await waitFor(() =>
      expect(screen.getAllByText(/name unavailable/i)).toHaveLength(50)
    );
    expect(screen.getAllByText("known")).toHaveLength(100);
  });
});
