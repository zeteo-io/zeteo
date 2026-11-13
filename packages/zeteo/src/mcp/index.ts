import { buildTereoDocument } from "../definitions/tereoDeclaration.js";
import { defineDiscoveryTools } from "./tools.js";
import { getTereo } from "../utils/tereo.js";
import { rateLimitRedis } from "./redis.js";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import type { Router } from "express";
import { readFileSync } from "fs";
import env from "../env.js";
import {
  createTereoMcp,
  type RateLimitRedis,
  type TereoMcp,
} from "@tereo-io/mcp";

/** Where the MCP endpoint is served; its metadata is under `/.well-known/oauth-protected-resource/mcp`. */
export const MCP_PATH = "/mcp";

/** The most a tool result may carry: above the MCP limit profile's 1 MB of rows, with room for the rest of a result. */
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

// Two levels up from both src/mcp and dist/mcp.
const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
) as { version: string };

export interface ZeteoMcpOptions {
  /** Where tereo's authorization-server metadata is fetched; TEREO_URL by default. */
  coreUrl?: string;
  /** The rate limiter's Redis; the shared client by default. */
  redis?: RateLimitRedis;
}

/** Zeteo's MCP server with its tools defined, not yet started. */
export const createZeteoMcp = (options: ZeteoMcpOptions = {}): TereoMcp => {
  const mcp = createTereoMcp({
    name: "zeteo",
    version,
    core: getTereo(),
    publicUrl: env.PUBLIC_URL,
    path: MCP_PATH,
    allowedClients: env.MCP_ALLOWED_CLIENTS,
    allowServiceAccounts: false,
    provisioning: buildTereoDocument(version),
    maxResultBytes: MAX_RESULT_BYTES,
    rateLimit: { perMinute: env.MCP_RATE_LIMIT_PER_MINUTE },
    redis: options.redis ?? rateLimitRedis(redis),
    coreUrl: options.coreUrl ?? env.TEREO_URL,
    logger: logger.child({ component: "mcp" }),
  });
  defineDiscoveryTools(mcp);
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
