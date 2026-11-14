import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserMenu } from "./UserMenu";

vi.mock("@/lib/auth", async () =>
  (await import("@/test/authMock")).mockAuth({
    permissions: ["admin"],
    me: { name: "Ada Lovelace", email: "ada@x.test" },
  })
);

describe("UserMenu", () => {
  it("shows the person's name as the button's label", () => {
    render(<UserMenu />);
    expect(
      screen.getByRole("button", { name: "Ada Lovelace" })
    ).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to its button", async () => {
    const user = userEvent.setup();
    render(<UserMenu />);
    const button = screen.getByRole("button", { name: "Ada Lovelace" });
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
  });
});
