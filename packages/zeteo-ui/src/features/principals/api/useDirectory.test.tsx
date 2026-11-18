import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useDirectory } from "./useDirectory";
import type { ReactNode } from "react";

const get = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get } })
);

const directory = {
  data: [{ type: "user", id: "u1", name: "Ada", status: "active" }],
  truncated: false,
};

const makeWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

describe("useDirectory", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ data: directory });
  });

  it.each([
    ["admin", "/v1/principals/all"],
    ["mine", "/v1/me/principals/all"],
  ] as const)("loads the %s directory from %s", async (scope, path) => {
    const { result } = renderHook(() => useDirectory(scope), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toEqual(directory));
    expect(get).toHaveBeenCalledWith(path, expect.anything());
  });

  it("loads once for every component that asks within five minutes", async () => {
    const wrapper = makeWrapper();
    const first = renderHook(() => useDirectory("admin"), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    const second = renderHook(() => useDirectory("admin"), { wrapper });
    expect(second.result.current.data).toEqual(directory);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when not enabled", async () => {
    const { result } = renderHook(() => useDirectory("admin", false), {
      wrapper: makeWrapper(),
    });
    expect(result.current.isLoading).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("gives the API's error as an ApiError", async () => {
    get.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useDirectory("admin"), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ code: "unknown" });
  });
});
