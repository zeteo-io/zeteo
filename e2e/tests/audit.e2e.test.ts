import { zeteoAuditEntries, type AuditEntry } from "../support/tereo.js";
import { PAID_ORDERS, query } from "../support/zeteo.js";
import { describe, expect, inject, it } from "vitest";
import { waitFor } from "../support/http.js";
import { stack } from "../support/stack.js";

const e2e = inject("e2e");

/** zeteo's entries for `runId` once Tereo holds every event in `events`. */
const auditOf = async (runId: string, events: string[]) =>
  (
    await waitFor(
      `Tereo's audit entries for run ${runId}`,
      async () => {
        const entries = await zeteoAuditEntries(e2e.admin.coreToken, runId);
        const seen = entries.map((e) => e.metadata?.event);
        return events.every((event) => seen.includes(event))
          ? entries
          : undefined;
      },
      { timeoutMs: 30_000 }
    )
  ).value;

const byEvent = (entries: AuditEntry[], event: string) =>
  entries.find((e) => e.metadata?.event === event);

describe("the audit outbox", () => {
  it("a query's run reaches Tereo's audit log", async () => {
    const res = await query(stack.zeteoUrl, e2e.alice.token, e2e.source.slug);
    expect(res.status).toBe(200);

    const entries = await auditOf(res.body.run_id, ["zeteo.query.run"]);

    const entry = byEvent(entries, "zeteo.query.run")!;
    expect(entry).toMatchObject({
      source: "zeteo",
      entityType: "query_run",
      entityId: res.body.run_id,
      userId: e2e.alice.id,
    });
    expect(entry.metadata).toMatchObject({
      source_id: e2e.source.id,
      entry_point: "api",
      row_count: 3,
    });
  });

  it("an export's start and end reach Tereo's audit log", async () => {
    const res = await fetch(`${stack.zeteoUrl}/v1/export?format=ndjson`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${e2e.admin.zeteoToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source: e2e.source.slug, ...PAID_ORDERS }),
    });
    expect(res.status).toBe(200);
    const runId = res.headers.get("x-zeteo-run-id")!;
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    // The head, three rows, and the line that says the export completed.
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ run_id: runId });
    expect(lines[4]).toEqual({ status: "complete", rows: 3 });

    const entries = await auditOf(runId, [
      "zeteo.export.started",
      "zeteo.export.run",
    ]);

    for (const event of ["zeteo.export.started", "zeteo.export.run"]) {
      expect(byEvent(entries, event)).toMatchObject({
        source: "zeteo",
        entityType: "query_run",
        entityId: runId,
        userId: e2e.admin.id,
      });
    }
    expect(byEvent(entries, "zeteo.export.run")!.metadata).toMatchObject({
      entry_point: "export",
      row_count: 3,
    });
  });
});
