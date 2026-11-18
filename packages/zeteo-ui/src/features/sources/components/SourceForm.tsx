import { descriptionProblem, DescriptionField } from "./DescriptionField";
import { parseNumberField } from "@/utils/parseNumberField";
import { syncIntervalProblem } from "@/utils/syncInterval";
import { useCreateSource } from "../api/useCreateSource";
import { useUpdateSource } from "../api/useUpdateSource";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { issueFor, type ApiError } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { sourceTypeName } from "./sourceLabels";
import { useNavigate } from "react-router-dom";
import { slugify } from "@/utils/slugify";
import "./styles.css";
import {
  ConnectionFields,
  DEFAULT_PORT,
  TLS_MODES,
  emptyConnection,
  type ConnectionState,
} from "./ConnectionFields";
import {
  Alert,
  BorderedSection,
  Button,
  Checkbox,
  Form,
  FormGrid,
  Input,
  Modal,
  Switch,
} from "@kosmeo-ui/react";
import type {
  CreateSource,
  Source,
  SourceSettings,
  DatabaseType,
  UpdateSource,
} from "../api/types";

const SLUG = /^[a-z][a-z0-9-]{1,62}$/;

const MAX_SCHEMAS = 20;
const MAX_SCHEMA_BYTES = 63;

/** A source's numeric limit as a form field: its key, label and range. */
export interface NumberField {
  key:
    | "timeout_ms"
    | "row_cap"
    | "export_row_cap"
    | "query_concurrency"
    | "export_concurrency";
  label: string;
  min: number;
  max: number;
  default: number;
}

/** The limits a source form edits. */
export const NUMBER_FIELDS: NumberField[] = [
  {
    key: "timeout_ms",
    label: "Time limit (ms)",
    min: 1000,
    max: 120000,
    default: 30000,
  },
  { key: "row_cap", label: "Row cap", min: 1, max: 50000, default: 50000 },
  {
    key: "export_row_cap",
    label: "Row cap",
    min: 0,
    max: 1000000,
    default: 0,
  },
  {
    key: "query_concurrency",
    label: "Queries at once",
    min: 1,
    max: 50,
    default: 5,
  },
  {
    key: "export_concurrency",
    label: "Exports at once",
    min: 1,
    max: 10,
    default: 2,
  },
];

type Limits = Record<NumberField["key"], string>;

/** The paths the form shows beside a field right now; other issues go to the notice. */
const shownPaths = (
  creating: boolean,
  connectionOpen: boolean,
  type: DatabaseType,
  tls: string
): string[] => [
  ...(creating ? ["slug"] : []),
  "name",
  "description",
  "schemas",
  "sync_interval_minutes",
  ...(connectionOpen
    ? [
        "settings.host",
        "settings.port",
        "settings.database",
        "settings.user",
        "settings.password",
        "settings.tls",
        ...(type === "postgres" && tls === "verify" ? ["settings.ca"] : []),
      ]
    : []),
  ...NUMBER_FIELDS.map((f) => f.key),
];

const parseSchemas = (text: string): string[] =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const isTls = (type: DatabaseType, value: unknown): value is string =>
  typeof value === "string" && TLS_MODES[type].includes(value);

const connectionOf = (source: Source): ConnectionState => {
  const s = source.settings ?? {};
  const text = (v: unknown, fallback = "") =>
    typeof v === "string" || typeof v === "number" ? String(v) : fallback;
  return {
    host: text(s.host),
    port: text(s.port, DEFAULT_PORT[source.type as DatabaseType]),
    database: text(s.database),
    user: text(s.user),
    password: "",
    tls: isTls(source.type as DatabaseType, s.tls) ? s.tls : "verify",
    ca: "",
  };
};

const buildSettings = (
  type: DatabaseType,
  c: ConnectionState
): SourceSettings => {
  const port = parseNumberField(c.port);
  const base = {
    host: c.host.trim(),
    ...(port !== undefined && { port }),
    database: c.database.trim(),
    user: c.user.trim(),
    password: c.password,
  };
  return type === "postgres"
    ? {
        ...base,
        tls: c.tls as "verify" | "require" | "off",
        // The CA field shows only for verified TLS; a hidden one is not sent.
        ...(c.tls === "verify" && c.ca.trim() && { ca: c.ca }),
      }
    : { ...base, tls: c.tls as "verify" | "trust-server-certificate" };
};

interface SourceFormProps {
  /** Shows the form in a dialog, which `onDone` closes on Cancel and after a save; else it is a page. */
  dialog?: { onDone: () => void };
  /** Present when editing. */
  source?: Source;
  /** The page title, shown with the form's Cancel and submit buttons. */
  title: string;
  /**
   * An upload's settings: no connection or catalogue; its name, and its
   * limits only for whoever may change them.
   */
  upload?: {
    /** `zeteo.sources.write`: the limits are shown and sent. */
    canSetLimits: boolean;
  };
}

const FORM_ID = "z-source-form";

export const SourceForm = ({
  source,
  title,
  upload,
  dialog,
}: SourceFormProps) => {
  const navigate = useNavigate();
  const create = useCreateSource();
  const update = useUpdateSource(source?.id ?? "");
  const mutation = source ? update : create;

  const [slug, setSlug] = useState("");
  // The slug follows the name until it is edited by hand.
  const [slugEdited, setSlugEdited] = useState(false);
  const [name, setName] = useState(source?.name ?? "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [type, setType] = useState<DatabaseType>(
    (source?.type as DatabaseType | undefined) ?? "postgres"
  );
  const [connectionOpen, setConnectionOpen] = useState(!source);
  const [conn, setConn] = useState<ConnectionState>(
    // An upload has no connection to read.
    source && !upload ? connectionOf(source) : emptyConnection("postgres")
  );
  const [schemas, setSchemas] = useState(source?.schemas.join(", ") ?? "");
  const [limits, setLimits] = useState<Limits>(
    Object.fromEntries(
      NUMBER_FIELDS.map((f) => [f.key, source ? String(source[f.key]) : ""])
    ) as Limits
  );
  const [exportEnabled, setExportEnabled] = useState(
    source?.export_enabled ?? false
  );
  // Only a Google Sheets source syncs.
  const syncs = source?.type === "google-sheets";
  const [syncEvery, setSyncEvery] = useState(
    String(source?.sync?.interval_minutes ?? 60)
  );
  const [allowWritable, setAllowWritable] = useState(false);
  const [offerWritable, setOfferWritable] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The password and CA must not outlive the form in the mutation cache.
  const resets = useRef([create.reset, update.reset]);
  useEffect(() => {
    const [resetCreate, resetUpdate] = resets.current;
    return () => {
      resetCreate();
      resetUpdate();
    };
  }, []);

  const serverError: ApiError | null = mutation.error;
  const errorFor = (path: string) =>
    errors[path] ?? issueFor(serverError, path);

  /** An edit: its own client-side error and the server's notice are stale. */
  const edited = (...paths: string[]) => {
    if (paths.length > 0) {
      setErrors((e) =>
        Object.fromEntries(
          Object.entries(e).filter(([k]) => !paths.includes(k))
        )
      );
    }
    if (mutation.error) mutation.reset();
  };

  // The writable-login override was given for the login as it was.
  const loginChanged = () => {
    setAllowWritable(false);
    setOfferWritable(false);
  };

  const changeConnection = (patch: Partial<ConnectionState>) => {
    setConn((c) => ({ ...c, ...patch }));
    loginChanged();
    edited(...Object.keys(patch).map((k) => `settings.${k}`));
  };

  const keepConnection = (src: Source) => {
    setConnectionOpen(false);
    setConn(connectionOf(src));
    loginChanged();
    setErrors((e) =>
      Object.fromEntries(
        Object.entries(e).filter(([k]) => !k.startsWith("settings."))
      )
    );
    mutation.reset();
  };

  const changeType = (next: DatabaseType) => {
    loginChanged();
    edited("settings.port", "settings.tls", "settings.ca");
    setConn((c) => ({
      ...emptyConnection(next),
      host: c.host,
      database: c.database,
      user: c.user,
      password: c.password,
      port: c.port === DEFAULT_PORT[type] ? DEFAULT_PORT[next] : c.port,
    }));
    setType(next);
  };

  const validate = (): Record<string, string> => {
    const found: Record<string, string> = {};
    if (!source && !SLUG.test(slug)) {
      found.slug =
        "Use lower case letters, digits and hyphens, starting with a letter (2 to 63 characters).";
    }
    if (!name.trim()) found.name = "A name is required.";
    const tooLong = descriptionProblem(description);
    if (tooLong) found.description = tooLong;
    if (connectionOpen) {
      const port = parseNumberField(conn.port);
      if (!conn.host.trim()) found["settings.host"] = "A host is required.";
      if (!conn.database.trim()) {
        found["settings.database"] = "A database is required.";
      }
      if (!conn.user.trim()) found["settings.user"] = "A user is required.";
      if (!conn.password) {
        found["settings.password"] = source
          ? "Enter the password again to change the connection."
          : "A password is required.";
      }
      if (port !== undefined && Number.isNaN(port)) {
        found["settings.port"] = "Enter a number.";
      } else if (port !== undefined && (port < 1 || port > 65535)) {
        found["settings.port"] = "A port is 1 to 65535.";
      }
    }
    const list = parseSchemas(schemas);
    // An upload has no schemas to name.
    if (!upload && list.length === 0) {
      found.schemas = "Name at least one schema.";
    } else if (list.length > MAX_SCHEMAS) {
      found.schemas = `Use at most ${MAX_SCHEMAS} schemas.`;
    } else if (new Set(list).size !== list.length) {
      found.schemas = "A schema is listed more than once.";
    } else if (
      list.some((s) => new TextEncoder().encode(s).length > MAX_SCHEMA_BYTES)
    ) {
      found.schemas = `A schema name is at most ${MAX_SCHEMA_BYTES} bytes.`;
    }
    if (syncs) {
      const problem = syncIntervalProblem(syncEvery);
      if (problem) found.sync_interval_minutes = problem;
    }
    for (const field of NUMBER_FIELDS) {
      const n = parseNumberField(limits[field.key]);
      if (n !== undefined && Number.isNaN(n)) {
        found[field.key] = "Enter a number.";
      } else if (n !== undefined && (n < field.min || n > field.max)) {
        found[field.key] = `${field.label} is ${field.min} to ${field.max}.`;
      }
    }
    return found;
  };

  /** What PATCH would carry: only what differs from the stored source. */
  const changes = (src: Source): UpdateSource => {
    const body: UpdateSource = {};
    if (upload) {
      // Its owner may change only the name; a sources admin the limits too.
      if (name.trim() !== src.name) body.name = name.trim();
      if (description.trim() !== src.description) {
        body.description = description.trim();
      }
      const minutes = parseNumberField(syncEvery);
      if (
        syncs &&
        minutes !== undefined &&
        !Number.isNaN(minutes) &&
        minutes !== src.sync?.interval_minutes
      ) {
        body.sync_interval_minutes = minutes;
      }
      if (!upload.canSetLimits) return body;
      for (const field of NUMBER_FIELDS) {
        const n = parseNumberField(limits[field.key]);
        if (n !== undefined && n !== src[field.key]) body[field.key] = n;
      }
      if (exportEnabled !== src.export_enabled)
        body.export_enabled = exportEnabled;
      return body;
    }
    if (name.trim() !== src.name) body.name = name.trim();
    if (description.trim() !== src.description) {
      body.description = description.trim();
    }
    const list = parseSchemas(schemas);
    if (!sameList(list, src.schemas)) body.schemas = list;
    for (const field of NUMBER_FIELDS) {
      const n = parseNumberField(limits[field.key]);
      if (n !== undefined && n !== src[field.key]) body[field.key] = n;
    }
    if (exportEnabled !== src.export_enabled)
      body.export_enabled = exportEnabled;
    if (connectionOpen) {
      body.settings = buildSettings(type, conn);
      if (allowWritable) body.allow_writable_login = true;
    }
    return body;
  };

  const pending = source ? changes(source) : null;
  const unchanged = pending !== null && Object.keys(pending).length === 0;
  const backHref = source ? `/sources/${source.id}` : "/sources";
  const leave = () => (dialog ? dialog.onDone() : navigate(backHref));

  const submit = () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const onError = (err: ApiError) =>
      setOfferWritable(err.code === "writable_login");

    if (source) {
      update.mutate(changes(source), {
        onSuccess: () => {
          update.reset();
          leave();
        },
        onError,
      });
      return;
    }
    const body: CreateSource = {
      slug,
      name: name.trim(),
      ...(description.trim() && { description: description.trim() }),
      type,
      settings: buildSettings(type, conn),
      schemas: parseSchemas(schemas),
      export_enabled: exportEnabled,
    };
    for (const field of NUMBER_FIELDS) {
      const n = parseNumberField(limits[field.key]);
      if (n !== undefined) body[field.key] = n;
    }
    if (allowWritable) body.allow_writable_login = true;
    create.mutate(body, {
      onSuccess: (created) => {
        create.reset();
        navigate(`/sources/${created.id}`);
      },
      onError,
    });
  };

  if (source?.archived_at) {
    return (
      <Alert variant="warning">
        This source is archived and cannot be changed.
      </Alert>
    );
  }

  const fieldPaths = shownPaths(!source, connectionOpen, type, conn.tls);
  const allIssuesShown =
    serverError?.status === 400 &&
    (serverError.issues?.length ?? 0) > 0 &&
    serverError.issues!.every((i) => fieldPaths.includes(i.path));

  const numberInput = (key: NumberField["key"]) => {
    const field = NUMBER_FIELDS.find((f) => f.key === key)!;
    return (
      <Input
        key={field.key}
        label={field.label}
        type="number"
        placeholder={source ? undefined : `${field.default} (default)`}
        value={limits[field.key]}
        error={errorFor(field.key)}
        onChange={(e) => {
          setLimits((l) => ({ ...l, [field.key]: e.target.value }));
          edited(field.key);
        }}
      />
    );
  };

  const cancelButton = (
    <Button
      key="cancel"
      size="sm"
      variant="secondary"
      fullWidth={false}
      onClick={leave}
    >
      Cancel
    </Button>
  );
  const saveButton = (
    <Button
      key="save"
      size="sm"
      type="submit"
      form={FORM_ID}
      fullWidth={false}
      isLoading={mutation.isPending}
      disabled={mutation.isPending || unchanged}
    >
      {source ? "Save changes" : "Create source"}
    </Button>
  );

  const form = (
    <div className="z-source-form-body">
      <Form id={FORM_ID} onSubmit={submit}>
        <BorderedSection title="About" as="h2">
          <FormGrid columns={source ? 1 : 2}>
            <Input
              label="Name"
              required
              value={name}
              error={errorFor("name")}
              onChange={(e) => {
                setName(e.target.value);
                if (!source && !slugEdited) setSlug(slugify(e.target.value));
                edited("name", "slug");
              }}
            />
            {!source && (
              <>
                <Input
                  label="Slug"
                  required
                  value={slug}
                  error={errorFor("slug")}
                  helperText="How queries name it. Can't be changed later."
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugEdited(true);
                    edited("slug");
                  }}
                />
              </>
            )}
          </FormGrid>
          <DescriptionField
            value={description}
            error={errorFor("description")}
            onChange={(value) => {
              setDescription(value);
              edited("description");
            }}
          />
          <div className="z-source-about-row">
            {!source && (
              <div>
                <div className="z-field-label">Database</div>
                <div className="z-segmented" role="group" aria-label="Database">
                  {(["postgres", "azure-sql"] as DatabaseType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      className="z-segmented-option"
                      aria-pressed={type === t}
                      onClick={() => type !== t && changeType(t)}
                    >
                      {sourceTypeName(t)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </BorderedSection>

        {syncs && (
          <BorderedSection title="Sync" as="h2">
            <Input
              label="Sync every"
              type="number"
              value={syncEvery}
              error={errorFor("sync_interval_minutes")}
              helperText="Minutes between syncs, 15 to 1440."
              onChange={(e) => {
                setSyncEvery(e.target.value);
                edited("sync_interval_minutes");
              }}
            />
          </BorderedSection>
        )}

        {!upload && (
          <BorderedSection
            title="Connection"
            as="h2"
            actions={
              source &&
              (connectionOpen ? (
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  onClick={() => keepConnection(source)}
                >
                  Keep connection unchanged
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  onClick={() => setConnectionOpen(true)}
                >
                  Change connection
                </Button>
              ))
            }
          >
            {connectionOpen ? (
              <ConnectionFields
                type={type}
                value={conn}
                onChange={changeConnection}
                editing={!!source}
                errorFor={errorFor}
              />
            ) : (
              <p className="z-muted z-source-connection-note">
                The connection stays as it is. Changing it needs the password
                again.
              </p>
            )}
          </BorderedSection>
        )}

        {!upload && (
          <BorderedSection title="Catalogue" as="h2">
            <Input
              label="Schemas"
              required
              value={schemas}
              error={errorFor("schemas")}
              helperText="The schemas whose tables people can query. Separate with commas; at most 20."
              onChange={(e) => {
                setSchemas(e.target.value);
                edited("schemas");
              }}
            />
          </BorderedSection>
        )}

        {(!upload || upload.canSetLimits) && (
          <>
            <BorderedSection title="Querying" as="h2">
              <FormGrid columns={3}>
                {numberInput("timeout_ms")}
                {numberInput("row_cap")}
                {numberInput("query_concurrency")}
              </FormGrid>
            </BorderedSection>

            <BorderedSection
              title="Exports"
              as="h2"
              actions={
                <Switch
                  size="sm"
                  label="Allow exports"
                  checked={exportEnabled}
                  onChange={(e) => setExportEnabled(e.target.checked)}
                />
              }
            >
              {exportEnabled ? (
                <FormGrid columns={2}>
                  {numberInput("export_row_cap")}
                  {numberInput("export_concurrency")}
                </FormGrid>
              ) : (
                <p className="z-muted z-source-connection-note">
                  People can't export from this source.
                </p>
              )}
            </BorderedSection>
          </>
        )}

        {serverError && !allIssuesShown && (
          <ErrorNotice error={serverError} fieldPaths={fieldPaths} />
        )}
        {offerWritable && (
          <Checkbox
            label="Allow this login although it can write"
            checked={allowWritable}
            onChange={(e) => setAllowWritable(e.target.checked)}
          />
        )}
      </Form>
    </div>
  );

  if (dialog) {
    return (
      <Modal
        show
        size="lg"
        title={title}
        onClose={leave}
        dismissible={!mutation.isPending}
        footerButtons={[cancelButton, saveButton]}
      >
        {form}
      </Modal>
    );
  }

  return (
    <div className="z-source-form">
      <PageHeader
        title={title}
        divider={false}
        actions={
          <div className="z-source-actions">
            {cancelButton}
            {saveButton}
          </div>
        }
      />
      {form}
    </div>
  );
};
