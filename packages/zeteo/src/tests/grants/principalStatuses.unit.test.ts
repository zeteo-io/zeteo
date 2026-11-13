// @module-tag unit
// @module-tag platform
import { principalStatuses } from "../../grants/principalStatuses.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { principalStatus } from "../../grants/principals.js";

vi.mock("../../grants/principals.js", () => ({ principalStatus: vi.fn() }));

const A = "0198f7a2-0000-7000-8000-00000000000a";
const B = "0198f7a2-0000-7000-8000-00000000000b";

describe("principalStatuses", () => {
  beforeEach(() => {
    vi.mocked(principalStatus).mockReset();
  });

  it("looks each distinct principal up once", async () => {
    vi.mocked(principalStatus).mockImplementation(async (type) =>
      type === "user" ? "orphaned" : "unknown"
    );
    const statuses = await principalStatuses([
      { principalType: "user", principalId: A },
      { principalType: "user", principalId: A },
      { principalType: "group", principalId: A },
      { principalType: "group", principalId: B },
    ]);
    expect(principalStatus).toHaveBeenCalledTimes(3);
    expect(statuses.get("user", A)).toBe("orphaned");
    expect(statuses.get("group", A)).toBe("unknown");
    expect(statuses.get("group", B)).toBe("unknown");
  });

  it("answers unknown for a principal whose lookup failed, and still answers the rest", async () => {
    vi.mocked(principalStatus).mockImplementation(async (_type, id) => {
      if (id === A) throw new Error("tereo is down");
      return "active";
    });
    const statuses = await principalStatuses([
      { principalType: "user", principalId: A },
      { principalType: "user", principalId: B },
    ]);
    expect(statuses.get("user", A)).toBe("unknown");
    expect(statuses.get("user", B)).toBe("active");
  });
});
