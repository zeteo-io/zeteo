import { expect, test } from "@playwright/test";
import { CLIENTS, stack } from "../support/stack.js";
import { expectJson } from "../support/http.js";
import {
  ADMIN_EMAIL,
  ensurePeople,
  expectCleanRun,
  submitTereoSignIn,
  watch,
} from "./support.js";
import { signIn } from "../support/oauth.js";

// Uploads in a real browser: a CSV is uploaded, previewed, turned into a
// source the signed-in user owns, and queried through the API with the
// owner's grant. Needs UPLOADS_READER_URL on the zeteo container
// (docker-compose.yml). Not run by CI, like the rest of e2e/.

test("a CSV is uploaded, previewed, created as an upload source and queried", async ({
  browser,
  baseURL,
}) => {
  await ensurePeople();
  const slug = `files-${Date.now().toString(36)}`;
  const csv = "Region,Revenue\nnorth,10\nsouth,32.5\nnorth,7\n";

  const context = await browser.newContext({ baseURL });
  const seen = watch(context);
  const page = await context.newPage();

  await page.goto("/my/data/new");
  await page.getByRole("button", { name: "Sign in" }).click();
  await submitTereoSignIn(page, ADMIN_EMAIL);
  await expect(page.getByRole("heading", { name: "Add data" })).toBeVisible();
  // Add data asks first whether the data is a file or a Google Sheet.
  await page.getByRole("button", { name: /Upload a file/ }).click();

  await page.locator('input[type="file"]').setInputFiles({
    name: "regional sales.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  // The preview: the table named from the file, columns normalized.
  await expect(
    page.getByRole("heading", { name: "regional_sales" })
  ).toBeVisible();
  await expect(page.getByText("revenue").first()).toBeVisible();

  await page.getByRole("textbox", { name: "Name", exact: true }).fill(slug);
  await page.getByRole("textbox", { name: "Slug" }).fill(slug);
  await page.getByRole("button", { name: "Create source" }).click();
  await expect(page).toHaveURL(/\/sources\/[0-9a-f-]{36}$/);

  // Queried as the owner, whose all-columns grant the create made.
  const token = await signIn({
    client: CLIENTS.web,
    email: ADMIN_EMAIL,
    clientSecret: stack.webClientSecret,
  });
  const result = await expectJson(200, "POST", `${stack.zeteoUrl}/v1/query`, {
    token,
    body: {
      source: slug,
      from: "regional_sales",
      select: ["region", { sum: "revenue", as: "total" }],
      groupBy: ["region"],
      orderBy: [{ region: "asc" }],
    },
  });
  expect(result.rows).toEqual([
    ["north", expect.anything()],
    ["south", expect.anything()],
  ]);

  await context.close();
  expectCleanRun(seen);
});
