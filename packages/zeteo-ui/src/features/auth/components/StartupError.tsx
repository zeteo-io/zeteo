import { Alert, AuthPage, Button } from "@kosmeo-ui/react";

interface StartupErrorProps {
  title: string;
  message: string;
  onRetry: () => void;
  onSignOut?: () => void;
}

/** A sign-in that cannot go on: no configuration, or no account answer. */
export const StartupError = ({
  title,
  message,
  onRetry,
  onSignOut,
}: StartupErrorProps) => (
  <AuthPage title={title} subtitle="zeteo admin">
    <Alert variant="danger">{message}</Alert>
    <Button onClick={onRetry} fullWidth>
      Try again
    </Button>
    {onSignOut && (
      <Button variant="secondary" onClick={onSignOut} fullWidth>
        Sign out
      </Button>
    )}
  </AuthPage>
);
