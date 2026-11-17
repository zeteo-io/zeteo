import { z } from "zod";
import {
  SavedPanelDescriptionSchema,
  SavedPanelNameSchema,
} from "../../../../../saved-panels/schemas.js";

export const SaveAsSavedPanelSchema = z.strictObject({
  name: SavedPanelNameSchema,
  description: SavedPanelDescriptionSchema.optional(),
});
