import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "@/lib/auth";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuth({
    permissions: ["zeteo.sources.write"],
    me: { name: "Grace Hopper" },
  })
);

const Probe = () => {
  const { me, can, signOut } = useAuth();
  return (
    <div>
      <p>{me.name}</p>
      <p>sources.read: {String(can("zeteo.sources.read"))}</p>
      <p>grants.read: {String(can("zeteo.grants.read"))}</p>
      <button onClick={signOut}>out</button>
    </div>
  );
};

describe("mockAuth", () => {
  it("signs feature tests in with the given person and permissions", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.getByText("sources.read: true")).toBeInTheDocument();
    expect(screen.getByText("grants.read: false")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "out" }));
    expect(useAuth().signOut).toHaveBeenCalledTimes(1);
  });
});
