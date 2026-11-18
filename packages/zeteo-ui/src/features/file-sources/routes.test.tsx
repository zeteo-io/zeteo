import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FS_ID, makeFileSource } from "./testFixtures";
import { TEST_UI_CONFIG } from "@/test/uiConfig";
import { fileSourceRoutes } from "./routes";

const get = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  permissions: ["zeteo.data.read", "zeteo.file_sources.write"],
  fileSources: true,
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => state.permissions,
    api: { get },
  })
);
vi.mock("@/lib/config", async () => ({
  ...(await vi.importActual<typeof import("@/lib/config")>("@/lib/config")),
  loadConfig: async () => ({
    ...TEST_UI_CONFIG,
    fileSources: state.fileSources,
  }),
}));

const renderAt = (path: string) => {
  const router = createMemoryRouter(fileSourceRoutes, {
    initialEntries: [path],
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
};

beforeEach(() => {
  state.permissions = ["zeteo.data.read", "zeteo.file_sources.write"];
  state.fileSources = true;
  get.mockReset().mockResolvedValue({ data: makeFileSource() });
});

describe("file source routes", () => {
  it("show a source to its owner", async () => {
    renderAt(`/my/data/${FS_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Q3 sales" })
    ).toBeInTheDocument();
  });

  it("show a source to an admin who reads sources", async () => {
    state.permissions = ["zeteo.sources.read"];
    renderAt(`/my/data/${FS_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Q3 sales" })
    ).toBeInTheDocument();
  });

  it("are not found while File Sources are off, asking zeteo nothing", async () => {
    state.fileSources = false;
    renderAt(`/my/data/${FS_ID}`);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("need zeteo.file_sources.write to add data", async () => {
    state.permissions = ["zeteo.data.read", "zeteo.sources.read"];
    renderAt("/my/data/new");
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(screen.getByText(/zeteo\.file_sources\.write/)).toBeInTheDocument();
  });

  it("show not found for an id that is not a UUID", async () => {
    renderAt("/my/data/not-a-uuid");
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
