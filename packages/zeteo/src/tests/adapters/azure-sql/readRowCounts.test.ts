// @module-tag int
// @module-tag platform
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { logger } from "../../../utils/logger.js";
import {
  mssqlFixtureSettings,
  mssqlFixtureTarget,
} from "../../support/mssqlFixture.js";

const options = { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 10_000 };
const open: SourceConnection[] = [];

/** The fixture's read-only login: db_datareader, hr denied, no VIEW DATABASE STATE. */
const connect = async () => {
  const connection = await azureSqlAdapter.connect(
    mssqlFixtureSettings("ro"),
    await mssqlFixtureTarget(),
    options
  );
  open.push(connection);
  return connection;
};

afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
});

describe("azure-sql readRowCounts", () => {
  it("gives the rows of the user tables in the listed schemas, views left out, without VIEW DATABASE STATE", async () => {
    const connection = await connect();
    const counts = Object.fromEntries(
      (await connection.readRowCounts(["sales"]))!.map((c) => [
        `${c.schemaName}.${c.name}`,
        c.rows,
      ])
    );
    expect(counts).toEqual({
      "sales.accounts": 2,
      "sales.customers": 3,
      "sales.orders": 12,
      "sales.order_lines": 2,
      "sales.ledger": 4,
    });
  });

  it("leaves out a table the login may not see: SQL Server hides its metadata", async () => {
    const connection = await connect();
    expect(await connection.readRowCounts(["hr"])).toEqual([]);
  });

  it("is empty for no schema, an unknown one, or only system schemas", async () => {
    const connection = await connect();
    expect(await connection.readRowCounts([])).toEqual([]);
    expect(await connection.readRowCounts(["no_such_schema"])).toEqual([]);
    expect(
      await connection.readRowCounts(["sys", "INFORMATION_SCHEMA"])
    ).toEqual([]);
  });

  it("is null, logged at warn, never a throw, when the source cannot answer", async () => {
    const connection = await azureSqlAdapter.connect(
      mssqlFixtureSettings("ro"),
      await mssqlFixtureTarget(),
      options
    );
    await connection.close();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await connection.readRowCounts(["sales"])).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "reading the source's row counts failed"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
