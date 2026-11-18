import { tableLabel, useTable, type Table } from "@/features/tables";
import { faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useDeclareRelation } from "../api/useDeclareRelation";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useState } from "react";
import "./styles.css";
import {
  BorderedSection,
  Button,
  Form,
  Input,
  Modal,
  SearchSelect,
  Switch,
} from "@kosmeo-ui/react";

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_PAIRS = 32;
const FORM_ID = "relation-form";

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
  /** How a table is named in the pickers: `schema.name` unless given. */
  getTableLabel?: (table: Table) => string;
}

const hasDuplicate = (values: string[]) =>
  new Set(values).size !== values.length;

export const RelationForm = ({
  sourceId,
  tables,
  onDeclared,
  onClose,
  getTableLabel = tableLabel,
}: RelationFormProps) => {
  const declare = useDeclareRelation(sourceId);
  const [name, setName] = useState("");
  const [fromTableId, setFromTableId] = useState("");
  const [toTableId, setToTableId] = useState("");
  const [pairs, setPairs] = useState<Pair[]>([{ from: "", to: "" }]);
  const [toMany, setToMany] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: fromTable, error: fromError } = useTable(
    sourceId,
    fromTableId || undefined
  );
  const { data: toTable, error: toError } = useTable(
    sourceId,
    toTableId || undefined
  );
  const columnOptions = (table: typeof fromTable) =>
    (table?.columns ?? []).filter((c) => !c.missing_since).map((c) => c.name);

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
    <Modal
      show
      title="Declare a relation"
      onClose={onClose}
      dismissible={!declare.isPending}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={declare.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="declare"
          type="submit"
          form={FORM_ID}
          fullWidth={false}
          isLoading={declare.isPending}
          disabled={declare.isPending}
        >
          Declare relation
        </Button>,
      ]}
    >
      <div className="z-relation-form">
        <Form id={FORM_ID} onSubmit={submit}>
          <Input
            label="Name"
            required
            value={name}
            error={errors.name}
            helperText="Unique on the from table."
            onChange={(e) => setName(e.target.value)}
          />
          <div className="z-relation-tables">
            <div>
              <SearchSelect<Table>
                label="From table"
                required
                placeholder="Search tables"
                value={tables.find((t) => t.id === fromTableId) ?? null}
                options={tables}
                getOptionLabel={getTableLabel}
                getOptionKey={(t) => t.id}
                longDropDown
                onSelect={(t) => chooseFromTable(t.id)}
              />
              {errors.from_table && <p role="alert">{errors.from_table}</p>}
              <ErrorNotice error={fromError} />
            </div>
            <div>
              <SearchSelect<Table>
                label="To table"
                required
                placeholder="Search tables"
                value={tables.find((t) => t.id === toTableId) ?? null}
                options={tables}
                getOptionLabel={getTableLabel}
                getOptionKey={(t) => t.id}
                longDropDown
                onSelect={(t) => chooseToTable(t.id)}
              />
              {errors.to_table && <p role="alert">{errors.to_table}</p>}
              <ErrorNotice error={toError} />
            </div>
          </div>

          <BorderedSection
            title="Columns"
            as="h3"
            actions={
              <div className="z-relation-columns-actions">
                <Switch
                  size="sm"
                  label="Each row has many matches"
                  labelLocation="left"
                  checked={toMany}
                  onChange={(e) => setToMany(e.target.checked)}
                />
                {pairs.length < MAX_PAIRS && (
                  <Button
                    size="sm"
                    variant="success"
                    fullWidth={false}
                    title="Add a column pair"
                    aria-label="Add column pair"
                    onClick={() =>
                      setPairs((all) => [...all, { from: "", to: "" }])
                    }
                  >
                    <FontAwesomeIcon icon={faPlus} />
                  </Button>
                )}
              </div>
            }
          >
            <div className="z-relation-pairs">
              {pairs.map((pair, index) => (
                <div className="z-relation-pair" key={index}>
                  <SearchSelect<string>
                    label={`From column ${index + 1}`}
                    placeholder="Search columns"
                    value={pair.from || null}
                    options={columnOptions(fromTable)}
                    getOptionLabel={(c) => c}
                    getOptionKey={(c) => c}
                    disabled={!fromTable}
                    onSelect={(from) => setPair(index, { from })}
                  />
                  <SearchSelect<string>
                    label={`To column ${index + 1}`}
                    placeholder="Search columns"
                    value={pair.to || null}
                    options={columnOptions(toTable)}
                    getOptionLabel={(c) => c}
                    getOptionKey={(c) => c}
                    disabled={!toTable}
                    onSelect={(to) => setPair(index, { to })}
                  />
                  {pairs.length > 1 && (
                    <div className="z-relation-remove">
                      <Button
                        variant="danger"
                        fullWidth={false}
                        title="Remove this column pair"
                        aria-label={`Remove column pair ${index + 1}`}
                        onClick={() =>
                          setPairs((all) => all.filter((_, i) => i !== index))
                        }
                      >
                        <FontAwesomeIcon icon={faTrash} />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {errors.pairs && <p role="alert">{errors.pairs}</p>}
            </div>
          </BorderedSection>

          <ErrorNotice error={declare.error} />
        </Form>
      </div>
    </Modal>
  );
};
