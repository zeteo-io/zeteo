import { challengeFor, createVerifier, randomToken } from "./pkce";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

describe("PKCE", () => {
  it("makes a verifier of 43 to 128 URL-safe characters", () => {
    for (let i = 0; i < 20; i++) {
      const verifier = createVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it("makes a different verifier each time", () => {
    expect(createVerifier()).not.toBe(createVerifier());
  });

  it("derives the challenge as the base64url SHA-256 of the verifier", async () => {
    // SHA-256("abc"), FIPS 180-2 appendix B.1, in base64url.
    expect(await challengeFor("abc")).toBe(
      Buffer.from(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "hex"
      ).toString("base64url")
    );

    const verifier = createVerifier();
    expect(await challengeFor(verifier)).toBe(
      createHash("sha256").update(verifier).digest("base64url")
    );
  });

  it("makes random URL-safe state and nonce values", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(randomToken()).not.toBe(a);
  });
});
