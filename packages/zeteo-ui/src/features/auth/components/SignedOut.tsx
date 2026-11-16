import { Alert, AuthPage, Button } from "@kosmeo-ui/react";
import { useLocation } from "react-router-dom";
import { takeReturnPath } from "@/lib/auth";
import { useAuth } from "@tereo-io/react";
import { isAxiosError } from "axios";

const EXPLANATIONS: Record<string, string> = {
  access_denied: "Sign-in was cancelled or refused.",
  invalid_grant: "The sign-in expired or was already used.",
};

/** What a failed callback says: Tereo's OAuth error code explained, or the reason given. */
export const describeSignInError = (err: unknown): string => {
  if (isAxiosError(err)) {
    if (!err.response) return "Tereo could not be reached.";
    const body = err.response.data as { error?: unknown } | undefined;
    const code = typeof body?.error === "string" ? body.error : undefined;
    return (
      (code && EXPLANATIONS[code]) ??
      `Tereo refused the sign-in (${code ?? err.response.status}).`
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return EXPLANATIONS[message] ?? message;
};

/** /signed-out: where a visitor without a session lands, and a failed sign-in ends. */
export const SignedOut = () => {
  const { signIn } = useAuth();
  const error = (useLocation().state as { error?: string } | null)?.error;
  return (
    <AuthPage title="Signed out" subtitle="zeteo admin">
      {error && (
        <Alert variant="danger" heading="Sign-in did not complete">
          <p>{error}</p>
        </Alert>
      )}
      <Button
        onClick={() => void signIn({ returnTo: takeReturnPath() })}
        fullWidth
      >
        Sign in
      </Button>
    </AuthPage>
  );
};
