/**
 * Reads an NDJSON body line by line, calling `onLine` with each parsed line
 * as soon as its newline arrives (a line may be split across chunks).
 */
export const readLines = async (
  body: ReadableStream<Uint8Array>,
  onLine: (line: unknown) => void
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (text: string) => {
    const trimmed = text.trim();
    if (trimmed !== "") onLine(JSON.parse(trimmed));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      flush(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      end = buffer.indexOf("\n");
    }
  }
  flush(buffer + decoder.decode());
};

/** The body of a failed streamed request, read back to JSON so its error can be told. */
export const readErrorBody = async (body: unknown): Promise<unknown> => {
  if (!(body instanceof ReadableStream)) return body;
  try {
    return JSON.parse(await new Response(body).text());
  } catch {
    return undefined;
  }
};
