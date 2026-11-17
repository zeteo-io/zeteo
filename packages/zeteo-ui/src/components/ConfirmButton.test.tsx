import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmButton } from "./ConfirmButton";

const setup = (onConfirm: () => Promise<void> | void) => {
  render(
    <ConfirmButton
      label="Delete"
      confirmTitle="Delete source"
      confirmText="This cannot be undone."
      confirmLabel="Yes, delete"
      onConfirm={onConfirm}
      danger
    />
  );
};

describe("ConfirmButton", () => {
  it("asks first and calls onConfirm only once confirmed", async () => {
    const onConfirm = vi.fn();
    setup(onConfirm);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByText("This cannot be undone.")
      ).not.toBeInTheDocument()
    );
  });

  it("does nothing when cancelled", async () => {
    const onConfirm = vi.fn();
    setup(onConfirm);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("stays open and busy until a promise settles", async () => {
    let finish!: () => void;
    setup(() => new Promise<void>((r) => (finish = r)));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    finish();
    await waitFor(() =>
      expect(
        screen.queryByText("This cannot be undone.")
      ).not.toBeInTheDocument()
    );
  });

  describe("when onConfirm rejects", () => {
    const unhandled = vi.fn();
    beforeEach(() => process.on("unhandledRejection", unhandled));
    afterEach(() => process.off("unhandledRejection", unhandled));

    it("stays open, shows the failure and lets the person try again", async () => {
      const onConfirm = vi
        .fn()
        .mockRejectedValueOnce({
          status: 409,
          code: "conflict",
          message: "Still in use",
        })
        .mockResolvedValueOnce(undefined);
      setup(onConfirm);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await user.click(screen.getByRole("button", { name: "Yes, delete" }));

      expect(await screen.findByText("Still in use")).toBeInTheDocument();
      expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
      const again = screen.getByRole("button", { name: "Yes, delete" });
      expect(again).toBeEnabled();

      await user.click(again);
      await waitFor(() =>
        expect(
          screen.queryByText("This cannot be undone.")
        ).not.toBeInTheDocument()
      );
      expect(onConfirm).toHaveBeenCalledTimes(2);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
    });
  });
});
