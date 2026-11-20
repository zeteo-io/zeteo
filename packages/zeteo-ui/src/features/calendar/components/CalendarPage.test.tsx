import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { CalendarPage } from "./CalendarPage";

const get = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
const permissions = vi.hoisted(() => ({
  held: ["zeteo.data.read", "zeteo.calendar.write"],
}));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => permissions.held,
    api: { get, put },
  })
);

const year = new Date().getFullYear();
const calendar = {
  working_days: [1, 2, 3, 4, 5],
  holidays: [{ date: `${year}-12-25`, name: "Christmas" }],
  fiscal_year_start_month: 1,
  time_zone: "UTC",
  updated_at: null,
};

describe("CalendarPage", () => {
  beforeEach(() => {
    permissions.held = ["zeteo.data.read", "zeteo.calendar.write"];
    put.mockReset().mockImplementation(async (_url, body) => ({ data: body }));
    get.mockReset().mockResolvedValue({ data: calendar });
  });

  it("notes a year with no holidays", async () => {
    renderWithProviders(<CalendarPage />);
    expect(await screen.findByText("Christmas")).toBeInTheDocument();
    expect(
      screen.getByText(`No holidays entered for ${year + 1}`)
    ).toBeInTheDocument();
  });

  it("puts the whole calendar, with pasted holidays and a toggled day", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CalendarPage />);
    await screen.findByText("Christmas");
    await user.click(screen.getByLabelText("Saturday"));
    await user.click(screen.getByRole("button", { name: "Add holidays" }));
    await user.click(screen.getByRole("button", { name: "Paste a list" }));
    await user.click(screen.getByLabelText("Holidays, one per line"));
    await user.paste(
      `${year + 1}-01-01,New Year\n${year + 1}-07-04, Independence Day`
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save calendar" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith("/v1/calendar", {
      working_days: [1, 2, 3, 4, 5, 6],
      holidays: [
        { date: `${year}-12-25`, name: "Christmas" },
        { date: `${year + 1}-01-01`, name: "New Year" },
        { date: `${year + 1}-07-04`, name: "Independence Day" },
      ],
      fiscal_year_start_month: 1,
      time_zone: "UTC",
    });
    expect(
      screen.queryByText(`No holidays entered for ${year + 1}`)
    ).toBeNull();
  });

  it("adds holidays row by row, refusing a half-filled row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CalendarPage />);
    await screen.findByText("Christmas");
    await user.click(screen.getByRole("button", { name: "Add holidays" }));
    await user.type(screen.getByLabelText("Date 1"), `${year + 1}-01-01`);
    await user.type(screen.getByLabelText("Name 1"), "New Year");
    await user.click(screen.getByRole("button", { name: /Another holiday/ }));
    await user.type(screen.getByLabelText("Name 2"), "No date");
    const dialogAdd = () => screen.getByRole("button", { name: "Add" });
    await user.click(dialogAdd());
    expect(screen.getByText(/Give a date and a name/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove row 2" }));
    await user.click(dialogAdd());
    expect(await screen.findByText("New Year")).toBeInTheDocument();
    expect(screen.queryByLabelText("Date 1")).toBeNull();
    expect(screen.getByRole("button", { name: "Save calendar" })).toBeEnabled();
  });

  it("enables Save only on a change, and again only after another", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CalendarPage />);
    await screen.findByText("Christmas");
    const save = screen.getByRole("button", { name: "Save calendar" });
    expect(save).toBeDisabled();
    await user.click(screen.getByLabelText("Saturday"));
    expect(save).toBeEnabled();
    // Undoing the change leaves nothing to save.
    await user.click(screen.getByLabelText("Saturday"));
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove Christmas" }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(save).toBeDisabled());
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("is read-only without the calendar permission", async () => {
    permissions.held = ["zeteo.data.read"];
    renderWithProviders(<CalendarPage />);
    await screen.findByText("Christmas");
    expect(screen.queryByRole("button", { name: "Save calendar" })).toBeNull();
    expect(screen.getByLabelText("Saturday")).toBeDisabled();
  });
});
