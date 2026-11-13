import { PAID_ORDER_IDS, query } from "../support/zeteo.js";
import { describe, expect, inject, it } from "vitest";
import { waitFor } from "../support/http.js";
import { stack } from "../support/stack.js";
import {
  serviceLogs,
  waitForTereoStatus,
  zeteoDbValue,
} from "../support/compose.js";
import {
  approveServiceAccess,
  getService,
  revokeServiceAccess,
} from "../support/tereo.js";

const e2e = inject("e2e");

/** What the SDK logs when its own requests meet a rejected service token. */
const SDK_RETRY_LOG =
  "Core rejected the service token; retrying once with a new one";

describe("zeteo's service token", () => {
  it("a revoked service token is replaced on the group lookup's 401, and the query goes through", async () => {
    // zeteo holds a service token: this query looked up the admin's groups
    // with it, and its audit entry is delivered with it.
    expect(
      (await query(stack.zeteoUrl, e2e.admin.zeteoToken, e2e.source.slug))
        .status
    ).toBe(200);
    // Nothing left for the outbox to deliver, so the next request zeteo makes
    // with the token is the group lookup below.
    await waitFor(
      "zeteo's outbox to drain",
      async () =>
        zeteoDbValue(`SELECT count(*) FROM "core"."core_outbox"`) === "0"
          ? true
          : undefined,
      { timeoutMs: 30_000 }
    );

    // Revoking any of the service's access rows revokes every access token
    // its client holds; approving it again restores the access.
    const service = await getService(e2e.admin.coreToken, "zeteo");
    const auditWriter = service.access.find(
      (row) => row.kind === "role" && row.target === "audit_writer"
    );
    expect(auditWriter?.status).toBe("approved");
    const since = new Date().toISOString();
    await revokeServiceAccess(e2e.admin.coreToken, service.id, [
      auditWriter!.id,
    ]);
    await approveServiceAccess(e2e.admin.coreToken, service.id, [
      auditWriter!.id,
    ]);

    // dave has not queried before, so zeteo has no cached groups for him and
    // asks Tereo, with the revoked token first.
    const res = await query(stack.zeteoUrl, e2e.dave.token, e2e.source.slug);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: unknown[]) => r[0])).toEqual(PAID_ORDER_IDS);
    // Tereo refused the revoked token on the group lookup...
    expect(
      await waitForTereoStatus(
        since,
        `/v1/admin/users/${e2e.dave.id}/groups`,
        401
      )
    ).toContain(401);
    // ...and the SDK's own retry did not handle it: zeteo's group request did.
    const sdkRetries = serviceLogs("zeteo", since).filter(
      (line) => line.message === SDK_RETRY_LOG
    );
    expect(sdkRetries).toEqual([]);
  });
});
