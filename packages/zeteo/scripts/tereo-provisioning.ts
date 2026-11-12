import { buildTereoDocument } from "../src/definitions/tereoDeclaration.js";
import { readFileSync, writeFileSync } from "fs";

// Writes tereo-provisioning.json, the document a deploy puts in core's
// provisioning folder. Its version is this package's.
const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  readFileSync(new URL("package.json", root), "utf-8")
);

writeFileSync(
  new URL("tereo-provisioning.json", root),
  `${JSON.stringify(buildTereoDocument(version), null, 2)}\n`
);
