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
  maxJoins: 4,
  exportEnabled: false,
  exportRowCap: 0,
  queryConcurrency: 5,
  exportConcurrency: 2,
  writableLoginAllowed: false,
  status: "active",
  lastRefreshedAt: null,
  sizeBytes: null,
  sizeMeasuredAt: null,
  ownerId: null,
  createdBy: "0198f7a2-0000-7000-8000-000000000002",
  createdAt: new Date("2026-11-12T00:00:00.000Z"),
  updatedAt: new Date("2026-11-12T00:00:00.000Z"),
  archivedAt: null,
  ...overrides,
});

const extras = { shareCount: 0, storedBytes: 0 };

describe("sourceView", () => {
  it.each([
    [
      "an azure-sql source's settings cannot be opened",
      { type: "azure_sql" as const, sealedSettings: { v: 1 } },
    ],
    ["the settings cannot be opened", { sealedSettings: { v: 1 } }],
  ])(
    "shows settings null, and logs the cause under err, when %s",
    (_, change) => {
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});
      try {
        expect(sourceView(row(change), extras).settings).toBeNull();
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

  it("shows the source's query and export concurrency", () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(
        sourceView(row({ queryConcurrency: 12, exportConcurrency: 4 }), extras)
      ).toMatchObject({ query_concurrency: 12, export_concurrency: 4 });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shows the size as a number, with when it was measured", () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(
        sourceView(
          row({
            sizeBytes: 5_000_000_000n,
            sizeMeasuredAt: new Date("2026-11-18T10:00:00.000Z"),
          }),
          extras
        )
      ).toMatchObject({
        size_bytes: 5_000_000_000,
        size_measured_at: "2026-11-18T10:00:00.000Z",
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shows size null while none is known", () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(sourceView(row({}), extras)).toMatchObject({
        size_bytes: null,
        size_measured_at: null,
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shows an upload source's stored bytes as its size, never measured, and no settings", () => {
    expect(
      sourceView(
        row({
          type: "upload",
          ownerId: "0198f7a2-0000-7000-8000-000000000003",
          sizeBytes: 99n,
          sizeMeasuredAt: new Date("2026-11-18T10:00:00.000Z"),
        }),
        { shareCount: 3, storedBytes: 8192 }
      )
    ).toMatchObject({
      type: "upload",
      owner_id: "0198f7a2-0000-7000-8000-000000000003",
      settings: null,
      size_bytes: 8192,
      size_measured_at: null,
      share_count: 3,
    });
  });

  it("shows a database source's share count", () => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(
        sourceView(row({}), { shareCount: 2, storedBytes: 0 }).share_count
      ).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
