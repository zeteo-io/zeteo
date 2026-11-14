import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { makeSource, SOURCE_ID } from "../testFixtures";
import { SourceDetailPage } from "./SourceDetailPage";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { SourceLayout } from "./SourceLayout";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.sources.write"] }));
vi.mock("@/lib/api/client", () => ({ api: { get, post } }));
vi.mock("@/lib/auth", async () => {
  const { mockAuth } = await import("@/test/authMock");
  return {
    ...mockAuth(),
    useAuth: () => mockAuth({ permissions: held.permissions }).useAuth(),
  };
});

const SOURCE_URL = `/v1/sources/${SOURCE_ID}`;

const renderDetail = () =>
  renderWithProviders(
    <Routes>
      <Route path="/sources/:sourceId" element={<SourceLayout />}>
        <Route index element={<SourceDetailPage />} />
        <Route path="tables" element={<p>tables page</p>} />
      </Route>
    </Routes>,
    { route: `/sources/${SOURCE_ID}` }
  );

describe("SourceDetailPage", () => {
  beforeEach(() => {
    held.permissions = ["zeteo.sources.write"];
    get.mockReset().mockResolvedValue({ data: makeSource() });
    post.mockReset();
  });

  it("shows the source, its tabs and its settings as returned", async () => {
    renderDetail();
    expect(
      await screen.findByRole("heading", { name: "Orders DB" })
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(SOURCE_URL);
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      `/sources/${SOURCE_ID}`
    );
    expect(screen.getByRole("link", { name: "Tables" })).toHaveAttribute(
      "href",
      `/sources/${SOURCE_ID}/tables`
    );
    expect(screen.getByRole("link", { name: "Relations" })).toHaveAttribute(
      "href",
      `/sources/${SOURCE_ID}/relations`
    );
    expect(screen.getByText("db.example.test")).toBeInTheDocument();
    expect(screen.queryByText(/password/i)).not.toBeInTheDocument();
  });

  it("prints non-primitive settings values as JSON, not [object Object]", async () => {
    get.mockResolvedValue({
      data: makeSource({ settings: { host: "h", options: { a: 1 } } }),
    });
    renderDetail();
    expect(await screen.findByText('{"a":1}')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it("says so when the settings are unreadable", async () => {
    get.mockResolvedValue({ data: makeSource({ settings: null }) });
    renderDetail();
    expect(await screen.findByText(/unreadable/i)).toBeInTheDocument();
  });

  it("shows Archived for an archived source, whatever its status", async () => {
    get.mockResolvedValue({
      data: makeSource({ archived_at: "2026-11-02T10:00:00.000Z" }),
    });
    renderDetail();
    await screen.findByRole("heading", { name: "Orders DB" });
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
  });

  it("Test shows the findings", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({
      data: {
        ok: true,
        findings: [{ code: "can_write_tables", detail: "can write orders" }],
      },
    });
    renderDetail();
    await user.click(await screen.findByRole("button", { name: "Test" }));
    expect(post).toHaveBeenCalledWith(`${SOURCE_URL}/test`);
    expect(await screen.findByText(/can write orders/)).toBeInTheDocument();
  });

  it("Test says when there are no findings", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ data: { ok: true, findings: [] } });
    renderDetail();
    await user.click(await screen.findByRole("button", { name: "Test" }));
    expect(await screen.findByText("No findings")).toBeInTheDocument();
  });

  it("Refresh shows the counts and reloads the source", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({
      data: {
        tables: { added: 2, missing: 1, restored: 0 },
        columns: { added: 9, changed: 3, missing: 4, restored: 5 },
        relations: { added: 6, missing: 7, restored: 8 },
      },
    });
    renderDetail();
    await screen.findByRole("heading", { name: "Orders DB" });
    const before = get.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(post).toHaveBeenCalledWith(`${SOURCE_URL}/refresh`);
    expect(await screen.findByText(/^Tables:/)).toHaveTextContent(
      "2 added, 1 missing, 0 restored"
    );
    expect(screen.getByText(/^Columns:/)).toHaveTextContent(
      "9 added, 3 changed, 4 missing, 5 restored"
    );
    expect(screen.getByText(/^Relations:/)).toHaveTextContent(
      "6 added, 7 missing, 8 restored"
    );
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  it("is busy while a call runs and ignores repeat clicks", async () => {
    const user = userEvent.setup();
    let finish: (v: unknown) => void = () => {};
    post.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderDetail();
    const button = await screen.findByRole("button", { name: "Test" });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    expect(post).toHaveBeenCalledTimes(1);
    finish({ data: { ok: true, findings: [] } });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("shows a 502 from Refresh without losing the page", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 502,
      code: "source_unreachable",
      message: "The source did not answer",
    });
    renderDetail();
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(
      await screen.findByText("The source did not answer")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Orders DB" })
    ).toBeInTheDocument();
  });

  it("Archive asks first, saying it cannot be undone, then archives", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ data: undefined });
    renderDetail();
    await user.click(await screen.findByRole("button", { name: "Archive" }));
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Archive source" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`${SOURCE_URL}/archive`)
    );
  });

  it("shows no write control for an archived source", async () => {
    get.mockResolvedValue({
      data: makeSource({ archived_at: "2026-11-02T10:00:00.000Z" }),
    });
    renderDetail();
    await screen.findByRole("heading", { name: "Orders DB" });
    for (const name of ["Test", "Refresh", "Archive", "Edit"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("shows no write control without zeteo.sources.write", async () => {
    held.permissions = ["zeteo.sources.read"];
    renderDetail();
    await screen.findByRole("heading", { name: "Orders DB" });
    for (const name of ["Test", "Refresh", "Archive", "Edit"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("shows a missing source's error", async () => {
    get.mockRejectedValue({
      status: 404,
      code: "not_found",
      message: "No such source",
    });
    renderDetail();
    expect(await screen.findByText("No such source")).toBeInTheDocument();
  });
});
