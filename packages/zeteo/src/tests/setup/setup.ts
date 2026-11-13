import { initializeRedis } from "../../utils/redis.js";
import { prisma } from "../../utils/db/prisma.js";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await initializeRedis();
  await prisma.$connect();
});
