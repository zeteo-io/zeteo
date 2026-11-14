import { parseNumberField } from "@/utils/parseNumberField";
import { useCreateSource } from "../api/useCreateSource";
import { useUpdateSource } from "../api/useUpdateSource";
import { ErrorNotice } from "@/components/ErrorNotice";
import { issueFor, type ApiError } from "@/lib/api";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  Button,
  Checkbox,
  Form,
  FormActions,
  FormGrid,
  Input,
  Select,
} from "@kosmeo-ui/react";
import type {
  CreateSource,
  Source,
  SourceSettings,
  SourceType,
  UpdateSource,
} from "../api/types";

const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const MAX_SCHEMAS = 20;
const MAX_SCHEMA_BYTES = 63;

interface NumberField {
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

const NUMBER_FIELDS: NumberField[] = [
  {
    key: "timeout_ms",
    label: "Timeout (ms)",
    min: 1000,
    max: 120000,
    default: 30000,
  },
  { key: "row_cap", label: "Row cap", min: 1, max: 50000, default: 50000 },
  {
    key: "export_row_cap",
    label: "Export row cap",
    min: 0,
    max: 1000000,
    default: 0,
  },
  {
    key: "query_concurrency",
    label: "Query concurrency",
    min: 1,
    max: 50,
    default: 5,
  },
  {
    key: "export_concurrency",
    label: "Export concurrency",
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
  type: SourceType
): string[] => [
  ...(creating ? ["slug"] : []),
  "name",
  "schemas",
  ...(connectionOpen
    ? [
        "settings.host",
        "settings.port",
        "settings.database",
        "settings.user",
        "settings.password",
        "settings.tls",
        ...(type === "postgres" ? ["settings.ca"] : []),
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

const isTls = (type: SourceType, value: unknown): value is string =>
  typeof value === "string" && TLS_MODES[type].includes(value);

const connectionOf = (source: Source): ConnectionState => {
  const s = source.settings ?? {};
  const text = (v: unknown, fallback = "") =>
    typeof v === "string" || typeof v === "number" ? String(v) : fallback;
  return {
    host: text(s.host),
    port: text(s.port, DEFAULT_PORT[source.type]),
    database: text(s.database),
    user: text(s.user),
    password: "",
    tls: isTls(source.type, s.tls) ? s.tls : "verify",
    ca: "",
  };
};

const buildSettings = (
  type: SourceType,
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
        ...(c.ca.trim() && { ca: c.ca }),
      }
    : { ...base, tls: c.tls as "verify" | "trust-server-certificate" };
};

interface SourceFormProps {
  /** Present when editing. */
  source?: Source;
}

export const SourceForm = ({ source }: SourceFormProps) => {
  const navigate = useNavigate();
  const create = useCreateSource();
  const update = useUpdateSource(source?.id ?? "");
  const mutation = source ? update : create;

  const [slug, setSlug] = useState("");
  const [name, setName] = useState(source?.name ?? "");
  const [type, setType] = useState<SourceType>(source?.type ?? "postgres");
  const [connectionOpen, setConnectionOpen] = useState(!source);
  const [conn, setConn] = useState<ConnectionState>(
    source ? connectionOf(source) : emptyConnection("postgres")
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

  const changeType = (next: SourceType) => {
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
    if (list.length === 0) found.schemas = "Name at least one schema.";
    else if (list.length > MAX_SCHEMAS) {
      found.schemas = `Use at most ${MAX_SCHEMAS} schemas.`;
    } else if (new Set(list).size !== list.length) {
      found.schemas = "A schema is listed more than once.";
    } else if (
      list.some((s) => new TextEncoder().encode(s).length > MAX_SCHEMA_BYTES)
    ) {
      found.schemas = `A schema name is at most ${MAX_SCHEMA_BYTES} bytes.`;
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
    if (name.trim() !== src.name) body.name = name.trim();
    const list = parseSchemas(schemas);
    if (!sameList(list, src.schemas)) body.schemas = list;
    for (const field of NUMBER_FIELDS) {
      const n = parseNumberField(limits[field.key]);
      if (n !== undefined && n !== src[field.key]) body[field.key] = n;
    }
    if (exportEnabled !== src.export_enabled)
      body.export_enabled = exportEnabled;
    if (connectionOpen) {
      body.settings = buildSettings(src.type, conn);
      if (allowWritable) body.allow_writable_login = true;
    }
    return body;
  };

  const pending = source ? changes(source) : null;
  const unchanged = pending !== null && Object.keys(pending).length === 0;

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
          navigate(`/sources/${source.id}`);
        },
        onError,
      });
      return;
    }
    const body: CreateSource = {
      slug,
      name: name.trim(),
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

  const fieldPaths = shownPaths(!source, connectionOpen, source?.type ?? type);
  const allIssuesShown =
    serverError?.status === 400 &&
    (serverError.issues?.length ?? 0) > 0 &&
    serverError.issues!.every((i) => fieldPaths.includes(i.path));

  return (
    <div className="z-source-form">
      <Form onSubmit={submit}>
        {!source && (
          <>
            <Input
              label="Slug"
              required
              value={slug}
              error={errorFor("slug")}
              helperText="Lower case letters, digits and hyphens. Cannot be changed later."
              onChange={(e) => {
                setSlug(e.target.value);
                edited("slug");
              }}
            />
            <Select<SourceType>
              label="Type"
              value={type}
              options={[
                { value: "postgres", label: "postgres" },
                { value: "azure-sql", label: "azure-sql" },
              ]}
              onChange={(next) => changeType(next ?? "postgres")}
            />
          </>
        )}
        <Input
          label="Name"
          required
          value={name}
          error={errorFor("name")}
          onChange={(e) => {
            setName(e.target.value);
            edited("name");
          }}
        />

        <fieldset>
          <legend>Connection</legend>
          {connectionOpen ? (
            <>
              <ConnectionFields
                type={source?.type ?? type}
                value={conn}
                onChange={changeConnection}
                editing={!!source}
                errorFor={errorFor}
              />
              {source && (
                <Button
                  variant="secondary"
                  fullWidth={false}
                  onClick={() => keepConnection(source)}
                >
                  Keep connection unchanged
                </Button>
              )}
            </>
          ) : (
            <div className="z-source-connection-unchanged">
              <span>Connection: unchanged</span>
              <Button
                variant="secondary"
                fullWidth={false}
                onClick={() => setConnectionOpen(true)}
              >
                Change connection
              </Button>
            </div>
          )}
        </fieldset>

        <Input
          label="Schemas"
          required
          value={schemas}
          error={errorFor("schemas")}
          helperText="Separate with commas: at most 20, each listed once."
          onChange={(e) => {
            setSchemas(e.target.value);
            edited("schemas");
          }}
        />

        <FormGrid columns={2}>
          {NUMBER_FIELDS.map((field) => (
            <Input
              key={field.key}
              label={field.label}
              placeholder={source ? undefined : `${field.default} (default)`}
              value={limits[field.key]}
              error={errorFor(field.key)}
              onChange={(e) => {
                setLimits((l) => ({ ...l, [field.key]: e.target.value }));
                edited(field.key);
              }}
            />
          ))}
        </FormGrid>
        <Checkbox
          label="Export enabled"
          checked={exportEnabled}
          onChange={(e) => setExportEnabled(e.target.checked)}
        />

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

        <FormActions>
          <Button
            variant="secondary"
            fullWidth={false}
            onClick={() =>
              navigate(source ? `/sources/${source.id}` : "/sources")
            }
          >
            Cancel
          </Button>
          <Button
            type="submit"
            fullWidth={false}
            isLoading={mutation.isPending}
            disabled={mutation.isPending || unchanged}
          >
            {source ? "Save changes" : "Create source"}
          </Button>
        </FormActions>
      </Form>
    </div>
  );
};
