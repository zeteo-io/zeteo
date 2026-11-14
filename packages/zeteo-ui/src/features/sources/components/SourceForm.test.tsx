import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { makeSource, SOURCE_ID } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { SourceForm } from "./SourceForm";

const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ api: { post, patch, get: vi.fn() } }));

// Required fields carry a visually hidden-from-AT " *" in their label text.
const labelPattern = (label: string) =>
  new RegExp(`^${label.replace(/[()]/g, "\\$&")}( \\*)?$`);
const field = (label: string) => screen.getByLabelText(labelPattern(label));
const maybeField = (label: string) =>
  screen.queryByLabelText(labelPattern(label));

const URL_ = `/v1/sources/${SOURCE_ID}`;

const renderCreate = () =>
  renderWithProviders(
    <Routes>
      <Route path="/sources/new" element={<SourceForm />} />
      <Route path="/sources/:sourceId" element={<p>detail page</p>} />
    </Routes>,
    { route: "/sources/new" }
  );

const renderEdit = (source = makeSource()) =>
  renderWithProviders(
    <Routes>
      <Route
        path="/sources/:sourceId/edit"
        element={<SourceForm source={source} />}
      />
      <Route path="/sources/:sourceId" element={<p>detail page</p>} />
    </Routes>,
    { route: `/sources/${source.id}/edit` }
  );

const type = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  text: string
) => {
  const input = field(label);
  await user.clear(input);
  await user.type(input, text);
};

const fillConnection = async (user: ReturnType<typeof userEvent.setup>) => {
  await type(user, "Host", "db.example.test");
  await type(user, "Database", "orders");
  await type(user, "User", "reader");
  await type(user, "Password", "s3cret");
};

describe("SourceForm", () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({ data: makeSource() });
    patch.mockReset().mockResolvedValue({ data: makeSource() });
  });

  describe("create", () => {
    it("swaps the connection fields and the default port with the type", async () => {
      const user = userEvent.setup();
      renderCreate();
      expect(field("Port")).toHaveValue(5432);
      expect(field("CA certificate")).toBeInTheDocument();

      await user.selectOptions(field("Type"), "azure-sql");

      expect(field("Port")).toHaveValue(1433);
      expect(maybeField("CA certificate")).not.toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "trust-server-certificate" })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "require" })
      ).not.toBeInTheDocument();
    });

    it("sends every field as typed, numbers as numbers, and goes to the new source", async () => {
      const user = userEvent.setup();
      post.mockResolvedValue({ data: makeSource({ id: "created-id" }) });
      renderCreate();
      await type(user, "Slug", "orders");
      await type(user, "Name", "Orders DB");
      await fillConnection(user);
      await type(user, "Port", "6543");
      await user.selectOptions(field("TLS"), "require");
      await type(user, "CA certificate", "-----BEGIN CERTIFICATE-----");
      await type(user, "Schemas", "public, sales, ops");
      await type(user, "Timeout (ms)", "20000");
      await type(user, "Row cap", "1000");
      await user.click(field("Export enabled"));
      await type(user, "Export row cap", "5000");
      await type(user, "Query concurrency", "7");
      await type(user, "Export concurrency", "3");

      await user.click(screen.getByRole("button", { name: "Create source" }));

      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post.mock.calls[0][0]).toBe("/v1/sources");
      expect(post.mock.calls[0][1]).toEqual({
        slug: "orders",
        name: "Orders DB",
        type: "postgres",
        settings: {
          host: "db.example.test",
          port: 6543,
          database: "orders",
          user: "reader",
          password: "s3cret",
          tls: "require",
          ca: "-----BEGIN CERTIFICATE-----",
        },
        schemas: ["public", "sales", "ops"],
        timeout_ms: 20000,
        row_cap: 1000,
        export_enabled: true,
        export_row_cap: 5000,
        query_concurrency: 7,
        export_concurrency: 3,
      });
      expect(await screen.findByText("detail page")).toBeInTheDocument();
    });

    it("omits empty optional numbers and the empty CA so the API applies its defaults", async () => {
      const user = userEvent.setup();
      renderCreate();
      await type(user, "Slug", "orders");
      await type(user, "Name", "Orders DB");
      await fillConnection(user);
      await type(user, "Schemas", "public");
      await user.click(screen.getByRole("button", { name: "Create source" }));

      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(post.mock.calls[0][1]).toEqual({
        slug: "orders",
        name: "Orders DB",
        type: "postgres",
        settings: {
          host: "db.example.test",
          port: 5432,
          database: "orders",
          user: "reader",
          password: "s3cret",
          tls: "verify",
        },
        schemas: ["public"],
        export_enabled: false,
      });
    });

    it("shows a 400 issue under the field it names", async () => {
      const user = userEvent.setup();
      post.mockRejectedValue({
        status: 400,
        code: "invalid_request",
        message: "Invalid request body. settings.host: Host is not valid",
        issues: [{ path: "settings.host", message: "Host is not valid" }],
      });
      renderCreate();
      await type(user, "Slug", "orders");
      await type(user, "Name", "Orders DB");
      await fillConnection(user);
      await type(user, "Schemas", "public");
      await user.click(screen.getByRole("button", { name: "Create source" }));

      expect(await screen.findByText("Host is not valid")).toBeInTheDocument();
      expect(field("Host")).toHaveAccessibleDescription("Host is not valid");
      expect(field("Password")).toHaveValue("s3cret");
    });

    it.each([
      ["slug_taken", 409, "That slug is in use"],
      ["host_not_allowed", 422, "Host not permitted"],
      ["source_unreachable", 502, "Could not connect"],
    ])("shows the API's description of %s", async (code, status, message) => {
      const user = userEvent.setup();
      post.mockRejectedValue({ status, code, message });
      renderCreate();
      await type(user, "Slug", "orders");
      await type(user, "Name", "Orders DB");
      await fillConnection(user);
      await type(user, "Schemas", "public");
      await user.click(screen.getByRole("button", { name: "Create source" }));
      expect(await screen.findByText(message)).toBeInTheDocument();
    });

    it("refuses duplicate schemas and more than 20, without calling the API", async () => {
      const user = userEvent.setup();
      renderCreate();
      await type(user, "Slug", "orders");
      await type(user, "Name", "Orders DB");
      await fillConnection(user);

      await type(user, "Schemas", "public, sales, public");
      await user.click(screen.getByRole("button", { name: "Create source" }));
      expect(await screen.findByText(/more than once/i)).toBeInTheDocument();

      await type(
        user,
        "Schemas",
        Array.from({ length: 21 }, (_, i) => `s${i}`).join(",")
      );
      await user.click(screen.getByRole("button", { name: "Create source" }));
      expect(await screen.findByText(/at most 20/i)).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });

    it("never asks for a password to be shown and uses new-password autocomplete", () => {
      renderCreate();
      const password = field("Password");
      expect(password).toHaveAttribute("autocomplete", "new-password");
      expect(password).toHaveValue("");
    });
  });

  describe("edit", () => {
    it("sends only the name when only the name changed, with no settings", async () => {
      const user = userEvent.setup();
      renderEdit();
      expect(screen.getByText("Connection: unchanged")).toBeInTheDocument();
      expect(maybeField("Host")).not.toBeInTheDocument();
      await type(user, "Name", "Orders (prod)");

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
      expect(patch.mock.calls[0][0]).toBe(URL_);
      expect(patch.mock.calls[0][1]).toEqual({ name: "Orders (prod)" });
      expect(await screen.findByText("detail page")).toBeInTheDocument();
    });

    it("does not offer to change the slug or the type", () => {
      renderEdit();
      expect(maybeField("Slug")).not.toBeInTheDocument();
      expect(maybeField("Type")).not.toBeInTheDocument();
    });

    it("blocks saving an opened connection group without a password", async () => {
      const user = userEvent.setup();
      renderEdit();
      await user.click(
        screen.getByRole("button", { name: "Change connection" })
      );
      expect(field("Host")).toHaveValue("db.example.test");
      expect(field("Password")).toHaveValue("");

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(patch).not.toHaveBeenCalled();
      expect(field("Password")).toHaveAttribute("aria-invalid", "true");
    });

    it("sends the whole settings object once the connection group is opened", async () => {
      const user = userEvent.setup();
      renderEdit();
      await user.click(
        screen.getByRole("button", { name: "Change connection" })
      );
      await fillConnection(user);
      await type(user, "Port", "5433");
      await user.selectOptions(field("TLS"), "require");
      await type(user, "CA certificate", "PEM");

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(patch).toHaveBeenCalled());
      expect(patch.mock.calls[0][1]).toEqual({
        settings: {
          host: "db.example.test",
          port: 5433,
          database: "orders",
          user: "reader",
          password: "s3cret",
          tls: "require",
          ca: "PEM",
        },
      });
    });

    it("sends changed limits and leaves an emptied optional number unchanged", async () => {
      const user = userEvent.setup();
      renderEdit();
      await type(user, "Row cap", "100");
      await user.clear(field("Timeout (ms)"));
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(patch).toHaveBeenCalled());
      expect(patch.mock.calls[0][1]).toEqual({ row_cap: 100 });
    });

    it("shows findings after a 422 writable_login and resends with allow_writable_login", async () => {
      const user = userEvent.setup();
      patch.mockRejectedValueOnce({
        status: 422,
        code: "writable_login",
        message: "This login can write",
        findings: [{ code: "can_write_tables", detail: "can write orders" }],
      });
      renderEdit();
      expect(
        maybeField("Allow this login although it can write")
      ).not.toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: "Change connection" })
      );
      await fillConnection(user);
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByText(/can write orders/)).toBeInTheDocument();
      expect(patch.mock.calls[0][1]).not.toHaveProperty("allow_writable_login");
      await user.click(field("Allow this login although it can write"));
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
      expect(patch.mock.calls[1][1]).toMatchObject({
        allow_writable_login: true,
        settings: { host: "db.example.test", password: "s3cret" },
      });
      expect(await screen.findByText("detail page")).toBeInTheDocument();
    });

    it("offers no edit for an archived source", () => {
      renderEdit(makeSource({ archived_at: "2026-11-02T10:00:00.000Z" }));
      expect(
        screen.queryByRole("button", { name: "Save changes" })
      ).not.toBeInTheDocument();
      expect(screen.getByText(/archived/i)).toBeInTheDocument();
    });
  });
});
