import type { Measure, MeasureInput, PreviewResult } from "../api/types";
import { fieldErrors, type MeasureField } from "./fieldErrors";
import { usePreviewMeasure } from "../api/usePreviewMeasure";
import { useMemo, useState, type ReactNode } from "react";
import { useSaveMeasure } from "../api/useSaveMeasure";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useAllTables } from "@/features/tables";
import type { ApiError } from "@/lib/api";
import "./styles.css";
import {
  BorderedSection,
  Button,
  Form,
  Input,
  Modal,
  SearchSelect,
  TextArea,
} from "@kosmeo-ui/react";

const FORM_ID = "measure-form";
const NAME = /^[a-z][a-z0-9_]{0,62}$/;

const pretty = (value: unknown) =>
  value === null || value === undefined ? "" : JSON.stringify(value, null, 2);

type Parsed = { ok: true; value: unknown } | { ok: false };
const parse = (text: string): Parsed => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const Field = ({
  name,
  error,
  children,
}: {
  name: MeasureField;
  error?: string | undefined;
  children: ReactNode;
}) => (
  <div data-field={name}>
    {children}
    {error && (
      <p className="z-measure-field-error" role="alert">
        {error}
      </p>
    )}
  </div>
);

const Preview = ({ result }: { result: PreviewResult }) => {
  const single = result.columns.length === 1 && result.rows.length === 1;
  const show = (v: unknown) =>
    typeof v === "number" ? v.toLocaleString() : v === null ? "—" : String(v);
  return (
    <div className="z-measure-preview">
      {single ? (
        <strong
          className="z-measure-preview-value"
          data-testid="measure-preview-value"
        >
          {show(result.rows[0]![0])}
        </strong>
      ) : result.rows.length === 0 ? (
        <span className="z-muted">No rows.</span>
      ) : (
        <table>
          <thead>
            <tr>
              {result.columns.map((c) => (
                <th key={c.name}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j}>{show(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.truncated && (
        <small className="z-muted">Rows were cut off.</small>
      )}
    </div>
  );
};

interface MeasureDialogProps {
  sourceId: string;
  /** The measure to change; absent to create one. */
  measure?: Measure;
  onClose: () => void;
}

/** Creating or changing a measure: its definition as JSON, checked by the server, and a preview that runs the draft. */
export const MeasureDialog = ({
  sourceId,
  measure,
  onClose,
}: MeasureDialogProps) => {
  const save = useSaveMeasure(sourceId);
  const preview = usePreviewMeasure(sourceId);
  const {
    tables,
    isLoading: tablesLoading,
    error: tablesError,
  } = useAllTables(sourceId, {
    includeMissing: false,
  });
  const [name, setName] = useState(measure?.name ?? "");
  const [table, setTable] = useState(measure?.table ?? "");
  const [description, setDescription] = useState(measure?.description ?? "");
  const [formula, setFormula] = useState(pretty(measure?.formula));
  const [where, setWhere] = useState(pretty(measure?.where));
  const [local, setLocal] = useState<Partial<Record<MeasureField, string>>>({});
  const [failure, setFailure] = useState<ApiError | null>(null);

  // A table is named as a query names it: bare, or `schema.name` where the bare name is not unique.
  const tableNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tables) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    return tables
      .map((t) =>
        counts.get(t.name) === 1 ? t.name : `${t.schema_name}.${t.name}`
      )
      .sort((a, b) => a.localeCompare(b));
  }, [tables]);
  const options =
    table && !tableNames.includes(table) ? [table, ...tableNames] : tableNames;

  const busy = save.isPending;

  /** The draft as the API takes it, or the problems with its text. */
  const draft = ():
    | { input: MeasureInput }
    | { problems: Partial<Record<MeasureField, string>> } => {
    const problems: Partial<Record<MeasureField, string>> = {};
    if (!NAME.test(name)) {
      problems.name =
        "Use lower case letters, digits and underscores, starting with a letter (1 to 63 characters).";
    }
    if (!table)
      problems.table = "Choose the table the measure is computed from.";
    if (!description.trim())
      problems.description = "Say what the measure means.";
    const f = parse(formula);
    if (!formula.trim() || !f.ok)
      problems.formula = "The formula is not valid JSON.";
    const w = where.trim() === "" ? undefined : parse(where);
    if (w && !w.ok) problems.where = "The filter is not valid JSON.";
    if (Object.keys(problems).length > 0) return { problems };
    return {
      input: {
        name,
        description: description.trim(),
        table,
        formula: (f as { value: unknown }).value,
        ...(w?.ok && { where: w.value }),
      },
    };
  };

  const submit = () => {
    const d = draft();
    setFailure(null);
    if ("problems" in d) {
      setLocal(d.problems);
      return;
    }
    setLocal({});
    const input = d.input;
    if (!measure) {
      save.mutate({ body: input }, { onSuccess: onClose, onError: setFailure });
      return;
    }
    const body: Partial<MeasureInput> & { where?: unknown } = {};
    if (input.name !== measure.name) body.name = input.name;
    if (input.description !== measure.description)
      body.description = input.description;
    if (input.table !== measure.table) body.table = input.table;
    if (JSON.stringify(input.formula) !== JSON.stringify(measure.formula))
      body.formula = input.formula;
    if (
      JSON.stringify(input.where ?? null) !==
      JSON.stringify(measure.where ?? null)
    ) {
      body.where = input.where ?? null;
    }
    if (Object.keys(body).length === 0) return onClose();
    save.mutate(
      { id: measure.id, body },
      { onSuccess: onClose, onError: setFailure }
    );
  };

  const runPreview = () => {
    const d = draft();
    if ("problems" in d) {
      setLocal(d.problems);
      return;
    }
    setLocal({});
    preview.mutate(d.input);
  };

  const server = fieldErrors(failure);
  const err = (f: MeasureField) => local[f] ?? server[f];

  return (
    <Modal
      show
      title={measure ? "Edit measure" : "New measure"}
      onClose={onClose}
      dismissible={!busy}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="preview"
          variant="secondary"
          fullWidth={false}
          isLoading={preview.isPending}
          disabled={busy || preview.isPending}
          onClick={runPreview}
        >
          Preview
        </Button>,
        <Button
          key="save"
          type="submit"
          form={FORM_ID}
          fullWidth={false}
          isLoading={busy}
          disabled={busy}
        >
          Save
        </Button>,
      ]}
    >
      <div className="z-measure-form">
        <Form id={FORM_ID} onSubmit={submit}>
          <Field name="name" error={err("name")}>
            <Input
              label="Name"
              required
              value={name}
              helperText="Unique in the source; queries refer to it as { measure: name }."
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field name="table" error={err("table")}>
            <SearchSelect<string>
              label="Table"
              required
              placeholder="Search tables"
              value={table || null}
              options={options}
              getOptionLabel={(t) => t}
              getOptionKey={(t) => t}
              disabled={tablesLoading}
              longDropDown
              onSelect={setTable}
            />
            <ErrorNotice error={tablesError} />
          </Field>
          <Field name="description" error={err("description")}>
            <TextArea
              label="Description"
              required
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field name="formula" error={err("formula")}>
            <div className="z-measure-json">
              <TextArea
                label="Formula (JSON)"
                required
                rows={6}
                value={formula}
                onChange={(e) => setFormula(e.target.value)}
              />
            </div>
          </Field>
          <Field name="where" error={err("where")}>
            <div className="z-measure-json">
              <TextArea
                label="Where (JSON, optional)"
                rows={3}
                value={where}
                onChange={(e) => setWhere(e.target.value)}
              />
            </div>
          </Field>
          {(preview.data || preview.error) && (
            <BorderedSection title="Preview" as="h3">
              {preview.data && <Preview result={preview.data} />}
              <ErrorNotice error={preview.error} />
            </BorderedSection>
          )}
          {Object.keys(server).length === 0 && <ErrorNotice error={failure} />}
        </Form>
      </div>
    </Modal>
  );
};
