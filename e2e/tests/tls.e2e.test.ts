import { describe, expect, inject, it } from "vitest";
import { expectJson } from "../support/http.js";
import { stack } from "../support/stack.js";
import { readFileSync } from "node:fs";
import {
  PAID_ORDER_IDS,
  grantTable,
  query,
  registerSource,
  sourceSettings,
  tableIds,
} from "../support/zeteo.js";

const e2e = inject("e2e");

/**
 * The source serves a certificate for `source-pg` signed by a CA made for the
 * run. zeteo's main replica does not trust that CA; zeteo-ca, a replica of
 * the same deploy, trusts it through NODE_EXTRA_CA_CERTS.
 */
describe("TLS to a source", () => {
  it("with verification on, the untrusted certificate is refused", async () => {
    const res = await registerSource(
      stack.zeteoUrl,
      e2e.admin.zeteoToken,
      "sales-untrusted",
      sourceSettings("verify")
    );

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("source_unreachable");
    // Nothing was stored.
    const list = await expectJson(200, "GET", `${stack.zeteoUrl}/v1/sources`, {
      token: e2e.admin.zeteoToken,
    });
    expect(list.data.map((s: { slug: string }) => s.slug)).not.toContain(
      "sales-untrusted"
    );
  });

  it("with verification on, a process trusting the CA (NODE_EXTRA_CA_CERTS) registers and queries the source", async () => {
    const res = await registerSource(
      stack.zeteoCaUrl,
      e2e.admin.zeteoToken,
      "sales-trusted",
      sourceSettings("verify")
    );
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("active");
    expect(res.body.settings.tls).toBe("verify");

    const tables = await tableIds(
      stack.zeteoCaUrl,
      e2e.admin.zeteoToken,
      res.body.id
    );
    await grantTable(
      stack.zeteoCaUrl,
      e2e.admin.zeteoToken,
      { type: "user", id: e2e.admin.id },
      tables.orders
    );
    const rows = await query(
      stack.zeteoCaUrl,
      e2e.admin.zeteoToken,
      "sales-trusted"
    );
    expect(rows.status).toBe(200);
    expect(rows.body.rows.map((r: unknown[]) => r[0])).toEqual(PAID_ORDER_IDS);

    // The replica without the CA still refuses that source's certificate.
    const untrusted = await query(
      stack.zeteoUrl,
      e2e.admin.zeteoToken,
      "sales-trusted"
    );
    expect(untrusted.status).toBe(502);
    expect(untrusted.body.error).toBe("source_unreachable");
  });

  it("with verification on and the CA in the source's settings, the source works without NODE_EXTRA_CA_CERTS", async () => {
    const res = await registerSource(
      stack.zeteoUrl,
      e2e.admin.zeteoToken,
      "sales-ca-setting",
      sourceSettings("verify", readFileSync(stack.caCertPath, "utf8"))
    );

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("active");
    expect(res.body.settings).not.toHaveProperty("ca");
  });

  it("with verification relaxed (tls: require), the source works without trusting the CA", async () => {
    // The source the other cases query was registered so, on the replica
    // that does not trust the CA.
    const source = await expectJson(
      200,
      "GET",
      `${stack.zeteoUrl}/v1/sources/${e2e.source.id}`,
      { token: e2e.admin.zeteoToken }
    );
    expect(source.settings.tls).toBe("require");
    expect(source.status).toBe("active");

    const rows = await query(
      stack.zeteoUrl,
      e2e.admin.zeteoToken,
      e2e.source.slug
    );
    expect(rows.status).toBe(200);
    expect(rows.body.rows.map((r: unknown[]) => r[0])).toEqual(PAID_ORDER_IDS);
  });
});
