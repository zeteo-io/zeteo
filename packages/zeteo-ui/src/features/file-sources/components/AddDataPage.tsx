import { fileSourceHref, MY_DATA_HREF } from "./labels";
import type { FileSource, Staging } from "../api/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { LoadFailure } from "./CastFailedNotice";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import "./styles.css";
import {
  useAddTables,
  useCreateFileSource,
  useFileSource,
  useReuploadTable,
  useUploadFile,
} from "../api/fileSources";
import {
  BorderedSection,
  Button,
  FileDropZone,
  FormGrid,
  Input,
  Spinner,
} from "@kosmeo-ui/react";
import {
  correctionOf,
  editsValid,
  initialEdits,
  PreviewEditor,
  type Edits,
} from "./PreviewEditor";

const ACCEPT = ".csv,.xlsx";
const FORM_ID = "z-fs-form";

const SLUG = /^[a-z][a-z0-9-]{1,62}$/;

/** A file's name without its extension: "Q3 sales.xlsx" → "Q3 sales". */
const baseName = (file: string) => file.replace(/\.[^.]+$/, "");

type Mode =
  | { kind: "create" }
  | { kind: "add"; source: FileSource }
  | { kind: "reupload"; source: FileSource; tableId: string };

/** Step one: choose a file; it is staged and its preview comes back. */
const FilePicker = ({
  onStaged,
}: {
  onStaged: (staging: Staging, fileName: string) => void;
}) => {
  const upload = useUploadFile();
  const [problem, setProblem] = useState<string | null>(null);
  const send = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setProblem(null);
    upload.mutate(file, { onSuccess: (s) => onStaged(s, file.name) });
  };
  return (
    <BorderedSection title="File" as="h2">
      {upload.isPending ? (
        <div className="z-fs-reading">
          <Spinner size="md" />
          <span>Reading the file…</span>
        </div>
      ) : (
        <FileDropZone
          accept={ACCEPT}
          maxFiles={1}
          label="Drop a CSV or Excel (.xlsx) file here"
          onFilesSelected={send}
          onError={setProblem}
        />
      )}
      <p className="z-note">
        You check the tables, names and types it finds before anything is
        created.
      </p>
      {problem && <p className="z-fs-problem">{problem}</p>}
      <ErrorNotice error={upload.error} />
    </BorderedSection>
  );
};

/** Upload a file, check its preview, then create a source, add tables or replace one table's data. */
const AddData = ({ mode }: { mode: Mode }) => {
  const navigate = useNavigate();
  const [staging, setStaging] = useState<Staging | null>(null);
  const [edits, setEdits] = useState<Edits>({});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const create = useCreateFileSource();
  const sourceId = mode.kind === "create" ? "" : mode.source.id;
  const add = useAddTables(sourceId);
  const reupload = useReuploadTable(
    sourceId,
    mode.kind === "reupload" ? mode.tableId : ""
  );
  const mutation =
    mode.kind === "create" ? create : mode.kind === "add" ? add : reupload;

  const target =
    mode.kind === "reupload"
      ? mode.source.tables.find((t) => t.id === mode.tableId)
      : undefined;

  const onStaged = (s: Staging, fileName: string) => {
    setStaging(s);
    if (mode.kind === "reupload") {
      // The table of the same name, else the first; columns keep their current types.
      const only =
        s.tables.find((t) => t.name === target?.name)?.key ?? s.tables[0]?.key;
      const types = new Map(
        (target?.columns ?? [])
          .filter((c) => !c.missing)
          .map((c) => [c.name, c.type])
      );
      setEdits(initialEdits(s.tables, { only, types }));
    } else {
      setEdits(initialEdits(s.tables));
    }
    if (mode.kind === "create" && !name) setName(baseName(fileName));
  };

  const back =
    mode.kind === "create" ? MY_DATA_HREF : fileSourceHref(mode.source.id);
  const slugProblem =
    slug && !SLUG.test(slug)
      ? "Lowercase letters, digits and hyphens, starting with a letter (2 to 63)."
      : undefined;
  const ready =
    !!staging &&
    editsValid(staging.tables, edits) &&
    (mode.kind !== "create" || (name.trim() !== "" && !slugProblem));

  const submit = () => {
    if (!staging || !ready || mutation.isPending) return;
    const kept = staging.tables
      .filter((t) => edits[t.key]?.keep)
      .map((t) => correctionOf(t, edits[t.key]!));
    const done = (source: FileSource) => navigate(fileSourceHref(source.id));
    if (mode.kind === "create") {
      create.mutate(
        {
          staging_id: staging.staging_id,
          name: name.trim(),
          ...(slug && { slug }),
          tables: kept,
        },
        { onSuccess: done }
      );
    } else if (mode.kind === "add") {
      add.mutate(
        { staging_id: staging.staging_id, tables: kept },
        { onSuccess: done }
      );
    } else {
      const [table] = kept;
      if (!table) return;
      // A re-upload keeps the table's name.
      const { name: _ignored, ...rest } = table;
      void _ignored;
      reupload.mutate(
        { staging_id: staging.staging_id, ...rest },
        { onSuccess: done }
      );
    }
  };

  const title =
    mode.kind === "create"
      ? "Add data"
      : mode.kind === "add"
        ? `Add tables to ${mode.source.name}`
        : `Re-upload ${target?.name ?? "table"}`;
  const submitLabel =
    mode.kind === "create"
      ? "Create source"
      : mode.kind === "add"
        ? "Add tables"
        : "Replace data";

  return (
    <div className="z-fs-form-page">
      <PageHeader
        title={title}
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
            {staging && (
              <Button
                size="sm"
                type="submit"
                form={FORM_ID}
                fullWidth={false}
                isLoading={mutation.isPending}
                disabled={!ready || mutation.isPending}
              >
                {submitLabel}
              </Button>
            )}
          </div>
        }
      />
      {mode.kind === "reupload" && (
        <p className="z-note">
          Columns are matched by name: matched columns keep their grants, new
          ones are added, and columns no longer in the file are marked missing.
          Queries see the old data until the new data is in place.
        </p>
      )}
      {!staging ? (
        <FilePicker onStaged={onStaged} />
      ) : (
        <form
          id={FORM_ID}
          className="z-fs-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {mode.kind === "create" && (
            <BorderedSection title="About" as="h2">
              <FormGrid columns={2}>
                <Input
                  label="Name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Input
                  label="Slug"
                  placeholder="Made from the name"
                  value={slug}
                  error={slugProblem}
                  helperText="How queries name the source."
                  onChange={(e) => setSlug(e.target.value)}
                />
              </FormGrid>
            </BorderedSection>
          )}
          <PreviewEditor
            tables={staging.tables}
            edits={edits}
            onChange={setEdits}
            mode={mode.kind === "reupload" ? "one" : "many"}
          />
          <LoadFailure error={mutation.error} />
        </form>
      )}
    </div>
  );
};

export const AddDataPage = () => <AddData mode={{ kind: "create" }} />;

/** Loads the source a page adds to or re-uploads into. */
const WithSource = ({
  children,
}: {
  children: (source: FileSource) => React.ReactNode;
}) => {
  const id = useUuidParam("fileSourceId");
  return id ? <SourceLoader id={id}>{children}</SourceLoader> : <NotFound />;
};

const SourceLoader = ({
  id,
  children,
}: {
  id: string;
  children: (source: FileSource) => React.ReactNode;
}) => {
  const { data, error, isLoading } = useFileSource(id);
  if (isLoading) return <Spinner size="lg" />;
  if (!data) return <ErrorNotice error={error} />;
  return <>{children(data)}</>;
};

export const AddTablesPage = () => (
  <WithSource>
    {(source) => <AddData mode={{ kind: "add", source }} />}
  </WithSource>
);

export const ReuploadPage = () => {
  const tableId = useUuidParam("tableId");
  return (
    <WithSource>
      {(source) =>
        tableId && source.tables.some((t) => t.id === tableId) ? (
          <AddData mode={{ kind: "reupload", source, tableId }} />
        ) : (
          <NotFound />
        )
      }
    </WithSource>
  );
};
