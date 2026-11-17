// @module-tag unit
// @module-tag platform
import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import ts from "typescript";
import path from "path";

// A dashboard run records at most once per window: an internal option of
// `runQuery` that only src/dashboards/ (and the engine itself) may pass. No
// request field, header or MCP argument can set it, so no other module may
// name `dashboard` in a `runQuery(...)` call.
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const ALLOWED = ["dashboards", "engine", "tests"].map(
  (d) => path.join(SRC, d) + path.sep
);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
      ? [full]
      : [];
  });

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
};

const namesDashboard = (node: ts.Node): boolean => {
  let found = false;
  walk(node, (n) => {
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      n.name.getText() === "dashboard"
    ) {
      found = true;
    }
  });
  return found;
};

/** The `runQuery(...)` calls in `text` whose arguments name `dashboard`, as `file:line`. */
const offendersIn = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  walk(source, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    if (name !== "runQuery") return;
    if (!n.arguments.some(namesDashboard)) return;
    const { line } = source.getLineAndCharacterOfPosition(n.getStart());
    out.push(`${path.relative(SRC, file)}:${line + 1}`);
  });
  return out;
};

const REFUSAL_RECORDER = "recordDashboardRefusal";

/**
 * Every mention of `recordDashboardRefusal` in `text` (an import, a call, a
 * property or a string naming it), as `file:line`: it writes a refused run
 * attributed to a dashboard, which only a dashboard's run may do.
 */
const refusalRecorderIn = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  walk(source, (n) => {
    const named =
      (ts.isIdentifier(n) && n.text === REFUSAL_RECORDER) ||
      (ts.isStringLiteralLike(n) && n.text === REFUSAL_RECORDER);
    if (!named) return;
    const { line } = source.getLineAndCharacterOfPosition(n.getStart());
    out.add(`${path.relative(SRC, file)}:${line + 1}`);
  });
  return [...out];
};

describe("the dashboard option of runQuery", () => {
  it("is found by the check", () => {
    expect(
      offendersIn(
        path.join(SRC, "x.ts"),
        `runQuery({ caller, entryPoint: "dashboard", dashboard: { dashboardId, now } });
         engine.runQuery({ ...input, dashboard });
         runQuery({ caller, entryPoint: "api" });`
      )
    ).toEqual(["x.ts:1", "x.ts:2"]);
  });

  it("is passed only from src/dashboards/ and src/engine/", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !ALLOWED.some((dir) => f.startsWith(dir)))
      .flatMap((f) => offendersIn(f, readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("recordDashboardRefusal", () => {
  it("is found by the check", () => {
    expect(
      refusalRecorderIn(
        path.join(SRC, "x.ts"),
        `import { recordDashboardRefusal } from "./engine/index.js";
         await engine.recordDashboardRefusal(caller, id, ref);
         const f = engine["recordDashboardRefusal"];
         recordRun({ caller });`
      )
    ).toEqual(["x.ts:1", "x.ts:2", "x.ts:3"]);
  });

  it("is referenced only from src/dashboards/ and src/engine/", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !ALLOWED.some((dir) => f.startsWith(dir)))
      .flatMap((f) => refusalRecorderIn(f, readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
