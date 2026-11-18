import { parseWho, whoFilter, whoId } from "./whoFilter";
import type { Principal } from "./api/usePrincipalNames";
import { describe, expect, it } from "vitest";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const U3 = "00000000-0000-4000-8000-000000000003";
const G1 = "00000000-0000-4000-8000-0000000000a1";

const directory: Principal[] = [
  { type: "user", id: U1, name: "zoe", email: "z@x.test", status: "active" },
  { type: "group", id: G1, name: "Analysts", status: "active" },
  { type: "user", id: U2, name: null, email: "bea@x.test", status: "active" },
  { type: "user", id: U3, name: null, email: null, status: "orphaned" },
];

describe("whoFilter", () => {
  it("is a SELECT keyed who, titled Who, its options sorted by name, groups marked, a missing name falling back to email then Unknown", () => {
    const filter = whoFilter(directory);
    expect(filter).toMatchObject({
      type: "SELECT",
      title: "Who",
      dataKey: "who",
    });
    expect(filter.type === "SELECT" && filter.options).toEqual([
      { id: `group:${G1}`, name: "Analysts (group)", selected: false },
      { id: `user:${U2}`, name: "bea@x.test", selected: false },
      { id: `user:${U3}`, name: "Unknown user", selected: false },
      { id: `user:${U1}`, name: "zoe", selected: false },
    ]);
  });

  it("takes a title and a data key, and keeps only the kinds asked for", () => {
    const filter = whoFilter(directory, {
      title: "Owner",
      dataKey: "owner",
      only: ["user"],
    });
    expect(filter).toMatchObject({ title: "Owner", dataKey: "owner" });
    expect(filter.type === "SELECT" && filter.options.map((o) => o.id)).toEqual(
      [`user:${U2}`, `user:${U3}`, `user:${U1}`]
    );
  });

  it("starts with the selected option chosen", () => {
    const filter = whoFilter(directory, { selected: whoId("group", G1) });
    expect(
      filter.type === "SELECT" &&
        filter.options.filter((o) => o.selected).map((o) => o.id)
    ).toEqual([`group:${G1}`]);
  });

  it("adds a selected principal the directory does not list, as unknown, so a deep link keeps it", () => {
    const gone = "00000000-0000-4000-8000-0000000000ff";
    const filter = whoFilter(directory, { selected: whoId("group", gone) });
    expect(filter.type === "SELECT" && filter.options.at(-1)).toEqual({
      id: `group:${gone}`,
      name: "Unknown group (group)",
      selected: true,
    });
  });

  it("is equal for the same directory and selection, so memoizing on them is safe", () => {
    expect(whoFilter(directory, { selected: whoId("user", U1) })).toEqual(
      whoFilter([...directory], { selected: whoId("user", U1) })
    );
  });
});

describe("parseWho", () => {
  it("reads filter[who] as principal_type and principal_id", () => {
    expect(parseWho({ "filter[who]": `group:${G1}` })).toEqual({
      principal_type: "group",
      principal_id: G1,
    });
  });

  it("reads another data key", () => {
    expect(parseWho({ "filter[owner]": `user:${U1}` }, "owner")).toEqual({
      principal_type: "user",
      principal_id: U1,
    });
    expect(parseWho({ "filter[who]": `user:${U1}` }, "owner")).toEqual({});
  });

  it.each([
    ["nothing chosen", {}],
    ["an empty value", { "filter[who]": "" }],
    ["no type", { "filter[who]": `:${U1}` }],
    ["no id", { "filter[who]": "user:" }],
    ["an unknown type", { "filter[who]": `robot:${U1}` }],
  ])("is {} for %s", (_, params) => {
    expect(parseWho(params)).toEqual({});
  });
});
