import { expect, test, type Page } from "@playwright/test";
import { CLIENTS, stack } from "../support/stack.js";
import { signIn } from "../support/oauth.js";
import { query } from "../support/zeteo.js";
import { readFileSync } from "node:fs";
import {
  createUser,
  ensureRole,
  roleId,
  setUserRoles,
} from "../support/tereo.js";
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

/** Opens the top bar's Admin menu, whose links are not in the page until it is open. */
const openAdmin = async (page: Page) => {
  const admin = page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Admin" });
  if ((await admin.getAttribute("aria-expanded")) !== "true") {
    await admin.click();
  }
};

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
    await expect(page).toHaveURL(`${zeteoOrigin()}/signed-out`);
    await page.getByRole("button", { name: "Sign in" }).click();
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
    // The slug follows the name until it is typed: name first, then slug.
    await field("Name").fill(`UI ${slug}`);
    await field("Slug").fill(slug);
    await field("Host").fill("source-pg");
    await field("Port").fill("5432");
    await field("Database").fill("source");
    await field("User").fill("zeteo_ro");
    await field("Password").fill(stack.sourceReaderPassword);
    // zeteo does not trust the run's CA: verify (TLS's default) against the
    // CA given here; the CA field shows only for verified TLS.
    await expect(field("TLS")).toHaveValue("Required, certificate verified");
    await field("CA certificate (optional)").fill(
      readFileSync(stack.caCertPath, "utf8")
    );
    await field("Schemas").fill("sales");
    await page.getByRole("button", { name: "Create source" }).click();

    await expect(page).toHaveURL(
      new RegExp(`^${zeteoOrigin()}/sources/[0-9a-f-]{36}$`)
    );
    sourceId = new URL(page.url()).pathname.split("/")[2];

    await openAdmin(page);
    await page.getByRole("link", { name: "Sources" }).click();
    const row = page.getByRole("row").filter({ hasText: slug });
    // Name (with the slug under it), Database, Status, Last refreshed.
    await expect(row.getByRole("cell").nth(1)).toHaveText("PostgreSQL");
    await expect(row.getByRole("cell").nth(2)).toHaveText("Active");
    await row.getByRole("link", { name: `UI ${slug}` }).click();
    await expect(page).toHaveURL(`${zeteoOrigin()}/sources/${sourceId}`);

    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(
      page.getByText("Connected. The login is read-only.")
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh catalogue" }).click();
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
    // The tokens are in localStorage: the reload signed in from them,
    // without a visit to Tereo (its sign-in page, an authorize request or a
    // callback), and the address stayed.
    const requested = seen.requests.slice(requestsBefore).map((r) => r.url);
    expect(
      requested.filter((u) => u.startsWith(`${stack.tereoUrl}/oauth/authorize`))
    ).toEqual([]);
    const landed = seen.navigations.slice(navigationsBefore);
    expect(landed.filter((u) => u.startsWith(stack.tereoUrl))).toEqual([]);
    expect(landed.filter((u) => u.includes("/callback"))).toEqual([]);
    expect(page.url()).not.toContain("code=");
    // Tereo's sign-in form showed only for the first sign-in (Tereo's page
    // may report one visit twice; a new sign-in would carry a new state).
    const logins = seen.navigations.filter((u) =>
      u.startsWith(`${stack.tereoUrl}/login`)
    );
    expect(new Set(logins).size).toBe(1);
  });

  await test.step("grant alice a whole table", async () => {
    await openAdmin(page);
    await page.getByRole("link", { name: "Grants" }).click();
    await page.getByRole("button", { name: "New grant" }).click();
    await page
      .getByRole("combobox", { name: "Search by name or email" })
      .fill("alice@e2e");
    await page.getByRole("option", { name: /alice@e2e\.example\.com/ }).click();
    // Source and Table are searchable fields: type, then pick from the list.
    await page.getByRole("textbox", { name: "Source" }).fill(`UI ${slug}`);
    await page.getByText(`UI ${slug}`, { exact: true }).click();
    await page.getByRole("textbox", { name: "Table" }).fill("sales.orders");
    await page.getByText("sales.orders", { exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "All columns" })
    ).toBeChecked();
    await page.getByRole("button", { name: "Create grant" }).click();

    await expect(page).toHaveURL(new RegExp(`^${zeteoOrigin()}/grants`));
    const row = page
      .getByRole("row")
      .filter({ hasText: "alice" })
      .filter({ hasText: slug });
    await expect(row).toHaveCount(1);
  });

  await test.step("give alice a limit, then delete it", async () => {
    await openAdmin(page);
    await page.getByRole("link", { name: "Limits" }).click();
    await page.getByRole("button", { name: "New limit" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("combobox", { name: "Search by name or email" })
      .fill("alice@e2e");
    // The list opens in a portal outside the dialog.
    await page.getByRole("option", { name: /alice@e2e\.example\.com/ }).click();
    await dialog.getByRole("textbox", { name: "Queries at once" }).fill("2");
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

    await openAdmin(page);
    await page.getByRole("link", { name: "Runs" }).click();
    const row = page
      .getByRole("row")
      .filter({ hasText: "alice" })
      .filter({ hasText: `UI ${slug}` });
    await expect(row).toHaveCount(1);
    // When, Person, Source, Entry point, Outcome, ...
    await expect(row.getByRole("cell").nth(4)).toHaveText("OK");
    await row.getByRole("button", { name: "Details" }).click();
    const detail = page.getByTestId("run-query");
    await expect(detail).toContainText('"from": "orders"');
    await page.getByRole("button", { name: "Close" }).click();
  });

  await test.step("the access token is in localStorage, the refresh token in Tereo's httpOnly cookie", async () => {
    const held = await storageOf(page);
    const entries = JSON.parse(held.local) as Record<string, string>;
    const tokensKey = Object.keys(entries).find((k) => k.endsWith("_tokens"));
    expect(tokensKey).toBeDefined();
    const stored = JSON.parse(entries[tokensKey as string]) as Record<
      string,
      unknown
    >;
    expect(stored.access_token).toEqual(expect.any(String));
    expect(seen.tokens).toContain(stored.access_token);
    // Nothing the script can read carries a refresh token.
    expect(stored.refresh_token).toBeUndefined();
    expect(seen.refreshTokens).toEqual([]);
    // Tereo's script-readable cookie is only its session indicator.
    expect(held.cookie).toBe(`tsi_${CLIENTS.ui.clientId}=1`);
    for (const token of seen.tokens) expect(held.cookie).not.toContain(token);
    expect(held.session).not.toMatch(/refresh/i);
    const refreshCookie = (await context.cookies()).find(
      (c) => c.name === `trt_${CLIENTS.ui.clientId}`
    );
    expect(refreshCookie?.httpOnly).toBe(true);
    expect(refreshCookie?.path).toBe("/oauth");
    // zeteo sets no cookie of its own.
    expect(seen.zeteoSetCookies).toEqual([]);
    expect(new URL(page.url()).search).not.toContain("code=");
    const afterCallback = seen.navigations.filter(
      (u) => u.startsWith(zeteoOrigin()) && !u.includes("/callback")
    );
    expect(afterCallback.filter((u) => u.includes("code="))).toEqual([]);
  });

  await test.step("sign out lands on /signed-out; Tereo no longer renews the session", async () => {
    const revocationsBefore = seen.revocations.length;

    await page.getByRole("button", { name: "E2E Admin" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(`${zeteoOrigin()}/signed-out`);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(seen.revocations.slice(revocationsBefore)).toEqual([200]);
    const held = await storageOf(page);
    expect(held.local).not.toContain("_tokens");

    // A renewal from the page is refused.
    const renewal = await page.evaluate(
      async ({ tereo, clientId }) => {
        const res = await fetch(`${tereo}/oauth/token`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token_response_mode: "cookie",
          }),
        });
        return { status: res.status, body: await res.json() };
      },
      { tereo: stack.tereoUrl, clientId: CLIENTS.ui.clientId }
    );
    expect(renewal.status).toBe(400);
    // The sign-out cleared the cookie: there is no refresh token to renew.
    expect(renewal.body.error).toBe("invalid_request");

    await page.goto("/sources");
    await expect(page).toHaveURL(`${zeteoOrigin()}/signed-out`);
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
  await page.getByRole("button", { name: "Sign in" }).click();
  await submitTereoSignIn(page, bob.email);
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Admin" })).toHaveCount(0);

  await context.close();
  expectCleanRun(seen);
});

test("a deep link opened signed out goes to /signed-out and, after signing in, to the link", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const seen = watch(context);
  const page = await context.newPage();
  const deepLink = "/runs?outcome=ok";

  await page.goto(deepLink);
  await expect(page).toHaveURL(`${zeteoOrigin()}/signed-out`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await submitTereoSignIn(page, ADMIN_EMAIL);
  await expect(page).toHaveURL(`${zeteoOrigin()}${deepLink}`);
  await expect(
    page.getByRole("heading", { name: "Runs", level: 1 })
  ).toBeVisible();

  await context.close();
  expectCleanRun(seen);
});

test("a role removed in Tereo hides its sections without a reload", async ({
  browser,
  baseURL,
}) => {
  const coreToken = await signIn({
    client: CLIENTS.tereoUi,
    email: ADMIN_EMAIL,
  });
  // A second role that keeps one section: only the run record.
  const runsReader = await ensureRole(coreToken, "e2e_runs_reader", [
    "zeteo.runs.read",
  ]);
  const email = `live-${Date.now().toString(36)}@e2e.example.com`;
  const userId = await createUser(coreToken, email, [
    await roleId(coreToken, "zeteo_admin"),
    runsReader,
  ]);

  const context = await browser.newContext({ baseURL });
  const seen = watch(context);
  const page = await context.newPage();

  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await submitTereoSignIn(page, email);
  const nav = page.getByRole("navigation", { name: "Sections" });
  await openAdmin(page);
  await expect(nav.getByRole("link", { name: "Sources" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Runs" })).toBeVisible();

  // Survives only while the page is not reloaded.
  await page.evaluate(() => {
    (window as unknown as { liveMarker: string }).liveMarker = "same page";
  });
  await setUserRoles(coreToken, userId, [runsReader]);

  // Tereo pushes the change over its socket; allow a bounded wait.
  await expect(nav.getByRole("link", { name: "Sources" })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(nav.getByRole("link", { name: "Runs" })).toBeVisible();
  // The sources page it was on says so inside the layout, and the run
  // record still opens, all on the same page.
  await expect(page.getByText("zeteo.sources.read")).toBeVisible();
  await nav.getByRole("link", { name: "Runs" }).click();
  await expect(
    page.getByRole("heading", { name: "Runs", level: 1 })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { liveMarker?: string }).liveMarker
    )
  ).toBe("same page");

  await context.close();
  expectCleanRun(seen);
});
