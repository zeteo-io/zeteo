import { GOOGLE_CONNECTION, ROBOT_EMAIL } from "../testFixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSheetStaging, SHEET_ID } from "../testFixtures";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { SheetLinkStep } from "./SheetLinkStep";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.uploads.write"],
    api: { get, post },
  })
);

const LINK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

describe("SheetLinkStep", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ data: GOOGLE_CONNECTION });
    post.mockReset().mockResolvedValue({ data: makeSheetStaging() });
  });

  it("shows sheet_in_use inline on the link field", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 409,
      code: "sheet_in_use",
      message: "That sheet is already a source.",
    });
    renderWithProviders(<SheetLinkStep onStaged={vi.fn()} />);
    await screen.findByText(ROBOT_EMAIL);
    await user.type(screen.getByLabelText(/Link to the Google Sheet/), LINK);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(
      await screen.findByText("That sheet is already a source.")
    ).toBeInTheDocument();
  });

  it("posts the link and hands the staging on", async () => {
    const user = userEvent.setup();
    const onStaged = vi.fn();
    renderWithProviders(<SheetLinkStep onStaged={onStaged} />);
    await screen.findByText(ROBOT_EMAIL);
    await user.type(screen.getByLabelText(/Link to the Google Sheet/), LINK);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(onStaged).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/v1/uploads/links", { url: LINK });
    expect(onStaged.mock.calls[0][0].spreadsheet.title).toBe("Budget 2027");
  });

  it("says an admin must set up Google first, with no input, on google_not_configured", async () => {
    get.mockRejectedValue({
      status: 404,
      code: "google_not_configured",
      message: "x",
    });
    renderWithProviders(<SheetLinkStep onStaged={vi.fn()} />);
    expect(
      await screen.findByText("An admin needs to set up Google Sheets first")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Link to the Google Sheet/)).toBeNull();
  });
});
