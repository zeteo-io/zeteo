import { callerFromAuth, type Caller } from "../middleware/auth.js";
import { DATA_READ } from "../definitions/tereoDeclaration.js";
import { hasPermission } from "../utils/permissions.js";
import { ForbiddenError } from "../utils/errors.js";
import type { AuthContext } from "@tereo-io/sdk";

/** The tool's caller, refused (`forbidden`) without `zeteo.data.read`, as `GET /v1/catalog` refuses them. */
export const requireDataRead = (auth: AuthContext): Caller => {
  const caller = callerFromAuth(auth);
  if (!hasPermission(caller.permissions, DATA_READ)) {
    throw new ForbiddenError(`Requires the ${DATA_READ} permission`);
  }
  return caller;
};
