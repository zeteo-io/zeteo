import type { FileColumnType, SheetStaging, Staging } from "../api/types";
import { isUploadType, sourceHref } from "../../components/sourceLabels";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { syncIntervalProblem } from "@/utils/syncInterval";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { LoadFailure } from "./CastFailedNotice";
import { SheetLinkStep } from "./SheetLinkStep";
import { useSource } from "../../api/useSource";
import { useNavigate } from "react-router-dom";
import type { Source } from "../../api/types";
import { useTable } from "@/features/tables";
import { slugify } from "@/utils/slugify";
import { MY_DATA_HREF } from "./labels";
import "./styles.css";
import {
  descriptionProblem,
  DescriptionField,
} from "../../components/DescriptionField";
import {
  Alert,
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
import {
  useAddTables,
  useCreateUploadSource,
  useDiscardStaging,
  useReuploadTable,
  useUploadFile,
} from "../api/uploads";

const ACCEPT = ".csv,.xlsx";
const FORM_ID = "z-fs-form";

const SLUG = /^[a-z][a-z0-9-]{1,62}$/;

/** How often a Google Sheet is synced: zeteo's default, in minutes. */
const DEFAULT_INTERVAL = "60";

/** A file's name without its extension: "Q3 sales.xlsx" → "Q3 sales". */
const baseName = (file: string) => file.replace(/\.[^.]+$/, "");

/** The table a re-upload replaces: its name, and its live columns' types. */
interface Target {
  id: string;
  name: string;
  columns: { name: string; type: string }[];
}

type Mode =
  | { kind: "create" }
  | { kind: "add"; source: Source }
  | { kind: "reupload"; source: Source; target: Target };

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

type Origin = "file" | "sheet";

/** The first step of Add data: where the data comes from. */
const SourceChoice = ({ onChoose }: { onChoose: (origin: Origin) => void }) => (
  <div className="z-fs-choices">
    <button
      type="button"
      className="z-fs-choice"
      onClick={() => onChoose("file")}
    >
      <span className="z-fs-choice-title">Upload a file</span>
      <span className="z-fs-choice-note">
        A CSV or Excel file, loaded once. Re-upload it when it changes.
      </span>
    </button>
    <button
      type="button"
      className="z-fs-choice"
      onClick={() => onChoose("sheet")}
    >
      <span className="z-fs-choice-title">Google Sheet</span>
      <span className="z-fs-choice-note">
        Zeteo keeps a copy and syncs it from the sheet on a schedule.
      </span>
    </button>
  </div>
);

/** Upload a file, check its preview, then create a source, add tables or replace one table's data. */
const AddData = ({ mode }: { mode: Mode }) => {
  const navigate = useNavigate();
  const [staging, setStaging] = useState<Staging | null>(null);
  // Add data starts with a choice; Add tables follows its source's kind.
  const [chosen, setChosen] = useState<Origin | null>(null);
  const [syncEvery, setSyncEvery] = useState(DEFAULT_INTERVAL);
  const origin: Origin | null = mode.kind === "reupload" ? "file" : chosen;
  const [edits, setEdits] = useState<Edits>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [slug, setSlug] = useState("");
  // The slug follows the name until it is edited by hand.
  const [slugEdited, setSlugEdited] = useState(false);
  const changeName = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };
  const create = useCreateUploadSource();
  const sourceId = mode.kind === "create" ? "" : mode.source.id;
  const add = useAddTables(sourceId);
  const target = mode.kind === "reupload" ? mode.target : undefined;
  const reupload = useReuploadTable(sourceId, target?.id ?? "");
  const mutation =
    mode.kind === "create" ? create : mode.kind === "add" ? add : reupload;

  // A staging the person leaves without using (Cancel, or navigating away)
  // is discarded, so it stops counting against their space.
  // Only leaving the page discards it: the cleanup runs on unmount alone, with
  // the latest discard function, so a re-render (a new API client after a
  // token refresh, say) never throws away the preview the person is editing.
  const discard = useDiscardStaging();
  const discardRef = useRef(discard);
  useEffect(() => {
    discardRef.current = discard;
  }, [discard]);
  const unused = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (unused.current) discardRef.current(unused.current);
    },
    []
  );

  // A failed create, add or re-upload is shown above the form and brought
  // into view, wherever the person was in a long preview.
  const failureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mutation.error) {
      failureRef.current?.scrollIntoView?.({
        block: "start",
        behavior: "smooth",
      });
    }
  }, [mutation.error]);
  const startAgain = () => {
    unused.current = null;
    mutation.reset();
    setStaging(null);
    setEdits({});
  };

  const onStaged = (s: Staging, defaultName: string) => {
    setStaging(s);
    unused.current = s.staging_id;
    if (mode.kind === "reupload") {
      // The table of the same name, else the first; columns keep their current types.
      const only =
        s.tables.find((t) => t.name === target?.name)?.key ?? s.tables[0]?.key;
      const types = new Map(
        (target?.columns ?? []).map(
          (c) => [c.name, c.type as FileColumnType] as const
        )
      );
      setEdits(initialEdits(s.tables, { only, types }));
    } else {
      setEdits(initialEdits(s.tables));
    }
    if (mode.kind === "create" && !name) changeName(defaultName);
  };

  const back =
    mode.kind === "create" ? MY_DATA_HREF : sourceHref(mode.source.id);
  const slugProblem =
    slug && !SLUG.test(slug)
      ? "Lowercase letters, digits and hyphens, starting with a letter (2 to 63)."
      : undefined;
  const ready =
    !!staging &&
    editsValid(staging.tables, edits) &&
    (mode.kind !== "create" || (name.trim() !== "" && !slugProblem)) &&
    (!(mode.kind === "create" && origin === "sheet") ||
      !syncIntervalProblem(syncEvery));
  const descriptionError = descriptionProblem(description);

  const submit = () => {
    if (!staging || !ready || mutation.isPending) return;
    if (mode.kind === "create" && descriptionError) {
      setSubmitted(true);
      return;
    }
    const kept = staging.tables
      .filter((t) => edits[t.key]?.keep)
      .map((t) => correctionOf(t, edits[t.key]!));
    const done = (source: Source) => {
      // The server has used the staging.
      unused.current = null;
      navigate(sourceHref(source.id));
    };
    if (mode.kind === "create") {
      const body = {
        staging_id: staging.staging_id,
        name: name.trim(),
        ...(description.trim() && { description: description.trim() }),
        ...(slug && { slug }),
        tables: kept,
      };
      create.mutate(
        origin === "sheet"
          ? { ...body, sync_interval_minutes: Number(syncEvery) }
          : body,
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
        origin === null ? (
          <SourceChoice onChoose={setChosen} />
        ) : origin === "sheet" ? (
          <SheetLinkStep
            sourceId={mode.kind === "add" ? mode.source.id : undefined}
            onStaged={(s: SheetStaging) => onStaged(s, s.spreadsheet.title)}
          />
        ) : (
          <FilePicker onStaged={(s, file) => onStaged(s, baseName(file))} />
        )
      ) : (
        <form
          id={FORM_ID}
          className="z-fs-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {mutation.error && (
            <div ref={failureRef}>
              {mutation.error.code === "staging_not_found" ? (
                <Alert variant="danger">
                  <p>
                    This preview is no longer available: a preview is kept for
                    an hour. Read the {origin === "sheet" ? "sheet" : "file"}{" "}
                    again to carry on.
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    fullWidth={false}
                    onClick={startAgain}
                  >
                    Start again
                  </Button>
                </Alert>
              ) : (
                <LoadFailure error={mutation.error} />
              )}
            </div>
          )}
          {mode.kind === "create" && (
            <BorderedSection title="About" as="h2">
              <FormGrid columns={2}>
                <Input
                  label="Name"
                  required
                  value={name}
                  onChange={(e) => changeName(e.target.value)}
                />
                <Input
                  label="Slug"
                  value={slug}
                  error={slugProblem}
                  helperText="How queries name the source. Made from the name until you change it."
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugEdited(true);
                  }}
                />
              </FormGrid>
              <DescriptionField
                value={description}
                error={submitted ? descriptionError : undefined}
                onChange={(value) => {
                  setDescription(value);
                  setSubmitted(false);
                }}
              />
            </BorderedSection>
          )}
          {mode.kind === "create" && origin === "sheet" && (
            <BorderedSection title="Sync" as="h2">
              <Input
                label="Sync every"
                type="number"
                value={syncEvery}
                error={syncIntervalProblem(syncEvery)}
                helperText="Minutes between syncs, 15 to 1440. Zeteo reads the sheet again at this pace."
                onChange={(e) => setSyncEvery(e.target.value)}
              />
            </BorderedSection>
          )}
          <PreviewEditor
            tables={staging.tables}
            edits={edits}
            onChange={setEdits}
            mode={mode.kind === "reupload" ? "one" : "many"}
            origin={origin ?? undefined}
          />
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
  children: (source: Source) => ReactNode;
}) => {
  const id = useUuidParam("sourceId");
  return id ? <SourceLoader id={id}>{children}</SourceLoader> : <NotFound />;
};

const SourceLoader = ({
  id,
  children,
}: {
  id: string;
  children: (source: Source) => ReactNode;
}) => {
  const { data, error, isLoading } = useSource(id);
  if (isLoading) return <Spinner size="lg" />;
  if (!data) return <ErrorNotice error={error} />;
  // Only an upload has tables to add or re-upload.
  if (!isUploadType(data.type)) return <NotFound />;
  return <>{children(data)}</>;
};

export const AddTablesPage = () => (
  <WithSource>
    {(source) => <AddData mode={{ kind: "add", source }} />}
  </WithSource>
);

/** Loads the table a re-upload replaces, with its live columns. */
const ReuploadTarget = ({
  source,
  tableId,
}: {
  source: Source;
  tableId: string;
}) => {
  const { data: table, error, isLoading } = useTable(source.id, tableId);
  if (isLoading) return <Spinner size="lg" />;
  if (!table) return error ? <ErrorNotice error={error} /> : <NotFound />;
  if (table.missing_since) return <NotFound />;
  const target: Target = {
    id: table.id,
    name: table.name,
    columns: table.columns
      .filter((c) => !c.missing_since)
      .map((c) => ({ name: c.name, type: c.type })),
  };
  return <AddData mode={{ kind: "reupload", source, target }} />;
};

export const ReuploadPage = () => {
  const tableId = useUuidParam("tableId");
  return (
    <WithSource>
      {(source) =>
        tableId ? (
          <ReuploadTarget source={source} tableId={tableId} />
        ) : (
          <NotFound />
        )
      }
    </WithSource>
  );
};
