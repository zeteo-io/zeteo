import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

export type CardTheme = "light" | "dark";
export type CardKind = "panel" | "dashboard";

/** A tool's result as the card reads it: its value, or its error's words. */
export type ToolOutcome =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** What the card says when the host cancels the tool call it was opened for. */
export const CANCELLED = "The call was cancelled.";

/** A tool call that failed; its message is what the viewer is shown. */
export class CardToolError extends Error {}

/**
 * What the card needs from the MCP Apps host, so tests can stand in for it.
 * Each `on…` returns a function that unsubscribes; one subscribed after the
 * host has sent its input or result is called with it at once.
 */
export interface CardHost {
  kind: CardKind;
  onToolInput(cb: (args: Record<string, unknown>) => void): () => void;
  onToolResult(cb: (outcome: ToolOutcome) => void): () => void;
  /** A tool's value; throws a `CardToolError` with the tool's error description. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  openLink(url: string): void;
  theme(): CardTheme;
  onThemeChange(cb: (theme: CardTheme) => void): () => void;
  reportSize(height: number): void;
}

/** Which card the page draws, from the `<meta name="zeteo-card">` zeteo sets when serving it. */
export const readKind = (doc: Document): CardKind | null => {
  const content = doc
    .querySelector<HTMLMetaElement>('meta[name="zeteo-card"]')
    ?.content.trim();
  return content === "panel" || content === "dashboard" ? content : null;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface ToolResultLike {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * A tool result's value: its structured content, else its text read as JSON.
 * An error's words are zeteo's `error_description` when the text is zeteo's
 * error body, else the text itself (a rate limit or timeout from the MCP layer).
 */
export const readToolResult = (result: ToolResultLike): ToolOutcome => {
  const text = result.content?.find((c) => c.type === "text")?.text;
  let parsed: unknown = undefined;
  if (text !== undefined) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (result.isError) {
    const described =
      isObject(parsed) && typeof parsed.error_description === "string"
        ? parsed.error_description
        : undefined;
    return {
      ok: false,
      error: described ?? (text?.trim() || "The tool call failed."),
    };
  }
  const value = result.structuredContent ?? parsed;
  return { ok: true, value: isObject(value) ? value : {} };
};

/** Listeners of one event, replaying its last value to a late subscriber when `replay` is set. */
const channel = <T>(replay: boolean) => {
  const listeners = new Set<(value: T) => void>();
  let last: { value: T } | null = null;
  return {
    emit(value: T) {
      if (replay) last = { value };
      listeners.forEach((cb) => cb(value));
    },
    on(cb: (value: T) => void) {
      listeners.add(cb);
      if (last) cb(last.value);
      return () => {
        listeners.delete(cb);
      };
    },
  };
};

const themeOf = (value: unknown): CardTheme | null =>
  value === "dark" || value === "light" ? value : null;

/**
 * Connects to the host (`ui/initialize`) and wraps it as a `CardHost`. The
 * handlers are set before connecting, so no notification is missed; the card
 * reports its own height (`autoResize` off).
 */
export const connectHost = async (kind: CardKind): Promise<CardHost> => {
  const app = new App(
    { name: "zeteo-card", version: "1.0.0" },
    {},
    { autoResize: false }
  );
  const inputs = channel<Record<string, unknown>>(true);
  const results = channel<ToolOutcome>(true);
  const themes = channel<CardTheme>(false);
  let theme: CardTheme = "light";

  app.addEventListener("toolinput", (params) =>
    inputs.emit(params.arguments ?? {})
  );
  // A cancellation that arrives once the result is in changes nothing.
  let answered = false;
  app.addEventListener("toolresult", (params) => {
    answered = true;
    results.emit(readToolResult(params));
  });
  app.addEventListener("toolcancelled", () => {
    if (!answered) results.emit({ ok: false, error: CANCELLED });
  });
  app.addEventListener("hostcontextchanged", (params) => {
    const next = themeOf(params.theme);
    if (next && next !== theme) {
      theme = next;
      themes.emit(next);
    }
  });

  await app.connect(new PostMessageTransport(window.parent, window.parent));
  theme = themeOf(app.getHostContext()?.theme) ?? theme;

  return {
    kind,
    onToolInput: inputs.on,
    onToolResult: results.on,
    callTool: async (name, args) => {
      let outcome: ToolOutcome;
      try {
        outcome = readToolResult(
          await app.callServerTool({ name, arguments: args })
        );
      } catch {
        throw new CardToolError("Zeteo could not be reached. Try again later.");
      }
      if (!outcome.ok) throw new CardToolError(outcome.error);
      return outcome.value;
    },
    openLink: (url) => {
      void app.openLink({ url }).catch(() => undefined);
    },
    theme: () => theme,
    onThemeChange: themes.on,
    reportSize: (height) => {
      void app.sendSizeChanged({ height }).catch(() => undefined);
    },
  };
};
