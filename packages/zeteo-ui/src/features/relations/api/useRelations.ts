import { useCursorList } from "@/lib/api";
import type { Relation } from "./types";

/** A source's relations in creation order, missing ones included. */
export const useRelations = (sourceId: string) =>
  useCursorList<Relation>(
    ["sources", sourceId, "relations"],
    `/v1/sources/${sourceId}/relations`
  );
