import type { AuthValue, Me } from "@/lib/auth/useAuth";
import { hasPermission } from "@/lib/auth/permissions";
import type { Tokens } from "@/lib/auth/tokens";
import type { ReactNode } from "react";
import { vi } from "vitest";

export const TEST_ME: Me = {
  id: "0b6c3c1e-8a52-4f7e-9b1d-2f4f8f0e9a11",
  type: "user",
  name: "Test Admin",
  email: "admin@example.com",
  permissions: [],
};

export const TEST_TOKENS: Tokens = {
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  idToken: "test-id-token",
  expiresAt: Number.MAX_SAFE_INTEGER,
};

/**
 * A stand-in for `@/lib/auth`, signed in with `permissions`:
 *
 *   vi.mock("@/lib/auth", async () =>
 *     (await import("@/test/authMock")).mockAuth({
 *       permissions: ["zeteo.sources.read"],
 *     })
 *   );
 *
 * `useAuth().signOut` is a `vi.fn()`; `can` is the real `hasPermission`.
 */
export const mockAuth = ({
  permissions = ["admin"],
  me = {},
}: { permissions?: string[]; me?: Partial<Me> } = {}) => {
  const fullMe: Me = { ...TEST_ME, permissions, ...me };
  const auth: AuthValue = {
    me: fullMe,
    can: (permission) => hasPermission(fullMe.permissions, permission),
    signOut: vi.fn(),
  };
  return {
    useAuth: () => auth,
    AuthProvider: ({ children }: { children: ReactNode }) => children,
    hasPermission,
    getTokens: vi.fn(() => TEST_TOKENS),
    setTokens: vi.fn(),
    renew: vi.fn(async () => TEST_TOKENS),
    signOut: vi.fn(async () => undefined),
    startLogin: vi.fn(async () => undefined),
    completeLogin: vi.fn(async () => ({ returnTo: "/" })),
    fetchMe: vi.fn(async () => fullMe),
    AuthError: class AuthError extends Error {
      code = "mocked";
    },
  };
};
