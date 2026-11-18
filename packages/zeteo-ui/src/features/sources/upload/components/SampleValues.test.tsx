import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SampleValues } from "./SampleValues";

describe("SampleValues", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the samples without a button when they fit", () => {
    render(<SampleValues samples={["a", "b"]} />);
    expect(screen.getByText("a, b")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  describe("when they run past two lines", () => {
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
        120
      );
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
        40
      );
    });

    it("cuts them to two lines, and shows all and fewer on request", async () => {
      render(<SampleValues samples={["a", "b"]} />);
      const text = screen.getByText("a, b");
      expect(text).toHaveClass("z-fs-samples-clamped");

      await userEvent.click(screen.getByRole("button", { name: "Show all" }));
      expect(text).not.toHaveClass("z-fs-samples-clamped");

      await userEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(text).toHaveClass("z-fs-samples-clamped");
    });
  });
});
