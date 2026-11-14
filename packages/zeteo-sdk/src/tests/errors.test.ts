import { describe, expect, it } from "vitest";
import {
  ExportInterruptedError,
  QueryRefusedError,
  ZeteoError,
} from "../errors.js";

describe("errors", () => {
  it("ZeteoError carries its fields and a plain cause", () => {
    const error = new ZeteoError("m", {
      status: 409,
      code: "c",
      cause: new Error("inner"),
    });
    expect(error).toMatchObject({ name: "ZeteoError", status: 409, code: "c" });
    expect(error.cause).toEqual(new Error("inner"));
  });

  it("status defaults to null", () => {
    expect(new ZeteoError("m", { code: "c" }).status).toBeNull();
  });

  it("QueryRefusedError is a ZeteoError with a path and suggestions", () => {
    const error = new QueryRefusedError("m", {
      status: 422,
      code: "c",
      path: ["a", 0],
    });
    expect(error).toBeInstanceOf(ZeteoError);
    expect(error.path).toEqual(["a", 0]);
    expect(error.suggestions).toEqual([]);
  });

  it("ExportInterruptedError is not a ZeteoError", () => {
    const error = new ExportInterruptedError("cut", "run-1", 40);
    expect(error).not.toBeInstanceOf(ZeteoError);
    expect(error).toMatchObject({ runId: "run-1", rowsRead: 40 });
  });
});
