// @module-tag int
// @module-tag platform
import { UploadSourceBusyError } from "../../utils/errors.js";
import { saveMergedTable } from "../../uploads/merged.js";
import { LOAD_LOCKING } from "../../uploads/loading.js";
import type { Caller } from "../../middleware/auth.js";
import { schemaFor } from "../../uploads/storage.js";
import { startV1Routes } from "../support/v1App.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../definitions/tereoDeclaration.js";
import {
  addTables,
  changeColumn,
  createUploadSource,
} from "../../uploads/service.js";
import {
  csvOf,
  removeUploadSourcesOf,
  stageFile,
  uploadTablesOf,
} from "../support/uploads.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

// A query holding a merged view must not hold up changes of tables the view
// does not read; it still holds up changes of its members.

const ownerId = randomUUID();
const owner: Caller = {
  userId: ownerId,
  organizationId: null,
  permissions: [DATA_READ, UPLOADS_WRITE],
  isServiceAccount: false,
};

let app: Awaited<ReturnType<typeof startV1Routes>>;
const lockTimeout = LOAD_LOCKING.swapLockTimeoutMs;

beforeAll(async () => {
  app = await startV1Routes();
});
beforeEach(() => {
  LOAD_LOCKING.swapLockTimeoutMs = 1000;
});
afterEach(async () => {
  LOAD_LOCKING.swapLockTimeoutMs = lockTimeout;
  await removeUploadSourcesOf([ownerId]);
});
afterAll(async () => {
  await app.close();
});

/** A file source of tables `a`, `b` and `c` (sku, qty), with `all_ab` merging a and b. */
const makeSource = async () => {
  let id = "";
  for (const name of ["a", "b", "c"]) {
    const staged = await stageFile(
      ownerId,
      csvOf(["sku", "qty"], [[name, "1"]]),
      `${name}.csv`
    );
    const table = { key: "csv", name };
    if (id === "") {
      id = (
        await createUploadSource(owner, {
          type: "upload",
          staging_id: staged.stagingId,
          name: "Stock",
          tables: [table],
        })
      ).id;
    } else {
      await addTables(owner, id, {
        staging_id: staged.stagingId,
        tables: [table],
      });
    }
  }
  const tables = await uploadTablesOf(id);
  const named = (n: string) => tables.find((t) => t.name === n)!;
  await saveMergedTable(owner, id, {
    name: "all_ab",
    label_column: "store",
    members: [
      { table_id: named("a").id, label: "A" },
      { table_id: named("b").id, label: "B" },
    ],
    columns: [{ name: "sku", from_name: "sku", include: true }],
  });
  return { id, a: named("a"), c: named("c") };
};

/** Runs `fn` while another transaction holds a read of the merged view open. */
const whileViewRead = async <T>(sourceId: string, fn: () => Promise<T>) => {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let reading!: () => void;
  const read = new Promise<void>((r) => (reading = r));
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT * FROM "${schemaFor(sourceId)}"."all_ab"`
      );
      reading();
      await released;
    },
    { timeout: 20_000 }
  );
  await read;
  try {
    return await fn();
  } finally {
    release();
    await holder;
  }
};

describe("merged views and concurrent reads", () => {
  it("a swap of a table no merged view reads completes while a query holds the view", async () => {
    const { id, c } = await makeSource();
    const qty = c.columns.find((col) => col.name === "qty")!;
    const started = Date.now();
    await whileViewRead(id, () =>
      changeColumn(owner, id, c.id, qty.id, { type: "text" })
    );
    expect(Date.now() - started).toBeLessThan(LOAD_LOCKING.swapLockTimeoutMs);
    const after = (await uploadTablesOf(id)).find((t) => t.id === c.id)!;
    expect(after.columns.find((col) => col.id === qty.id)!.type).toBe("text");
  });

  it("a swap of a member waits on the query and answers busy", async () => {
    const { id, a } = await makeSource();
    const qty = a.columns.find((col) => col.name === "qty")!;
    await expect(
      whileViewRead(id, () =>
        changeColumn(owner, id, a.id, qty.id, { type: "text" })
      )
    ).rejects.toBeInstanceOf(UploadSourceBusyError);
  });
});
