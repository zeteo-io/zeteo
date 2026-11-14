import { describe, expect, inject, it } from "vitest";
import { CLIENTS, stack, UI_ORIGIN } from "../support/stack.js";
import { serviceToken, signInPublic } from "../support/oauth.js";
import { ADMIN_EMAIL } from "../support/tereo.js";
import { requestJson } from "../support/http.js";

const e2e = inject("e2e");

describe("GET /v1/me", () => {
  it("the admin signed in through the UI's client gets their name, email and zeteo permissions", async () => {
    const signedIn = await signInPublic(
      CLIENTS.ui.clientId,
      { email: ADMIN_EMAIL },
      { origin: UI_ORIGIN }
    );

    const res = await requestJson("GET", `${stack.zeteoUrl}/v1/me`, {
      token: signedIn.accessToken,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toMatchObject({
      id: e2e.admin.id,
      type: "user",
      name: "E2E Admin",
      email: ADMIN_EMAIL,
    });
    // Tereo's first admin holds the bare `admin`, which covers every zeteo permission.
    expect(res.body.permissions).toEqual(expect.any(Array));
    expect(
      res.body.permissions.some(
        (p: string) => p === "admin" || p === "zeteo.grants.read"
      )
    ).toBe(true);
  });

  it("a person with only zeteo.data.read gets exactly that permission", async () => {
    const res = await requestJson("GET", `${stack.zeteoUrl}/v1/me`, {
      token: e2e.bob.token,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: e2e.bob.id,
      type: "user",
      name: "bob",
      email: e2e.bob.email,
      permissions: ["zeteo.data.read"],
    });
  });

  it("the calling app service's token is a service, with the zeteo_admin permissions", async () => {
    const token = await serviceToken(
      stack.app.clientId,
      stack.app.clientSecret
    );

    const res = await requestJson("GET", `${stack.zeteoUrl}/v1/me`, { token });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("service");
    expect(res.body.permissions).toContain("zeteo.grants.read");
  });

  it("without a token it is 401", async () => {
    const res = await requestJson("GET", `${stack.zeteoUrl}/v1/me`);
    expect(res.status).toBe(401);
  });
});
