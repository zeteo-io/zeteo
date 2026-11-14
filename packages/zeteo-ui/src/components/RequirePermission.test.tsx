import { render, screen } from "@testing-library/react";
import { RequirePermission } from "./RequirePermission";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuth({
    permissions: ["zeteo.grants.write"],
  })
);

describe("RequirePermission", () => {
  it("renders children when the permission is held (write covers read)", () => {
    render(
      <RequirePermission permission="zeteo.grants.read">
        inside
      </RequirePermission>
    );
    expect(screen.getByText("inside")).toBeInTheDocument();
  });

  it("renders the no-access page otherwise", () => {
    render(
      <RequirePermission permission="zeteo.sources.read">
        inside
      </RequirePermission>
    );
    expect(screen.queryByText("inside")).not.toBeInTheDocument();
    expect(screen.getByText("No access")).toBeInTheDocument();
  });
});
