import type { SourceLocator } from "../../../../middleware/uploadOwner.js";
import { idOrUndefined } from "../../../../middleware/uploadOwner.js";

/** The `:sourceId` of the URL: an owner manages their own upload source's relations and descriptions. */
export const sourceOfParams: SourceLocator = async (req) =>
  idOrUndefined(req.params.sourceId);
