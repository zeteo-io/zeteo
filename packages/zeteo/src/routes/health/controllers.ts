import { healthCheck } from "../../utils/db/prisma.js";
import type { Request, Response } from "express";
import { redis } from "../../utils/redis.js";

const PROBE_TIMEOUT_MS = 500;

/** Whether `probe` resolves in time; a hung dependency counts as down. */
const answers = async (probe: () => Promise<unknown>): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([probe().then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

// Public, so it names no version.
export const getHealth = async (_req: Request, res: Response) => {
  const [postgres, redisOk] = await Promise.all([
    answers(healthCheck),
    answers(() => redis.ping()),
  ]);
  const healthy = postgres && redisOk;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    postgres: postgres ? "ok" : "fail",
    redis: redisOk ? "ok" : "fail",
  });
};
