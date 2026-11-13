import { azureSqlSettingsSchema, type AzureSqlSettings } from "./settings.js";
import { prepareAzureSqlQuery } from "./runQuery.js";
import type { SourceAdapter } from "../types.js";
import { sqlLanguage } from "../sql/language.js";
import { connectAzureSql } from "./connect.js";

export const azureSqlAdapter: SourceAdapter<AzureSqlSettings> = {
  type: "azure-sql",
  settingsSchema: azureSqlSettingsSchema,
  language: sqlLanguage,
  hostOf: (settings) => settings.host,
  redact: ({ password: _password, ...rest }) => rest,
  connect: connectAzureSql,
  prepare: prepareAzureSqlQuery,
};
