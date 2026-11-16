import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SignedOut } from "./SignedOut";
import { Callback } from "./Callback";

const complete = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () => ({
  ...(await (await import("@/test/authMock")).mockTereo()),
  useCompleteSignIn: () => ({ complete, error: null, isPending: true }),
}));

const Where = () => {
  const { pathname, search } = useLocation();
  return <p>at {`${pathname}${search}`}</p>;
};

const renderCallback = () =>
  render(
    <MemoryRouter initialEntries={["/callback?code=c&state=s"]}>
      <Routes>
        <Route path="/callback" element={<Callback />} />
        <Route path="/signed-out" element={<SignedOut />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );

describe("Callback", () => {
  beforeEach(() => {
    complete.mockReset();
    window.history.replaceState(null, "", "/callback?code=c&state=s");
  });

  it("lands on the page sign-in started from", async () => {
    complete.mockResolvedValue({ returnTo: "/grants?source_id=x" });
    renderCallback();

    expect(screen.getByText("Signing you in…")).toBeInTheDocument();
    expect(
      await screen.findByText("at /grants?source_id=x")
    ).toBeInTheDocument();
    expect(complete).toHaveBeenCalledWith(
      new URLSearchParams("code=c&state=s")
    );
  });

  it("lands on / when no page was asked for", async () => {
    complete.mockResolvedValue({ returnTo: null });
    renderCallback();
    expect(await screen.findByText("at /")).toBeInTheDocument();
  });

  it("explains a failed sign-in on /signed-out, with a way to sign in again", async () => {
    complete.mockRejectedValue(new Error("access_denied"));
    renderCallback();

    expect(
      await screen.findByText("Sign-in was cancelled or refused.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
