import { describe, expect, inject, it } from "vitest";
import { CLIENTS, stack, UI_ORIGIN } from "../support/stack.js";
import { requestJson } from "../support/http.js";
import {
  authorizeSilently,
  refreshPublic,
  revokePublic,
  signInPublic,
} from "../support/oauth.js";

const e2e = inject("e2e");

const UI = CLIENTS.ui.clientId;

// zeteo's admin UI is a page on zeteo's origin: the browser signs in at
// Tereo, the page exchanges the code and refreshes from its own origin, and
// holds the tokens in memory. Tereo has to answer that origin's CORS and give
// the refresh token in the body.
describe("signing in from a page on zeteo's origin", () => {
  it("a public client's code is exchanged from the UI's origin", async () => {
    const signedIn = await signInPublic(UI, e2e.alice, { origin: UI_ORIGIN });

    expect(signedIn.headers.get("access-control-allow-origin")).toBe(UI_ORIGIN);
    expect(typeof signedIn.refreshToken).toBe("string");
    expect(signedIn.refreshToken.length).toBeGreaterThan(0);
    expect(signedIn.accessToken.length).toBeGreaterThan(0);
    expect(signedIn.idToken.length).toBeGreaterThan(0);

    const preflight = await fetch(`${stack.tereoUrl}/oauth/token`, {
      method: "OPTIONS",
      headers: {
        Origin: UI_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBeGreaterThanOrEqual(200);
    expect(preflight.status).toBeLessThan(300);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      UI_ORIGIN
    );
  });

  it("the refresh token renews from the body, with no cookie", async () => {
    const signedIn = await signInPublic(UI, e2e.alice, { origin: UI_ORIGIN });

    const refreshed = await refreshPublic(UI, signedIn.refreshToken, {
      origin: UI_ORIGIN,
    });

    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("access-control-allow-origin")).toBe(
      UI_ORIGIN
    );
    expect(refreshed.body.access_token).toEqual(expect.any(String));
    expect(refreshed.body.access_token).not.toBe(signedIn.accessToken);
    expect(refreshed.body.refresh_token).toEqual(expect.any(String));
    const catalog = await requestJson("GET", `${stack.zeteoUrl}/v1/catalog`, {
      token: refreshed.body.access_token,
    });
    expect(catalog.status).toBe(200);
  });

  it("prompt=none returns a code while the Tereo session is live, and login_required without one", async () => {
    const signedIn = await signInPublic(UI, e2e.alice, { origin: UI_ORIGIN });

    const live = await authorizeSilently(UI, signedIn.cookies);
    expect(live).toEqual({ code: expect.any(String), error: undefined });

    const none = await authorizeSilently(UI);
    expect(none.code).toBeUndefined();
    expect(none.error).toBe("login_required");
  });

  it("revoking the refresh token ends renewal", async () => {
    const signedIn = await signInPublic(UI, e2e.alice, { origin: UI_ORIGIN });

    const revoked = await revokePublic(UI, signedIn.refreshToken, {
      origin: UI_ORIGIN,
    });
    expect(revoked.status).toBe(200);

    const refreshed = await refreshPublic(UI, signedIn.refreshToken, {
      origin: UI_ORIGIN,
    });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe("invalid_grant");
  });
});

// The stack runs zeteo in production mode, which publishes only an https
// UI_TEREO_URL, and Tereo here is reached over http: so UI_CLIENT_ID is left
// unset and the UI is off. What stays on is checked here.
describe("zeteo with the admin UI off", () => {
  it("/ui-config.json is a JSON 404 and / is a JSON 404", async () => {
    for (const path of ["/ui-config.json", "/"]) {
      const res = await requestJson("GET", `${stack.zeteoUrl}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(res.body).toMatchObject({ error: expect.any(String) });
    }
  });

  it("every response carries the content security policy", async () => {
    const calls = [
      fetch(`${stack.zeteoUrl}/health`),
      fetch(`${stack.zeteoUrl}/`),
      fetch(`${stack.zeteoUrl}/v1/me`),
      fetch(`${stack.zeteoUrl}/ui-config.json`),
    ];
    for (const res of await Promise.all(calls)) {
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // No UI, no tereo origin for the browser to call.
      expect(csp).toContain("connect-src 'self';");
      expect(csp).not.toContain(stack.tereoUrl);
    }
  });
});
