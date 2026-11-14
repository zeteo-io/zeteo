// @module-tag unit
// @module-tag platform
// @module-tag security
import { cspDirectives } from "../../ui/csp.js";
import { describe, expect, it } from "vitest";

const BASE = {
  default: ["'self'"],
  fixed: {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "font-src": ["'self'"],
    "form-action": ["'self'"],
    "base-uri": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
  },
};

describe("cspDirectives", () => {
  it("lets the UI reach the origin of UI_TEREO_URL, and upgrades requests on an https PUBLIC_URL", () => {
    expect(
      cspDirectives({
        UI_CLIENT_ID: "zeteo-ui",
        UI_TEREO_URL: "https://core.example.com/",
        PUBLIC_URL: "https://zeteo.example.com",
      })
    ).toEqual({
      ...BASE.fixed,
      "connect-src": ["'self'", "https://core.example.com"],
      "upgrade-insecure-requests": [],
    });
  });

  it("names no Tereo origin when the UI is not configured", () => {
    expect(
      cspDirectives({
        UI_CLIENT_ID: undefined,
        UI_TEREO_URL: "https://core.example.com",
        PUBLIC_URL: "https://zeteo.example.com",
      })
    ).toEqual({
      ...BASE.fixed,
      "connect-src": ["'self'"],
      "upgrade-insecure-requests": [],
    });
  });

  it("leaves out the upgrade directive on an http PUBLIC_URL", () => {
    expect(
      cspDirectives({
        UI_CLIENT_ID: "zeteo-ui",
        UI_TEREO_URL: "http://localhost:4001",
        PUBLIC_URL: "http://localhost:4201",
      })
    ).toEqual({
      ...BASE.fixed,
      "connect-src": ["'self'", "http://localhost:4001"],
    });
  });
});
