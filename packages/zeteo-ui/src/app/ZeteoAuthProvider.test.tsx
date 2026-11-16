import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ZeteoAuthProvider } from "./ZeteoAuthProvider";
import type { TereoAuthConfig } from "@tereo-io/react";
import { TEST_UI_CONFIG } from "@/test/uiConfig";
import type { AxiosInstance } from "axios";
import type { ReactNode } from "react";

const mounted = vi.hoisted(() => ({ configs: [] as unknown[] }));
vi.mock("@tereo-io/react", async () => ({
  ...(await vi.importActual<typeof import("@tereo-io/react")>(
    "@tereo-io/react"
  )),
  TereoAuthProvider: ({
    config,
    children,
  }: {
    config: unknown;
    children: ReactNode;
  }) => {
    mounted.configs.push(config);
    return children;
  },
}));
const loadConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", async () => ({
  ...(await vi.importActual<typeof import("@/lib/config")>("@/lib/config")),
  loadConfig,
}));

const config = () => mounted.configs.at(-1) as TereoAuthConfig;

describe("ZeteoAuthProvider", () => {
  beforeEach(() => {
    mounted.configs.length = 0;
    loadConfig.mockReset().mockResolvedValue(TEST_UI_CONFIG);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mounts Tereo's sign-in with /ui-config.json's values", async () => {
    render(<ZeteoAuthProvider>inside</ZeteoAuthProvider>);

    expect(await screen.findByText("inside")).toBeInTheDocument();
    expect(config()).toMatchObject({
      coreUrl: "https://tereo.test",
      clientId: "zeteo-ui",
      redirectUri: `${window.location.origin}/callback`,
      apis: { zeteo: "" },
      live: true,
      signedOutPath: "/signed-out",
    });
  });

  it("loads the user from zeteo's GET /v1/me", async () => {
    render(<ZeteoAuthProvider>inside</ZeteoAuthProvider>);
    await screen.findByText("inside");
    const me = {
      id: "u-1",
      type: "user",
      name: "Ada",
      email: null,
      permissions: ["zeteo.runs.read"],
    };
    const get = vi.fn(async () => ({ data: me }));

    await expect(
      config().loadUser({ zeteo: { get } as unknown as AxiosInstance })
    ).resolves.toEqual(me);
    expect(get).toHaveBeenCalledWith("/v1/me");

    get.mockResolvedValueOnce({ data: { id: "u-1" } as typeof me });
    await expect(
      config().loadUser({ zeteo: { get } as unknown as AxiosInstance })
    ).rejects.toThrow("unexpected body");
  });

  it("shows the startup error when /ui-config.json fails, without mounting sign-in", async () => {
    const { ConfigError } = await import("@/lib/config");
    loadConfig.mockRejectedValue(
      new ConfigError("/ui-config.json answered 404")
    );
    render(<ZeteoAuthProvider>inside</ZeteoAuthProvider>);

    expect(
      await screen.findByText("zeteo's admin UI is not available")
    ).toBeInTheDocument();
    expect(
      screen.getByText("/ui-config.json answered 404")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(mounted.configs).toEqual([]);
  });

  it("says sign-in needs a secure context on plain http", () => {
    vi.stubGlobal("isSecureContext", false);
    render(<ZeteoAuthProvider>inside</ZeteoAuthProvider>);

    expect(screen.getByText("Sign-in cannot start")).toBeInTheDocument();
    expect(
      screen.getByText(/needs https \(or localhost\)/)
    ).toBeInTheDocument();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(mounted.configs).toEqual([]);
  });
});
