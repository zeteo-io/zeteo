import { checkTableName, NATIVE_TYPE, withLoadLock } from "./loading.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { originOf, type MergedDefinition } from "./origin.js";
import { prisma, type Prisma } from "../utils/db/prisma.js";
import type { ColumnType } from "../adapters/types.js";
import { isUploadSource } from "../sources/types.js";
import type { Caller } from "../middleware/auth.js";
import type { UploadColumnType } from "./types.js";
import { MAX_LABEL_LENGTH } from "./mergedSql.js";
import { suggestLabels } from "./mergedLabels.js";
import { tableView } from "../views/catalog.js";
import { schemaFor } from "./storage.js";
import {
  NotAnUploadSourceError,
  NotFoundError,
  SourceArchivedError,
  ValidationError,
} from "../utils/errors.js";
import {
  createMergedViews,
  isLiveMember,
  fromNameOf,
  resolveMemberColumn,
  type CatalogTable,
} from "./mergedViews.js";
import {
  assertUploadsOn,
  findChangeable,
  giveOwnerGrant,
  inDrop,
  lockChangeable,
  tableNameTaken,
} from "./service.js";

/**
 * Merged tables: a table of an upload source that stacks two or more of its
 * other tables (its members) as one view, with a label column naming the
 * member of each row and the columns its owner chose, matched by name. Its
 * definition lives in its origin (`MergedDefinition`); its view is made by
 * `withMergedViews` (`mergedViews.ts`) in every transaction that changes the
 * source's stored tables, this one's own saves included.
 */

const NAME = /^[a-z][a-z0-9_]{0,62}$/;

const invalid = (path: string, message: string) =>
  new ValidationError(`Invalid request body. ${path}: ${message}`, [
    { path, message },
  ]);

/** One column of the members' union, matched by name. */
export interface UnionColumn {
  name: string;
  /** The members' type, or `text` when they disagree. */
  type: UploadColumnType;
  /** The distinct types the members give it, sorted. */
  types: ColumnType[];
  /** The members that have it, in the order given. */
  inMembers: string[];
  /** Each member's column of this name. */
  columnIdByMember: Record<string, string>;
}

/**
 * A member's columns: a live table's live columns; a missing table's as it
 * last had them (those that went missing with it).
 */
const columnsOf = (table: CatalogTable) =>
  table.columns
    .filter(
      (c) =>
        c.missingSince === null ||
        (table.missingSince !== null &&
          c.missingSince.getTime() >= table.missingSince.getTime())
    )
    .sort((a, b) => a.position - b.position);

/** The union of `tables`' columns by name, in order of first appearance. */
const unionOf = (tables: CatalogTable[]): UnionColumn[] => {
  const byName = new Map<
    string,
    { types: Set<ColumnType>; inMembers: string[]; ids: Record<string, string> }
  >();
  for (const t of tables) {
    for (const c of columnsOf(t)) {
      const entry = byName.get(c.name) ?? {
        types: new Set<ColumnType>(),
        inMembers: [],
        ids: {},
      };
      entry.types.add(c.type);
      entry.inMembers.push(t.id);
      entry.ids[t.id] = c.id;
      byName.set(c.name, entry);
    }
  }
  return [...byName.entries()].map(([name, e]) => {
    const types = [...e.types].sort();
    return {
      name,
      type: (types.length === 1 ? types[0] : "text") as UploadColumnType,
      types,
      inMembers: e.inMembers,
      columnIdByMember: e.ids,
    };
  });
};

/** True for a table that may be a member: a stored table, not a merged one. */
const mayBeMember = (t: CatalogTable) =>
  t.kind === "table" && originOf(t)?.kind !== "merged";

/**
 * The source's tables of `ids`, in that order, each one that may be a
 * member (missing ones included); `invalid(pathOf(i))` for any other.
 */
const membersOf = async (
  db: Prisma.TransactionClient,
  sourceId: string,
  ids: string[],
  pathOf: (i: number) => string
): Promise<CatalogTable[]> => {
  const tables = await db.sourceTable.findMany({
    where: { sourceId, id: { in: ids } },
    include: { columns: true },
  });
  const byId = new Map(tables.map((t) => [t.id, t]));
  return ids.map((id, i) => {
    const t = byId.get(id);
    if (!t || !mayBeMember(t)) {
      throw invalid(pathOf(i), "Not a table of the source that can be merged");
    }
    return t;
  });
};

/**
 * The union of the columns of the source's tables `memberTableIds` (missing
 * ones by their last columns), matched by name; members whose types
 * disagree give `text`.
 */
export const columnUnion = async (
  sourceId: string,
  memberTableIds: string[]
): Promise<UnionColumn[]> =>
  unionOf(await membersOf(prisma, sourceId, memberTableIds, () => "member"));

/** The title a member's label is suggested from: its spreadsheet's title or its file's name. */
const titleOf = (t: CatalogTable): string => {
  const origin = originOf(t);
  if (origin?.kind === "google-sheets") return origin.spreadsheetTitle;
  if (origin?.kind === "file") return origin.filename.replace(/\.[^.]+$/, "");
  return t.name;
};

/**
 * For the merged table editor: the union of the members' columns, and a
 * suggested label for each member (the part of its title the others do not
 * share; the table names when titles repeat).
 */
export const mergedColumns = async (sourceId: string, memberIds: string[]) => {
  const source = await prisma.source.findUnique({ where: { id: sourceId } });
  if (!source) throw new NotFoundError("Source not found");
  if (!isUploadSource(source)) throw new NotAnUploadSourceError();
  if (source.archivedAt) throw new SourceArchivedError();
  assertUploadsOn();
  const tables = await membersOf(prisma, sourceId, memberIds, () => "member");
  let titles = tables.map(titleOf);
  if (new Set(titles).size !== titles.length)
    titles = tables.map((t) => t.name);
  return {
    columns: unionOf(tables).map((c) => ({
      name: c.name,
      type: c.type,
      types: c.types,
      members: c.inMembers,
    })),
    labels: suggestLabels(
      tables.map((t, i) => ({ tableId: t.id, title: titles[i]! }))
    ),
  };
};

/** What saving a merged table takes (`POST …/merged-tables`, `PUT …/tables/:id/merged`). */
export interface MergedTableInput {
  name: string;
  label_column: string;
  members: { table_id: string; label: string }[];
  /** Union columns by `from_name`; those included are the merged table's, named `name`. */
  columns: { name: string; from_name: string; include: boolean }[];
}

/** The checks that need no database; the labels trimmed. */
const checkInput = (input: MergedTableInput) => {
  checkTableName(input.name, "name");
  if (!NAME.test(input.label_column)) {
    throw invalid(
      "label_column",
      "A name is a lowercase letter, then lowercase letters, digits or _, at most 63"
    );
  }
  if (input.members.length < 2) {
    throw invalid("members", "A merged table needs at least two members");
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  const members = input.members.map((m, i) => {
    if (ids.has(m.table_id)) {
      throw invalid(`members.${i}.table_id`, "A table is a member once");
    }
    ids.add(m.table_id);
    const label = m.label.trim();
    if (label === "" || label.includes("\0")) {
      throw invalid(`members.${i}.label`, "Give the member a label");
    }
    if ([...label].length > MAX_LABEL_LENGTH) {
      throw invalid(
        `members.${i}.label`,
        `A label is at most ${MAX_LABEL_LENGTH} characters`
      );
    }
    if (labels.has(label)) {
      throw invalid(`members.${i}.label`, "Each member needs its own label");
    }
    labels.add(label);
    return { tableId: m.table_id, label };
  });
  const froms = new Set<string>();
  const names = new Set<string>([input.label_column]);
  const included: { name: string; fromName: string; at: number }[] = [];
  input.columns.forEach((c, i) => {
    if (froms.has(c.from_name)) {
      throw invalid(`columns.${i}.from_name`, "A column is given twice");
    }
    froms.add(c.from_name);
    if (!c.include) return;
    if (!NAME.test(c.name)) {
      throw invalid(
        `columns.${i}.name`,
        "A name is a lowercase letter, then lowercase letters, digits or _, at most 63"
      );
    }
    if (names.has(c.name)) {
      throw invalid(`columns.${i}.name`, "Another column has this name");
    }
    names.add(c.name);
    included.push({ name: c.name, fromName: c.from_name, at: i });
  });
  if (included.length === 0) {
    throw invalid("columns", "Include at least one column");
  }
  return { members, included };
};

/**
 * Creates a merged table of the source (no `tableId`) or replaces the
 * definition of one: members (two or more tables of the source that are not
 * merged; on an edit, members that are missing may stay), labels, the label
 * column and the included columns, typed from their members (`text` when
 * they disagree). Column ids are kept by the member column they map from;
 * a column no longer included is marked missing. A new merged table gets an
 * owner grant. Its view is made in the same transaction.
 */
export const saveMergedTable = async (
  caller: Caller,
  sourceId: string,
  input: MergedTableInput,
  tableId?: string
) => {
  const { members, included } = checkInput(input);
  await findChangeable(caller, sourceId);
  const savedId = await withLoadLock(sourceId, () =>
    // An edit changes this merged table's view only; a new one has none yet.
    inDrop(
      sourceId,
      tableId === undefined ? [] : [tableId],
      async (tx, audit) => {
        const row = await lockChangeable(tx, caller, sourceId);
        const existing =
          tableId === undefined
            ? null
            : await tx.sourceTable.findFirst({
                where: { id: tableId, sourceId, missingSince: null },
                include: { columns: true },
              });
        const oldOrigin = existing ? originOf(existing) : null;
        if (tableId !== undefined && oldOrigin?.kind !== "merged") {
          throw new NotFoundError("Merged table not found");
        }
        const oldDef =
          oldOrigin?.kind === "merged" ? oldOrigin.definition : null;

        const tables = await membersOf(
          tx,
          sourceId,
          members.map((m) => m.tableId),
          (i) => `members.${i}.table_id`
        );
        tables.forEach((t, i) => {
          if (
            !isLiveMember(t) &&
            !oldDef?.members.some((m) => m.tableId === t.id)
          ) {
            throw invalid(
              `members.${i}.table_id`,
              "Not a table of the source that can be merged"
            );
          }
        });
        const union = new Map(unionOf(tables).map((u) => [u.name, u]));
        const own = existing?.columns ?? [];
        const ownById = new Map(own.map((c) => [c.id, c]));
        const old = new Map(
          (oldDef?.columns ?? []).flatMap((c) => {
            const catalog = ownById.get(c.columnId);
            return catalog ? [[fromNameOf(catalog), c] as const] : [];
          })
        );
        const memberIds = new Set(members.map((m) => m.tableId));
        const selected = included.map((c) => {
          const u = union.get(c.fromName);
          const kept = old.get(c.fromName);
          if (!u && !kept) {
            throw invalid(
              `columns.${c.at}.from_name`,
              "No member has this column"
            );
          }
          return {
            ...c,
            type: u?.type ?? (kept!.type as UploadColumnType),
            from: u
              ? u.columnIdByMember
              : Object.fromEntries(
                  Object.entries(kept!.from).filter(([m]) => memberIds.has(m))
                ),
          };
        });

        const clash = await tx.sourceTable.findFirst({
          where: {
            sourceId,
            name: input.name,
            ...(existing && { NOT: { id: existing.id } }),
          },
        });
        if (clash) throw tableNameTaken();

        const now = new Date();
        const table = existing
          ? await tx.sourceTable.update({
              where: { id: existing.id },
              data: { name: input.name, lastSyncedAt: now, lastSeenAt: now },
            })
          : await tx.sourceTable.create({
              data: {
                sourceId,
                schemaName: schemaFor(sourceId),
                name: input.name,
                kind: "view",
                lastSeenAt: now,
                lastSyncedAt: now,
                rowCount: 0,
                origin: {
                  kind: "merged",
                  definition: { labelColumnId: "", members: [], columns: [] },
                },
              },
            });

        // Every name moves at once: first out of the way, then to its place.
        await tx.$executeRaw`
        UPDATE "zeteo"."source_columns" SET "name" = '~' || "id"::text
        WHERE "table_id" = ${table.id}::uuid`;
        const labelRow = oldDef ? ownById.get(oldDef.labelColumnId) : undefined;
        const labelData = {
          name: input.label_column,
          type: "text" as const,
          nativeType: NATIVE_TYPE.text,
          position: 1,
          originalName: null,
          missingSince: null,
        };
        const label = labelRow
          ? await tx.sourceColumn.update({
              where: { id: labelRow.id },
              data: labelData,
            })
          : await tx.sourceColumn.create({
              data: {
                ...labelData,
                tableId: table.id,
                nullable: false,
                isPrimaryKey: false,
              },
            });
        const byFrom = new Map(
          own
            .filter((c) => c.id !== labelRow?.id)
            .map((c) => [fromNameOf(c), c])
        );
        const columns: MergedDefinition["columns"] = [];
        for (const [i, s] of selected.entries()) {
          const data = {
            name: s.name,
            type: s.type,
            nativeType: NATIVE_TYPE[s.type],
            position: i + 2,
            originalName: s.fromName,
          };
          const match = byFrom.get(s.fromName);
          byFrom.delete(s.fromName);
          // A kept column keeps its `missing_since`: the view's rebuild clears
          // it when a member has the column, and leaves it when none does.
          const column = match
            ? await tx.sourceColumn.update({ where: { id: match.id }, data })
            : await tx.sourceColumn.create({
                data: {
                  ...data,
                  missingSince: null,
                  tableId: table.id,
                  nullable: true,
                  isPrimaryKey: false,
                },
              });
          columns.push({ columnId: column.id, type: s.type, from: s.from });
        }
        // Columns no longer included keep their name where it is free.
        const taken = new Set([
          input.label_column,
          ...selected.map((s) => s.name),
        ]);
        let position = selected.length + 2;
        for (const c of byFrom.values()) {
          let name = c.name;
          for (let n = 2; taken.has(name); n += 1) {
            name = `${c.name.slice(0, 58)}_${n}`;
          }
          taken.add(name);
          await tx.sourceColumn.update({
            where: { id: c.id },
            data: { name, position, missingSince: c.missingSince ?? now },
          });
          position += 1;
        }

        const definition: MergedDefinition = {
          labelColumnId: label.id,
          members,
          columns,
          warnings: [],
        };
        await tx.sourceTable.update({
          where: { id: table.id },
          data: { origin: { kind: "merged", definition } },
        });
        if (!existing) {
          await giveOwnerGrant(tx, table.id, row.ownerId!, caller.userId);
          // Nothing dropped a view of a new table: it is made here.
          await createMergedViews(tx, sourceId, [table.id]);
        }
        audit({
          action: AUDIT_EVENTS.sourceMergedTableSaved,
          resourceType: "source",
          resourceId: sourceId,
          actorId: caller.userId,
          metadata: {
            slug: row.slug,
            type: "upload",
            table: { id: table.id, name: input.name },
            created: !existing,
            members: members.map((m) => m.tableId),
            columns: selected.length,
            ...(!existing && {
              owner_grant: { user_id: row.ownerId, table_ids: [table.id] },
            }),
          },
        });
        return table.id;
      }
    )
  );
  return tableView(
    await prisma.sourceTable.findUniqueOrThrow({ where: { id: savedId } })
  );
};

/**
 * A merged table's definition and state, for its detail: members (with
 * whether each is missing), its columns (which live members give each),
 * the members' columns it does not carry (`available`), and the member
 * columns that no longer fill theirs (`warnings`). Null for another table.
 */
export const mergedDetail = async (sourceId: string, tableId: string) => {
  const table = await prisma.sourceTable.findFirst({
    where: { id: tableId, sourceId },
    include: { columns: true },
  });
  if (!table) throw new NotFoundError("Table not found");
  const origin = originOf(table);
  if (origin?.kind !== "merged") return null;
  const def = origin.definition;
  const tables = await prisma.sourceTable.findMany({
    where: { sourceId, id: { in: def.members.map((m) => m.tableId) } },
    include: { columns: true },
  });
  const byId = new Map(tables.map((t) => [t.id, t]));
  const own = new Map(table.columns.map((c) => [c.id, c]));
  const live = def.members
    .map((m) => byId.get(m.tableId))
    .filter((t): t is CatalogTable => isLiveMember(t));
  const columns = def.columns.flatMap((c) => {
    const catalog = own.get(c.columnId);
    if (!catalog) return [];
    return [
      {
        id: catalog.id,
        name: catalog.name,
        from_name: fromNameOf(catalog),
        type: c.type,
        // The live members that have it, fitting or not.
        members: live
          .filter((t) => {
            const { state } = resolveMemberColumn(
              t,
              c.type,
              c.from[t.id],
              fromNameOf(catalog)
            );
            return state === "fits" || state === "unfit";
          })
          .map((t) => t.id),
        missing: catalog.missingSince !== null,
      },
    ];
  });
  const carried = new Set(columns.map((c) => c.from_name));
  return {
    label_column: own.get(def.labelColumnId)?.name ?? "",
    members: def.members.map((m) => {
      const t = byId.get(m.tableId);
      return {
        table_id: m.tableId,
        name: t?.name ?? "",
        label: m.label,
        missing: !isLiveMember(t),
      };
    }),
    columns,
    available: unionOf(live)
      .filter((u) => !carried.has(u.name))
      .map((u) => ({ name: u.name, type: u.type, members: u.inMembers })),
    warnings: (def.warnings ?? []).map((w) => ({
      column_id: w.columnId,
      table_id: w.tableId,
    })),
  };
};
