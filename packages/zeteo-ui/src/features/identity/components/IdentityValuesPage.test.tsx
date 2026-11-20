import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityValuesPage } from "./IdentityValuesPage";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { parsePasted } from "../bulkPaste";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.grants.write"],
    api: { get, post, delete: del },
  })
);

const KEY_ID = "d1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
const ADA = "b1111111-1c7a-4a53-9d0e-6a3b1f2c4d01";
const ALAN = "b2222222-1c7a-4a53-9d0e-6a3b1f2c4d02";
const NINA = "b3333333-1c7a-4a53-9d0e-6a3b1f2c4d03";

const users = [
  {
    type: "user",
    id: ADA,
    name: "Ada Lovelace",
    email: "ada@example.com",
    status: "active",
  },
  {
    type: "user",
    id: ALAN,
    name: "Alan Turing",
    email: "Alan@Example.com",
    status: "active",
  },
  {
    type: "user",
    id: NINA,
    name: "Nina Nobody",
    email: "nina@example.com",
    status: "active",
  },
];

const answer = async (url: string) => {
  if (url === "/v1/identity-keys")
    return {
      data: {
        data: [
          {
            id: KEY_ID,
            name: "rep_region",
            label: "regions",
            description: null,
          },
        ],
        next_cursor: null,
      },
    };
  if (url === `/v1/identity-keys/${KEY_ID}/values`)
    return {
      data: {
        data: [
          {
            id: "v1",
            key_id: KEY_ID,
            user_id: ADA,
            value: "Northwest",
            created_by: ADA,
            created_at: "2026-11-01T00:00:00Z",
          },
        ],
        next_cursor: null,
      },
    };
  if (url === `/v1/identity-keys/${KEY_ID}/missing`)
    return { data: { users: [{ user_id: NINA, via_grant_ids: ["g1"] }] } };
  if (url === "/v1/principals/all")
    return { data: { data: users, truncated: false } };
  throw new Error(`unexpected ${url}`);
};

const renderPage = () =>
  renderWithProviders(
    <Routes>
      <Route path="/identities/:keyId" element={<IdentityValuesPage />} />
    </Routes>,
    { route: `/identities/${KEY_ID}` }
  );

describe("parsePasted", () => {
  it("splits at the first tab or comma and keeps the rest of the value", () => {
    expect(
      parsePasted("a@x.com\tNorth, West\nb@x.com,East\n\nnope").bad
    ).toEqual(["nope"]);
    expect(parsePasted("a@x.com\tNorth, West").lines[0]).toMatchObject({
      email: "a@x.com",
      value: "North, West",
    });
  });
});

describe("IdentityValuesPage", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockReset();
    get.mockImplementation(answer);
    post.mockImplementation(async (url: string, body: unknown) =>
      url === "/v1/principals/lookup"
        ? {
            data: {
              data: (
                body as { principals: { type: string; id: string }[] }
              ).principals.map((p) => ({
                ...p,
                name: users.find((u) => u.id === p.id)?.name ?? null,
                status: "active",
              })),
            },
          }
        : { data: { data: [] } }
    );
  });

  it("lists the key's values", async () => {
    renderPage();
    expect(await screen.findByText("Northwest")).toBeInTheDocument();
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("sends the resolved lines in one call and lists the unresolved one", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Add values" }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/v1/principals/all", expect.anything())
    );
    await user.click(screen.getByLabelText("One person per line"));
    await user.paste(
      "ada@example.com, Northwest\nalan@example.com\tSoutheast\nghost@example.com, East"
    );
    const dialog = screen.getByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Add values" })
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/v1/identity-keys/${KEY_ID}/values`, {
        values: [
          { user_id: ADA, value: "Northwest" },
          { user_id: ALAN, value: "Southeast" },
        ],
      })
    );
    const valueCalls = post.mock.calls.filter(([url]) =>
      String(url).endsWith("/values")
    );
    expect(valueCalls).toHaveLength(1);
    const list = await within(dialog).findByRole("list");
    expect(list).toHaveTextContent("ghost@example.com, East");
  });

  it("filters to people missing a value", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Northwest");
    await user.click(screen.getByLabelText("Missing"));
    expect(await screen.findByText("Nina Nobody")).toBeInTheDocument();
    expect(screen.queryByText("Northwest")).toBeNull();
    expect(get).toHaveBeenCalledWith(`/v1/identity-keys/${KEY_ID}/missing`);
  });
});
