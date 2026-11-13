// @module-tag unit
// @module-tag platform
import { postExport } from "../../../../routes/v1/export/controllers.js";
import { QueryTimeoutError } from "../../../../utils/errors.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../../utils/logger.js";
import type { Request, Response } from "express";
import { EventEmitter } from "node:events";
import {
  abortExports,
  resetExportShutdown,
  runExport,
} from "../../../../engine/export.js";

// runExport, stood in for so a test chooses what cuts the stream; the rest
// of the module is real.
const cut = vi.hoisted(() => ({ err: undefined as unknown }));
vi.mock(import("../../../../engine/export.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runExport: vi.fn(async (_input, sink) => {
      await sink.start({ columns: [], warnings: [], runId: "run-1" });
      throw cut.err;
    }),
  };
});
vi.mock(import("../../../../export/httpSink.js"), () => ({
  httpSink: () => ({
    start: async () => undefined,
    rows: async () => undefined,
    end: async () => undefined,
  }),
}));

/** The error a new export is refused with once the service is stopping. */
const shutdownError = async (): Promise<unknown> => {
  const actual = await vi.importActual<
    typeof import("../../../../engine/export.js")
  >("../../../../engine/export.js");
  abortExports();
  try {
    await actual.runExport(
      {
        caller: {
          userId: "u",
          organizationId: null,
          permissions: [],
          isServiceAccount: false,
        },
        body: { source: "s" },
        signal: new AbortController().signal,
      },
      {
        start: async () => undefined,
        rows: async () => undefined,
        end: async () => undefined,
      }
    );
  } catch (err) {
    return err;
  } finally {
    resetExportShutdown();
  }
  throw new Error("the export was not refused");
};

/** Runs the controller with a stream that is cut by `err` after it started. */
const cutBy = async (err: unknown) => {
  cut.err = err;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroy: vi.fn(),
  });
  const req = {
    query: {},
    body: { source: "s" },
    caller: {
      userId: "u",
      organizationId: null,
      permissions: [],
      isServiceAccount: false,
    },
  };
  await postExport(req as unknown as Request, res as unknown as Response);
  return res;
};

describe("POST /v1/export: a stream cut after it started", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["shutdown", shutdownError],
    ["its deadline", async () => new QueryTimeoutError()],
  ])(
    "logs a stream cut by %s at warn and cuts the connection",
    async (_, make) => {
      const err = await make();
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const error = vi
        .spyOn(logger, "error")
        .mockImplementation(() => undefined);
      const res = await cutBy(err);
      expect(vi.mocked(runExport)).toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        { err, run_id: "run-1" },
        "export stopped mid-stream"
      );
      expect(error).not.toHaveBeenCalled();
    }
  );

  it("logs any other failure at error", async () => {
    const err = new Error("broken");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await cutBy(err);
    expect(error).toHaveBeenCalledWith(
      { err, run_id: "run-1" },
      "export failed mid-stream"
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
