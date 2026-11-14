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

// The stack sets UI_CLIENT_ID and UI_TEREO_URL (Tereo as the host reaches it);
// the image has no UI build, so only the config and the policy are served.
describe("zeteo with the admin UI configured", () => {
  it("/ui-config.json publishes Tereo's host-facing URL and the client id", async () => {
    const res = await requestJson("GET", `${stack.zeteoUrl}/ui-config.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.body).toEqual({
      tereo_url: stack.tereoUrl.replace(/\/+$/, ""),
      client_id: "e2e-ui",
    });
  });

  it("/ is a JSON 404 for a browser: there is no UI build", async () => {
    const res = await fetch(`${stack.zeteoUrl}/`, {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("every response carries the content security policy naming Tereo", async () => {
    const calls = [
      fetch(`${stack.zeteoUrl}/health`),
      fetch(`${stack.zeteoUrl}/`),
      fetch(`${stack.zeteoUrl}/v1/me`),
      fetch(`${stack.zeteoUrl}/ui-config.json`),
    ];
    const tereoOrigin = new URL(stack.tereoUrl).origin;
    for (const res of await Promise.all(calls)) {
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toMatch(
        new RegExp(`connect-src [^;]*${tereoOrigin.replace(/\./g, "\\.")}`)
      );
    }
  });
});
