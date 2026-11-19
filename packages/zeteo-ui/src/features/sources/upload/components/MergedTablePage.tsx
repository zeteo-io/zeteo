import { BorderedSection, Button, Input, Spinner } from "@kosmeo-ui/react";
import { useMergedColumns, useSaveMergedTable } from "../api/merged";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isUploadType } from "../../components/sourceLabels";
import type { MergedDetail, Table } from "@/features/tables";
import { sourceHref } from "../../components/sourceLabels";
import { useAllTables, useTable } from "@/features/tables";
import { clashes, MergedColumns } from "./MergedColumns";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { useSource } from "../../api/useSource";
import { useNavigate } from "react-router-dom";
import type { Source } from "../../api/types";
import "./styles.css";

const FORM_ID = "z-merged-form";
const DEFAULT_LABEL_COLUMN = "source";

/** What an edit starts from: the table's definition as it is. */
interface Existing {
  tableId: string;
  name: string;
  merged: MergedDetail;
}

interface EditorProps {
  source: Source;
  existing?: Existing;
}

/** Create or edit a merged table: its members and labels, and which of their columns it carries. */
export const MergedTableEditor = ({ source, existing }: EditorProps) => {
  const navigate = useNavigate();
  const { tables } = useAllTables(source.id, { includeMissing: false });
  const candidates = tables.filter(
    (t: Table) => !t.missing_since && t.origin?.kind !== "merged"
  );
  const startLabels = Object.fromEntries(
    (existing?.merged.members ?? [])
      .filter((m) => !m.missing)
      .map((m) => [m.table_id, m.label])
  );

  const [name, setName] = useState(existing?.name ?? "");
  const [labelColumn, setLabelColumn] = useState(
    existing?.merged.label_column ?? DEFAULT_LABEL_COLUMN
  );
  const [chosen, setChosen] = useState<Set<string>>(
    new Set(Object.keys(startLabels))
  );
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});

  const memberIds = candidates.filter((t) => chosen.has(t.id)).map((t) => t.id);
  const union = useMergedColumns(source.id, memberIds);
  const columns = memberIds.length >= 2 ? (union.data?.columns ?? []) : [];

  const labelOf = (id: string) =>
    labels[id] ?? startLabels[id] ?? union.data?.labels[id] ?? "";
  const existingNames = new Set(
    (existing?.merged.columns ?? [])
      .filter((c) => !c.missing)
      .map((c) => c.name)
  );
  const isIncluded = (c: { name: string; members: string[] }) =>
    included[c.name] ??
    (existing
      ? existingNames.has(c.name)
      : c.members.length === memberIds.length);
  const nameOf = (c: { name: string }) => names[c.name] ?? c.name;

  const nameProblems = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of columns) {
    if (!isIncluded(c)) continue;
    const n = nameOf(c).trim();
    if (n === "") nameProblems.set(c.name, "Give the column a name.");
    else if (seen.has(n) || n === labelColumn.trim())
      nameProblems.set(c.name, "Another column has this name.");
    seen.add(n);
  }

  const save = useSaveMergedTable(source.id, existing?.tableId);
  const failureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (save.error) {
      failureRef.current?.scrollIntoView?.({
        block: "start",
        behavior: "smooth",
      });
    }
  }, [save.error]);

  const ready =
    name.trim() !== "" &&
    labelColumn.trim() !== "" &&
    memberIds.length >= 2 &&
    memberIds.every((id) => labelOf(id).trim() !== "") &&
    columns.length > 0 &&
    nameProblems.size === 0;

  const submit = () => {
    if (!ready || save.isPending) return;
    save.mutate(
      {
        name: name.trim(),
        label_column: labelColumn.trim(),
        members: memberIds.map((id) => ({
          table_id: id,
          label: labelOf(id).trim(),
        })),
        columns: columns.map((c) => ({
          name: nameOf(c).trim(),
          from_name: c.name,
          include: isIncluded(c),
        })),
      },
      { onSuccess: (t) => navigate(`${sourceHref(source.id)}/tables/${t.id}`) }
    );
  };

  const back = existing
    ? `${sourceHref(source.id)}/tables/${existing.tableId}`
    : `${sourceHref(source.id)}/tables`;
  const toggle = (id: string, on: boolean) =>
    setChosen((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="z-fs-form-page">
      <PageHeader
        title={existing ? "Edit merged table" : "Add merged table"}
        divider={false}
        actions={
          <div className="z-header-actions">
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => navigate(back)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              form={FORM_ID}
              fullWidth={false}
              isLoading={save.isPending}
              disabled={!ready || save.isPending}
            >
              Save
            </Button>
          </div>
        }
      />
      <form
        id={FORM_ID}
        className="z-fs-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {save.error && (
          <div ref={failureRef}>
            <ErrorNotice error={save.error} />
          </div>
        )}
        <BorderedSection title="About" as="h2">
          <div className="z-merged-about">
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label="Label column"
              value={labelColumn}
              helperText="Each row carries the label of the table it came from in this column."
              onChange={(e) => setLabelColumn(e.target.value)}
            />
          </div>
        </BorderedSection>

        <BorderedSection title="Tables to merge" as="h2">
          {candidates.length < 2 ? (
            <p className="z-note">
              A merged table needs at least two tables that are not themselves
              merged.
            </p>
          ) : (
            <ul className="z-merged-members">
              {candidates.map((t) => (
                <li key={t.id}>
                  <label className="z-merged-pick">
                    <input
                      type="checkbox"
                      checked={chosen.has(t.id)}
                      onChange={(e) => toggle(t.id, e.target.checked)}
                    />
                    <span>{t.name}</span>
                  </label>
                  {chosen.has(t.id) && (
                    <Input
                      aria-label={`Label for ${t.name}`}
                      value={labelOf(t.id)}
                      onChange={(e) =>
                        setLabels((l) => ({ ...l, [t.id]: e.target.value }))
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {memberIds.length === 1 && (
            <p className="z-note">Choose at least two tables.</p>
          )}
        </BorderedSection>

        {memberIds.length >= 2 && (
          <BorderedSection title="Columns" as="h2">
            {union.isLoading ? (
              <Spinner size="md" />
            ) : (
              <>
                <ErrorNotice error={union.error} />
                <MergedColumns
                  columns={columns}
                  memberCount={memberIds.length}
                  isIncluded={isIncluded}
                  nameOf={nameOf}
                  problemOf={(c) => nameProblems.get(c.name)}
                  onInclude={(c, on) =>
                    setIncluded((i) => ({ ...i, [c.name]: on }))
                  }
                  onRename={(c, n) => setNames((m) => ({ ...m, [c.name]: n }))}
                />
                {columns.some(clashes) && (
                  <p className="z-note">
                    A column whose members disagree on the type is stored as
                    text.
                  </p>
                )}
              </>
            )}
          </BorderedSection>
        )}
      </form>
    </div>
  );
};

/** Loads the upload source the editor works in. */
const WithSource = ({
  children,
}: {
  children: (source: Source) => ReactNode;
}) => {
  const id = useUuidParam("sourceId");
  const { data, error, isLoading } = useSource(id ?? "");
  if (!id) return <NotFound />;
  if (isLoading) return <Spinner size="lg" />;
  if (!data) return <ErrorNotice error={error} />;
  if (!isUploadType(data.type)) return <NotFound />;
  return <>{children(data)}</>;
};

export const MergedTableNewPage = () => (
  <WithSource>{(source) => <MergedTableEditor source={source} />}</WithSource>
);

const EditLoader = ({ source }: { source: Source }) => {
  const tableId = useUuidParam("tableId");
  const { data, error, isLoading } = useTable(source.id, tableId);
  if (!tableId) return <NotFound />;
  if (isLoading) return <Spinner size="lg" />;
  if (!data) return <ErrorNotice error={error} />;
  if (!data.merged || data.missing_since) return <NotFound />;
  return (
    <MergedTableEditor
      key={tableId}
      source={source}
      existing={{ tableId, name: data.name, merged: data.merged }}
    />
  );
};

export const MergedTableEditPage = () => (
  <WithSource>{(source) => <EditLoader source={source} />}</WithSource>
);
