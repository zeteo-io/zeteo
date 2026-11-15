import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeSource, SOURCE_ID } from "./testFixtures";
import { sourceRoutes } from "./routes";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ api: { get, post: vi.fn() } }));
vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuth({
    permissions: ["zeteo.sources.read"],
  })
);

const renderAt = (path: string) => {
  const router = createMemoryRouter(sourceRoutes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
};

beforeEach(() => {
  get.mockReset().mockImplementation(async () => ({ data: makeSource() }));
});

describe("source routes with an id that is not a UUID", () => {
  it.each([
    "/sources/not-a-uuid",
    "/sources/not-a-uuid/tables",
    `/sources/${SOURCE_ID}/tables/x%3Fy`,
  ])("show not found at %s, asking zeteo nothing", async (path) => {
    renderAt(path);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("loads a source named by an upper-case UUID by its lower-case id", async () => {
    renderAt(`/sources/${SOURCE_ID.toUpperCase()}`);
    expect(
      await screen.findByRole("heading", { name: makeSource().name })
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/v1/sources/${SOURCE_ID}`);
  });
});

describe("source routes without zeteo.sources.write", () => {
  it.each(["/sources/new", `/sources/${SOURCE_ID}/edit`])(
    "show the no-access page at %s",
    async (path) => {
      renderAt(path);
      expect(await screen.findByText("No access")).toBeInTheDocument();
      expect(screen.getByText(/zeteo\.sources\.write/)).toBeInTheDocument();
    }
  );
});
