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

// A measure in a real browser: bob, an editor of the source, defines two
// measures on orders, a dashboard shows them as a gauge, rendered by the
// image's UI.

test("a gauge panel shows a measure's value for the viewer", async ({
  browser,
  baseURL,
}) => {
  const { bob } = await ensurePeople();
  const admin = await serviceToken(stack.app.clientId, stack.app.clientSecret);
  const slug = `gauge-${Date.now().toString(36)}`;

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
    { type: "user", id: bob.id },
    tables.orders
  );
  // Bob holds `zeteo.measures.write`; being listed makes him an editor here.
  await expectJson(
    200,
    "PUT",
    `${stack.zeteoUrl}/v1/sources/${source.body.id}/measure-editors`,
    {
      token: admin,
      body: { principals: [{ type: "user", id: bob.id }] },
    }
  );

  const token = await signIn({
    client: CLIENTS.web,
    email: bob.email,
    clientSecret: stack.webClientSecret,
  });
  const measures = `${stack.zeteoUrl}/v1/sources/${source.body.id}/measures`;
  await expectJson(201, "POST", measures, {
    token,
    body: {
      name: "paid_revenue",
      description: "Revenue of paid orders; use for money received.",
      table: "orders",
      formula: { sum: "total" },
      where: { status: { eq: "paid" } },
    },
  });
  await expectJson(201, "POST", measures, {
    token,
    body: {
      name: "gross_revenue",
      description: "Revenue of every order, paid or not.",
      table: "orders",
      formula: { sum: "total" },
    },
  });
  const saved = await expectJson(
    201,
    "POST",
    `${stack.zeteoUrl}/v1/saved-queries`,
    {
      token,
      body: {
        name: `Paid against gross ${slug}`,
        query: {
          source: slug,
          from: "orders",
          select: [{ measure: "paid_revenue" }, { measure: "gross_revenue" }],
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
        name: `Pacing ${slug}`,
        panels: [
          {
            kind: "own",
            saved_query_id: saved.id,
            title: "Paid against gross",
            chart: {
              type: "gauge",
              version: 1,
              value: "paid_revenue",
              max: "gross_revenue",
            },
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
  await submitTereoSignIn(page, bob.email);
  await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboard.id}$`));

  const panel = page.getByRole("region", { name: "Paid against gross" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("canvas")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/Updated/)).toBeVisible();

  await context.close();
  expectCleanRun(seen);
});
