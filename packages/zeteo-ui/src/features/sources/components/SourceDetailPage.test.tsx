import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSource, SOURCE_ID } from "../testFixtures";
import { SourceDetailPage } from "./SourceDetailPage";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { SourceLayout } from "./SourceLayout";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
const held = vi.hoisted(() => ({ permissions: ["zeteo.sources.write"] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
    api: { get, post, patch },
  })
);

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
    patch.mockReset().mockResolvedValue({ data: makeSource() });
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

  it("shows the description under the name when set", async () => {
    get.mockResolvedValue({
      data: makeSource({ description: "Orders and invoices." }),
    });
    renderDetail();
    expect(await screen.findByText("Orders and invoices.")).toBeInTheDocument();
  });

  it("shows no description line when it is empty", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "Orders DB" });
    expect(
      document.querySelector(".z-source-description")
    ).not.toBeInTheDocument();
  });

  it("shows the connection and limits in words", async () => {
    get.mockResolvedValue({
      data: makeSource({
        settings: {
          host: "db.example.test",
          database: "orders",
          user: "reader",
          tls: "verify",
        },
        timeout_ms: 60_000,
        row_cap: 50_000,
      }),
    });
    renderDetail();
    await screen.findByRole("heading", { name: "Orders DB" });
    expect(screen.getAllByText("PostgreSQL").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Required, certificate verified")
    ).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("1 min")).toBeInTheDocument();
    expect(screen.getAllByText("50,000 rows").length).toBeGreaterThan(0);
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
    await user.click(
      await screen.findByRole("button", { name: "Test connection" })
    );
    expect(post).toHaveBeenCalledWith(`${SOURCE_URL}/test`);
    expect(await screen.findByText(/can write orders/)).toBeInTheDocument();
  });

  it("Test says when there are no findings", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ data: { ok: true, findings: [] } });
    renderDetail();
    await user.click(
      await screen.findByRole("button", { name: "Test connection" })
    );
    expect(
      await screen.findByText("Connected. The login is read-only.")
    ).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Refresh catalogue" }));
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
    const button = await screen.findByRole("button", {
      name: "Test connection",
    });
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
    await user.click(
      await screen.findByRole("button", { name: "Refresh catalogue" })
    );
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
    expect(
      screen.getByText(
        "Archiving closes the source's connections and stops all further changes to it. Grants on its tables stop working: no one can query them any more. It cannot be undone."
      )
    ).toBeInTheDocument();
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
    for (const name of [
      "Test connection",
      "Refresh catalogue",
      "Archive",
      "Edit",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("shows no write control without zeteo.sources.write", async () => {
    held.permissions = ["zeteo.sources.read"];
    renderDetail();
    await screen.findByRole("heading", { name: "Orders DB" });
    for (const name of [
      "Test connection",
      "Refresh catalogue",
      "Archive",
      "Edit",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("keeps the last result under the header on every tab", async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ data: { ok: true, findings: [] } });
    renderDetail();
    await user.click(
      await screen.findByRole("button", { name: "Test connection" })
    );
    await screen.findByText("Connected. The login is read-only.");
    await user.click(screen.getByRole("link", { name: "Tables" }));
    expect(await screen.findByText("tables page")).toBeInTheDocument();
    expect(
      screen.getByText("Connected. The login is read-only.")
    ).toBeInTheDocument();
  });

  it("replaces the last result with the next action's", async () => {
    const user = userEvent.setup();
    post.mockImplementation(async (url: string) =>
      url.endsWith("/test")
        ? { data: { ok: true, findings: [] } }
        : {
            data: {
              tables: { added: 1, missing: 0, restored: 0 },
              columns: { added: 0, changed: 0, missing: 0, restored: 0 },
              relations: { added: 0, missing: 0, restored: 0 },
            },
          }
    );
    renderDetail();
    await user.click(
      await screen.findByRole("button", { name: "Test connection" })
    );
    await screen.findByText("Connected. The login is read-only.");
    await user.click(screen.getByRole("button", { name: "Refresh catalogue" }));
    expect(await screen.findByText(/Catalogue refreshed/)).toBeInTheDocument();
    expect(
      screen.queryByText("Connected. The login is read-only.")
    ).not.toBeInTheDocument();
  });

  it("shows the size of its schemas' tables", async () => {
    renderDetail();
    expect(await screen.findByText("4.8 MB")).toBeInTheDocument();
  });

  it("says Unknown when the size could not be read", async () => {
    get.mockResolvedValue({ data: makeSource({ size_bytes: null }) });
    renderDetail();
    await screen.findByRole("heading", { name: "Orders DB" });
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("Edit opens the source's settings in a dialog", async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Connection")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue("Orders DB");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
