// @module-tag unit
// @module-tag platform
import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import ts from "typescript";
import path from "path";

// Every error code the HTTP API can answer with resolves to a status and is
// shaped like a code. Codes and statuses are read from the source: each
// AppError construction resolved through its class's constructor down to
// AppError, the helpers that take a code and throw with it
// (`mapUniqueViolation`), and the `{ status, code }` literals of
// utils/errors.ts's own mapping.
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const ERRORS_FILE = path.join(SRC, "utils/errors.ts");
const QUERY_ERRORS_FILE = path.join(SRC, "engine/errors.ts");
const CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$|^[a-z]+$/;

interface Pair {
  status: number | undefined;
  code: string;
  at: string;
}

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
};

const where = (n: ts.Node) => {
  const file = n.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(n.getStart());
  return `${path.relative(SRC, file.fileName)}:${line + 1}`;
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(path.join(SRC, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => path.join(SRC, dir, f));

const apiSourceFiles = (): string[] =>
  sourceFiles(".").filter((f) => !/^tests\//.test(path.relative(SRC, f)));

const errorsFile = parse(ERRORS_FILE);

// The query planner's errors live with the engine.
const errorClasses = new Map<string, ts.ClassDeclaration>();
for (const file of [errorsFile, parse(QUERY_ERRORS_FILE)]) {
  walk(file, (n) => {
    if (ts.isClassDeclaration(n) && n.name) errorClasses.set(n.name.text, n);
  });
}

/** What a construction comes to: a status if it is a literal, and the code expression. */
interface Resolved {
  status: number | undefined;
  code: ts.Expression | undefined;
}

const numberOf = (e: ts.Expression | undefined) =>
  e && ts.isNumericLiteral(e) ? Number(e.text) : undefined;

/** Follows `new <cls>(args)` through each constructor's `super(...)` to AppError's (status, code). */
const resolveConstruction = (
  cls: string,
  args: readonly (ts.Expression | undefined)[]
): Resolved => {
  if (cls === "AppError") return { status: numberOf(args[0]), code: args[1] };
  const decl = errorClasses.get(cls)!;
  const parent = decl.heritageClauses?.[0]?.types[0]?.expression.getText();
  const ctor = decl.members.find(ts.isConstructorDeclaration);
  if (!ctor) return resolveConstruction(parent!, args);

  const bound = new Map<string, ts.Expression | undefined>();
  ctor.parameters.forEach((p, i) =>
    bound.set(p.name.getText(), args[i] ?? p.initializer)
  );
  let superArgs: (ts.Expression | undefined)[] = [];
  walk(ctor, (n) => {
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      superArgs = n.arguments.map((a) =>
        ts.isIdentifier(a) && bound.has(a.text) ? bound.get(a.text) : a
      );
    }
  });
  return resolveConstruction(parent!, superArgs);
};

/** The name and parameters of the function `n` is in. */
const enclosingFunction = (
  n: ts.Node
): { name: string; params: string[] } | null => {
  for (let p = n.parent; p; p = p.parent) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isArrowFunction(p) ||
      ts.isFunctionExpression(p)
    ) {
      const name =
        p.name?.getText() ??
        (ts.isVariableDeclaration(p.parent) ? p.parent.name.getText() : null);
      if (!name) return null;
      return { name, params: p.parameters.map((q) => q.name.getText()) };
    }
  }
  return null;
};

/** A function that throws an AppError with the code it is given: its name, the code's index and the status. */
interface Helper {
  name: string;
  index: number;
  status: number | undefined;
}

const restPairs = (): { pairs: Pair[]; helpers: Helper[] } => {
  const pairs: Pair[] = [];
  const helpers: Helper[] = [];
  const files = apiSourceFiles().map(parse);
  for (const file of files) {
    walk(file, (n) => {
      if (
        !ts.isNewExpression(n) ||
        !ts.isIdentifier(n.expression) ||
        !errorClasses.has(n.expression.text)
      ) {
        return;
      }
      const { status, code } = resolveConstruction(
        n.expression.text,
        n.arguments ?? []
      );
      if (code && ts.isStringLiteral(code)) {
        pairs.push({ status, code: code.text, at: where(n) });
      } else if (code && ts.isIdentifier(code)) {
        const fn = enclosingFunction(n);
        const index = fn?.params.indexOf(code.text) ?? -1;
        if (fn && index >= 0) helpers.push({ name: fn.name, index, status });
      }
    });
  }
  for (const file of files) {
    walk(file, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
      const callee = n.expression.text;
      for (const helper of helpers.filter((h) => h.name === callee)) {
        const arg = n.arguments[helper.index];
        if (arg && ts.isStringLiteral(arg)) {
          pairs.push({ status: helper.status, code: arg.text, at: where(n) });
        }
      }
    });
  }

  walk(errorsFile, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const prop = (name: string) =>
      n.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && p.name.getText() === name
      )?.initializer;
    const code = prop("code");
    if (code && ts.isStringLiteral(code)) {
      pairs.push({
        status: numberOf(prop("status")),
        code: code.text,
        at: where(n),
      });
    }
  });
  return { pairs, helpers };
};

const describePair = ({ status, code, at }: Pair) =>
  `${status ?? "?"} ${code} (${at})`;

describe("error codes", () => {
  const { pairs, helpers } = restPairs();

  it("finds the codes it should", () => {
    const codes = pairs.map((p) => p.code);
    for (const code of [
      "invalid_request",
      "not_found",
      "conflict",
      "version_conflict",
      "payload_too_large",
      "server_error",
      "temporarily_unavailable",
      "not_found_or_not_accessible",
      "invalid_operator",
      "export_not_enabled",
      "too_many_exports",
    ]) {
      expect(codes).toContain(code);
    }
    expect(helpers.map((h) => h.name)).toContain("mapUniqueViolation");
    expect(helpers.map((h) => h.name)).toContain("fail");
  });

  it("resolves a status for every HTTP code", () => {
    expect(
      pairs.filter((p) => p.status === undefined).map(describePair)
    ).toEqual([]);
  });

  it("shapes every code as lower snake case", () => {
    expect(pairs.filter((p) => !CODE.test(p.code)).map(describePair)).toEqual(
      []
    );
  });
});
