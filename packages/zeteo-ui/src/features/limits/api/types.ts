// Field for field the OpenAPI `PrincipalLimit`, `CreatePrincipalLimitRequest`
// and `UpdatePrincipalLimitRequest` schemas.
import type { PrincipalStatus, PrincipalType } from "@/features/principals";

export interface PrincipalLimit {
  id: string;
  principal_type: PrincipalType;
  principal_id: string;
  principal_status: PrincipalStatus;
  query_concurrency: number | null;
  export_concurrency: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePrincipalLimit {
  principal_type: PrincipalType;
  principal_id: string;
  query_concurrency?: number;
  export_concurrency?: number;
}

export interface UpdatePrincipalLimit {
  query_concurrency?: number | null;
  export_concurrency?: number | null;
}

export interface LimitFilters {
  principal_type?: PrincipalType;
  principal_id?: string;
}

export const LIMIT_FIELDS = [
  { key: "query_concurrency", label: "Queries at once", min: 1, max: 100 },
  { key: "export_concurrency", label: "Exports at once", min: 1, max: 10 },
] as const;
