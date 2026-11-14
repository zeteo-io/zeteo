const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const randomBase64url = (byteLength: number): string =>
  base64url(crypto.getRandomValues(new Uint8Array(byteLength)));

/** 32 random bytes: a 43-character verifier, the shortest RFC 7636 allows. */
export const createVerifier = (): string => randomBase64url(32);

/** For `state` and `nonce`. */
export const randomToken = (): string => randomBase64url(24);

export const challengeFor = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
};
