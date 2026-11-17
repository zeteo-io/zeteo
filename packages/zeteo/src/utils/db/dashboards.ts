import { Prisma as PrismaRuntime } from "../../../prisma/generated/client/index.js";
import { prisma, type Prisma } from "./prisma.js";
import type { Principal } from "./grants.js";
import type {
  DashboardTheme,
  PanelKind,
  PrincipalType,
  Dashboard,
  DashboardPanel,
  DashboardShare,
} from "../../../prisma/generated/client/index.js";

/** The client or the open transaction a repository function runs on. */
type Db = Prisma.TransactionClient | typeof prisma;

export interface DashboardInput {
  ownerId: string;
  name: string;
  description: string;
  timeRange?: string | null;
  refreshSeconds?: number | null;
  theme?: DashboardTheme;
}

export type DashboardChanges = Partial<Omit<DashboardInput, "ownerId">>;

/** A panel as written: its place in the grid and what it shows. */
export interface PanelInput {
  kind: PanelKind;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string | null;
  savedQueryId?: string | null;
  savedPanelId?: string | null;
  chart?: Prisma.InputJsonValue | null;
  timeColumn?: string | null;
}

export type PanelChanges = Partial<PanelInput>;

export type DashboardWithPanels = Dashboard & { panels: DashboardPanel[] };

const chartData = (chart: Prisma.InputJsonValue | null | undefined) =>
  chart === undefined
    ? {}
    : { chart: chart === null ? PrismaRuntime.DbNull : chart };

const panelChanges = ({ chart, ...rest }: PanelChanges) => ({
  ...rest,
  ...chartData(chart),
});

const panelData = ({ chart, ...rest }: PanelInput) => ({
  ...rest,
  ...chartData(chart),
});

const nameFilter = (q: string | undefined) =>
  q ? { name: { contains: q, mode: "insensitive" as const } } : {};

export const findById = (
  id: string,
  tx: Db = prisma
): Promise<Dashboard | null> => tx.dashboard.findUnique({ where: { id } });

/**
 * One page, newest first (ids are time-ordered), starting after the `cursor` id.
 * `"mine"` is what `userId` owns; `"shared"` is what is shared with the user or
 * with any of their groups, never what they own.
 */
export const listVisibleTo = async (
  options: {
    userId: string;
    groupIds: string[];
    scope: "mine" | "shared";
    q?: string;
    cursor?: string;
    limit: number;
  },
  tx: Db = prisma
): Promise<{ rows: Dashboard[]; hasMore: boolean }> => {
  const { userId, groupIds, scope, q, cursor, limit } = options;
  const reaching: Prisma.DashboardShareWhereInput = {
    OR: [
      { principalType: "user", principalId: userId },
      ...(groupIds.length > 0
        ? [{ principalType: "group" as const, principalId: { in: groupIds } }]
        : []),
    ],
  };
  const rows = await tx.dashboard.findMany({
    where: {
      ...(scope === "mine"
        ? { ownerId: userId }
        : { ownerId: { not: userId }, shares: { some: reaching } }),
      ...nameFilter(q),
      ...(cursor && { id: { lt: cursor } }),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

/** Every one, optionally narrowed to an owner or a name, newest first, after the `cursor` id. */
export const listAll = async (
  options: { ownerId?: string; q?: string; cursor?: string; limit: number },
  tx: Db = prisma
): Promise<{ rows: Dashboard[]; hasMore: boolean }> => {
  const { ownerId, q, cursor, limit } = options;
  const rows = await tx.dashboard.findMany({
    where: {
      ...(ownerId && { ownerId }),
      ...nameFilter(q),
      ...(cursor && { id: { lt: cursor } }),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
};

const PANEL_ORDER = [
  { y: "asc" as const },
  { x: "asc" as const },
  { id: "asc" as const },
];

/** The dashboard with its panels in reading order (top to bottom, left to right). */
export const findWithPanels = (
  id: string,
  tx: Db = prisma
): Promise<DashboardWithPanels | null> =>
  tx.dashboard.findUnique({
    where: { id },
    include: { panels: { orderBy: PANEL_ORDER } },
  });

export const create = (
  data: DashboardInput,
  tx: Db = prisma
): Promise<Dashboard> => tx.dashboard.create({ data });

export const update = (
  id: string,
  data: DashboardChanges,
  tx: Db = prisma
): Promise<Dashboard> => tx.dashboard.update({ where: { id }, data });

/** Deletes the dashboard; its panels and shares go with it, and the runs that came from it keep their record with no link. */
export const remove = (id: string, tx: Db = prisma): Promise<Dashboard> =>
  tx.dashboard.delete({ where: { id } });

/** Makes the dashboard's panels exactly `panels`, in a new set of rows. */
export const replacePanels = async (
  tx: Db,
  dashboardId: string,
  panels: PanelInput[]
): Promise<DashboardPanel[]> => {
  await tx.dashboardPanel.deleteMany({ where: { dashboardId } });
  if (panels.length > 0) {
    await tx.dashboardPanel.createMany({
      data: panels.map((p) => ({ dashboardId, ...panelData(p) })),
    });
  }
  return tx.dashboardPanel.findMany({
    where: { dashboardId },
    orderBy: PANEL_ORDER,
  });
};

export const addPanel = (
  dashboardId: string,
  panel: PanelInput,
  tx: Db = prisma
): Promise<DashboardPanel> =>
  tx.dashboardPanel.create({ data: { dashboardId, ...panelData(panel) } });

export const updatePanel = (
  id: string,
  changes: PanelChanges,
  tx: Db = prisma
): Promise<DashboardPanel> =>
  tx.dashboardPanel.update({ where: { id }, data: panelChanges(changes) });

export const removePanel = (
  id: string,
  tx: Db = prisma
): Promise<DashboardPanel> => tx.dashboardPanel.delete({ where: { id } });

/** How many dashboards have a panel on the saved query (a dashboard counts once, however many panels). */
export const countUsingSavedQuery = async (
  savedQueryId: string,
  tx: Db = prisma
): Promise<number> =>
  (
    await tx.dashboardPanel.findMany({
      where: { savedQueryId },
      distinct: ["dashboardId"],
      select: { dashboardId: true },
    })
  ).length;

/** How many dashboards have a panel linked to the saved panel (a dashboard counts once). */
export const countUsingSavedPanel = async (
  savedPanelId: string,
  tx: Db = prisma
): Promise<number> =>
  (
    await tx.dashboardPanel.findMany({
      where: { savedPanelId },
      distinct: ["dashboardId"],
      select: { dashboardId: true },
    })
  ).length;

/** The dashboards with a panel on the saved query, each once (for an admin). */
export const listUsingSavedQuery = async (
  savedQueryId: string,
  tx: Db = prisma
): Promise<Dashboard[]> =>
  tx.dashboard.findMany({
    where: { panels: { some: { savedQueryId } } },
    orderBy: { id: "desc" },
  });

const key = (p: Principal) => `${p.type}:${p.id}`;

/** Makes the shares exactly `principals`; resolves who was added and who removed. Shares already there keep their `createdBy` and `createdAt`. */
export const replaceShares = async (
  tx: Db,
  dashboardId: string,
  principals: Principal[],
  createdBy: string
): Promise<{ added: Principal[]; removed: Principal[] }> => {
  const existing = await tx.dashboardShare.findMany({ where: { dashboardId } });
  const wanted = new Map(principals.map((p) => [key(p), p]));
  const have = new Map<string, Principal>(
    existing.map((s) => {
      const p = { type: s.principalType as PrincipalType, id: s.principalId };
      return [key(p), p];
    })
  );
  const added = [...wanted].filter(([k]) => !have.has(k)).map(([, p]) => p);
  const removed = [...have].filter(([k]) => !wanted.has(k)).map(([, p]) => p);
  if (removed.length > 0) {
    await tx.dashboardShare.deleteMany({
      where: {
        dashboardId,
        OR: removed.map((p) => ({ principalType: p.type, principalId: p.id })),
      },
    });
  }
  if (added.length > 0) {
    await tx.dashboardShare.createMany({
      data: added.map((p) => ({
        dashboardId,
        principalType: p.type,
        principalId: p.id,
        createdBy,
      })),
    });
  }
  return { added, removed };
};

export const listShares = (
  id: string,
  tx: Db = prisma
): Promise<DashboardShare[]> =>
  tx.dashboardShare.findMany({
    where: { dashboardId: id },
    orderBy: [{ createdAt: "asc" }, { principalId: "asc" }],
  });

/**
 * Hands it to `newOwnerId`. `keepAccessFor` (the previous owner) gets a user
 * share so they keep reading it, or null for none. A share the new owner held
 * is dropped, as an owner needs none.
 */
export const transfer = async (
  tx: Db,
  id: string,
  newOwnerId: string,
  keepAccessFor: string | null
): Promise<Dashboard> => {
  const updated = await tx.dashboard.update({
    where: { id },
    data: { ownerId: newOwnerId },
  });
  await tx.dashboardShare.deleteMany({
    where: { dashboardId: id, principalType: "user", principalId: newOwnerId },
  });
  if (keepAccessFor !== null && keepAccessFor !== newOwnerId) {
    await tx.dashboardShare.upsert({
      where: {
        dashboardId_principalType_principalId: {
          dashboardId: id,
          principalType: "user",
          principalId: keepAccessFor,
        },
      },
      create: {
        dashboardId: id,
        principalType: "user",
        principalId: keepAccessFor,
        createdBy: newOwnerId,
      },
      update: {},
    });
  }
  return updated;
};
