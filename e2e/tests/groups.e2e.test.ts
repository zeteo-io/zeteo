import { serviceLogs, tereoStatusesFor } from "../support/compose.js";
import { PAID_ORDER_IDS, query } from "../support/zeteo.js";
import { requestJson, waitFor } from "../support/http.js";
import { describe, expect, inject, it } from "vitest";
import { stack } from "../support/stack.js";
import {
  addGroupMember,
  removeGroupMember,
  userGroups,
} from "../support/tereo.js";

const e2e = inject("e2e");

/** zeteo caches a user's groups for 30 s; 35 s leaves room for the poll. */
const MEMBERSHIP_DELAY_MS = 35_000;

const bobQuery = () => query(stack.zeteoUrl, e2e.bob.token, e2e.source.slug);

describe("access through a Tereo group", () => {
  it("a user granted only through a group can query, and loses access within 35 s of leaving it", async () => {
    const before = await bobQuery();
    expect(before.status).toBe(422);
    expect(before.body.error).toBe("not_found_or_not_accessible");

    await addGroupMember(e2e.admin.coreToken, e2e.groupId, e2e.bob.id);
    const groups = await userGroups(e2e.admin.coreToken, e2e.bob.id);
    expect(groups.status).toBe(200);
    expect(groups.body.data.map((g: { id: string }) => g.id)).toEqual([
      e2e.groupId,
    ]);

    const joined = await waitFor(
      "bob's query after joining the group",
      async () => {
        const res = await bobQuery();
        return res.status === 200 ? res : undefined;
      },
      { timeoutMs: MEMBERSHIP_DELAY_MS }
    );
    expect(joined.value.body.rows.map((r: unknown[]) => r[0])).toEqual(
      PAID_ORDER_IDS
    );

    await removeGroupMember(e2e.admin.coreToken, e2e.groupId, e2e.bob.id);
    const left = await waitFor(
      "bob's refusal after leaving the group",
      async () => {
        const res = await bobQuery();
        if (res.status === 200) return undefined;
        return res;
      },
      { timeoutMs: MEMBERSHIP_DELAY_MS }
    );
    expect(left.value.status).toBe(422);
    expect(left.value.body.error).toBe("not_found_or_not_accessible");
    expect(left.elapsedMs).toBeLessThanOrEqual(MEMBERSHIP_DELAY_MS);
  });

  it("a group grant's principal status is read from Tereo without an error", async () => {
    const since = new Date().toISOString();

    const res = await requestJson(
      "GET",
      `${stack.zeteoUrl}/v1/grants/${e2e.groupGrantId}`,
      { token: e2e.admin.zeteoToken }
    );

    expect(res.status).toBe(200);
    // A failed lookup shows `unknown` too, and is logged: this one is not.
    const failures = serviceLogs("zeteo", since).filter(
      (line) => line.message === "reading a principal failed"
    );
    expect(failures).toEqual([]);
    // zeteo's service account cannot hold groups.read, so Tereo refuses to
    // describe the group (403) and the status is `unknown`, as documented.
    expect(tereoStatusesFor(since, `/v1/admin/groups/${e2e.groupId}`)).toEqual([
      403,
    ]);
    expect(res.body.principal_status).toBe("unknown");
  });
});
