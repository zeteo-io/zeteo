import { describe, expect, inject, it } from "vitest";
import { CLIENTS, stack } from "../support/stack.js";
import { requestJson } from "../support/http.js";
import { signIn } from "../support/oauth.js";

const e2e = inject("e2e");

describe("tokens from Tereo", () => {
  it("a user's token from an app client with zeteo in its audience reaches /v1/catalog", async () => {
    const res = await requestJson("GET", `${stack.zeteoUrl}/v1/catalog`, {
      token: e2e.alice.token,
    });

    expect(res.status).toBe(200);
    const sales = res.body.sources.find(
      (s: { slug: string }) => s.slug === e2e.source.slug
    );
    expect(sales.tables.map((t: { name: string }) => t.name).sort()).toEqual([
      "customers",
      "orders",
    ]);
  });

  it("a token issued for another audience is 401, though Tereo itself accepts it", async () => {
    const token = await signIn({
      client: CLIENTS.other,
      email: e2e.alice.email,
    });
    // The token is live: Tereo answers its userinfo.
    const userinfo = await requestJson(
      "GET",
      `${stack.tereoUrl}/oauth/userinfo`,
      { token }
    );
    expect(userinfo.status).toBe(200);
    expect(userinfo.body.sub).toBe(e2e.alice.id);

    const res = await requestJson("GET", `${stack.zeteoUrl}/v1/catalog`, {
      token,
    });

    expect(res.status).toBe(401);
  });
});
