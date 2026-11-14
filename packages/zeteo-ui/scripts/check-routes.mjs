// Fails when a router path, or a file in public/, sits under a path zeteo keeps
// for itself. Zeteo serves this UI at its root and answers those prefixes
// itself, so such a page could never load.
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

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const router = path.join(uiRoot, "src/app/router.tsx");
const publicDir = path.join(uiRoot, "public");

const firstSegment = (p) => p.replace(/^\/+/, "").split("/")[0];

const problems = [];
if (existsSync(router)) {
  readFileSync(router, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(/path:\s*["']([^"']+)["']/g)) {
        if (RESERVED.includes(firstSegment(m[1]))) {
          problems.push(`src/app/router.tsx:${i + 1}: route "${m[1]}"`);
        }
      }
    });
}
if (existsSync(publicDir)) {
  for (const entry of readdirSync(publicDir)) {
    if (RESERVED.includes(entry)) problems.push(`public/${entry}`);
  }
}

if (problems.length) {
  console.error(
    `check-routes: routes under a path zeteo reserves (/${RESERVED.join(", /")}):\n  ${problems.join("\n  ")}`
  );
  process.exit(1);
}
console.log("check-routes: no route under a reserved prefix");
