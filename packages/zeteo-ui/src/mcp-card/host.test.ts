import { CANCELLED, connectHost, type ToolOutcome } from "./host";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (params: Record<string, unknown>) => void;

// The ext-apps App, as far as connectHost uses it: listeners by event name,
// a handshake whose host context says light, and the outbound calls.
const fakeApp = vi.hoisted(() => ({
  listeners: {} as Record<string, Listener[]>,
  emit(event: string, params: Record<string, unknown>) {
    (this.listeners[event] ?? []).forEach((cb) => cb(params));
  },
}));
vi.mock("@modelcontextprotocol/ext-apps", () => ({
  PostMessageTransport: class {},
  App: class {
    addEventListener(event: string, cb: Listener) {
      (fakeApp.listeners[event] ??= []).push(cb);
    }
    connect = vi.fn(async () => undefined);
    getHostContext = () => ({ theme: "light" });
    callServerTool = vi.fn();
    openLink = vi.fn(async () => ({}));
    sendSizeChanged = vi.fn(async () => undefined);
  },
}));

describe("connectHost", () => {
  // Each test's connectHost adds its own listeners; drop the last test's.
  beforeEach(() => {
    fakeApp.listeners = {};
  });

  it("passes the tool's input and result on, replaying them to a late listener", async () => {
    const host = await connectHost("panel");
    fakeApp.emit("toolinput", { arguments: { id: "p1" } });
    fakeApp.emit("toolresult", {
      content: [{ type: "text", text: '{"id":"p1"}' }],
    });
    const inputs: unknown[] = [];
    const outcomes: ToolOutcome[] = [];
    host.onToolInput((args) => inputs.push(args));
    host.onToolResult((o) => outcomes.push(o));
    expect(inputs).toEqual([{ id: "p1" }]);
    expect(outcomes).toEqual([{ ok: true, value: { id: "p1" } }]);
  });

  it("ends a cancelled call with a message, not a spinner", async () => {
    const host = await connectHost("dashboard");
    const outcomes: ToolOutcome[] = [];
    host.onToolResult((o) => outcomes.push(o));
    fakeApp.emit("toolcancelled", { reason: "user action" });
    expect(outcomes.at(-1)).toEqual({ ok: false, error: CANCELLED });
  });

  it("ignores a cancellation that arrives after the result", async () => {
    const host = await connectHost("panel");
    const outcomes: ToolOutcome[] = [];
    host.onToolResult((o) => outcomes.push(o));
    fakeApp.emit("toolresult", {
      content: [{ type: "text", text: '{"id":"p1"}' }],
    });
    fakeApp.emit("toolcancelled", { reason: "late" });
    expect(outcomes).toEqual([{ ok: true, value: { id: "p1" } }]);
  });

  it("follows the host's theme as its context changes", async () => {
    const host = await connectHost("panel");
    expect(host.theme()).toBe("light");
    const themes: string[] = [];
    host.onThemeChange((t) => themes.push(t));
    fakeApp.emit("hostcontextchanged", { theme: "dark" });
    expect(host.theme()).toBe("dark");
    expect(themes).toEqual(["dark"]);
  });
});
