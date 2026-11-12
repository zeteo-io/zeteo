import { postgresSettingsSchema, type PostgresSettings } from "./settings.js";
import type { SourceAdapter } from "../types.js";
import { connectPostgres } from "./connect.js";

export const postgresAdapter: SourceAdapter<PostgresSettings> = {
  type: "postgres",
  settingsSchema: postgresSettingsSchema,
  hostOf: (settings) => settings.host,
  redact: ({ password: _password, ca: _ca, ...rest }) => rest,
  connect: connectPostgres,
};
