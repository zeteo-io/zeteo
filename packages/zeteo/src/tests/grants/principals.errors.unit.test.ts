// @module-tag unit
// @module-tag platform
import { ServiceUnavailableError } from "../../utils/errors.js";
import { runInTransactionScope } from "../../utils/tereo.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as tereoGroups from "../../utils/tereoGroups.js";
import { RequestError } from "@tereo-io/sdk/handler";
import { requests } from "@tereo-io/sdk/handler";
import {
  fetchGroupsFromTereo,
  statusFromTereo,
} from "../../grants/principals.js";

vi.mock("../../utils/tereoGroups.js");
vi.mock("@tereo-io/sdk/handler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tereo-io/sdk/handler")>()),
  requests: { auth: { getUser: vi.fn() } },
}));

const failing = (status?: number) =>
  Object.assign(new Error("request failed"), {
    response: status === undefined ? undefined : { status },
  });

afterEach(() => vi.resetAllMocks());

describe("fetchGroupsFromTereo", () => {
  it("returns id and organizationId of each group", async () => {
    vi.mocked(tereoGroups.listUserGroups).mockResolvedValue({
      data: [{ id: "g", organizationId: "o", name: "x" } as never],
    });
    expect(await fetchGroupsFromTereo("u")).toEqual([
      { id: "g", organizationId: "o" },
    ]);
  });

  it("reads a 404 as no groups", async () => {
    vi.mocked(tereoGroups.listUserGroups).mockRejectedValue(failing(404));
    expect(await fetchGroupsFromTereo("u")).toEqual([]);
  });

  it("rethrows any other failure", async () => {
    vi.mocked(tereoGroups.listUserGroups).mockRejectedValue(failing(500));
    await expect(fetchGroupsFromTereo("u")).rejects.toThrow("request failed");
  });
});

describe("statusFromTereo for a group", () => {
  it("is active on 200", async () => {
    vi.mocked(tereoGroups.getGroup).mockResolvedValue({});
    expect(await statusFromTereo("group", "g")).toBe("active");
  });

  it.each([403, 404])("is unknown on %i", async (status) => {
    vi.mocked(tereoGroups.getGroup).mockRejectedValue(failing(status));
    expect(await statusFromTereo("group", "g")).toBe("unknown");
  });

  it.each([500, undefined])("is a 503 on %s", async (status) => {
    vi.mocked(tereoGroups.getGroup).mockRejectedValue(failing(status));
    await expect(statusFromTereo("group", "g")).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
  });
});

describe("statusFromTereo for a user", () => {
  const getUser = () => vi.mocked(requests.auth.getUser);

  it("is active when tereo has the user", async () => {
    getUser().mockResolvedValue({} as never);
    expect(await statusFromTereo("user", "u")).toBe("active");
  });

  it("is orphaned on an HTTP 404 (the SDK's RequestError)", async () => {
    getUser().mockRejectedValue(
      new RequestError("AS_0001", "no user", { httpStatus: 404 })
    );
    expect(await statusFromTereo("user", "u")).toBe("orphaned");
  });

  it("is a 503 on any other failure", async () => {
    getUser().mockRejectedValue(
      new RequestError("AS_0001", "boom", { httpStatus: 500 })
    );
    await expect(statusFromTereo("user", "u")).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
  });
});

describe("transaction guard", () => {
  it("refuses both tereo calls inside a transaction", async () => {
    await runInTransactionScope(async () => {
      await expect(fetchGroupsFromTereo("u")).rejects.toThrow(
        /withAudit transaction/
      );
      await expect(statusFromTereo("user", "u")).rejects.toThrow(
        /withAudit transaction/
      );
      await expect(statusFromTereo("group", "g")).rejects.toThrow(
        /withAudit transaction/
      );
    });
  });
});
