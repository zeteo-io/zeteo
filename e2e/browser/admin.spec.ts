import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { CLIENTS, stack } from "../support/stack.js";
import { query } from "../support/zeteo.js";
import { refreshPublic, signIn } from "../support/oauth.js";
import {
  ADMIN_EMAIL,
  ensurePeople,
  expectCleanRun,
  submitTereoSignIn,
  watch,
  type Person,
} from "./support.js";

// zeteo's admin UI in a real browser: the image's build, served by zeteo,
// signing in through the released Tereo's own pages.

let alice: Person;
let bob: Person;

test.beforeAll(async () => {
  ({ alice, bob } = await ensurePeople());
});

const zeteoOrigin = () => new URL(stack.zeteoUrl).origin;

/** The page's storage and cookies as zeteo's origin sees them. */
const storageOf = (page: Page) =>
  page.evaluate(() => {
    const dump = (store: Storage) =>
      Object.fromEntries(
        Array.from({ length: store.length }, (_, i) => {
          const key = store.key(i) as string;
          return [key, store.getItem(key)];
        })
      );
    return {
      local: JSON.stringify(dump(localStorage)),
      session: JSON.stringify(dump(sessionStorage)),
      cookie: document.cookie,
    };
  });

test("an admin administers zeteo through the UI", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const seen = watch(context);
  const page = await context.newPage();
  const slug = `ui-${Date.now().toString(36)}`;
  const description = `Orders, described in the browser at ${new Date().toISOString()}`;
  let sourceId = "";

  await test.step("sign in through Tereo and land on the sources", async () => {
    await page.goto("/");
    await submitTereoSignIn(page, ADMIN_EMAIL);
    await expect(page).toHaveURL(`${zeteoOrigin()}/sources`);
    await expect(
      page.getByRole("heading", { name: "Sources", level: 1 })
    ).toBeVisible();
  });

  await test.step("create a Postgres source and read its tables", async () => {
    await page.getByRole("button", { name: "New source" }).click();
    const field = (name: string) =>
      page.getByRole("textbox", { name, exact: true });
    await field("Slug").fill(slug);
    await field("Name").fill(`UI ${slug}`);
    await field("Host").fill("source-pg");
    await field("Port").fill("5432");
    await field("Database").fill("source");
    await field("User").fill("zeteo_ro");
    await field("Password").fill(stack.sourceReaderPassword);
    // zeteo does not trust the run's CA: verify against the CA given here.
    await page.getByRole("combobox", { name: "TLS" }).selectOption("verify");
    await field("CA certificate").fill(readFileSync(stack.caCertPath, "utf8"));
    await field("Schemas").fill("sales");
    await page.getByRole("button", { name: "Create source" }).click();

    await expect(page).toHaveURL(
      new RegExp(`^${zeteoOrigin()}/sources/[0-9a-f-]{36}$`)
    );
    sourceId = new URL(page.url()).pathname.split("/")[2];

    await page.getByRole("link", { name: "Sources" }).click();
    const row = page.getByRole("row").filter({ hasText: slug });
    // Name, Slug, Type, Status, Last refreshed.
    await expect(row.getByRole("cell").nth(3)).toHaveText("active");
    await row.getByRole("link", { name: `UI ${slug}` }).click();
    await expect(page).toHaveURL(`${zeteoOrigin()}/sources/${sourceId}`);

    await page.getByRole("button", { name: "Test", exact: true }).click();
    await expect(page.getByText("No findings")).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Catalogue refreshed")).toBeVisible();

    await page.getByRole("link", { name: "Tables", exact: true }).click();
    await expect(page.getByRole("link", { name: "orders" })).toBeVisible();
    await expect(page.getByRole("link", { name: "customers" })).toBeVisible();
  });

  await test.step("describe a table; a reload keeps the sign-in and the description", async () => {
    await page.getByRole("link", { name: "orders" }).click();
    await page.getByRole("button", { name: "Edit descriptions" }).click();
    await page
      .getByRole("textbox", { name: "Table description" })
      .fill(description);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(description)).toBeVisible();
    const tableUrl = page.url();
    const requestsBefore = seen.requests.length;
    const navigationsBefore = seen.navigations.length;

    await page.reload();
    await expect(page).toHaveURL(tableUrl);
    await expect(page.getByText(description)).toBeVisible();
    // Tokens live in memory only, so the reload signed in again: a
    // prompt=none authorize at Tereo, its code back at /callback, and the
    // table's address restored.
    const requested = seen.requests.slice(requestsBefore).map((r) => r.url);
    const authorize = requested.findIndex(
      (u) =>
        u.startsWith(`${stack.tereoUrl}/oauth/authorize?`) &&
        new URL(u).searchParams.get("prompt") === "none"
    );
    expect(authorize).toBeGreaterThanOrEqual(0);
    const callback = requested.findIndex(
      (u, i) =>
        i > authorize &&
        u.startsWith(`${zeteoOrigin()}/callback?`) &&
        new URL(u).searchParams.has("code")
    );
    expect(callback).toBeGreaterThan(authorize);
    const landed = seen.navigations.slice(navigationsBefore);
    const atCallback = landed.findIndex((u) =>
      u.startsWith(`${zeteoOrigin()}/callback?`)
    );
    expect(atCallback).toBeGreaterThanOrEqual(0);
    expect(landed.slice(atCallback + 1)).toContain(tableUrl);
    expect(page.url()).not.toContain("code=");
    // The reload went through Tereo silently: its sign-in form showed only
    // for the first sign-in (Tereo's page may report one visit twice; a new
    // sign-in would carry a new state).
    const logins = seen.navigations.filter((u) =>
      u.startsWith(`${stack.tereoUrl}/login`)
    );
    expect(new Set(logins).size).toBe(1);
  });

  await test.step("grant alice a whole table", async () => {
    await page.getByRole("link", { name: "Grants" }).click();
    await page.getByRole("button", { name: "New grant" }).click();
    await page
      .getByRole("textbox", { name: "Search by name or email" })
      .fill("alice@e2e");
    await page.getByRole("button", { name: /alice@e2e\.example\.com/ }).click();
    await page
      .getByRole("combobox", { name: "Source" })
      .selectOption({ label: `UI ${slug} (${slug})` });
    await page
      .getByRole("combobox", { name: "Table" })
      .selectOption({ label: "sales.orders" });
    await page.getByRole("radio", { name: "All columns" }).check();
    await page.getByRole("button", { name: "Create grant" }).click();

    await expect(page).toHaveURL(new RegExp(`^${zeteoOrigin()}/grants`));
    const row = page
      .getByRole("row")
      .filter({ hasText: "alice" })
      .filter({ hasText: slug });
    await expect(row).toHaveCount(1);
  });

  await test.step("give alice a limit, then delete it", async () => {
    await page.getByRole("link", { name: "Limits" }).click();
    await page.getByRole("button", { name: "New limit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("textbox", { name: "Search by name or email" })
      .fill("alice@e2e");
    await dialog
      .getByRole("button", { name: /alice@e2e\.example\.com/ })
      .click();
    await dialog.getByRole("textbox", { name: "Query concurrency" }).fill("2");
    await dialog.getByRole("button", { name: "Create limit" }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByRole("row").filter({ hasText: "alice" });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete limit" }).click();
    await expect(row).toHaveCount(0);
  });

  await test.step("alice's query, run through the API, is in the run record", async () => {
    const aliceToken = await signIn({
      client: CLIENTS.web,
      email: alice.email,
      clientSecret: stack.webClientSecret,
    });
    const ran = await query(stack.zeteoUrl, aliceToken, slug);
    expect(ran.status).toBe(200);

    await page.getByRole("link", { name: "Runs" }).click();
    const row = page
      .getByRole("row")
      .filter({ hasText: "alice" })
      .filter({ hasText: `UI ${slug}` });
    await expect(row).toHaveCount(1);
    // When, Person, Source, Entry point, Outcome, ...
    await expect(row.getByRole("cell").nth(4)).toHaveText("ok");
    await row.getByRole("button", { name: "Details" }).click();
    const detail = page.getByTestId("run-query");
    await expect(detail).toContainText('"from": "orders"');
    await page.getByRole("button", { name: "Close" }).click();
  });

  await test.step("no token is stored, and no code is left in the address", async () => {
    // The first sign-in's and the reload's access, refresh and ID tokens.
    expect(seen.tokens.length).toBeGreaterThanOrEqual(6);
    const held = await storageOf(page);
    for (const token of seen.tokens) {
      expect(held.local).not.toContain(token);
      expect(held.session).not.toContain(token);
      expect(held.cookie).not.toContain(token);
    }
    for (const cookie of await context.cookies()) {
      for (const token of seen.tokens) {
        expect(cookie.value).not.toContain(token);
      }
    }
    // zeteo sets no cookie; the host's cookies are Tereo's (cookies are not
    // separated by port).
    expect(seen.zeteoSetCookies).toEqual([]);
    expect(new URL(page.url()).search).not.toContain("code=");
    const afterCallback = seen.navigations.filter(
      (u) => u.startsWith(zeteoOrigin()) && !u.includes("/callback")
    );
    expect(afterCallback.filter((u) => u.includes("code="))).toEqual([]);
  });

  await test.step("sign out; the next visit asks for the password again", async () => {
    const refreshToken = seen.lastRefreshToken;
    expect(refreshToken).toEqual(expect.any(String));
    const revocationsBefore = seen.revocations.length;

    await page.getByRole("button", { name: "E2E Admin" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(new RegExp(`^${stack.tereoUrl}/login`));

    // The UI revoked its refresh token, and Tereo no longer renews it.
    expect(seen.revocations.slice(revocationsBefore)).toEqual([200]);
    const renewed = await refreshPublic(
      CLIENTS.ui.clientId,
      refreshToken as string,
      { origin: zeteoOrigin() }
    );
    expect(renewed.status).toBe(400);
    expect(renewed.body.error).toBe("invalid_grant");

    await page.goto("/sources");
    await expect(page).toHaveURL(new RegExp(`^${stack.tereoUrl}/login`));
    await expect(page.getByRole("textbox", { name: "Password" })).toBeVisible();
  });

  await context.close();
  expectCleanRun(seen);
});

test("a user without admin permissions sees no sections", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const seen = watch(context);
  const page = await context.newPage();

  await page.goto("/");
  await submitTereoSignIn(page, bob.email);
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sources" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Grants" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Runs" })).toHaveCount(0);

  await context.close();
  expectCleanRun(seen);
});
