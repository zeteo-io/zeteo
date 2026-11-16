import { rememberReturnPath, takeReturnPath } from "./returnPath";
import { afterEach, describe, expect, it } from "vitest";

const KEY = "zeteo-ui:return-path";
// Same origin, so the address bar can hold any path.
const visit = (path: string) =>
  window.history.replaceState(null, "", `${window.location.origin}${path}`);

describe("return path", () => {
  afterEach(() => {
    sessionStorage.clear();
    visit("/");
  });

  it("returns to the page with its query and hash, once", () => {
    visit("/grants?source_id=x#top");
    rememberReturnPath();
    expect(takeReturnPath()).toBe("/grants?source_id=x#top");
    expect(takeReturnPath()).toBeUndefined();
  });

  it.each(["//evil.com", "/\\evil.com"])(
    "remembers no return to %s, which a browser reads as another site",
    (path) => {
      visit(path);
      rememberReturnPath();
      expect(takeReturnPath()).toBeUndefined();
    }
  );

  it.each(["//evil.com/x", "/\\evil.com", "https://evil.com", "grants", ""])(
    "takes no stored %j that is not a path on this site",
    (stored) => {
      sessionStorage.setItem(KEY, stored);
      expect(takeReturnPath()).toBeUndefined();
      expect(sessionStorage.getItem(KEY)).toBeNull();
    }
  );
});
