// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  MIN_SERVER_VERSION_NUM,
  ownDatabaseProblem,
} from "../../file-sources/readerRole.js";

describe("ownDatabaseProblem", () => {
  it("accepts PostgreSQL 16 or later where Zeteo may create schemas", () => {
    for (const versionNum of [160000, 160004, 170002]) {
      expect(
        ownDatabaseProblem({ database: "zeteo", versionNum, canCreate: true })
      ).toBeNull();
    }
  });

  it("refuses a server older than PostgreSQL 16, naming its version", () => {
    expect(MIN_SERVER_VERSION_NUM).toBe(160000);
    expect(
      ownDatabaseProblem({
        database: "zeteo",
        versionNum: 150008,
        canCreate: true,
      })
    ).toMatch(/PostgreSQL 16 or later.*150008/);
  });

  it("refuses a database where Zeteo's own role lacks CREATE", () => {
    expect(
      ownDatabaseProblem({
        database: "zeteo",
        versionNum: 160000,
        canCreate: false,
      })
    ).toMatch(/CREATE on the database "zeteo"/);
  });
});
