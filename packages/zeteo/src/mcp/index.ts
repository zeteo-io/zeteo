import { buildTereoDocument } from "../definitions/tereoDeclaration.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { defineDiscoveryTools } from "./tools.js";
import { defineQueryTool } from "./queryTool.js";
import { getTereo } from "../utils/tereo.js";
import { rateLimitRedis } from "./redis.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import { MCP_PATH } from "./paths.js";
import type { Router } from "express";
import { readFileSync } from "fs";
import env from "../env.js";
import {
  createTereoMcp,
  type RateLimitRedis,
  type TereoMcp,
} from "@tereo-io/mcp";

/** The most a tool result may carry: above the MCP limit profile's 1 MB of rows, with room for the rest of a result. */
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

// Two levels up from both src/mcp and dist/mcp.
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
) as { version: string };

export interface ZeteoMcpOptions {
  /** Where tereo's authorization-server metadata is fetched; the core client's URL by default. */
  coreUrl?: string;
  /** The rate limiter's Redis; the shared client by default. */
  redis?: RateLimitRedis;
}

/** Zeteo's MCP server with its tools defined, not yet started. */
export const createZeteoMcp = (options: ZeteoMcpOptions = {}): TereoMcp => {
  const mcp = createTereoMcp({
    name: "zeteo",
    version,
    instructions: MCP_INSTRUCTIONS,
    core: getTereo(),
    publicUrl: env.PUBLIC_URL,
    path: MCP_PATH,
    allowedClients: env.MCP_ALLOWED_CLIENTS,
    allowServiceAccounts: false,
    provisioning: buildTereoDocument(version),
    maxResultBytes: MAX_RESULT_BYTES,
    rateLimit: { perMinute: env.MCP_RATE_LIMIT_PER_MINUTE },
    redis: options.redis ?? rateLimitRedis(redis),
    coreUrl: options.coreUrl,
    logger: logger.child({ component: "mcp" }),
  });
  defineDiscoveryTools(mcp);
  defineQueryTool(mcp);
  return mcp;
};

/**
 * Null when MCP is off. `coreUrl` overrides where Tereo's authorization-server
 * metadata is fetched (tests).
 */
export const createMcpRouter = async (
  options: { coreUrl?: string } = {}
): Promise<Router | null> => {
  if (env.MCP_ALLOWED_CLIENTS.length === 0) {
    logger.info("MCP is off: MCP_ALLOWED_CLIENTS is empty");
    return null;
  }
  return createZeteoMcp(options).router();
};
