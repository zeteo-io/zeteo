import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { optionTexts, pickOption } from "@/test/searchSelect";
import { makeSource, SOURCE_ID } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { MemoryRouter } from "react-router-dom";
import { SourceForm } from "./SourceForm";

const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    api: { post, patch, get: vi.fn() },
  })
);

// Required fields carry a visually hidden-from-AT " *" in their label text.
const labelPattern = (label: string) =>
  new RegExp(`^${label.replace(/[()]/g, "\\$&")}( \\*)?$`);
const field = (label: string) => screen.getByLabelText(labelPattern(label));
const maybeField = (label: string) =>
  screen.queryByLabelText(labelPattern(label));
// The boxed section under a heading; "Row cap" is in both Querying and Exports.
const section = (title: string) =>
  within(
    screen
      .getByRole("heading", { name: title })
      .closest(".k-bordered-section") as HTMLElement
  );
const inSection = (title: string, label: string) =>
  section(title).getByLabelText(labelPattern(label));
const chooseDatabase = (
  user: ReturnType<typeof userEvent.setup>,
  name: "PostgreSQL" | "Azure SQL"
) =>
  user.click(
    within(screen.getByRole("group", { name: "Database" })).getByRole(
      "button",
      { name }
    )
  );

const URL_ = `/v1/sources/${SOURCE_ID}`;

const renderCreate = () =>
  renderWithProviders(
    <Routes>
      <Route path="/sources/new" element={<SourceForm title="New source" />} />
      <Route path="/sources/:sourceId" element={<p>detail page</p>} />
    </Routes>,
    { route: "/sources/new" }
  );

const renderEdit = (source = makeSource()) =>
  renderWithProviders(
    <Routes>
      <Route
        path="/sources/:sourceId/edit"
        element={<SourceForm source={source} title="Edit source" />}
      />
      <Route path="/sources/:sourceId" element={<p>detail page</p>} />
    </Routes>,
    { route: `/sources/${source.id}/edit` }
  );

const type = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string | HTMLElement,
  text: string
) => {
  const input = typeof label === "string" ? field(label) : label;
  await user.clear(input);
  await user.type(input, text);
};

const fillConnection = async (user: ReturnType<typeof userEvent.setup>) => {
  await type(user, "Host", "db.example.test");
  await type(user, inSection("Connection", "Database"), "orders");
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
      expect(field("Port")).toHaveValue("5432");
      expect(field("CA certificate (optional)")).toBeInTheDocument();

      await chooseDatabase(user, "Azure SQL");

      expect(field("Port")).toHaveValue("1433");
      expect(maybeField("CA certificate (optional)")).not.toBeInTheDocument();
      await user.click(field("TLS"));
      await waitFor(() =>
        expect(optionTexts()).toEqual([
          "Required, certificate verified",
          "Required, server certificate trusted",
        ])
      );
    });

    it("sends every field as typed, numbers as numbers, and goes to the new source", async () => {
      const user = userEvent.setup();
      post.mockResolvedValue({ data: makeSource({ id: "created-id" }) });
      renderCreate();
      await type(user, "Slug", "orders");
      await type(user, "Name", "Orders DB");
      await fillConnection(user);
      await type(user, "Port", "6543");
      await type(
        user,
        "CA certificate (optional)",
        "-----BEGIN CERTIFICATE-----"
      );
      await type(user, "Schemas", "public, sales, ops");
      await type(user, "Time limit (ms)", "20000");
      await type(user, inSection("Querying", "Row cap"), "1000");
      await user.click(field("Allow exports"));
      await type(user, inSection("Exports", "Row cap"), "5000");
      await type(user, "Queries at once", "7");
      await type(user, "Exports at once", "3");

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
          tls: "verify",
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
      expect(
        screen.getByText(/The connection stays as it is/)
      ).toBeInTheDocument();
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
      expect(
        screen.queryByRole("group", { name: "Database" })
      ).not.toBeInTheDocument();
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
      await type(user, "CA certificate (optional)", "PEM");

      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(patch).toHaveBeenCalled());
      expect(patch.mock.calls[0][1]).toEqual({
        settings: {
          host: "db.example.test",
          port: 5433,
          database: "orders",
          user: "reader",
          password: "s3cret",
          tls: "verify",
          ca: "PEM",
        },
      });
    });

    it("sends changed limits and leaves an emptied optional number unchanged", async () => {
      const user = userEvent.setup();
      renderEdit();
      await type(user, inSection("Querying", "Row cap"), "100");
      await user.clear(field("Time limit (ms)"));
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
      expect(
        screen.getByText("This source is archived and cannot be changed.")
      ).toBeInTheDocument();
    });
  });

  describe("create, more", () => {
    const fillBasics = async (user: ReturnType<typeof userEvent.setup>) => {
      await type(user, "Slug", "orders");
      await type(user, "Name", "Orders DB");
      await fillConnection(user);
      await type(user, "Schemas", "public");
    };

    it("sends an Azure SQL source with its port and tls and no ca", async () => {
      const user = userEvent.setup();
      renderCreate();
      await chooseDatabase(user, "Azure SQL");
      await pickOption(
        user,
        field("TLS"),
        "Required, server certificate trusted"
      );
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(post.mock.calls[0][1]).toMatchObject({
        type: "azure-sql",
        settings: {
          port: 1433,
          tls: "trust-server-certificate",
        },
      });
      expect(post.mock.calls[0][1].settings).not.toHaveProperty("ca");
    });

    it("drops a typed CA when the type is switched to Azure SQL", async () => {
      const user = userEvent.setup();
      renderCreate();
      await type(user, "CA certificate (optional)", "PEM");
      await chooseDatabase(user, "Azure SQL");
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(post.mock.calls[0][1].settings).not.toHaveProperty("ca");
    });

    it("asks for a CA only for verified TLS, and drops a typed one otherwise", async () => {
      const user = userEvent.setup();
      renderCreate();
      await type(user, "CA certificate (optional)", "PEM");
      await pickOption(user, field("TLS"), "Required");
      expect(maybeField("CA certificate (optional)")).not.toBeInTheDocument();
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      await waitFor(() => expect(post).toHaveBeenCalled());
      expect(post.mock.calls[0][1].settings).toMatchObject({ tls: "require" });
      expect(post.mock.calls[0][1].settings).not.toHaveProperty("ca");
    });

    it("suggests the slug from the name until the slug is edited", async () => {
      const user = userEvent.setup();
      renderCreate();
      await type(user, "Name", "Larkspur Retail 2");
      expect(field("Slug")).toHaveValue("larkspur-retail-2");
      await type(user, "Slug", "larkspur");
      await type(user, "Name", "Something else");
      expect(field("Slug")).toHaveValue("larkspur");
    });

    it("drops leading digits and symbols from a suggested slug", async () => {
      const user = userEvent.setup();
      renderCreate();
      await type(user, "Name", "2024 -- Sales!");
      expect(field("Slug")).toHaveValue("sales");
    });

    it("shows the export settings only while exports are allowed", async () => {
      const user = userEvent.setup();
      renderCreate();
      expect(maybeField("Exports at once")).not.toBeInTheDocument();
      expect(
        screen.getByText("People can't export from this source.")
      ).toBeInTheDocument();
      await user.click(field("Allow exports"));
      expect(field("Exports at once")).toBeInTheDocument();
      await user.click(field("Allow exports"));
      expect(maybeField("Exports at once")).not.toBeInTheDocument();
    });

    it("offers the writable-login override on create and resends with it", async () => {
      const user = userEvent.setup();
      post.mockRejectedValueOnce({
        status: 422,
        code: "writable_login",
        message: "This login can write",
        findings: [{ code: "superuser", detail: "is a superuser" }],
      });
      renderCreate();
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      expect(await screen.findByText(/is a superuser/)).toBeInTheDocument();
      await user.click(field("Allow this login although it can write"));
      await user.click(screen.getByRole("button", { name: "Create source" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      expect(post.mock.calls[1][1]).toMatchObject({
        allow_writable_login: true,
      });
    });

    it("hides the override when the login is edited afterwards", async () => {
      const user = userEvent.setup();
      post.mockRejectedValueOnce({
        status: 422,
        code: "writable_login",
        message: "This login can write",
        findings: [{ code: "superuser", detail: "is a superuser" }],
      });
      renderCreate();
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      await user.click(field("Allow this login although it can write"));
      await type(user, "User", "someone-else");
      expect(
        maybeField("Allow this login although it can write")
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Create source" }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      expect(post.mock.calls[1][1]).not.toHaveProperty("allow_writable_login");
    });

    it("shows issues at the CA field and at an unknown path", async () => {
      const user = userEvent.setup();
      post.mockRejectedValue({
        status: 400,
        code: "invalid_request",
        message: "Invalid request body.",
        issues: [
          { path: "settings.ca", message: "Not a PEM certificate" },
          { path: "settings.extra", message: "Unknown key" },
        ],
      });
      renderCreate();
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      expect(
        await screen.findByText("Not a PEM certificate")
      ).toBeInTheDocument();
      expect(
        screen.getByText("settings.extra: Unknown key")
      ).toBeInTheDocument();
    });

    it("shows an issue at tls beside the select", async () => {
      const user = userEvent.setup();
      post.mockRejectedValue({
        status: 400,
        code: "invalid_request",
        message: "Invalid request body.",
        issues: [{ path: "settings.tls", message: "Bad tls mode" }],
      });
      renderCreate();
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      expect(await screen.findByText("Bad tls mode")).toBeInTheDocument();
    });

    it("reports a non-numeric number as 'Enter a number' and sends nothing", async () => {
      const user = userEvent.setup();
      renderCreate();
      await fillBasics(user);
      await type(user, inSection("Querying", "Row cap"), "12abc");
      await user.click(screen.getByRole("button", { name: "Create source" }));
      expect(await screen.findByText("Enter a number.")).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
      await type(user, inSection("Querying", "Row cap"), "12");
      expect(screen.queryByText("Enter a number.")).not.toBeInTheDocument();
    });

    it("clears the server's notice once a field is edited", async () => {
      const user = userEvent.setup();
      post.mockRejectedValue({
        status: 409,
        code: "slug_taken",
        message: "That slug is in use",
      });
      renderCreate();
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      expect(
        await screen.findByText("That slug is in use")
      ).toBeInTheDocument();
      await type(user, "Slug", "orders-2");
      expect(screen.queryByText("That slug is in use")).not.toBeInTheDocument();
    });

    it("keeps no password in the mutation cache once the form is gone", async () => {
      const user = userEvent.setup();
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { unmount } = render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/sources/new"]}>
            <Routes>
              <Route
                path="/sources/new"
                element={<SourceForm title="New source" />}
              />
              <Route path="/sources/:sourceId" element={<p>detail page</p>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      );
      await fillBasics(user);
      await user.click(screen.getByRole("button", { name: "Create source" }));
      await screen.findByText("detail page");
      unmount();
      await waitFor(() =>
        expect(
          client
            .getMutationCache()
            .getAll()
            .filter((m) => JSON.stringify(m.state.variables).includes("s3cret"))
        ).toHaveLength(0)
      );
    });

    it("has no stored-secret notes on create", () => {
      renderCreate();
      expect(
        screen.queryByText(/stored CA is not shown/)
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/stored password is not shown/)
      ).not.toBeInTheDocument();
    });
  });

  describe("edit, more", () => {
    it("says the stored CA and password are not shown once the connection is opened", async () => {
      const user = userEvent.setup();
      renderEdit();
      await user.click(
        screen.getByRole("button", { name: "Change connection" })
      );
      expect(
        screen.getByText(
          "The stored CA is not shown. Paste it again; leaving this empty removes it."
        )
      ).toBeInTheDocument();
      expect(
        screen.getByText("The stored password is not shown. Enter it again.")
      ).toBeInTheDocument();
    });

    it("undoes a connection change with 'Keep connection unchanged'", async () => {
      const user = userEvent.setup();
      renderEdit();
      await user.click(
        screen.getByRole("button", { name: "Change connection" })
      );
      await type(user, "Host", "elsewhere.example.test");
      await user.click(
        screen.getByRole("button", { name: "Keep connection unchanged" })
      );
      expect(
        screen.getByText(/The connection stays as it is/)
      ).toBeInTheDocument();

      await type(user, "Name", "Renamed");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(patch).toHaveBeenCalled());
      expect(patch.mock.calls[0][1]).toEqual({ name: "Renamed" });
    });

    it("restores the stored host when the connection is reopened after keeping it", async () => {
      const user = userEvent.setup();
      renderEdit();
      await user.click(
        screen.getByRole("button", { name: "Change connection" })
      );
      await type(user, "Host", "elsewhere.example.test");
      await user.click(
        screen.getByRole("button", { name: "Keep connection unchanged" })
      );
      await user.click(
        screen.getByRole("button", { name: "Change connection" })
      );
      expect(field("Host")).toHaveValue("db.example.test");
    });
  });
});
