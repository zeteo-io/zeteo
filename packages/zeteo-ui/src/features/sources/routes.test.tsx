import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_ID } from "./testFixtures";
import { sourceRoutes } from "./routes";

vi.mock("@/lib/api/client", async () => {
  const { makeSource } = await import("./testFixtures");
  return {
    api: { get: vi.fn(async () => ({ data: makeSource() })), post: vi.fn() },
  };
});
vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuth({
    permissions: ["zeteo.sources.read"],
  })
);

describe("source routes without zeteo.sources.write", () => {
  it.each(["/sources/new", `/sources/${SOURCE_ID}/edit`])(
    "show the no-access page at %s",
    async (path) => {
      const router = createMemoryRouter(sourceRoutes, {
        initialEntries: [path],
      });
      render(
        <QueryClientProvider client={new QueryClient()}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      );
      expect(await screen.findByText("No access")).toBeInTheDocument();
      expect(screen.getByText(/zeteo\.sources\.write/)).toBeInTheDocument();
    }
  );
});
