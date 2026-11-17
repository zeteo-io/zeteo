// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { chartedQuery } from "../../../../../support/dashboards.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  DASHBOARDS_READ,
  DATA_READ,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  savedQueryOf,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  savedPanelOf,
  savedPanelsCall,
} from "../../../../../support/savedPanels.js";
import {
  addUserToDirectory,
  clearDirectory,
} from "../../../../../support/principals.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("/v1/saved-panels/:savedPanelId/shares", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    await addUserToDirectory(u.id);
    return u;
  };
  const setUp = async () => {
    const owner = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    return { owner, id: await savedPanelOf(owner.token, sq) };
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedpanelshares");
  });
  afterAll(async () => {
    await clearDirectory();
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("replaces the shares and lists them for the owner", async () => {
    const { owner, id } = await setUp();
    const a = await user();
    const put = await savedPanelsCall("PUT", `/${id}/shares`, owner.token, {
      principals: [a.principal],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toMatchObject([{ type: "user", id: a.id }]);
    expect(
      (await savedPanelsCall("GET", `/${id}/shares`, owner.token)).body.data
    ).toHaveLength(1);
    expect(
      (await savedPanelsCall("GET", `/${id}`, a.token)).body.shared_at
    ).toEqual(expect.any(String));
    const cleared = await savedPanelsCall("PUT", `/${id}/shares`, owner.token, {
      principals: [],
    });
    expect(cleared.body.data).toEqual([]);
    expect((await savedPanelsCall("GET", `/${id}`, a.token)).status).toBe(404);
  });

  it("refuses the owner as a recipient, and hides the shares from a recipient", async () => {
    const { owner, id } = await setUp();
    const a = await user();
    const self = await savedPanelsCall("PUT", `/${id}/shares`, owner.token, {
      principals: [owner.principal],
    });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("invalid_share");
    await savedPanelsCall("PUT", `/${id}/shares`, owner.token, {
      principals: [a.principal],
    });
    expect(
      (await savedPanelsCall("GET", `/${id}/shares`, a.token)).status
    ).toBe(404);
    const admin = tokenFor({ permissions: [DATA_READ, DASHBOARDS_READ] });
    expect((await savedPanelsCall("GET", `/${id}/shares`, admin)).status).toBe(
      200
    );
    expect(
      (
        await savedPanelsCall("PUT", `/${id}/shares`, admin, {
          principals: [],
        })
      ).status
    ).toBe(403);
  });
});
