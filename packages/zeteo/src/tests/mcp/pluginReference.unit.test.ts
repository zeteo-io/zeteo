// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import {
  DASHBOARDS_REFERENCE,
  QUERYING_REFERENCE,
} from "../../mcp/reference.js";

const repo = new URL("../../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf-8");
const readJson = (path: string) => JSON.parse(read(path));

const GENERATED_HEADER =
  "<!-- Written by npm run plugin:reference in packages/zeteo; edit src/mcp/reference.ts. -->\n\n";

describe("the zeteo Claude Code plugin", () => {
  it("plugin reference files match reference.ts", () => {
    expect(read("plugins/zeteo/skills/zeteo-querying/reference.md")).toBe(
      `${GENERATED_HEADER}${QUERYING_REFERENCE}\n`
    );
    expect(read("plugins/zeteo/skills/zeteo-dashboards/reference.md")).toBe(
      `${GENERATED_HEADER}${DASHBOARDS_REFERENCE}\n`
    );
  });

  it("plugin.json and marketplace.json name the same plugin and version", () => {
    const plugin = readJson("plugins/zeteo/.claude-plugin/plugin.json");
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(plugin.license).toBe("Apache-2.0");
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({
      name: plugin.name,
      version: plugin.version,
      source: "./plugins/zeteo",
    });
  });

  it.each(["zeteo-querying", "zeteo-dashboards"])(
    "each SKILL.md has name and description frontmatter and links reference.md (%s)",
    (skill) => {
      const text = read(`plugins/zeteo/skills/${skill}/SKILL.md`);
      const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(match).not.toBeNull();
      expect(match![1]).toMatch(new RegExp(`^name: ${skill}$`, "m"));
      expect(match![1]).toMatch(/^description: \S.*$/m);
      expect(text).toContain("](reference.md)");
    }
  );

  it(".mcp.json names no fixed host", () => {
    const plugin = readJson("plugins/zeteo/.claude-plugin/plugin.json");
    expect(plugin.userConfig.mcp_url.type).toBe("string");
    expect(readJson("plugins/zeteo/.mcp.json")).toEqual({
      mcpServers: {
        zeteo: { type: "http", url: "${user_config.mcp_url}" },
      },
    });
  });
});
