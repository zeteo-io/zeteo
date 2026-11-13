// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  RedisTimeoutError,
  withinRedisTimeout,
} from "../../utils/redisTimeout.js";

describe("withinRedisTimeout", () => {
  it("returns what the command returns", async () => {
    expect(await withinRedisTimeout(Promise.resolve("OK"), 50)).toBe("OK");
  });

  it("passes the command's own failure through", async () => {
    await expect(
      withinRedisTimeout(Promise.reject(new Error("boom")), 50)
    ).rejects.toThrow("boom");
  });

  it("rejects with RedisTimeoutError when the command never settles", async () => {
    const started = Date.now();
    await expect(
      withinRedisTimeout(new Promise(() => undefined), 50)
    ).rejects.toBeInstanceOf(RedisTimeoutError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("swallows a rejection that comes after the timeout", async () => {
    let fail!: (err: Error) => void;
    const late = new Promise<never>((_, reject) => {
      fail = reject;
    });
    await expect(withinRedisTimeout(late, 10)).rejects.toBeInstanceOf(
      RedisTimeoutError
    );
    fail(new Error("Connection is closed"));
    // An unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
