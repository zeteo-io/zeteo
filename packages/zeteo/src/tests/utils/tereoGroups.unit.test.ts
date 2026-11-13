// @module-tag unit
// @module-tag platform
import { getGroup, listUserGroups } from "../../utils/tereoGroups.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { purgeServiceToken } from "@tereo-io/sdk/handler";
import { getHandler } from "@tereo-io/sdk/handler";

vi.mock("@tereo-io/sdk/handler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tereo-io/sdk/handler")>()),
  getHandler: vi.fn(),
  purgeServiceToken: vi.fn(),
}));

const handleRequest = vi.fn();
const failing = (status: number) =>
  Object.assign(new Error("failed"), { response: { status } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getHandler).mockReturnValue({ handleRequest } as never);
});

describe("tereoGroups requests", () => {
  it("lists a user's groups with a GET as the core client", async () => {
    handleRequest.mockResolvedValue({ data: { data: [] } });
    await listUserGroups("u-1");
    expect(handleRequest).toHaveBeenCalledWith({
      clientName: expect.stringMatching(/\S/),
      requestName: "core.groups.listForUser",
      method: "GET",
      url: "/v1/admin/users/u-1/groups",
    });
  });

  it("reads one group", async () => {
    handleRequest.mockResolvedValue({ data: {} });
    await getGroup("g-1");
    expect(handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", url: "/v1/admin/groups/g-1" })
    );
  });

  it("escapes a path parameter as one segment", async () => {
    handleRequest.mockResolvedValue({ data: {} });
    await getGroup("a/b?c#d");
    expect(handleRequest.mock.calls[0][0].url).toBe(
      "/v1/admin/groups/a%2Fb%3Fc%23d"
    );
  });

  it.each(["", ".", ".."])("refuses the path parameter %j", async (id) => {
    await expect(getGroup(id)).rejects.toThrow(/cannot be sent/);
    await expect(listUserGroups(id)).rejects.toThrow(/cannot be sent/);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("retries once with a fresh token after a 401", async () => {
    handleRequest
      .mockRejectedValueOnce(failing(401))
      .mockResolvedValueOnce({ data: { id: "g" } });
    expect(await getGroup("g")).toEqual({ id: "g" });
    expect(purgeServiceToken).toHaveBeenCalledTimes(1);
    expect(handleRequest).toHaveBeenCalledTimes(2);
  });

  it("gives up after the second 401, and does not retry other statuses", async () => {
    handleRequest.mockRejectedValue(failing(401));
    await expect(getGroup("g")).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(handleRequest).toHaveBeenCalledTimes(2);

    handleRequest.mockReset().mockRejectedValue(failing(500));
    await expect(getGroup("g")).rejects.toMatchObject({
      response: { status: 500 },
    });
    expect(handleRequest).toHaveBeenCalledTimes(1);
  });
});
