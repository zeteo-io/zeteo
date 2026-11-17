import type { BrowserContext, Page, Response } from "@playwright/test";
import {
  ADMIN_EMAIL,
  completeSetup,
  createUser,
  roleId,
  searchUsers,
} from "../support/tereo.js";
import { CLIENTS, stack } from "../support/stack.js";
import { expect } from "@playwright/test";
import { signIn } from "../support/oauth.js";

export { ADMIN_EMAIL };

export interface Person {
  id: string;
  email: string;
}

/**
 * Tereo set up, and alice and bob as the Vitest files create them: the
 * browser test may run on its own (`run.sh --browser`) or after them.
 */
export const ensurePeople = async (): Promise<{
  alice: Person;
  bob: Person;
}> => {
  await completeSetup();
  const coreToken = await signIn({
    client: CLIENTS.tereoUi,
    email: ADMIN_EMAIL,
  });
  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}@e2e.example.com`;
    const found = await searchUsers(coreToken, "email", email);
    const existing = (found.body?.data ?? []).find(
      (u: { email: string }) => u.email === email
    );
    const id = existing
      ? (existing.id as string)
      : await createUser(coreToken, email, [await roleId(coreToken, role)]);
    return { id, email };
  };
  return {
    alice: await person("alice", "zeteo_mcp_user"),
    bob: await person("bob", "zeteo_user"),
  };
};

/** Tereo's sign-in form, filled and sent; the page is on it already. */
export const submitTereoSignIn = async (page: Page, email: string) => {
  await expect(page).toHaveURL(new RegExp(`^${stack.tereoUrl}/login`));
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page
    .getByRole("textbox", { name: "Password" })
    .fill(stack.userPassword);
  await page.getByRole("button", { name: "Sign In" }).click();
};

export interface Watch {
  /** Every request's origin. */
  origins: Set<string>;
  /** Every request in order, redirect hops included. */
  requests: Array<{ method: string; url: string }>;
  /** Console messages that report a refused load or a policy violation. */
  violations: string[];
  /** Uncaught errors of zeteo's or Tereo's pages. */
  pageErrors: string[];
  /** Access and ID tokens from every successful /oauth/token answer. */
  tokens: string[];
  /** Refresh tokens from /oauth/token bodies: none, as Tereo keeps it in a cookie. */
  refreshTokens: string[];
  /** The `grant_type` of every successful /oauth/token request. */
  grants: string[];
  /** The status of every /oauth/revoke answer. */
  revocations: number[];
  /** Every main-frame URL the page navigated to. */
  navigations: string[];
  /** zeteo's responses that tried to set a cookie. */
  zeteoSetCookies: string[];
  /** Responses this recording could not read, e.g. a body gone after a navigation. */
  unreadable: string[];
}

/**
 * Records what the browser does in `context`: where it sends requests, what
 * the console reports, the tokens Tereo hands out, the pages it lands on.
 */
export const watch = (context: BrowserContext): Watch => {
  const seen: Watch = {
    origins: new Set(),
    requests: [],
    violations: [],
    pageErrors: [],
    tokens: [],
    refreshTokens: [],
    grants: [],
    revocations: [],
    navigations: [],
    zeteoSetCookies: [],
    unreadable: [],
  };
  const zeteoOrigin = new URL(stack.zeteoUrl).origin;
  const tereoOrigin = new URL(stack.tereoUrl).origin;
  context.on("request", (request) => {
    const url = new URL(request.url());
    // data: and blob: URLs are the page's own content, not a request out.
    if (url.protocol === "http:" || url.protocol === "https:") {
      seen.origins.add(url.origin);
      seen.requests.push({ method: request.method(), url: request.url() });
    }
  });
  const record = async (response: Response) => {
    const url = new URL(response.url());
    const request = response.request();
    if (url.origin === zeteoOrigin) {
      const cookie = await response.headerValue("set-cookie");
      if (cookie) seen.zeteoSetCookies.push(`${url.pathname}: ${cookie}`);
    }
    if (url.origin !== tereoOrigin || request.method() !== "POST") return;
    if (url.pathname === "/oauth/revoke") {
      seen.revocations.push(response.status());
    }
    if (url.pathname === "/oauth/token" && response.ok()) {
      const grant = new URLSearchParams(request.postData() ?? "").get(
        "grant_type"
      );
      seen.grants.push(grant ?? "");
      const body = (await response.json()) as Record<string, unknown>;
      for (const key of ["access_token", "id_token"]) {
        if (typeof body[key] === "string") seen.tokens.push(body[key]);
      }
      if (typeof body.refresh_token === "string") {
        seen.refreshTokens.push(body.refresh_token);
      }
    }
  };
  context.on("response", (response) => {
    record(response).catch((err: unknown) =>
      seen.unreadable.push(`${response.url()}: ${String(err)}`)
    );
  });
  const onPage = (page: Page) => {
    page.on("console", (message) => {
      const text = message.text();
      if (
        /Refused to|Content[- ]Security[- ]Policy|violates the following/i.test(
          text
        )
      ) {
        seen.violations.push(text);
      }
    });
    page.on("pageerror", (err) => seen.pageErrors.push(String(err)));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) seen.navigations.push(frame.url());
    });
  };
  context.pages().forEach(onPage);
  context.on("page", onPage);
  return seen;
};

/** Requests went only to zeteo and Tereo, and nothing was refused or thrown. */
export const expectCleanRun = (seen: Watch) => {
  const allowed = [
    new URL(stack.zeteoUrl).origin,
    new URL(stack.tereoUrl).origin,
  ];
  // Both were seen: the recording works.
  expect([...seen.origins]).toEqual(expect.arrayContaining(allowed));
  expect([...seen.origins].filter((o) => !allowed.includes(o))).toEqual([]);
  expect(seen.violations).toEqual([]);
  expect(seen.pageErrors).toEqual([]);
  expect(seen.unreadable).toEqual([]);
};
