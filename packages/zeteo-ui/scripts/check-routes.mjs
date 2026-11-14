// Fails when a route path in src/, or a file in public/, sits under a path
// zeteo keeps for itself. Zeteo serves this UI at its root and answers those
// prefixes itself (case-insensitively, as Express routes), so such a page
// could never load. Conservative: any path literal whose first segment is a
// reserved one is flagged, absolute or relative.
//
// Usage: node scripts/check-routes.mjs [uiRoot]
/* global console, process */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RESERVED = [
  "v1",
  "health",
  "mcp",
  ".well-known",
  "assets",
  "ui-config.json",
];

const uiRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(uiRoot, "public");

const firstSegment = (p) => p.replace(/^\/+/, "").split("/")[0].toLowerCase();
const reserved = (p) => RESERVED.includes(firstSegment(p));

// path: "x", path="x", path={"x"}, path={'x'}, path={`x`}
const PATH_LITERAL = /\bpath\s*(?::|=\s*\{?)\s*["'`]([^"'`]+)["'`]/g;
const isTest = (f) => /\.test\.(ts|tsx)$/.test(f);

const problems = [];
for (const dir of ["src/app", "src/features"]) {
  const abs = path.join(uiRoot, dir);
  if (!existsSync(abs)) continue;
  for (const file of readdirSync(abs, { recursive: true, encoding: "utf8" })) {
    if (!/\.(ts|tsx)$/.test(file) || isTest(file)) continue;
    readFileSync(path.join(abs, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(PATH_LITERAL)) {
          if (reserved(m[1]))
            problems.push(`${dir}/${file}:${i + 1}: route "${m[1]}"`);
        }
      });
  }
}
if (existsSync(publicDir)) {
  for (const entry of readdirSync(publicDir)) {
    if (reserved(entry)) problems.push(`public/${entry}`);
  }
}

if (problems.length) {
  console.error(
    `check-routes: routes under a path zeteo reserves (/${RESERVED.join(", /")}):\n  ${problems.join("\n  ")}`
  );
  process.exit(1);
}
console.log("check-routes: no route under a reserved prefix");
