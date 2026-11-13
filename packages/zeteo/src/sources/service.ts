import type { LoginFinding, SourceAdapter } from "../adapters/types.js";
import type { Source } from "../../prisma/generated/client/index.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { mapUniqueViolation } from "../utils/prismaErrors.js";
import { connectChecked, readSettings } from "./connect.js";
import { sealSettings } from "../utils/crypto/envelope.js";
import { withAudit } from "../utils/transaction.js";
import type { Prisma } from "../utils/db/prisma.js";
import { adapterFor } from "../adapters/index.js";
import { storedType, typeOf } from "./types.js";
import { closeSourcePool } from "./pools.js";
import { logger } from "../utils/logger.js";
import { db } from "../utils/db/index.js";
import { randomUUID } from "crypto";
import {
  ConflictError,
  issuesOf,
  NotFoundError,
  SourceArchivedError,
  ValidationError,
  WritableLoginError,
} from "../utils/errors.js";

/** The fields a caller may set on a source, as the API names them. */
export interface SourceFields {
  name: string;
  settings: unknown;
  schemas: string[];
  allow_writable_login: boolean;
  timeout_ms: number;
  row_cap: number;
  export_enabled: boolean;
  export_row_cap: number;
}

export type CreateSourceInput = Pick<
  SourceFields,
  "name" | "settings" | "schemas"
> &
  Partial<Omit<SourceFields, "name" | "settings" | "schemas">> & {
    slug: string;
    type: "postgres" | "azure-sql";
  };

export type UpdateSourceInput = Partial<SourceFields>;

/** Columns for the optional fields a caller gave. */
const optionalColumns = (input: Partial<SourceFields>) => ({
  ...(input.name !== undefined && { name: input.name }),
  ...(input.schemas !== undefined && { schemas: input.schemas }),
  ...(input.timeout_ms !== undefined && { timeoutMs: input.timeout_ms }),
  ...(input.row_cap !== undefined && { rowCap: input.row_cap }),
  ...(input.export_enabled !== undefined && {
    exportEnabled: input.export_enabled,
  }),
  ...(input.export_row_cap !== undefined && {
    exportRowCap: input.export_row_cap,
  }),
});

/** The adapter's own check of `settings`; the issues name `settings.<field>` and never carry values. */
const parseSettings = (adapter: SourceAdapter, settings: unknown): unknown => {
  const parsed = adapter.settingsSchema.safeParse(settings);
  if (parsed.success) return parsed.data;
  const issues = issuesOf(parsed.error).map((issue) => ({
    ...issue,
    path: issue.path ? `settings.${issue.path}` : "settings",
  }));
  throw new ValidationError(
    `Invalid request body. ${issues.map((i) => `${i.path}: ${i.message}`).join(", ")}`,
    issues
  );
};

/** Connects to the settings' destination for one login check and always closes the connection. */
const inspectLogin = async (
  adapter: SourceAdapter,
  settings: unknown
): Promise<LoginFinding[]> => {
  const connection = await connectChecked(adapter, settings);
  try {
    return await connection.checkLogin();
  } finally {
    await connection.close().catch((err: unknown) => {
      logger.warn({ err }, "closing a source check connection failed");
    });
  }
};

/**
 * What to record for a login check: refuses a login with findings unless the
 * caller allowed it, and says whether the override was used.
 */
const judgeLogin = (findings: LoginFinding[], allow: boolean) => {
  if (findings.length === 0) return { overridden: false, codes: [] };
  const codes = [...new Set(findings.map((f) => f.code))];
  if (!allow) throw new WritableLoginError(codes);
  return { overridden: true, codes };
};

const overrideMetadata = (verdict: ReturnType<typeof judgeLogin>) =>
  verdict.overridden
    ? { writable_login_allowed: true, findings: verdict.codes }
    : {};

const slugTaken = () =>
  new ConflictError("A source with this slug already exists", "slug_taken");

/** Registers a source. Nothing is stored unless the destination is allowed, the login connects and the check passes or is overridden. */
export const createSource = async (
  input: CreateSourceInput,
  actorId: string
): Promise<Source> => {
  const adapter = adapterFor(input.type);
  const settings = parseSettings(adapter, input.settings);
  if (await db.sources.findBySlug(input.slug)) throw slugTaken();

  const id = randomUUID();
  const findings = await inspectLogin(adapter, settings);
  const verdict = judgeLogin(findings, input.allow_writable_login ?? false);
  const sealed = sealSettings(settings, id);

  return withAudit(async (tx, audit) => {
    const row = await mapUniqueViolation(
      () =>
        tx.source.create({
          data: {
            id,
            slug: input.slug,
            type: storedType(input.type),
            sealedSettings: sealed as unknown as Prisma.InputJsonObject,
            writableLoginAllowed: verdict.overridden,
            createdBy: actorId,
            ...optionalColumns(input),
            name: input.name,
            schemas: input.schemas,
          },
        }),
      slugTaken().message,
      "slug_taken"
    );
    audit({
      action: AUDIT_EVENTS.sourceCreated,
      resourceType: "source",
      resourceId: id,
      actorId,
      metadata: {
        slug: row.slug,
        type: input.type,
        ...overrideMetadata(verdict),
      },
    });
    return row;
  });
};

const requireActive = async (id: string): Promise<Source> => {
  const row = await db.sources.findById(id);
  if (!row) throw new NotFoundError("Source not found");
  if (row.archivedAt) throw new SourceArchivedError();
  return row;
};

/**
 * Changes a source. New settings go through the same checks as a create and
 * replace the old ones whole; a change that omits them never contacts the source.
 */
export const updateSource = async (
  id: string,
  input: UpdateSourceInput,
  actorId: string
): Promise<Source> => {
  const row = await requireActive(id);
  const type = typeOf(row);

  let settingsChange:
    | {
        sealed: unknown;
        verdict: ReturnType<typeof judgeLogin>;
      }
    | undefined;
  if (input.settings !== undefined) {
    const adapter = adapterFor(type);
    const settings = parseSettings(adapter, input.settings);
    const findings = await inspectLogin(adapter, settings);
    settingsChange = {
      sealed: sealSettings(settings, id),
      verdict: judgeLogin(findings, input.allow_writable_login ?? false),
    };
  }

  const updated = await withAudit(async (tx, audit) => {
    const { count } = await tx.source.updateMany({
      // Archived since it was read: the change must not land.
      where: { id, archivedAt: null },
      data: {
        ...optionalColumns(input),
        ...(settingsChange && {
          sealedSettings: settingsChange.sealed as Prisma.InputJsonObject,
          writableLoginAllowed: settingsChange.verdict.overridden,
        }),
      },
    });
    if (count === 0) throw new SourceArchivedError();
    const current = await tx.source.findUniqueOrThrow({ where: { id } });
    audit({
      action: AUDIT_EVENTS.sourceUpdated,
      resourceType: "source",
      resourceId: id,
      actorId,
      metadata: {
        slug: current.slug,
        type,
        changed: Object.keys(input).filter(
          (key) => key !== "allow_writable_login"
        ),
        ...(settingsChange && overrideMetadata(settingsChange.verdict)),
      },
    });
    return current;
  });

  if (settingsChange) await closeSourcePool(id);
  return updated;
};

export const archiveSource = async (
  id: string,
  actorId: string
): Promise<void> => {
  await withAudit(async (tx, audit) => {
    const row = await tx.source.findUnique({ where: { id } });
    if (!row) throw new NotFoundError("Source not found");
    const { count } = await tx.source.updateMany({
      where: { id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (count === 0) throw new SourceArchivedError();
    audit({
      action: AUDIT_EVENTS.sourceArchived,
      resourceType: "source",
      resourceId: id,
      actorId,
      metadata: { slug: row.slug, type: typeOf(row) },
    });
  });
  await closeSourcePool(id);
};

/** Runs the login check against the stored settings on a fresh connection; changes nothing. */
export const testSource = async (id: string): Promise<LoginFinding[]> => {
  const row = await requireActive(id);
  const adapter = adapterFor(typeOf(row));
  return inspectLogin(
    adapter,
    readSettings(adapter, row.id, row.sealedSettings)
  );
};
