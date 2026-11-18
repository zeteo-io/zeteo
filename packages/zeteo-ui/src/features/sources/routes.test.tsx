import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FS_ID, uploadGet } from "./upload/testFixtures";
import { render, screen } from "@testing-library/react";
import { makeSource, SOURCE_ID } from "./testFixtures";
import { TEST_UI_CONFIG } from "@/test/uiConfig";
import { sourceRoutes } from "./routes";

const get = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  permissions: ["zeteo.sources.read"],
  fileSources: true,
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => state.permissions,
    api: { get, post: vi.fn() },
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
  const router = createMemoryRouter(sourceRoutes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
};

const OWNER = ["zeteo.data.read", "zeteo.file_sources.write"];

beforeEach(() => {
  state.permissions = ["zeteo.sources.read"];
  state.fileSources = true;
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
  it.each(["/sources/new"])("show the no-access page at %s", async (path) => {
    renderAt(path);
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(screen.getByText(/zeteo\.sources\.write/)).toBeInTheDocument();
  });
});

describe("an upload's pages", () => {
  beforeEach(() => {
    get.mockImplementation(uploadGet());
  });

  it("show an upload at /sources/:id to its owner, who holds only zeteo.file_sources.write", async () => {
    state.permissions = OWNER;
    renderAt(`/sources/${FS_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Q3 sales" })
    ).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();
  });

  it("show an upload to an admin who reads sources", async () => {
    renderAt(`/sources/${FS_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Q3 sales" })
    ).toBeInTheDocument();
  });

  it("refuse an owner while File Sources are off, asking zeteo nothing", async () => {
    state.permissions = OWNER;
    state.fileSources = false;
    renderAt(`/sources/${FS_ID}`);
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(screen.getByText(/zeteo\.sources\.read/)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("refuse someone with neither permission", async () => {
    state.permissions = ["zeteo.data.read"];
    renderAt(`/sources/${FS_ID}`);
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("need zeteo.file_sources.write to add data", async () => {
    state.permissions = ["zeteo.data.read", "zeteo.sources.read"];
    renderAt("/my/data/new");
    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(screen.getByText(/zeteo\.file_sources\.write/)).toBeInTheDocument();
  });

  it.each([
    "/my/data/new",
    `/sources/${FS_ID}/add`,
    `/sources/${FS_ID}/tables/${FS_ID}/reupload`,
  ])("are not found at %s while File Sources are off", async (path) => {
    state.permissions = OWNER;
    state.fileSources = false;
    renderAt(path);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("show Add tables to the owner", async () => {
    state.permissions = OWNER;
    renderAt(`/sources/${FS_ID}/add`);
    expect(
      await screen.findByRole("heading", { name: "Add tables to Q3 sales" })
    ).toBeInTheDocument();
  });

  it("do not offer Add tables for a database source", async () => {
    state.permissions = ["zeteo.sources.write"];
    get.mockImplementation(async () => ({ data: makeSource() }));
    renderAt(`/sources/${SOURCE_ID}/add`);
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});
