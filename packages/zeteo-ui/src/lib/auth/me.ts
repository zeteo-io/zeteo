import type { Me } from "./useAuth";

export class MeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MeError";
    this.status = status;
  }
}

const parseMe = (body: unknown): Me => {
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
    throw new MeError(0, "GET /v1/me answered with an unexpected body");
  }
  return {
    id: b.id,
    type: b.type,
    name: b.name as string | null,
    email: b.email as string | null,
    permissions: b.permissions as string[],
  };
};

/** `GET /v1/me` on zeteo, with the given access token. */
export const fetchMe = async (accessToken: string): Promise<Me> => {
  let res: Response;
  try {
    res = await fetch("/v1/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      credentials: "same-origin",
    });
  } catch {
    throw new MeError(0, "zeteo could not be reached");
  }
  if (!res.ok) {
    throw new MeError(res.status, `GET /v1/me answered ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new MeError(0, "GET /v1/me did not answer JSON");
  }
  return parseMe(body);
};
