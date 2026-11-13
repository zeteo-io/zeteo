import { StringDecoder } from "node:string_decoder";

export const MAX_LINE_BYTES = 32 * 1024 * 1024;

export class LineTooLongError extends Error {
  constructor(maxLineBytes: number) {
    super(`@zeteo-io/sdk: an export line is longer than ${maxLineBytes} bytes`);
    this.name = "LineTooLongError";
  }
}

/** One parsed JSON value per `\n`-terminated line; a final fragment without one is dropped. */
export async function* lines(
  source: AsyncIterable<Buffer | string>,
  maxLineBytes = MAX_LINE_BYTES
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
      if (pendingBytes + Buffer.byteLength(piece) > maxLineBytes) {
        throw new LineTooLongError(maxLineBytes);
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
    if (pendingBytes > maxLineBytes) throw new LineTooLongError(maxLineBytes);
  }
}
