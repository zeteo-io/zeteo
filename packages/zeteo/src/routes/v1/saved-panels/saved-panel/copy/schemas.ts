import { SavedPanelNameSchema } from "../../schemas.js";
import { z } from "zod";

export const CopySavedPanelSchema = z.strictObject({
  name: SavedPanelNameSchema,
});
