// @module-tag unit
// @module-tag platform
import { InvalidAuditEntryError } from "@tereo-io/sdk";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { logger } from "../../utils/logger.js";
import {
  errorHandler,
  findingsBody,
  WritableLoginError,
} from "../../utils/errors.js";

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

const findings = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    code: "can_write_tables",
    detail: `The login can INSERT on sales.t${i}`,
  }));

describe("findingsBody", () => {
  it("keeps up to 20 findings as they are", () => {
    expect(findingsBody(findings(20))).toEqual({ findings: findings(20) });
  });

  it("keeps the first 20 of more, and says it left some out", () => {
    expect(findingsBody(findings(21))).toEqual({
      findings: findings(20),
      truncated: true,
    });
  });
});

describe("WritableLoginError", () => {
  it("carries the findings as code and detail, capped at 20", () => {
    const err = new WritableLoginError(findings(25));
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("writable_login");
    expect(err.details).toEqual({ findings: findings(20), truncated: true });
  });
});
