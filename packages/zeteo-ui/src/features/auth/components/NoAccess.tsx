import { AuthPage, Button } from "@kosmeo-ui/react";
import type { Me } from "@/lib/auth/useAuth";

interface NoAccessProps {
  me: Me;
  onSignOut: () => void;
}

export const NoAccess = ({ me, onSignOut }: NoAccessProps) => (
  <AuthPage title="No access" subtitle="zeteo admin">
    <p>
      Signed in as {me.name ?? me.email ?? me.id}
      {me.name && me.email ? ` (${me.email})` : ""}.
    </p>
    <p>
      You have no zeteo admin permission. Ask an administrator for one, then
      sign in again.
    </p>
    <Button variant="secondary" onClick={onSignOut} fullWidth>
      Sign out
    </Button>
  </AuthPage>
);
