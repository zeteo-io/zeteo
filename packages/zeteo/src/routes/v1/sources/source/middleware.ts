import type { SourceLocator } from "../../../../middleware/fileSourceOwner.js";
import { idOrUndefined } from "../../../../middleware/fileSourceOwner.js";

/** The `:sourceId` of the URL: an owner manages their own file source's relations and descriptions. */
export const sourceOfParams: SourceLocator = async (req) =>
  idOrUndefined(req.params.sourceId);
