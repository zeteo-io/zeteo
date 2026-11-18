// @module-tag unit
// @module-tag platform
import { afterEach, describe, expect, it, vi } from "vitest";
import env from "../../env.js";
import {
  withXlsxSlot,
  XLSX_WAIT_MS,
  xlsxGateState,
} from "../../file-sources/uploadLimits.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("withXlsxSlot", () => {
  const concurrency = env.FILE_SOURCE_XLSX_CONCURRENCY;
  afterEach(() => {
    env.FILE_SOURCE_XLSX_CONCURRENCY = concurrency;
    vi.useRealTimers();
  });

  it("reads at most FILE_SOURCE_XLSX_CONCURRENCY workbooks at once, the rest waiting their turn", async () => {
    env.FILE_SOURCE_XLSX_CONCURRENCY = 2;
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, i) =>
      withXlsxSlot(async () => {
        started.push(i);
        await gate.promise;
        return i;
      })
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(xlsxGateState()).toEqual({ reading: 2, waiting: 1 });
    gates[0]!.resolve();
    await runs[0];
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    gates[1]!.resolve();
    gates[2]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(xlsxGateState()).toEqual({ reading: 0, waiting: 0 });
  });

  it("gives the slot back when the work fails", async () => {
    env.FILE_SOURCE_XLSX_CONCURRENCY = 1;
    await expect(
      withXlsxSlot(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await withXlsxSlot(async () => "next")).toBe("next");
    expect(xlsxGateState()).toEqual({ reading: 0, waiting: 0 });
  });

  it("refuses with 503 one that waits past XLSX_WAIT_MS", async () => {
    vi.useFakeTimers();
    env.FILE_SOURCE_XLSX_CONCURRENCY = 1;
    const gate = deferred();
    const first = withXlsxSlot(() => gate.promise);
    const second = withXlsxSlot(async () => "never");
    const refused = expect(second).rejects.toMatchObject({
      statusCode: 503,
      code: "temporarily_unavailable",
    });
    await vi.advanceTimersByTimeAsync(XLSX_WAIT_MS + 1);
    await refused;
    expect(xlsxGateState()).toEqual({ reading: 1, waiting: 0 });
    gate.resolve();
    await first;
    expect(xlsxGateState()).toEqual({ reading: 0, waiting: 0 });
  });
});
