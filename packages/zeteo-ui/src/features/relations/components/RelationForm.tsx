import { tableLabel, useTable, type Table } from "@/features/tables";
import { useDeclareRelation } from "../api/useDeclareRelation";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useState } from "react";
import "./styles.css";
import {
  Button,
  Checkbox,
  Form,
  FormActions,
  Input,
  Select,
} from "@kosmeo-ui/react";

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_PAIRS = 32;

interface Pair {
  from: string;
  to: string;
}

interface RelationFormProps {
  sourceId: string;
  /** Tables to choose from: the caller leaves out missing ones. */
  tables: Table[];
  onDeclared: () => void;
  onClose: () => void;
}

const hasDuplicate = (values: string[]) =>
  new Set(values).size !== values.length;

export const RelationForm = ({
  sourceId,
  tables,
  onDeclared,
  onClose,
}: RelationFormProps) => {
  const declare = useDeclareRelation(sourceId);
  const [name, setName] = useState("");
  const [fromTableId, setFromTableId] = useState("");
  const [toTableId, setToTableId] = useState("");
  const [pairs, setPairs] = useState<Pair[]>([{ from: "", to: "" }]);
  const [toMany, setToMany] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fromTable = useTable(sourceId, fromTableId || undefined).data;
  const toTable = useTable(sourceId, toTableId || undefined).data;
  const tableOptions = tables.map((t) => ({
    value: t.id,
    label: tableLabel(t),
  }));
  const columnOptions = (table: typeof fromTable) =>
    (table?.columns ?? [])
      .filter((c) => !c.missing_since)
      .map((c) => ({ value: c.name, label: c.name }));

  const setPair = (index: number, patch: Partial<Pair>) =>
    setPairs((all) =>
      all.map((p, i) => (i === index ? { ...p, ...patch } : p))
    );

  const chooseFromTable = (id: string) => {
    setFromTableId(id);
    setPairs((all) => all.map((p) => ({ ...p, from: "" })));
  };
  const chooseToTable = (id: string) => {
    setToTableId(id);
    setPairs((all) => all.map((p) => ({ ...p, to: "" })));
  };

  const validate = () => {
    const found: Record<string, string> = {};
    if (!NAME.test(name)) {
      found.name =
        "Use lower case letters, digits and underscores, starting with a letter (1 to 63 characters).";
    }
    if (!fromTableId)
      found.from_table = "Choose the table the relation starts at.";
    if (!toTableId) found.to_table = "Choose the table it points to.";
    if (pairs.some((p) => !p.from || !p.to)) {
      found.pairs = "Choose a column on both sides of every column pair.";
    } else if (
      hasDuplicate(pairs.map((p) => p.from)) ||
      hasDuplicate(pairs.map((p) => p.to))
    ) {
      found.pairs = "A column cannot be used more than once on the same side.";
    }
    return found;
  };

  const submit = () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    declare.mutate(
      {
        name,
        from_table_id: fromTableId,
        from_columns: pairs.map((p) => p.from),
        to_table_id: toTableId,
        to_columns: pairs.map((p) => p.to),
        to_many: toMany,
      },
      { onSuccess: onDeclared }
    );
  };

  return (
    <div className="z-relation-form">
      <h2>Declare a relation</h2>
      <Form onSubmit={submit}>
        <Input
          label="Name"
          required
          value={name}
          error={errors.name}
          helperText="Unique on the from table."
          onChange={(e) => setName(e.target.value)}
        />
        <Select
          label="From table"
          required
          placeholder="Choose a table"
          value={fromTableId}
          options={tableOptions}
          onChange={(id) => chooseFromTable(id ?? "")}
        />
        {errors.from_table && <p role="alert">{errors.from_table}</p>}
        <Select
          label="To table"
          required
          placeholder="Choose a table"
          value={toTableId}
          options={tableOptions}
          onChange={(id) => chooseToTable(id ?? "")}
        />
        {errors.to_table && <p role="alert">{errors.to_table}</p>}

        <div className="z-relation-pairs">
          {pairs.map((pair, index) => (
            <div className="z-relation-pair" key={index}>
              <Select
                label={`From column ${index + 1}`}
                placeholder="Choose a column"
                value={pair.from}
                options={columnOptions(fromTable)}
                disabled={!fromTable}
                onChange={(from) => setPair(index, { from: from ?? "" })}
              />
              <Select
                label={`To column ${index + 1}`}
                placeholder="Choose a column"
                value={pair.to}
                options={columnOptions(toTable)}
                disabled={!toTable}
                onChange={(to) => setPair(index, { to: to ?? "" })}
              />
              {pairs.length > 1 && (
                <Button
                  variant="secondary"
                  fullWidth={false}
                  aria-label={`Remove column pair ${index + 1}`}
                  onClick={() =>
                    setPairs((all) => all.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {errors.pairs && <p role="alert">{errors.pairs}</p>}
          {pairs.length < MAX_PAIRS && (
            <div>
              <Button
                variant="secondary"
                fullWidth={false}
                onClick={() =>
                  setPairs((all) => [...all, { from: "", to: "" }])
                }
              >
                Add column pair
              </Button>
            </div>
          )}
        </div>

        <Checkbox
          label="Each row has many matches"
          checked={toMany}
          onChange={(e) => setToMany(e.target.checked)}
        />
        <ErrorNotice error={declare.error} />
        <FormActions>
          <Button variant="secondary" fullWidth={false} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            fullWidth={false}
            isLoading={declare.isPending}
            disabled={declare.isPending}
          >
            Declare relation
          </Button>
        </FormActions>
      </Form>
    </div>
  );
};
