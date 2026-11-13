import env from "../../env.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Source settings, encrypted. A fresh data key encrypts the settings JSON; the
 * master key wraps that data key. Both are AES-256-GCM with a random 12-byte IV
 * and the source id as additional authenticated data, so a sealed value cannot
 * be moved to another source.
 *
 * Every field is base64url. `wrappedKey` is `iv (12) || tag (16) || encrypted
 * data key (32)`; `iv` and `tag` belong to the settings ciphertext.
 */
export interface SealedSettings {
  v: 1;
  kid: string;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Never sent to a caller. Messages carry no key material and no plaintext. */
export class SettingsUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsUnreadableError";
  }
}

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyId = (masterKey: Buffer): string =>
  createHash("sha256")
    .update(masterKey)
    .digest()
    .subarray(0, 8)
    .toString("hex");

function encrypt(key: Buffer, plain: Buffer, aad: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function decrypt(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
  aad: Buffer
): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** The bytes of a base64url field that must be exactly `length` long (any length when omitted). */
function field(value: unknown, name: string, length?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new SettingsUnreadableError(`sealed settings: ${name} is malformed`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (length === undefined ? bytes.length === 0 : bytes.length !== length) {
    throw new SettingsUnreadableError(`sealed settings: ${name} is malformed`);
  }
  return bytes;
}

/** Seals and opens under one master key. The service uses the default one below; tests build their own. */
export function createEnvelope(masterKey: Buffer) {
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`the master key must be ${KEY_BYTES} bytes`);
  }
  const kid = keyId(masterKey);

  const sealSettings = (plain: unknown, sourceId: string): SealedSettings => {
    const aad = Buffer.from(sourceId, "utf8");
    const dataKey = randomBytes(KEY_BYTES);
    try {
      const data = encrypt(
        dataKey,
        Buffer.from(JSON.stringify(plain), "utf8"),
        aad
      );
      const wrap = encrypt(masterKey, dataKey, aad);
      return {
        v: 1,
        kid,
        wrappedKey: Buffer.concat([
          wrap.iv,
          wrap.tag,
          wrap.ciphertext,
        ]).toString("base64url"),
        iv: data.iv.toString("base64url"),
        tag: data.tag.toString("base64url"),
        ciphertext: data.ciphertext.toString("base64url"),
      };
    } finally {
      dataKey.fill(0);
    }
  };

  const openSettings = (sealed: SealedSettings, sourceId: string): unknown => {
    if (typeof sealed !== "object" || sealed === null || sealed.v !== 1) {
      throw new SettingsUnreadableError("sealed settings: unsupported version");
    }
    if (sealed.kid !== kid) {
      throw new SettingsUnreadableError(
        `sealed settings: kid mismatch (sealed under ${String(sealed.kid)}, this service holds ${kid})`
      );
    }
    const wrapped = field(
      sealed.wrappedKey,
      "wrappedKey",
      IV_BYTES + TAG_BYTES + KEY_BYTES
    );
    const iv = field(sealed.iv, "iv", IV_BYTES);
    const tag = field(sealed.tag, "tag", TAG_BYTES);
    const ciphertext = field(sealed.ciphertext, "ciphertext");
    const aad = Buffer.from(sourceId, "utf8");

    let dataKey: Buffer | undefined;
    try {
      dataKey = decrypt(
        masterKey,
        wrapped.subarray(0, IV_BYTES),
        wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
        wrapped.subarray(IV_BYTES + TAG_BYTES),
        aad
      );
      return JSON.parse(
        decrypt(dataKey, iv, tag, ciphertext, aad).toString("utf8")
      ) as unknown;
    } catch {
      // The cause is dropped: it can only say that a tag did not verify.
      throw new SettingsUnreadableError(
        "sealed settings: authentication failed (tampered, or sealed for another source)"
      );
    } finally {
      dataKey?.fill(0);
    }
  };

  return { kid, sealSettings, openSettings };
}

let defaultEnvelope: ReturnType<typeof createEnvelope> | undefined;

function defaultOne() {
  if (!defaultEnvelope) {
    if (!env.ZETEO_MASTER_KEY) {
      throw new Error("ZETEO_MASTER_KEY is not set");
    }
    defaultEnvelope = createEnvelope(
      Buffer.from(env.ZETEO_MASTER_KEY, "base64url")
    );
  }
  return defaultEnvelope;
}

export const sealSettings = (
  plain: unknown,
  sourceId: string
): SealedSettings => defaultOne().sealSettings(plain, sourceId);

export const openSettings = (
  sealed: SealedSettings,
  sourceId: string
): unknown => defaultOne().openSettings(sealed, sourceId);
