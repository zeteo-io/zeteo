import { expect, test } from "@playwright/test";
import { serviceToken, signIn } from "../support/oauth.js";
import { CLIENTS, stack } from "../support/stack.js";
import { expectJson } from "../support/http.js";
import { readFileSync } from "node:fs";
import {
  ensurePeople,
  expectCleanRun,
  submitTereoSignIn,
  watch,
} from "./support.js";
import {
  grantTable,
  registerSource,
  sourceSettings,
  tableIds,
} from "../support/zeteo.js";

// A dashboard in a real browser: alice's saved query, shown as a bar chart
// on a dashboard she owns, rendered by the image's UI.

test("a dashboard renders a chart of the viewer's own query", async ({
  browser,
  baseURL,
}) => {
  const { alice } = await ensurePeople();
  const admin = await serviceToken(stack.app.clientId, stack.app.clientSecret);
  const slug = `dash-${Date.now().toString(36)}`;

  const source = await registerSource(
    stack.zeteoUrl,
    admin,
    slug,
    sourceSettings("verify", readFileSync(stack.caCertPath, "utf8"))
  );
  expect(source.status).toBe(201);
  const tables = await tableIds(stack.zeteoUrl, admin, source.body.id);
  await grantTable(
    stack.zeteoUrl,
    admin,
    { type: "user", id: alice.id },
    tables.orders
  );

  const token = await signIn({
    client: CLIENTS.web,
    email: alice.email,
    clientSecret: stack.webClientSecret,
  });
  const saved = await expectJson(
    201,
    "POST",
    `${stack.zeteoUrl}/v1/saved-queries`,
    {
      token,
      body: {
        name: `Revenue by status ${slug}`,
        query: {
          source: slug,
          from: "orders",
          select: ["status", { sum: "total", as: "revenue" }],
          groupBy: ["status"],
          orderBy: [{ status: "asc" }],
        },
      },
    }
  );
  const dashboard = await expectJson(
    201,
    "POST",
    `${stack.zeteoUrl}/v1/dashboards`,
    {
      token,
      body: {
        name: `Sales ${slug}`,
        panels: [
          {
            kind: "own",
            saved_query_id: saved.id,
            title: "Revenue by status",
            chart: { type: "bar", version: 1, x: "status", y: ["revenue"] },
          },
        ],
      },
    }
  );

  const context = await browser.newContext({ baseURL });
  const seen = watch(context);
  const page = await context.newPage();

  await page.goto(`/dashboards/${dashboard.id}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await submitTereoSignIn(page, alice.email);
  await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboard.id}$`));

  const panel = page.getByRole("region", { name: "Revenue by status" });
  await expect(panel).toBeVisible();
  // ECharts draws the bars on a canvas once the run's line for the panel arrives.
  await expect(panel.locator("canvas")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/Updated/)).toBeVisible();

  await context.close();
  expectCleanRun(seen);
});
