// @module-tag unit
// @module-tag platform
import { InvalidAuditEntryError } from "@tereo-io/sdk";
import { errorHandler } from "../../utils/errors.js";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { logger } from "../../utils/logger.js";

/** A response that records what the handler wrote. */
const recorder = () => {
  const written: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    setHeader: () => res,
    status: (code: number) => {
      written.status = code;
      return res;
    },
    json: (body: unknown) => {
      written.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, written };
};

const req = { method: "POST", originalUrl: "/v1/sources" } as Request;

describe("errorHandler", () => {
  it("answers an audit entry the SDK refused as a 500, logged under err", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      const err = new InvalidAuditEntryError("userId must be a UUID");
      const { res, written } = recorder();
      errorHandler(err, req, res, () => {});
      expect(written).toEqual({
        status: 500,
        body: {
          error: "server_error",
          error_description: "An unexpected error occurred",
        },
      });
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        expect.any(String)
      );
    } finally {
      error.mockRestore();
    }
  });
});
