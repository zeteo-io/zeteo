// @module-tag unit
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getHandler, resetHandler } from "@tereo-io/sdk/handler";
import type { CoreClient } from "@tereo-io/sdk";

// The two group lookups zeteo relies on, through the real SDK client with only
// its HTTP request handler stubbed: a change in how the SDK maps 404, 403 or
// 5xx, or escapes an id, fails here.

const answering = (status: number) =>
  Object.assign(new Error(`status ${status}`), {
    isAxiosError: true,
    response: { status },
  });

let tereo: CoreClient;
let stop: () => Promise<void>;
const handleRequest = vi.fn();

beforeAll(async () => {
  // Outside test mode, where the SDK's methods answer from stubs.
  vi.stubEnv("TEREO_TEST_MODE", "false");
  vi.stubEnv("TEREO_URL", "http://tereo.invalid");
  vi.stubEnv("TEREO_CLIENT_ID", "zeteo-client");
  vi.stubEnv("TEREO_CLIENT_SECRET", "zeteo-secret");
  vi.stubEnv("REQUEST_HANDLER_KEY", "x".repeat(40));
  vi.resetModules();
  const mod = await import("../../utils/tereo.js");
  await mod.initializeTereo();
  tereo = mod.getTereo();
  stop = mod.stopTereo;
  vi.spyOn(getHandler(), "handleRequest").mockImplementation(handleRequest);
});

afterAll(async () => {
  await stop?.();
  vi.unstubAllEnvs();
  resetHandler();
});

const lookups = {
  listUserGroups: (id: string) => tereo.auth.listUserGroups(id),
  getGroup: (id: string) => tereo.auth.getGroup(id),
};

describe.each(Object.keys(lookups) as (keyof typeof lookups)[])(
  "auth.%s",
  (name) => {
    it("returns null for a 404", async () => {
      handleRequest.mockRejectedValue(answering(404));
      expect(await lookups[name]("id-1")).toBeNull();
    });

    it.each([403, 500])("throws for a %i", async (status) => {
      handleRequest.mockRejectedValue(answering(status));
      await expect(lookups[name]("id-1")).rejects.toMatchObject({
        httpStatus: status,
      });
    });

    it("refuses an id of .. without sending a request", async () => {
      handleRequest.mockClear();
      await expect(lookups[name]("..")).rejects.toThrow();
      expect(handleRequest).not.toHaveBeenCalled();
    });
  }
);
