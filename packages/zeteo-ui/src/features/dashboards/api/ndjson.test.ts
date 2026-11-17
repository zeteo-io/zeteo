import { controlledStream } from "../testFixtures";
import { describe, expect, it } from "vitest";
import { readLines } from "./ndjson";

const body = (text: string) => {
  const s = controlledStream();
  s.push(text);
  s.close();
  return s.stream;
};

describe("readLines", () => {
  it("passes each whole line, the last one with or without its newline", async () => {
    const lines: unknown[] = [];
    await readLines(body('{"a":1}\n{"b":2}'), (l) => lines.push(l));
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("treats a trailing partial line as an interrupted stream, not a parse error", async () => {
    const lines: unknown[] = [];
    await expect(
      readLines(body('{"a":1}\n{"panel_id":"x","sta'), (l) => lines.push(l))
    ).rejects.toEqual({
      status: null,
      code: "interrupted",
      message: "The dashboard's run stopped before it finished.",
    });
    expect(lines).toEqual([{ a: 1 }]);
  });
});
