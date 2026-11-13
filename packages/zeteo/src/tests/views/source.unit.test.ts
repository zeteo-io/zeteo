// @module-tag unit
// @module-tag platform
import type { Source } from "../../../prisma/generated/client/index.js";
import { sourceView } from "../../views/source.js";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";

const row = (overrides: Partial<Source>): Source => ({
  id: "0198f7a2-0000-7000-8000-000000000001",
  slug: "sales",
  name: "Sales",
  type: "postgres",
  sealedSettings: {},
  schemas: ["public"],
  timeoutMs: 30_000,
  rowCap: 50_000,
  exportEnabled: false,
  exportRowCap: 0,
  writableLoginAllowed: false,
  status: "active",
  lastRefreshedAt: null,
  createdBy: "0198f7a2-0000-7000-8000-000000000002",
  createdAt: new Date("2026-11-12T00:00:00.000Z"),
  updatedAt: new Date("2026-11-12T00:00:00.000Z"),
  archivedAt: null,
  ...overrides,
});

describe("sourceView", () => {
  it.each([
    ["the type has no adapter", { type: "azure_sql" as const }],
    ["the settings cannot be opened", { sealedSettings: { v: 1 } }],
  ])(
    "shows settings null, and logs the cause under err, when %s",
    (_, change) => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      try {
        expect(sourceView(row(change)).settings).toBeNull();
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({
            err: expect.any(Error),
            source_id: "0198f7a2-0000-7000-8000-000000000001",
          }),
          "source settings cannot be shown"
        );
      } finally {
        error.mockRestore();
      }
    }
  );
});
