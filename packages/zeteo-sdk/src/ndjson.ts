import { StringDecoder } from "node:string_decoder";

export const MAX_LINE_BYTES = 32 * 1024 * 1024;

const tooLong = () =>
  new Error(
    `@zeteo-io/sdk: an export line is longer than ${MAX_LINE_BYTES} bytes`
  );

/** One parsed JSON value per `\n`-terminated line; a final fragment without one is dropped. */
export async function* lines(
  source: AsyncIterable<Buffer | string>
): AsyncGenerator<unknown> {
  // Holds back a character split across chunks until its last byte arrives.
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let pendingBytes = 0;
  for await (const chunk of source) {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      const piece = text.slice(start, newline);
      if (pendingBytes + Buffer.byteLength(piece) > MAX_LINE_BYTES) {
        throw tooLong();
      }
      const line = pending + piece;
      pending = "";
      pendingBytes = 0;
      start = newline + 1;
      yield JSON.parse(line);
    }
    const rest = text.slice(start);
    pending += rest;
    pendingBytes += Buffer.byteLength(rest);
    if (pendingBytes > MAX_LINE_BYTES) throw tooLong();
  }
}
