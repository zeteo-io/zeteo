import { prisma } from "../../utils/db/prisma.js";
import { tokenFor } from "./tokens.js";
import { fetchJson } from "./http.js";
import {
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  sourceBody,
  sourceSettings,
  writeToken as sourcesWriteToken,
} from "./sources.js";

export const grantsWriteToken = () => tokenFor({ permissions: [GRANTS_WRITE] });
export const grantsReadToken = () => tokenFor({ permissions: [GRANTS_READ] });

/** A source over the fixture database, registered through the API; returns its id. */
export const registerSource = async (baseUrl: string): Promise<string> => {
  const res = await fetchJson(
    "POST",
    `${baseUrl}/v1/sources`,
    sourcesWriteToken(),
    sourceBody(sourceSettings("ro"), { schemas: ["sales"] })
  );
  if (res.status !== 201) throw new Error(`source not created: ${res.status}`);
  return res.body.id as string;
};

export const tableOf = (sourceId: string, name: string) =>
  prisma.sourceTable.findFirstOrThrow({ where: { sourceId, name } });

export const columnsOf = (tableId: string) =>
  prisma.sourceColumn.findMany({
    where: { tableId },
    orderBy: { position: "asc" },
  });
