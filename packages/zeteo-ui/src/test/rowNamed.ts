import { screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * The table row whose text holds `name` (a string or pattern), once it is
 * there. A Who filter's options name people too, so the text alone is not
 * enough to find the row.
 */
export const rowNamed = async (name: string | RegExp) => {
  let row: HTMLElement | null = null;
  await waitFor(() => {
    row =
      screen
        .getAllByText(name)
        .map((e) => e.closest("tr"))
        .find((tr) => tr !== null) ?? null;
    expect(row).not.toBeNull();
  });
  return row!;
};
