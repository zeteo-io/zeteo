import type { UiConfig } from "@/lib/config";
import { vi } from "vitest";

export const TEST_UI_CONFIG: UiConfig = {
  tereoUrl: "https://tereo.test",
  clientId: "zeteo-ui",
};

/** A stand-in for `@/lib/config` whose `/ui-config.json` answers at once. */
export const mockConfig = async () => ({
  ...(await vi.importActual<typeof import("@/lib/config")>("@/lib/config")),
  loadConfig: async () => TEST_UI_CONFIG,
});
