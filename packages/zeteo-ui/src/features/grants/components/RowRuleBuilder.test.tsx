import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { RowRuleBuilder } from "./RowRuleBuilder";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { Group } from "../rowRuleModel";
import { useState } from "react";
import {
  emptyRule,
  locate,
  parseRule,
  toRule,
  newCondition,
  newGroup,
} from "../rowRuleModel";

const columns = [
  { name: "status", type: "text", inGrant: true },
  { name: "amount", type: "integer", inGrant: true },
  { name: "placed_on", type: "date", inGrant: true },
];

describe("row rule model", () => {
  it("round-trips builder rules", () => {
    const rules = [
      { status: { in: ["paid"] } },
      {
        or: [
          { amount: { between: [1, 5] } },
          {
            and: [{ status: { ne: "void" } }, { placed_on: { isNull: false } }],
          },
        ],
      },
      { placed_on: { gte: { relative: { unit: "day", offset: -90 } } } },
      { status: { notIn: { identity: "rep" } } },
    ];
    for (const rule of rules) {
      const draft = parseRule(rule);
      expect(draft).not.toBeNull();
      const out = toRule(draft!, columns);
      expect(out).toEqual(rule);
    }
  });

  it("does not parse what the builder cannot show", () => {
    expect(parseRule({ not: { status: { eq: "a" } } })).toBeNull();
    expect(
      parseRule({ and: [{ or: [{ and: [{ status: { eq: "a" } }] }] }] })
    ).toBeNull();
  });

  it("locates the condition an error path names", () => {
    const a = newCondition({ column: "status" });
    const b = newCondition({ column: "amount" });
    const root = newGroup([a, b]);
    expect(locate(root, ["row_rule", "and", 1, "amount"])).toBe(b.id);
    expect(locate(newGroup([a]), ["row_rule", "status"])).toBe(a.id);
  });
});

const Harness = ({ onRule }: { onRule: (g: Group) => void }) => {
  const [value, setValue] = useState<Group>(emptyRule());
  return (
    <RowRuleBuilder
      columns={columns}
      identityKeys={[{ name: "rep", label: "reps", description: null }]}
      value={value}
      onChange={(g) => {
        setValue(g);
        onRule(g);
      }}
    />
  );
};

describe("RowRuleBuilder", () => {
  it("toggles a group between AND and OR and adds conditions and groups", async () => {
    const user = userEvent.setup();
    const onRule = vi.fn();
    renderWithProviders(<Harness onRule={onRule} />);
    await user.click(screen.getByRole("button", { name: "OR" }));
    expect(onRule.mock.lastCall![0].mode).toBe("or");
    await user.click(screen.getByRole("button", { name: /Add condition/ }));
    expect(screen.getAllByLabelText("Column")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Add group/ }));
    expect(screen.getAllByLabelText("Column")).toHaveLength(3);
    // A nested group cannot nest further.
    expect(screen.getAllByRole("button", { name: /Add group/ })).toHaveLength(
      1
    );
    await user.click(screen.getByRole("button", { name: "Remove group" }));
    expect(screen.getAllByLabelText("Column")).toHaveLength(2);
  });

  it("removes a condition", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness onRule={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remove condition" }));
    expect(screen.queryByLabelText("Column")).not.toBeInTheDocument();
  });
});
