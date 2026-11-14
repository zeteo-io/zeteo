import { useStubbedClient } from "./support/callContext.js";
import type { ListRunsOptions } from "../types/runs.js";
import { describe, expect, it } from "vitest";
import { runsCalls } from "../calls/runs.js";
import { paginate } from "../paginate.js";

const run = (id: string) => ({ id });

describe("paginate", () => {
  const t = useStubbedClient();

  it("follows next_cursor until null, repeating limit and filters", async () => {
    const pages: Record<string, unknown> = {
      "": { data: [run("1"), run("2")], next_cursor: "c1" },
      c1: { data: [run("3"), run("4")], next_cursor: "c2" },
      c2: { data: [run("5")], next_cursor: null },
    };
    t.stub.respond((req) => ({ body: pages[req.query.cursor ?? ""] }));
    const calls = runsCalls(t.ctx("p-1"));

    const ids: string[] = [];
    const options: ListRunsOptions = { limit: 2, outcome: "ok" };
    for await (const item of paginate((o) => calls.list(o), options)) {
      ids.push(item.id);
    }

    expect(ids).toEqual(["1", "2", "3", "4", "5"]);
    expect(t.stub.requests.map((r) => r.query)).toEqual([
      { limit: "2", outcome: "ok" },
      { limit: "2", outcome: "ok", cursor: "c1" },
      { limit: "2", outcome: "ok", cursor: "c2" },
    ]);
  });

  it("starts from the given cursor and works with no options", async () => {
    t.stub.respond(() => ({ body: { data: [run("1")], next_cursor: null } }));
    const calls = runsCalls(t.ctx("p-1"));
    const seen: string[] = [];
    for await (const item of paginate((o) => calls.list(o))) {
      seen.push(item.id);
    }
    for await (const item of paginate((o) => calls.list(o), { cursor: "x" })) {
      seen.push(item.id);
    }
    expect(seen).toEqual(["1", "1"]);
    expect(t.stub.requests[1].query).toEqual({ cursor: "x" });
  });

  it("makes no further request when the consumer stops early", async () => {
    t.stub.respond(() => ({
      body: { data: [run("1"), run("2")], next_cursor: "more" },
    }));
    const calls = runsCalls(t.ctx("p-1"));
    for await (const item of paginate((o) => calls.list(o))) {
      if (item.id === "1") break;
    }
    expect(t.stub.requests).toHaveLength(1);
  });

  it("throws pagination_stuck when next_cursor repeats the cursor sent", async () => {
    t.stub.respond(() => ({ body: { data: [run("1")], next_cursor: "same" } }));
    const calls = runsCalls(t.ctx("p-1"));
    const ids: string[] = [];
    await expect(
      (async () => {
        for await (const item of paginate((o) => calls.list(o), {
          cursor: "same",
        })) {
          ids.push(item.id);
        }
      })()
    ).rejects.toMatchObject({ status: null, code: "pagination_stuck" });
    expect(t.stub.requests).toHaveLength(1);
  });

  it("leaves the caller's options unchanged", async () => {
    t.stub.respond((req) => ({
      body: req.query.cursor
        ? { data: [run("2")], next_cursor: null }
        : { data: [run("1")], next_cursor: "c1" },
    }));
    const calls = runsCalls(t.ctx("p-1"));
    const options: ListRunsOptions = { limit: 1, outcome: "ok" };
    for await (const item of paginate((o) => calls.list(o), options)) {
      void item;
    }
    expect(options).toEqual({ limit: 1, outcome: "ok" });
  });
});
