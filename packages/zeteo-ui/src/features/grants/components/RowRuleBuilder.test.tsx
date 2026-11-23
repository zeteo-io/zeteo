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

  it("re-saves loaded numbers and decimal strings exactly as they were", () => {
    const rules = [
      { amount: { eq: "12345678901234567891" } },
      { amount: { eq: 5 } },
      { amount: { eq: "5" } },
      { amount: { in: ["12345678901234567891", 7, "0.10"] } },
      { amount: { notIn: ["9007199254740993", "8"] } },
      { amount: { between: ["12345678901234567891", "99999999999999999999"] } },
      { amount: { between: [1.5, "2.50"] } },
      // A column the page does not know: the loaded value decides.
      { other: { gte: "12345678901234567891" } },
    ];
    for (const rule of rules) {
      expect(toRule(parseRule(rule)!, columns)).toEqual(rule);
    }
  });

  it("never sends a number that loses precision", () => {
    const at = (text: string, extra: object = {}) =>
      toRule(
        newGroup([newCondition({ column: "amount", text, ...extra })]),
        columns
      );
    expect(at("12345678901234567891")).toEqual({
      amount: { eq: "12345678901234567891" },
    });
    expect(at("9007199254740993")).toEqual({
      amount: { eq: "9007199254740993" },
    });
    expect(at("42")).toEqual({ amount: { eq: 42 } });
    expect(at("-1.25")).toEqual({ amount: { eq: -1.25 } });
    expect(at("0.10")).toEqual({ amount: { eq: "0.10" } });
    expect(at("1e30")).toEqual({ amount: { eq: "1e30" } });
    expect(
      toRule(
        newGroup([
          newCondition({
            column: "amount",
            op: "in",
            list: ["12345678901234567891", "3"],
          }),
        ]),
        columns
      )
    ).toEqual({ amount: { in: ["12345678901234567891", 3] } });
    expect(
      toRule(
        newGroup([
          newCondition({
            column: "amount",
            op: "between",
            text: "1",
            text2: "12345678901234567891",
          }),
        ]),
        columns
      )
    ).toEqual({ amount: { between: [1, "12345678901234567891"] } });
  });

  it("saves an edited value by the column's type, not the loaded one", () => {
    const draft = parseRule({ amount: { eq: 5 } })!;
    const c = draft.items[0] as ReturnType<typeof newCondition>;
    const edited = newGroup([{ ...c, text: "12345678901234567891" }]);
    expect(toRule(edited, columns)).toEqual({
      amount: { eq: "12345678901234567891" },
    });
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

  it("says when the identity options could not be loaded", () => {
    renderWithProviders(
      <RowRuleBuilder
        columns={columns}
        identityKeys={[]}
        identityError
        value={emptyRule()}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /identity options could not be loaded/
    );
  });

  it("stops a list at 1,000 values and says so", () => {
    const list = Array.from({ length: 1000 }, (_, i) => `v${i}`);
    const onChange = vi.fn();
    const rule = newGroup([newCondition({ column: "status", op: "in", list })]);
    renderWithProviders(
      <RowRuleBuilder
        columns={columns}
        identityKeys={[]}
        value={rule}
        onChange={onChange}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/up to 1,000 values/);
    return userEvent
      .setup()
      .type(screen.getByLabelText("Values"), "one more{Enter}")
      .then(() => expect(onChange).not.toHaveBeenCalled());
  });
});
