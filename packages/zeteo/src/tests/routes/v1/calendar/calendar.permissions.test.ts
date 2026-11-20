// @module-tag int
// @module-tag platform
import { resetCalendar, validCalendar } from "../../../support/calendar.js";
import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";

describe("/v1/calendar permissions", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await resetCalendar();
    await app.close();
  });

  it("refuses a PUT without zeteo.calendar.write, even to a data reader", async () => {
    const token = tokenFor({ permissions: [DATA_READ] });
    const res = await fetchJson(
      "PUT",
      `${app.url}/v1/calendar`,
      token,
      validCalendar()
    );
    expect(res.status).toBe(403);
  });

  it("refuses a GET without zeteo.data.read", async () => {
    const res = await fetchJson(
      "GET",
      `${app.url}/v1/calendar`,
      tokenFor({ permissions: [] })
    );
    expect(res.status).toBe(403);
  });

  it("refuses a request with no token", async () => {
    const res = await fetchJson("GET", `${app.url}/v1/calendar`, null);
    expect(res.status).toBe(401);
  });
});
