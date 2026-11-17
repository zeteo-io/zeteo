import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// Vitest runs from the package directory.
const script = path.resolve("scripts/check-routes.mjs");
const roots: string[] = [];

const run = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "check-routes-"));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), body);
  }
  return spawnSync("node", [script, root], { encoding: "utf8" }).status;
};

describe("check-routes", () => {
  afterEach(() => {
    for (const r of roots.splice(0))
      rmSync(r, { recursive: true, force: true });
  });

  it("passes a clean tree", () => {
    expect(
      run({
        "src/app/router.tsx": 'export const r = [{ path: "/sources" }];',
        "public/favicon.svg": "",
      })
    ).toBe(0);
  });

  it.each([
    ["object path, other case", "src/app/router.tsx", 'x = { path: "/V1/x" }'],
    ["JSX relative path", "src/app/routes/a.tsx", '<Route path="health" />'],
    ["JSX expression path", "src/features/a/r.tsx", "<Route path={'/mcp'} />"],
    ["public file, other case", "public/Assets/x", ""],
  ])("fails on %s", (_name, file, body) => {
    expect(run({ [file]: body })).toBe(1);
  });
});
