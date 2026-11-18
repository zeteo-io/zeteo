import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSource, SOURCE_ID } from "../testFixtures";
import { Link, Route, Routes } from "react-router-dom";
import { fromPage, MY_DATA_BACK } from "./sourceBack";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { SourceLayout } from "./SourceLayout";

const get = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.sources.read"] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get },
  })
);

const SOURCE = `/sources/${SOURCE_ID}`;

const renderFrom = (route: string) =>
  renderWithProviders(
    <Routes>
      <Route
        path="/start"
        element={
          <Link to={SOURCE} state={fromPage(MY_DATA_BACK)}>
            Open from My sources
          </Link>
        }
      />
      <Route path="/sources/:sourceId" element={<SourceLayout />}>
        <Route index element={<p>overview</p>} />
        <Route path="tables" element={<p>tables</p>} />
      </Route>
    </Routes>,
    { route }
  );

const backLink = () => screen.findByRole("link", { name: /^←/ });

describe("a source page's back link", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.sources.read"];
    get.mockReset().mockResolvedValue({ data: makeSource() });
  });

  it("goes back where the person came from, on every tab", async () => {
    const user = userEvent.setup();
    renderFrom("/start");
    await user.click(
      screen.getByRole("link", { name: "Open from My sources" })
    );
    expect(await backLink()).toHaveTextContent("← My sources");
    expect(await backLink()).toHaveAttribute("href", "/my?tab=sources");
    await user.click(screen.getByRole("link", { name: "Tables" }));
    expect(await screen.findByText("tables")).toBeInTheDocument();
    expect(await backLink()).toHaveTextContent("← My sources");
  });

  it("goes to Sources, without a known origin, for whoever may read sources", async () => {
    renderFrom(SOURCE);
    expect(await backLink()).toHaveTextContent("← Sources");
    expect(await backLink()).toHaveAttribute("href", "/sources");
  });

  it("goes to My sources, without a known origin, for whoever may not", async () => {
    held.permissions = ["zeteo.data.read", "zeteo.file_sources.write"];
    get.mockResolvedValue({
      data: makeSource({ type: "upload" as never, settings: null }),
    });
    renderFrom(SOURCE);
    expect(await backLink()).toHaveTextContent("← My sources");
  });
});
