import type { CardHost, CardTheme, ToolOutcome } from "@/mcp-card/host";
import { CardToolError } from "@/mcp-card/host";
import { vi } from "vitest";

type ToolAnswer = (args: Record<string, unknown>) => unknown;

/**
 * A stand-in for the MCP Apps host: the test sends the tool's input and
 * result, switches the theme, and answers the card's tool calls. An answer
 * that is a `CardToolError` (or throws one) is the tool's error.
 */
export const fakeCardHost = (
  kind: CardHost["kind"],
  tools: Record<string, ToolAnswer> = {}
) => {
  const inputs: ((args: Record<string, unknown>) => void)[] = [];
  const results: ((outcome: ToolOutcome) => void)[] = [];
  const themes: ((theme: CardTheme) => void)[] = [];
  let current: CardTheme = "light";

  const host: CardHost = {
    kind,
    onToolInput: (cb) => {
      inputs.push(cb);
      return () => inputs.splice(inputs.indexOf(cb), 1);
    },
    onToolResult: (cb) => {
      results.push(cb);
      return () => results.splice(results.indexOf(cb), 1);
    },
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      const answer = tools[name];
      if (!answer) throw new CardToolError(`No tool ${name}`);
      const value = await answer(args);
      if (value instanceof CardToolError) throw value;
      return value;
    }),
    openLink: vi.fn(),
    theme: () => current,
    onThemeChange: (cb) => {
      themes.push(cb);
      return () => themes.splice(themes.indexOf(cb), 1);
    },
    reportSize: vi.fn(),
  };

  return {
    host,
    sendInput: (args: Record<string, unknown>) =>
      inputs.forEach((cb) => cb(args)),
    sendResult: (outcome: ToolOutcome) => results.forEach((cb) => cb(outcome)),
    setTheme: (theme: CardTheme) => {
      current = theme;
      themes.forEach((cb) => cb(theme));
    },
    /** The arguments of each call to `name`, in order. */
    callsTo: (name: string) =>
      vi
        .mocked(host.callTool)
        .mock.calls.filter(([n]) => n === name)
        .map(([, args]) => args),
  };
};
