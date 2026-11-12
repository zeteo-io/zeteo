import "dotenv/config";

// Side-effect module: must be the first import of every entry point (server,
// CLI, tests). `utils/logger.ts` reads LOG_LEVEL and SERVICE_NAME when it
// loads and throws if either is unset, so they have to be in place before
// anything imports it.
process.env.SERVICE_NAME = "zeteo";
// `||=`, not `??=`: an empty `LOG_LEVEL=` is unset too.
process.env.LOG_LEVEL ||= "info";
