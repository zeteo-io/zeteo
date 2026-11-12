// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  SettingsUnreadableError,
  createEnvelope,
  openSettings,
  sealSettings,
  type SealedSettings,
} from "../../../utils/crypto/envelope.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const settings = {
  host: "db.internal",
  port: 5432,
  user: "reader",
  password: "s3cr3t-Passw0rd-xyz",
};

/** The same sealed value with one byte of one field flipped. */
function flipByte(
  sealed: SealedSettings,
  field: "ciphertext" | "tag" | "wrappedKey" | "iv"
): SealedSettings {
  const bytes = Buffer.from(sealed[field], "base64url");
  bytes[0] ^= 0x01;
  return { ...sealed, [field]: bytes.toString("base64url") };
}

describe("envelope encryption of source settings", () => {
  it("opens what it sealed", () => {
    expect(openSettings(sealSettings(settings, SOURCE_ID), SOURCE_ID)).toEqual(
      settings
    );
  });

  it("seals to the documented shape", () => {
    const sealed = sealSettings(settings, SOURCE_ID);
    expect(Object.keys(sealed).sort()).toEqual(
      ["ciphertext", "iv", "kid", "tag", "v", "wrappedKey"].sort()
    );
    expect(sealed.v).toBe(1);
    expect(sealed.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(Buffer.from(sealed.iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(sealed.tag, "base64url")).toHaveLength(16);
    // wrap iv (12) + wrap tag (16) + encrypted 32-byte data key
    expect(Buffer.from(sealed.wrappedKey, "base64url")).toHaveLength(60);
  });

  it("gives two seals of the same input different wrappedKey, iv and ciphertext", () => {
    const a = sealSettings(settings, SOURCE_ID);
    const b = sealSettings(settings, SOURCE_ID);
    expect(a.kid).toBe(b.kid);
    expect(a.wrappedKey).not.toBe(b.wrappedKey);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it.each(["ciphertext", "tag", "wrappedKey", "iv"] as const)(
    "refuses a flipped byte in %s",
    (field) => {
      const sealed = sealSettings(settings, SOURCE_ID);
      expect(() => openSettings(flipByte(sealed, field), SOURCE_ID)).toThrow(
        SettingsUnreadableError
      );
    }
  );

  it("refuses a sealed value opened for another source", () => {
    const sealed = sealSettings(settings, SOURCE_ID);
    expect(() =>
      openSettings(sealed, "22222222-2222-4222-8222-222222222222")
    ).toThrow(SettingsUnreadableError);
  });

  it("refuses an unknown version and malformed fields", () => {
    const sealed = sealSettings(settings, SOURCE_ID);
    const cases: unknown[] = [
      { ...sealed, v: 2 },
      { ...sealed, ciphertext: 5 },
      { ...sealed, tag: "" },
      { ...sealed, wrappedKey: "AAAA" },
      null,
      "text",
    ];
    for (const bad of cases) {
      expect(() => openSettings(bad as SealedSettings, SOURCE_ID)).toThrow(
        SettingsUnreadableError
      );
    }
  });

  it("refuses a value sealed under another master key, naming only the kid", () => {
    const other = createEnvelope(randomBytes(32));
    const mine = createEnvelope(randomBytes(32));
    const sealed = other.sealSettings(settings, SOURCE_ID);
    let message = "";
    try {
      mine.openSettings(sealed, SOURCE_ID);
    } catch (err) {
      expect(err).toBeInstanceOf(SettingsUnreadableError);
      message = (err as Error).message;
    }
    expect(message).toMatch(/kid/);
    expect(message).toContain(sealed.kid);
    expect(message).not.toContain(settings.password);
  });

  it("keeps the plaintext out of the sealed JSON", () => {
    const json = JSON.stringify(sealSettings(settings, SOURCE_ID));
    for (const secret of [settings.password, settings.user, settings.host]) {
      expect(json).not.toContain(secret);
    }
    for (let i = 0; i + 6 <= settings.password.length; i++) {
      expect(json).not.toContain(settings.password.slice(i, i + 6));
    }
  });

  it("puts no key material or plaintext in the error for a tampered value", () => {
    const sealed = sealSettings(settings, SOURCE_ID);
    try {
      openSettings(flipByte(sealed, "ciphertext"), SOURCE_ID);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(settings.password);
      expect(message).not.toContain(sealed.wrappedKey);
      expect(message).not.toContain(sealed.ciphertext);
    }
  });

  it("refuses a master key that is not 32 bytes", () => {
    expect(() => createEnvelope(randomBytes(16))).toThrow();
  });
});
