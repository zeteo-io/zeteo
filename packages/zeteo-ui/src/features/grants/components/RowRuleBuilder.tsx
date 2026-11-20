import { Button, Input, SearchSelect, Switch } from "@kosmeo-ui/react";
import { faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IdentityKey } from "@/features/identity";
import { useState } from "react";
import "./styles.css";
import {
  RELATIVE_UNIT_CHOICES,
  columnKind,
  newCondition,
  newGroup,
  type ColumnKind,
  type Condition,
  type Group,
  type Op,
  type RelativeUnitChoice,
  type RuleColumn,
} from "../rowRuleModel";

interface RowRuleBuilderProps {
  /** All of the table's columns; those the grant does not include are marked. */
  columns: RuleColumn[];
  identityKeys: IdentityKey[];
  value: Group;
  onChange: (value: Group) => void;
  /** The condition or group an `invalid_row_rule` error points at, and its message. */
  invalidId?: string | null;
  invalidMessage?: string;
}

interface OpChoice {
  id: string;
  label: string;
  op: Op;
  key: string;
}

const op = (o: Op, label: string): OpChoice => ({
  id: o,
  label,
  op: o,
  key: "",
});

const opsFor = (kind: ColumnKind, keys: IdentityKey[]): OpChoice[] => {
  const ordered = kind === "number" || kind === "date";
  const base: OpChoice[] =
    kind === "boolean"
      ? [op("eq", "is")]
      : [
          op("eq", "is"),
          op("ne", "is not"),
          ...(ordered
            ? [
                op("gt", kind === "date" ? "is after" : "is greater than"),
                op("gte", kind === "date" ? "is on or after" : "is at least"),
                op("lt", kind === "date" ? "is before" : "is less than"),
                op("lte", kind === "date" ? "is on or before" : "is at most"),
                op("between", "is between"),
              ]
            : []),
          op("in", "is one of"),
          op("notIn", "is none of"),
          ...(kind === "text"
            ? [op("contains", "contains"), op("startsWith", "starts with")]
            : []),
          ...(kind === "date" ? [op("last", "is in the last")] : []),
        ];
  return [
    ...base,
    op("empty", "is empty"),
    op("notEmpty", "is not empty"),
    ...keys.flatMap((k): OpChoice[] =>
      kind === "boolean"
        ? []
        : [
            {
              id: `mineIn:${k.name}`,
              label: `is one of my ${k.label}`,
              op: "mineIn",
              key: k.name,
            },
            {
              id: `mineNotIn:${k.name}`,
              label: `is none of my ${k.label}`,
              op: "mineNotIn",
              key: k.name,
            },
          ]
    ),
  ];
};

const UNIT_LABEL: Record<RelativeUnitChoice, string> = {
  day: "days",
  week: "weeks",
  month: "months",
  quarter: "quarters",
  year: "years",
};

const inputType = (kind: ColumnKind) =>
  kind === "number" ? "number" : kind === "date" ? "date" : "text";

/** Values typed one at a time and shown as removable chips. */
const ChipInput = ({
  label,
  values,
  type,
  onChange,
}: {
  label: string;
  values: string[];
  type: "text" | "number" | "date";
  onChange: (values: string[]) => void;
}) => {
  const [pending, setPending] = useState("");
  const add = () => {
    const v = pending.trim();
    setPending("");
    if (v && !values.includes(v)) onChange([...values, v]);
  };
  return (
    <div className="z-rule-chips">
      <Input
        label={label}
        type={type}
        value={pending}
        placeholder="Type a value and press Enter"
        onChange={(e) => setPending(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || (e.key === "," && type === "text")) {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
      {values.length > 0 && (
        <ul className="z-rule-chip-list">
          {values.map((v) => (
            <li key={v} className="z-rule-chip">
              {v}
              <button
                type="button"
                className="z-chip-clear"
                aria-label={`Remove ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface ConditionRowProps {
  condition: Condition;
  columns: RuleColumn[];
  identityKeys: IdentityKey[];
  invalidId?: string | null;
  invalidMessage?: string;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}

const ConditionRow = ({
  condition: c,
  columns,
  identityKeys,
  invalidId,
  invalidMessage,
  onChange,
  onRemove,
}: ConditionRowProps) => {
  const column = columns.find((x) => x.name === c.column);
  const kind = columnKind(column?.type);
  const choices = opsFor(kind, identityKeys);
  // A key the rule names that is not (or no longer) a key stays as the rule has it.
  const current =
    choices.find((o) => o.op === c.op && o.key === c.key) ??
    (c.op === "mineIn" || c.op === "mineNotIn"
      ? {
          id: `${c.op}:${c.key}`,
          label: `${c.op === "mineIn" ? "is one of" : "is none of"} my ${c.key}`,
          op: c.op,
          key: c.key,
        }
      : null);
  const options =
    current && !choices.includes(current) ? [current, ...choices] : choices;
  const type = inputType(kind);
  const invalid = invalidId === c.id;

  const chooseColumn = (name: string) => {
    const next = columns.find((x) => x.name === name);
    const stillThere = opsFor(columnKind(next?.type), identityKeys).some(
      (o) => o.op === c.op && o.key === c.key
    );
    onChange(
      stillThere
        ? { ...c, column: name }
        : newCondition({ id: c.id, column: name })
    );
  };

  const value = () => {
    switch (c.op) {
      case "empty":
      case "notEmpty":
      case "mineIn":
      case "mineNotIn":
        return null;
      case "in":
      case "notIn":
        return (
          <ChipInput
            label="Values"
            type={type}
            values={c.list}
            onChange={(list) => onChange({ ...c, list })}
          />
        );
      case "between":
        return (
          <div className="z-rule-between">
            <Input
              label="From"
              type={type}
              value={c.text}
              onChange={(e) => onChange({ ...c, text: e.target.value })}
            />
            <Input
              label="To"
              type={type}
              value={c.text2}
              onChange={(e) => onChange({ ...c, text2: e.target.value })}
            />
          </div>
        );
      case "last":
        return (
          <div className="z-rule-between">
            <Input
              label="Last"
              type="number"
              value={c.n}
              onChange={(e) => onChange({ ...c, n: e.target.value })}
            />
            <SearchSelect<RelativeUnitChoice>
              label="Unit"
              value={c.unit}
              options={RELATIVE_UNIT_CHOICES}
              getOptionLabel={(u) => UNIT_LABEL[u]}
              getOptionKey={(u) => u}
              onSelect={(unit) => onChange({ ...c, unit })}
            />
          </div>
        );
      default:
        return kind === "boolean" ? (
          <SearchSelect<string>
            label="Value"
            value={c.text || null}
            options={["true", "false"]}
            getOptionLabel={(v) => v}
            getOptionKey={(v) => v}
            onSelect={(text) => onChange({ ...c, text })}
          />
        ) : (
          <Input
            label="Value"
            type={type}
            value={c.text}
            onChange={(e) => onChange({ ...c, text: e.target.value })}
          />
        );
    }
  };

  return (
    <div
      className={`z-rule-condition${invalid ? " z-rule-invalid" : ""}`}
      data-invalid={invalid ? "true" : undefined}
    >
      <div className="z-rule-row">
        <SearchSelect<RuleColumn>
          label="Column"
          placeholder="Search columns"
          value={
            column ??
            (c.column ? { name: c.column, type: "", inGrant: true } : null)
          }
          options={columns}
          getOptionLabel={(x) =>
            x.inGrant ? x.name : `${x.name} (not in this grant)`
          }
          getOptionKey={(x) => x.name}
          longDropDown
          onSelect={(x) => chooseColumn(x.name)}
        />
        <SearchSelect<OpChoice>
          label="Operator"
          value={current}
          options={options}
          getOptionLabel={(o) => o.label}
          getOptionKey={(o) => o.id}
          disabled={!c.column}
          onSelect={(o) =>
            onChange({
              ...c,
              op: o.op,
              key: o.key,
              list: o.op === "in" || o.op === "notIn" ? c.list : [],
            })
          }
        />
        {value() ?? <div />}
        <div className="z-rule-remove">
          <Button
            variant="danger"
            fullWidth={false}
            title="Remove this condition"
            aria-label="Remove condition"
            onClick={onRemove}
          >
            <FontAwesomeIcon icon={faTrash} />
          </Button>
        </div>
      </div>
      {column && !column.inGrant && (
        <p className="z-muted z-rule-note">
          This column is not in the grant. People with the grant cannot see it,
          but the rule still limits their rows by it.
        </p>
      )}
      {invalid && invalidMessage && (
        <p role="alert" className="z-rule-error">
          {invalidMessage}
        </p>
      )}
    </div>
  );
};

const ModeToggle = ({
  group,
  onChange,
}: {
  group: Group;
  onChange: (mode: "and" | "or") => void;
}) => (
  <div className="z-rule-mode">
    <span className="z-muted">Match</span>
    <div className="z-segmented" role="group" aria-label={`Match mode`}>
      {(["and", "or"] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="z-segmented-option"
          aria-pressed={group.mode === m}
          onClick={() => onChange(m)}
        >
          {m === "and" ? "AND" : "OR"}
        </button>
      ))}
    </div>
    <span className="z-muted">
      {group.mode === "and" ? "all of these" : "any of these"}
    </span>
  </div>
);

interface GroupViewProps extends Omit<
  RowRuleBuilderProps,
  "value" | "onChange"
> {
  group: Group;
  nested: boolean;
  onChange: (g: Group) => void;
  onRemove?: () => void;
}

const GroupView = ({
  group,
  nested,
  columns,
  identityKeys,
  invalidId,
  invalidMessage,
  onChange,
  onRemove,
}: GroupViewProps) => {
  const setItem = (index: number, item: Condition | Group) =>
    onChange({
      ...group,
      items: group.items.map((x, i) => (i === index ? item : x)),
    });
  const removeItem = (index: number) =>
    onChange({ ...group, items: group.items.filter((_, i) => i !== index) });
  return (
    <div className={nested ? "z-rule-group z-rule-nested" : "z-rule-group"}>
      <div className="z-rule-group-head">
        <ModeToggle
          group={group}
          onChange={(mode) => onChange({ ...group, mode })}
        />
        {onRemove && (
          <Button
            variant="secondary"
            size="sm"
            fullWidth={false}
            aria-label="Remove group"
            onClick={onRemove}
          >
            Remove group
          </Button>
        )}
      </div>
      {group.items.map((item, index) =>
        item.kind === "group" ? (
          <GroupView
            key={item.id}
            group={item}
            nested
            columns={columns}
            identityKeys={identityKeys}
            invalidId={invalidId}
            invalidMessage={invalidMessage}
            onChange={(g) => setItem(index, g)}
            onRemove={() => removeItem(index)}
          />
        ) : (
          <ConditionRow
            key={item.id}
            condition={item}
            columns={columns}
            identityKeys={identityKeys}
            invalidId={invalidId}
            invalidMessage={invalidMessage}
            onChange={(c) => setItem(index, c)}
            onRemove={() => removeItem(index)}
          />
        )
      )}
      <div className="z-rule-add">
        <Button
          variant="secondary"
          size="sm"
          fullWidth={false}
          onClick={() =>
            onChange({ ...group, items: [...group.items, newCondition()] })
          }
        >
          <FontAwesomeIcon icon={faPlus} /> Add condition
        </Button>
        {!nested && (
          <Button
            variant="secondary"
            size="sm"
            fullWidth={false}
            onClick={() =>
              onChange({
                ...group,
                items: [...group.items, newGroup([newCondition()], "or")],
              })
            }
          >
            <FontAwesomeIcon icon={faPlus} /> Add group
          </Button>
        )}
      </div>
    </div>
  );
};

const usesIdentity = (g: Group): boolean =>
  g.items.some((i) =>
    i.kind === "group"
      ? usesIdentity(i)
      : i.op === "mineIn" || i.op === "mineNotIn"
  );

/**
 * Edits a row rule: groups of conditions, nested one level, each group
 * matching all (AND) or any (OR) of its conditions.
 */
export const RowRuleBuilder = ({
  columns,
  identityKeys,
  value,
  onChange,
  invalidId,
  invalidMessage,
}: RowRuleBuilderProps) => (
  <div className="z-rule-builder">
    <GroupView
      group={value}
      nested={false}
      columns={columns}
      identityKeys={identityKeys}
      invalidId={invalidId}
      invalidMessage={invalidMessage}
      onChange={onChange}
    />
    {usesIdentity(value) && (
      <Switch
        size="sm"
        label="Include people who report to me (coming soon)"
        checked={false}
        disabled
        onChange={() => undefined}
      />
    )}
  </div>
);
