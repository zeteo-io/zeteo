import { Alert } from "@kosmeo-ui/react";

export const NO_ACCESS_NOTICE =
  "You need expanded permissions to run this saved query. Ask an admin to extend your access.";

export const NoAccessNotice = () => (
  <Alert variant="warning" size="sm">
    {NO_ACCESS_NOTICE}
  </Alert>
);
