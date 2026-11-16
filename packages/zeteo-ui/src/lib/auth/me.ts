import type { AxiosInstance } from "axios";
import { useAuth } from "@tereo-io/react";
import { ZETEO_API } from "@/lib/api";

export interface Me {
  id: string;
  type: "user" | "service";
  name: string | null;
  email: string | null;
  permissions: string[];
  [key: string]: unknown;
}

export const parseMe = (body: unknown): Me => {
  const b = (body ?? {}) as Record<string, unknown>;
  const nullableString = (v: unknown) => typeof v === "string" || v === null;
  if (
    typeof b.id !== "string" ||
    (b.type !== "user" && b.type !== "service") ||
    !nullableString(b.name) ||
    !nullableString(b.email) ||
    !Array.isArray(b.permissions) ||
    !b.permissions.every((p) => typeof p === "string")
  ) {
    throw new Error("GET /v1/me answered with an unexpected body");
  }
  return {
    id: b.id,
    type: b.type,
    name: b.name as string | null,
    email: b.email as string | null,
    permissions: b.permissions as string[],
  };
};

/** The provider's `loadUser`: `GET /v1/me` on zeteo. */
export const loadMe = async (
  apis: Record<string, AxiosInstance>
): Promise<Me> => parseMe((await apis[ZETEO_API].get<unknown>("/v1/me")).data);

/** The signed-in person. Only for components under the auth gate, which renders them signed in. */
export const useMe = (): Me => {
  const { user } = useAuth<Me>();
  if (!user) throw new Error("useMe is used before sign-in");
  return user;
};
