import type { AuthState } from "@tereo-io/react";
import type { AxiosInstance } from "axios";
import type { ReactNode } from "react";
import type { Me } from "@/lib/auth";
import { vi } from "vitest";

export const TEST_ME: Me = {
  id: "0b6c3c1e-8a52-4f7e-9b1d-2f4f8f0e9a11",
  type: "user",
  name: "Test Admin",
  email: "admin@example.com",
  permissions: [],
};

type Permissions = string[] | (() => string[]);

/** The HTTP methods a test answers on zeteo's client. */
export type ApiMock = Partial<
  Record<
    "get" | "post" | "put" | "patch" | "delete",
    (...args: never[]) => unknown
  >
>;

/**
 * A stand-in for `@tereo-io/react`, signed in with `permissions` (a list, or
 * a function read at every render for tests that change them), with `api` as
 * zeteo's client:
 *
 *   const get = vi.hoisted(() => vi.fn());
 *   vi.mock("@tereo-io/react", async () =>
 *     (await import("@/test/authMock")).mockTereo({
 *       permissions: ["zeteo.sources.read"],
 *       api: { get },
 *     })
 *   );
 *
 * `hasPermission` is the package's own; `signIn` and `signOut` are `vi.fn()`.
 * Everything not replaced is the real package.
 */
export const mockTereo = async ({
  permissions = ["admin"],
  me = {},
  api = {},
}: { permissions?: Permissions; me?: Partial<Me>; api?: ApiMock } = {}) => {
  const actual =
    await vi.importActual<typeof import("@tereo-io/react")>("@tereo-io/react");
  const held = () =>
    typeof permissions === "function" ? permissions() : permissions;
  const signIn = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => undefined);
  const useAuth = (): AuthState<Me> => {
    const user: Me = { ...TEST_ME, ...me, permissions: held() };
    return {
      user,
      isLoading: false,
      isSignedIn: true,
      isLive: true,
      hasPermission: (required) =>
        actual.hasPermission(user.permissions, required),
      signIn,
      signOut,
      switchOrganization: vi.fn(async () => undefined),
      reloadUser: vi.fn(async () => undefined),
    };
  };
  return {
    ...actual,
    useAuth,
    useApi: () => api as unknown as AxiosInstance,
    TereoAuthProvider: ({ children }: { children: ReactNode }) => children,
    signIn,
    signOut,
  };
};
