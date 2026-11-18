// @module-tag unit
// @module-tag platform
import { UpdateSourceSchema } from "../../../../routes/v1/sources/source/schemas.js";
import { describe, expect, it } from "vitest";
import {
  CreateSourceSchema,
  CreateUploadSourceSchema,
  ListSourcesQuerySchema,
} from "../../../../routes/v1/sources/schemas.js";

const create = (schemas: unknown) =>
  CreateSourceSchema.safeParse({
    slug: "sales",
    type: "postgres",
    name: "Sales",
    settings: {},
    schemas,
  });

describe("source schema names", () => {
  it.each([
    [["public"]],
    [["sales", "hr"]],
    [["with space inside"]],
    [["ünïcode"]],
    [["a".repeat(63)]],
  ])("accepts %j", (schemas) => {
    expect(create(schemas).success).toBe(true);
  });

  it.each([
    ["an empty name", [""]],
    ["a name of 64 bytes", ["a".repeat(64)]],
    ["a name of 64 bytes in multibyte characters", ["é".repeat(32)]],
    ["a leading space", [" sales"]],
    ["a trailing space", ["sales "]],
    ["a leading tab", ["\tsales"]],
    ["a trailing newline", ["sales\n"]],
    ["a newline inside", ["sa\nles"]],
    ["a NUL character", ["sa\u0000les"]],
    ["a DEL character", ["sa\u007fles"]],
    ["a C1 control character", ["sa\u0085les"]],
    ["a duplicate", ["sales", "sales"]],
  ])("refuses %s", (_, schemas) => {
    expect(create(schemas).success).toBe(false);
  });
});

describe("source name", () => {
  it("refuses a NUL character in the name of a create and of an update", () => {
    const body = {
      slug: "sales",
      type: "postgres",
      settings: {},
      schemas: ["public"],
    };
    expect(
      CreateSourceSchema.safeParse({ ...body, name: "Sa\u0000les" }).success
    ).toBe(false);
    expect(
      CreateSourceSchema.safeParse({ ...body, name: "Sales" }).success
    ).toBe(true);
    expect(UpdateSourceSchema.safeParse({ name: "Sa\u0000les" }).success).toBe(
      false
    );
  });
});

describe("source description", () => {
  const body = {
    slug: "sales",
    type: "postgres",
    name: "Sales",
    settings: {},
    schemas: ["public"],
  };
  const upload = {
    type: "upload",
    staging_id: "0198f7a2-0000-7000-8000-000000000001",
    name: "Orders",
    tables: [{ key: "csv" }],
  };

  it("accepts 500 characters on a create, an upload source's create and an update", () => {
    const description = "a".repeat(500);
    expect(CreateSourceSchema.safeParse({ ...body, description }).success).toBe(
      true
    );
    expect(
      CreateUploadSourceSchema.safeParse({ ...upload, description }).success
    ).toBe(true);
    expect(UpdateSourceSchema.safeParse({ description }).success).toBe(true);
  });

  it.each([
    ["501 characters", "a".repeat(501)],
    ["a NUL character", "Sa\u0000les"],
  ])("refuses %s", (_, description) => {
    expect(CreateSourceSchema.safeParse({ ...body, description }).success).toBe(
      false
    );
    expect(
      CreateUploadSourceSchema.safeParse({ ...upload, description }).success
    ).toBe(false);
    expect(UpdateSourceSchema.safeParse({ description }).success).toBe(false);
  });

  it("trims it, and leaves it out when the body omits it", () => {
    expect(
      CreateSourceSchema.parse({ ...body, description: "  x  " }).description
    ).toBe("x");
    expect(UpdateSourceSchema.parse({ description: "  x  " })).toEqual({
      description: "x",
    });
    expect(CreateSourceSchema.parse(body)).not.toHaveProperty("description");
  });

  it("accepts an empty one, which clears it", () => {
    expect(UpdateSourceSchema.parse({ description: "" })).toEqual({
      description: "",
    });
  });
});

describe("max_joins", () => {
  const body = {
    slug: "sales",
    type: "postgres",
    name: "Sales",
    settings: {},
    schemas: ["public"],
  };

  it.each([1, 8])("accepts %s on a create and on an update", (max_joins) => {
    expect(CreateSourceSchema.safeParse({ ...body, max_joins }).success).toBe(
      true
    );
    expect(UpdateSourceSchema.safeParse({ max_joins }).success).toBe(true);
  });

  it.each([0, 9, 2.5, "4"])("refuses %j", (max_joins) => {
    expect(CreateSourceSchema.safeParse({ ...body, max_joins }).success).toBe(
      false
    );
    expect(UpdateSourceSchema.safeParse({ max_joins }).success).toBe(false);
  });

  it("leaves max_joins out when the body omits it", () => {
    const parsed = CreateSourceSchema.parse(body);
    expect(parsed).not.toHaveProperty("max_joins");
    expect(UpdateSourceSchema.parse({ name: "x" })).not.toHaveProperty(
      "max_joins"
    );
  });
});

describe("an upload source's create", () => {
  const body = {
    type: "upload",
    staging_id: "0198f7a2-0000-7000-8000-000000000001",
    name: "Orders",
    tables: [{ key: "csv" }],
  };

  it("accepts a staging with its tables, and an optional slug", () => {
    expect(CreateUploadSourceSchema.safeParse(body).success).toBe(true);
    expect(
      CreateUploadSourceSchema.safeParse({ ...body, slug: "orders" }).success
    ).toBe(true);
  });

  it.each([
    ["no tables", { tables: [] }],
    ["a database source's settings", { settings: {} }],
    ["schemas", { schemas: ["public"] }],
    ["a bad slug", { slug: "Orders!" }],
    ["a staging id that is not one", { staging_id: "nope" }],
    [
      "a table name with __load_",
      { tables: [{ key: "csv", name: "a__load_x" }] },
    ],
    [
      "an unknown column type",
      { tables: [{ key: "csv", columns: [{ index: 0, type: "money" }] }] },
    ],
  ])("refuses %s", (_, change) => {
    expect(
      CreateUploadSourceSchema.safeParse({ ...body, ...change }).success
    ).toBe(false);
  });

  it("is not a database source's create", () => {
    expect(CreateSourceSchema.safeParse(body).success).toBe(false);
  });
});

describe("the list's filters", () => {
  it.each([
    [{}],
    [{ type: "upload" }],
    [{ type: "azure-sql" }],
    [{ owner_id: "me" }],
    [{ owner_id: "0198f7a2-0000-7000-8000-000000000001", type: "postgres" }],
  ])("accepts %j", (query) => {
    expect(ListSourcesQuerySchema.safeParse(query).success).toBe(true);
  });

  it.each([[{ type: "azure_sql" }], [{ owner_id: "you" }], [{ scope: "all" }]])(
    "refuses %j",
    (query) => {
      expect(ListSourcesQuerySchema.safeParse(query).success).toBe(false);
    }
  );
});
