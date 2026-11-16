import { hasSession, readTokens, useAuth } from "@tereo-io/react";
import { NoAccess, StartupError } from "@/features/auth";
import { rememberReturnPath, type Me } from "@/lib/auth";
import { Centered, Spinner } from "@kosmeo-ui/react";
import { useEffect, type ReactNode } from "react";
import { useMeError } from "./ZeteoAuthProvider";

/**
 * The app's pages render only for someone signed in with a zeteo permission.
 * A visitor with no session is sent to /signed-out by the provider.
 */
export const AuthGate = ({ children }: { children: ReactNode }) => {
  const { user, isLoading, signOut, reloadUser } = useAuth<Me>();
  const meError = useMeError();
  const noSession = !user && !isLoading && !readTokens() && !hasSession();

  useEffect(() => {
    if (noSession) rememberReturnPath();
  }, [noSession]);

  if (user) return user.permissions.length === 0 ? <NoAccess /> : children;
  if (isLoading || noSession) {
    return (
      <Centered>
        <Spinner size="lg" />
      </Centered>
    );
  }
  // A token, but GET /v1/me kept failing.
  return (
    <StartupError
      title="Your account could not be loaded"
      message={meError?.message ?? "zeteo did not answer GET /v1/me."}
      onRetry={() => void reloadUser()}
      onSignOut={() => void signOut()}
    />
  );
};
