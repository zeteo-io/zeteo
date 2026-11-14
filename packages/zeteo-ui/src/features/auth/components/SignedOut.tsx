import { Alert, AuthPage, Button } from "@kosmeo-ui/react";

const EXPLANATIONS: Record<string, string> = {
  access_denied: "Sign-in was cancelled or refused.",
  no_login_state:
    "This sign-in answer does not belong to a sign-in started in this tab.",
  state_mismatch:
    "This sign-in answer does not belong to the sign-in started in this tab.",
  nonce_mismatch: "Tereo's answer did not match this sign-in.",
  audience_mismatch: "Tereo issued a sign-in for a different client.",
  tereo_unreachable: "Tereo could not be reached.",
  invalid_grant: "The sign-in expired or was already used.",
};

interface SignedOutProps {
  code: string;
  onSignIn: () => void;
}

export const SignedOut = ({ code, onSignIn }: SignedOutProps) => (
  <AuthPage title="Signed out" subtitle="zeteo admin">
    <Alert variant="danger" heading="Sign-in did not complete">
      <p>{EXPLANATIONS[code] ?? "Tereo did not complete the sign-in."}</p>
      <p>
        Error: <code>{code}</code>
      </p>
    </Alert>
    <Button onClick={onSignIn} fullWidth>
      Sign in
    </Button>
  </AuthPage>
);
