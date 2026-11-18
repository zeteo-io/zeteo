// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { logger } from "../../../utils/logger.js";
import {
  asMssqlAdmin,
  dropLoginSql,
  ensureLoginSql,
  mssqlFixtureSettings,
  mssqlFixtureTarget,
  queryMssqlAdmin,
  quoteMssqlIdent,
} from "../../support/mssqlFixture.js";

const options = { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 10_000 };
/** A reader that may also see the database's state, as the docs suggest. */
const STATE_LOGIN = "zeteo_size_reader";
const STATE_PASSWORD = "Size-reader-1";
const open: SourceConnection[] = [];

const connect = async (settings: ReturnType<typeof mssqlFixtureSettings>) => {
  const connection = await azureSqlAdapter.connect(
    settings,
    await mssqlFixtureTarget(),
    options
  );
  open.push(connection);
  return connection;
};

/** The used pages of the named tables, read as the administrator. */
const sizeOf = async (tables: string[]): Promise<number> => {
  const [row] = await queryMssqlAdmin<{ bytes: string | number }>(
    `SELECT CAST(SUM(CAST(used_page_count AS bigint)) * 8192 AS bigint) AS bytes
       FROM sys.dm_db_partition_stats
      WHERE object_id IN (${tables.map((_, i) => `OBJECT_ID(@p${i})`).join(", ")})`,
    tables
  );
  return Number(row!.bytes);
};

beforeAll(async () => {
  await asMssqlAdmin([dropLoginSql(STATE_LOGIN)], "master");
  await asMssqlAdmin([ensureLoginSql(STATE_LOGIN, STATE_PASSWORD)], "master");
  const user = quoteMssqlIdent(STATE_LOGIN);
  await asMssqlAdmin([
    `IF USER_ID('${STATE_LOGIN}') IS NULL CREATE USER ${user} FOR LOGIN ${user}`,
    `ALTER ROLE db_datareader ADD MEMBER ${user}`,
    `GRANT VIEW DATABASE STATE TO ${user}`,
  ]);
});

afterAll(async () => {
  await Promise.all(open.map((c) => c.close()));
  await asMssqlAdmin([`DROP USER IF EXISTS ${quoteMssqlIdent(STATE_LOGIN)}`]);
  await asMssqlAdmin([dropLoginSql(STATE_LOGIN)], "master");
});

describe("azure-sql readSize", () => {
  it("sums the used pages of the user tables in the listed schemas", async () => {
    const connection = await connect(
      mssqlFixtureSettings("ro", {
        user: STATE_LOGIN,
        password: STATE_PASSWORD,
      })
    );
    const sales = await sizeOf([
      "sales.accounts",
      "sales.customers",
      "sales.orders",
      "sales.order_lines",
      "sales.ledger",
    ]);
    expect(sales).toBeGreaterThan(0);
    expect(await connection.readSize(["sales"])).toBe(sales);
    expect(await connection.readSize(["sales", "hr"])).toBe(
      sales + (await sizeOf(["hr.salaries"]))
    );
  });

  it("is 0 for no schema, an unknown one, or only system schemas", async () => {
    const connection = await connect(
      mssqlFixtureSettings("ro", {
        user: STATE_LOGIN,
        password: STATE_PASSWORD,
      })
    );
    expect(await connection.readSize([])).toBe(0);
    expect(await connection.readSize(["no_such_schema"])).toBe(0);
    expect(await connection.readSize(["sys", "INFORMATION_SCHEMA"])).toBe(0);
  });

  it("is null without VIEW DATABASE STATE, logged at info, never a throw", async () => {
    const connection = await connect(mssqlFixtureSettings("ro"));
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      expect(await connection.readSize(["sales"])).toBeNull();
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "the login may not read the source's size (VIEW DATABASE STATE)"
      );
    } finally {
      info.mockRestore();
    }
  });

  it("is null, logged at warn, when the source cannot answer", async () => {
    const connection = await azureSqlAdapter.connect(
      mssqlFixtureSettings("ro"),
      await mssqlFixtureTarget(),
      options
    );
    await connection.close();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await connection.readSize(["sales"])).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "reading the source's size failed"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
