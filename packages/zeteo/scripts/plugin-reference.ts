import { loadUnitTestEnv } from "../src/tests/setup/testEnv.js";
import { writeFileSync } from "fs";

const GENERATED_HEADER =
  "<!-- Written by npm run plugin:reference in packages/zeteo; edit src/mcp/reference.ts. -->\n\n";

// reference.ts reads the query limits, whose module loads the env schema. The
// text needs no real database or Redis, so the unit test environment will do.
Object.assign(process.env, loadUnitTestEnv());
const { DASHBOARDS_REFERENCE, QUERYING_REFERENCE } =
  await import("../src/mcp/reference.js");

// Writes the reference file each of the plugin's skills links to.
const skills = new URL("../../../plugins/zeteo/skills/", import.meta.url);

writeFileSync(
  new URL("zeteo-querying/reference.md", skills),
  `${GENERATED_HEADER}${QUERYING_REFERENCE}\n`
);
writeFileSync(
  new URL("zeteo-dashboards/reference.md", skills),
  `${GENERATED_HEADER}${DASHBOARDS_REFERENCE}\n`
);
