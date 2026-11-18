import { columnTypeName } from "./labels";
import {
  Alert,
  Badge,
  BorderedSection,
  FormGrid,
  Input,
  SearchSelect,
  Switch,
  Table,
} from "@kosmeo-ui/react";
import {
  FILE_COLUMN_TYPES,
  type ColumnCorrection,
  type FileColumnType,
  type PreviewColumn,
  type PreviewTable,
  type TableCorrection,
} from "../api/types";

/** What the person changed of one staged table; anything left out is as the preview proposed. */
export interface TableEdit {
  keep: boolean;
  name?: string;
  /** Undefined: the detected header row. */
  headerRow?: number | null;
  columns: Record<number, { name?: string; type?: FileColumnType }>;
}

export type Edits = Record<string, TableEdit>;

/** The query language's name shape, as zeteo checks it. */
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const NAME_RULE =
  "A lowercase letter, then lowercase letters, digits or _ (at most 63).";

export const nameProblem = (name: string): string | undefined =>
  NAME.test(name) ? undefined : NAME_RULE;

/** The edits the preview starts with: every table kept (or only `only`), types as `types` says where it names the column. */
export const initialEdits = (
  tables: PreviewTable[],
  { only, types }: { only?: string; types?: Map<string, FileColumnType> } = {}
): Edits =>
  Object.fromEntries(
    tables.map((t) => [
      t.key,
      {
        keep: only === undefined || t.key === only,
        columns: Object.fromEntries(
          t.columns
            .filter((c) => types?.has(c.name) && types.get(c.name) !== c.type)
            .map((c) => [c.index, { type: types!.get(c.name) }])
        ),
      },
    ])
  );

/** One table's corrections: only what differs from the preview. */
export const correctionOf = (
  table: PreviewTable,
  edit: TableEdit
): TableCorrection => {
  const columns: ColumnCorrection[] = table.columns.flatMap((c) => {
    const e = edit.columns[c.index];
    const name =
      e?.name !== undefined && e.name !== c.name ? e.name : undefined;
    const type =
      e?.type !== undefined && e.type !== c.type ? e.type : undefined;
    return name === undefined && type === undefined
      ? []
      : [
          {
            index: c.index,
            ...(name !== undefined && { name }),
            ...(type !== undefined && { type }),
          },
        ];
  });
  return {
    key: table.key,
    ...(edit.name !== undefined &&
      edit.name !== table.name && { name: edit.name }),
    ...(edit.headerRow !== undefined &&
      edit.headerRow !== table.header_row && { header_row: edit.headerRow }),
    ...(columns.length > 0 && { columns }),
  };
};

/** Whether every kept table's names are valid, and at least one is kept. */
export const editsValid = (tables: PreviewTable[], edits: Edits) => {
  const kept = tables.filter((t) => edits[t.key]?.keep);
  return (
    kept.length > 0 &&
    kept.every((t) => {
      const e = edits[t.key]!;
      return (
        (e.name === undefined || !nameProblem(e.name)) &&
        Object.values(e.columns).every(
          (c) => c.name === undefined || !nameProblem(c.name)
        )
      );
    })
  );
};

const KIND_NAMES: Record<PreviewTable["kind"], string> = {
  csv: "CSV",
  sheet: "Sheet",
  table: "Excel table",
};

interface HeaderChoice {
  id: string;
  label: string;
  row: number | null;
}

const HEADER_ROWS = 10;
const headerChoices: HeaderChoice[] = [
  { id: "none", label: "No header", row: null },
  ...Array.from({ length: HEADER_ROWS }, (_, i) => ({
    id: String(i),
    label: `Row ${i + 1}`,
    row: i,
  })),
];

interface TypeChoice {
  id: FileColumnType;
  label: string;
}
const typeChoices: TypeChoice[] = FILE_COLUMN_TYPES.map((t) => ({
  id: t,
  label: columnTypeName(t),
}));

interface PreviewEditorProps {
  tables: PreviewTable[];
  edits: Edits;
  onChange: (edits: Edits) => void;
  /** `one`: exactly one table is chosen (a re-upload), and its name is the existing table's. */
  mode?: "many" | "one";
}

/** The staged tables of an upload, to keep or leave out and correct before anything is created. */
export const PreviewEditor = ({
  tables,
  edits,
  onChange,
  mode = "many",
}: PreviewEditorProps) => {
  const set = (key: string, edit: TableEdit) =>
    onChange({ ...edits, [key]: edit });
  const choose = (key: string, keep: boolean) =>
    mode === "one"
      ? onChange(
          Object.fromEntries(
            Object.entries(edits).map(([k, e]) => [
              k,
              { ...e, keep: k === key ? keep : false },
            ])
          )
        )
      : set(key, { ...edits[key]!, keep });

  return (
    <>
      {tables.map((table) => {
        const edit = edits[table.key] ?? { keep: false, columns: {} };
        const name = edit.name ?? table.name;
        const headerRow =
          edit.headerRow !== undefined ? edit.headerRow : table.header_row;
        const headerChanged = headerRow !== table.header_row;
        const setColumn = (
          column: PreviewColumn,
          change: { name?: string; type?: FileColumnType }
        ) =>
          set(table.key, {
            ...edit,
            columns: {
              ...edit.columns,
              [column.index]: { ...edit.columns[column.index], ...change },
            },
          });
        return (
          <BorderedSection
            key={table.key}
            title={table.name}
            as="h2"
            actions={
              <Switch
                size="sm"
                label={mode === "one" ? "Use this table" : "Keep"}
                labelLocation="left"
                checked={edit.keep}
                onChange={(e) => choose(table.key, e.target.checked)}
              />
            }
          >
            <p className="z-fs-preview-meta">
              <Badge size="sm" variant="secondary">
                {KIND_NAMES[table.kind]}
              </Badge>
              <span>{table.row_count.toLocaleString()} rows</span>
            </p>
            {!edit.keep ? (
              <p className="z-note">
                {mode === "one" ? "Not used." : "Left out: it is not created."}
              </p>
            ) : (
              <>
                {table.warnings.map((w) => (
                  <Alert key={w} variant="warning">
                    {w}
                  </Alert>
                ))}
                <FormGrid columns={2}>
                  {mode === "many" && (
                    <Input
                      label="Table name"
                      value={name}
                      error={nameProblem(name)}
                      onChange={(e) =>
                        set(table.key, { ...edit, name: e.target.value })
                      }
                    />
                  )}
                  <SearchSelect<HeaderChoice>
                    label="Header row"
                    value={
                      headerChoices.find((c) => c.row === headerRow) ?? null
                    }
                    options={headerChoices}
                    getOptionLabel={(c) => c.label}
                    getOptionKey={(c) => c.id}
                    onSelect={(c) =>
                      set(table.key, { ...edit, headerRow: c.row })
                    }
                  />
                </FormGrid>
                {headerChanged && (
                  <p className="z-note">
                    Column names you have not typed come from the new header row
                    when you save, and the samples below are from the first
                    reading.
                  </p>
                )}
                <div className="z-fs-columns">
                  <Table<PreviewColumn>
                    rowKey={(c) => c.index}
                    rows={table.columns}
                    columns={[
                      {
                        title: "Column",
                        cellElement: (c) => {
                          const value = edit.columns[c.index]?.name ?? c.name;
                          return (
                            <Input
                              label={`Name of column ${c.index + 1}`}
                              value={value}
                              error={nameProblem(value)}
                              onChange={(e) =>
                                setColumn(c, { name: e.target.value })
                              }
                            />
                          );
                        },
                      },
                      {
                        title: "From header",
                        cellElement: (c) =>
                          c.original_name && c.original_name !== c.name ? (
                            c.original_name
                          ) : (
                            <span className="z-muted">—</span>
                          ),
                      },
                      {
                        title: "Type",
                        cellElement: (c) => {
                          const type = edit.columns[c.index]?.type ?? c.type;
                          return (
                            <SearchSelect<TypeChoice>
                              label={`Type of column ${c.index + 1}`}
                              value={
                                typeChoices.find((t) => t.id === type) ?? null
                              }
                              options={typeChoices}
                              getOptionLabel={(t) => t.label}
                              getOptionKey={(t) => t.id}
                              onSelect={(t) => setColumn(c, { type: t.id })}
                            />
                          );
                        },
                      },
                      {
                        title: "Sample values",
                        cellElement: (c) =>
                          c.samples.length > 0 ? (
                            <span className="z-fs-samples">
                              {c.samples.join(", ")}
                            </span>
                          ) : (
                            <span className="z-muted">Empty</span>
                          ),
                      },
                    ]}
                  />
                </div>
              </>
            )}
          </BorderedSection>
        );
      })}
    </>
  );
};
