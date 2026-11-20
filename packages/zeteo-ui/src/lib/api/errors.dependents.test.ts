import { AxiosError, AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { toApiError } from "./errors";

describe("toApiError measure_in_use", () => {
  it("keeps the dependents as kind and name", () => {
    const err = toApiError(
      new AxiosError("failed", "ERR_BAD_REQUEST", undefined, null, {
        status: 409,
        statusText: "",
        data: {
          error: "measure_in_use",
          error_description: "In use",
          dependents: [
            { kind: "measure", name: "margin" },
            { kind: "metric", name: "margin_pct" },
            { nope: 1 },
          ],
        },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
    );
    expect(err.dependents).toEqual([
      { kind: "measure", name: "margin" },
      { kind: "metric", name: "margin_pct" },
    ]);
  });
});
