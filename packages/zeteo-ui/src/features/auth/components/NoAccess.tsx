import { AuthPage, Button } from "@kosmeo-ui/react";
import { useAuth } from "@tereo-io/react";
import { useMe } from "@/lib/auth";

/** Signed in, but holding no zeteo permission. */
export const NoAccess = () => {
  const me = useMe();
  const { signOut } = useAuth();
  return (
    <AuthPage title="No access" subtitle="zeteo admin">
      <p>
        Signed in as {me.name ?? me.email ?? me.id}
        {me.name && me.email ? ` (${me.email})` : ""}.
      </p>
      <p>
        You have no zeteo admin permission. Ask an administrator for one, then
        sign in again.
      </p>
      <Button variant="secondary" onClick={() => void signOut()} fullWidth>
        Sign out
      </Button>
    </AuthPage>
  );
};
