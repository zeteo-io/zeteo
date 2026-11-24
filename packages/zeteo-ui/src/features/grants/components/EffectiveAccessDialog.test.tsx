import { USER_ID, GRANT_ID, GROUP_ID, makeGrant } from "../testFixtures";
import { EffectiveAccessDialog } from "./EffectiveAccessDialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { pickOption } from "@/test/searchSelect";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get, post } })
);

const effective = (over: object) => ({
  columns: "all",
  rows: "limited",
  rule_summary: "region is one of your regions",
  grants: [
    {
      grant_id: GRANT_ID,
      principal_type: "user",
      principal_id: USER_ID,
      row_access: "rule",
    },
    {
      grant_id: "g2",
      principal_type: "group",
      principal_id: GROUP_ID,
      row_access: "all",
    },
  ],
  warnings: [],
  organizations: [],
  ...over,
});

describe("EffectiveAccessDialog", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockImplementation(
      async (
        _url: string,
        body: { principals: { type: string; id: string }[] }
      ) => ({
        data: {
          data: body.principals.map((p) => ({
            ...p,
            name: p.type === "group" ? "Analysts" : "Ada Lovelace",
            status: "active",
          })),
        },
      })
    );
  });

  const show = (data: object) => {
    get.mockImplementation(async (url: string) => {
      if (url === "/v1/grants/effective") return { data };
      if (url === "/v1/identity-keys")
        return {
          data: {
            data: [
              {
                id: "k",
                name: "rep_region",
                label: "regions",
                description: null,
              },
            ],
            next_cursor: null,
          },
        };
      if (url.endsWith("/tables"))
        return {
          data: {
            data: [
              {
                id: "t2",
                schema_name: "public",
                name: "orders_eu",
                missing_since: null,
              },
            ],
            next_cursor: null,
          },
        };
      throw new Error(`unexpected ${url}`);
    });
    renderWithProviders(
      <EffectiveAccessDialog grant={makeGrant()} onClose={() => undefined} />
    );
  };

  it("asks for the grant's user and table, and shows rows and the rule", async () => {
    show(effective({}));
    expect(await screen.findByText("Only some rows")).toBeInTheDocument();
    expect(
      screen.getByText(/region is one of your regions/)
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/v1/grants/effective", {
      params: { user_id: USER_ID, table_id: makeGrant().table.id },
    });
  });

  it("words each warning", async () => {
    show(
      effective({
        warnings: [
          { code: "all_rows_overrides", grant_id: "g2" },
          { code: "missing_identity_value", key: "rep_region" },
          { code: "merged_members_limited", member_table_ids: ["t2"] },
          { code: "row_rule_unavailable", reason: "column_missing" },
        ],
      })
    );
    expect(
      await screen.findByText(
        "The grant to Analysts is All rows, so this user sees every row."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This user has no regions, so rules using it show them nothing."
      )
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "This user's access to public.orders_eu is limited differently from this merged table."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "A rule names a column that no longer exists; queries on this table are refused."
      )
    ).toBeInTheDocument();
  });

  it("asks again as signed in to an organization of the user's groups, and words a rule that does not apply", async () => {
    const ORG = "0rg00000-1c7a-4a53-9d0e-6a3b1f2c4d01";
    const inactive = {
      code: "org_scoped_rule_inactive",
      group_id: GROUP_ID,
      group_name: "West reps",
      organization_id: ORG,
      organization_name: "Acme",
    };
    show(
      effective({
        rows: "all",
        rule_summary: null,
        warnings: [inactive],
        organizations: [{ id: ORG, name: "Acme" }],
      })
    );
    expect(
      await screen.findByText(
        "A rule on West reps applies only when signed in to Acme; under this sign-in this user isn't limited by it."
      )
    ).toBeInTheDocument();
    await pickOption(
      userEvent.setup(),
      screen.getByLabelText("Signed in to"),
      "Acme"
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/v1/grants/effective", {
        params: {
          user_id: USER_ID,
          table_id: makeGrant().table.id,
          organization_id: ORG,
        },
      })
    );
  });

  it.each([
    [
      "too_many_values",
      "This user's rule resolves to too many values (or too many people report to them); queries on this table are refused.",
    ],
    [
      "hierarchy_unavailable",
      "Reporting lines couldn't be read from Tereo; queries using them are refused until it answers.",
    ],
  ])("words a rule unavailable for %s by its reason", async (reason, text) => {
    show(effective({ warnings: [{ code: "row_rule_unavailable", reason }] }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(
      screen.queryByText(/a column that no longer exists/)
    ).not.toBeInTheDocument();
  });
});
