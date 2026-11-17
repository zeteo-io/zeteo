import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { type AxiosAdapter, type AxiosResponse } from "axios";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { queryClient } from "./provider";
import { App } from "@/app";

// The real @tereo-io/react runs here: only zeteo's and Tereo's answers (an
// axios adapter) and core's socket are replaced.
vi.mock("@/lib/config", async () =>
  (await import("@/test/uiConfig")).mockConfig()
);
const socket = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>();
  return {
    listeners,
    active: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: (event: string, fn: (payload: unknown) => void) => {
      listeners.set(event, fn);
    },
  };
});
vi.mock("socket.io-client", () => ({ io: () => socket }));

const TOKENS_KEY = "tereo_zeteo-ui_tokens";
const RETURN_KEY = "zeteo-ui:return-path";
const PACKAGE_RETURN_KEY = "tereo_zeteo-ui_post_login_path";
const SIGNED_IN_KEY = "tereo_zeteo-ui_signed_in";
const SOURCE_ID = "6f1f8a8e-2b7c-4d3e-9a51-0c9d7e6b5a41";

const base64url = (value: object) =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jwt = (claims: object) =>
  `${base64url({ alg: "none" })}.${base64url(claims)}.sig`;

const storeSession = () =>
  localStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      access_token: jwt({ sub: "u-1", sid: "s-1" }),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid",
      expiresAt: Date.now() + 3_600_000,
    })
  );

let permissions: string[];
let meStatus: number;
let tokenStatus: number;
const requests: { url: string; auth: unknown }[] = [];

const answer: AxiosAdapter = async (config) => {
  const url = config.url ?? "";
  requests.push({ url, auth: config.headers?.Authorization });
  const respond = (status: number, data: unknown): AxiosResponse => ({
    status,
    statusText: String(status),
    data,
    headers: {},
    config,
  });
  if (url.endsWith("/oauth/token")) {
    const res = respond(tokenStatus, { error: "server_error" });
    throw new axios.AxiosError("refused", "ERR_BAD_RESPONSE", config, {}, res);
  }
  if (url === "/v1/me") {
    const res =
      meStatus === 200
        ? respond(200, {
            id: "u-1",
            type: "user",
            name: "Ada Lovelace",
            email: "ada@x.test",
            permissions,
          })
        : respond(meStatus, {
            error: "forbidden",
            error_description: "zeteo refused this account",
          });
    if (res.status >= 400) {
      throw new axios.AxiosError("refused", "ERR_BAD_REQUEST", config, {}, res);
    }
    return res;
  }
  // Lists answer empty; nothing else is asked for here.
  return respond(200, { data: [], next_cursor: null });
};

// jsdom cannot leave the page: it reports each navigation as an error on its
// virtual console, which these tests take over to count them.
type JsdomError = { type: string; message: string };
const virtualConsole = (
  globalThis as unknown as {
    jsdom: {
      virtualConsole: {
        on: (event: "jsdomError", fn: (e: JsdomError) => void) => void;
        listeners: (event: "jsdomError") => ((e: JsdomError) => void)[];
        removeAllListeners: (event: "jsdomError") => void;
      };
    };
  }
).jsdom.virtualConsole;
const navigations: string[] = [];
const signedOutRedirects = () => navigations;

describe("the session, with the real @tereo-io/react", () => {
  const originalAdapter = axios.defaults.adapter;
  let jsdomListeners: ((e: JsdomError) => void)[] = [];

  beforeEach(() => {
    permissions = ["zeteo.grants.read", "zeteo.runs.read"];
    meStatus = 200;
    tokenStatus = 503;
    requests.length = 0;
    socket.listeners.clear();
    axios.defaults.adapter = answer;
    navigations.length = 0;
    jsdomListeners = virtualConsole.listeners("jsdomError");
    virtualConsole.removeAllListeners("jsdomError");
    virtualConsole.on("jsdomError", (e) => {
      if (e.message.includes("navigation")) navigations.push(e.message);
      else jsdomListeners.forEach((fn) => fn(e));
    });
  });

  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
    queryClient.clear();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    virtualConsole.removeAllListeners("jsdomError");
    jsdomListeners.forEach((fn) => virtualConsole.on("jsdomError", fn));
  });

  it("restores the session on a reload of a deep link, keeping the address", async () => {
    storeSession();
    window.history.replaceState(null, "", `/grants?source_id=${SOURCE_ID}`);
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Grants" })
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/grants");
    expect(window.location.search).toBe(`?source_id=${SOURCE_ID}`);
    expect(requests.find((r) => r.url === "/v1/me")?.auth).toMatch(/^Bearer /);
    expect(signedOutRedirects()).toEqual([]);
  });

  it("sends a visitor with no session to /signed-out, and signs in back to the page asked for", async () => {
    window.history.replaceState(null, "", `/grants?source_id=${SOURCE_ID}`);
    const { unmount } = render(<App />);

    // The provider leaves for /signed-out; the page asked for is kept.
    await vi.waitFor(() => expect(signedOutRedirects()).toHaveLength(1));
    expect(sessionStorage.getItem(RETURN_KEY)).toBe(
      `/grants?source_id=${SOURCE_ID}`
    );
    unmount();

    // The browser lands on /signed-out; its Sign in starts the sign-in with that path.
    window.history.replaceState(null, "", "/signed-out");
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Sign in" })
    );
    await vi.waitFor(() => expect(signedOutRedirects()).toHaveLength(2));
    expect(sessionStorage.getItem(RETURN_KEY)).toBeNull();
    expect(sessionStorage.getItem(PACKAGE_RETURN_KEY)).toBe(
      `/grants?source_id=${SOURCE_ID}`
    );
    expect(sessionStorage.getItem("tereo_zeteo-ui_pkce")).not.toBeNull();
  });

  it("shows the no-access page to someone with no zeteo permission", async () => {
    permissions = [];
    storeSession();
    window.history.replaceState(null, "", "/grants");
    render(<App />);

    expect(await screen.findByText("No access")).toBeInTheDocument();
    expect(screen.getByText(/Signed in as Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it("says why when zeteo refuses the account", async () => {
    meStatus = 403;
    storeSession();
    render(<App />);

    expect(
      await screen.findByText("Your account could not be loaded")
    ).toBeInTheDocument();
    expect(screen.getByText("zeteo refused this account")).toBeInTheDocument();
  });

  it("blames the session, not zeteo, when a session cannot be renewed; Try again reloads the page", async () => {
    localStorage.setItem(SIGNED_IN_KEY, JSON.stringify("1"));
    render(<App />);

    expect(
      await screen.findByText("Your session could not be restored")
    ).toBeInTheDocument();
    expect(screen.queryByText(/GET \/v1\/me/)).not.toBeInTheDocument();
    expect(requests.some((r) => r.url === "/v1/me")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(navigations).toHaveLength(1));
  });

  it("hides a section when Tereo says the permissions changed", async () => {
    storeSession();
    window.history.replaceState(null, "", "/runs");
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    await userEvent.click(within(nav).getByRole("button", { name: "Admin" }));
    expect(within(nav).getByRole("link", { name: "Grants" })).toBeVisible();

    permissions = ["zeteo.runs.read"];
    act(() =>
      socket.listeners.get("auth:permissions:changed")?.({
        reason: "role_removed",
        timestamp: Date.now(),
      })
    );

    await vi.waitFor(() =>
      expect(
        within(nav).queryByRole("link", { name: "Grants" })
      ).not.toBeInTheDocument()
    );
    expect(window.location.pathname).toBe("/runs");
  });
});
