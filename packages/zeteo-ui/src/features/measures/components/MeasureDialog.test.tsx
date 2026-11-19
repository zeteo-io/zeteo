import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_ID } from "@/features/sources/testFixtures";
import { makeTable } from "@/features/tables/testFixtures";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { pickOption } from "@/test/searchSelect";
import { MeasureDialog } from "./MeasureDialog";
import { makeMeasure } from "../testFixtures";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get, post } })
);

const label = (text: string) => new RegExp(`^${text}( \\*)?$`);
const field = (text: string) => screen.getByLabelText(label(text));
type User = ReturnType<typeof userEvent.setup>;

const fill = async (user: User) => {
  await user.type(field("Name"), "paid_revenue");
  await pickOption(user, field("Table"), "orders");
  await user.type(field("Description"), "Revenue of paid orders");
  // userEvent treats { as a key; paste the JSON.
  await user.click(field("Formula \\(JSON\\)"));
  await user.paste('{"sum":"amt"}');
};

describe("MeasureDialog", () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset().mockResolvedValue({
      data: { data: [makeTable()], next_cursor: null },
    });
  });

  it("shows a server plan error under the formula field at its path", async () => {
    post.mockRejectedValue({
      status: 400,
      code: "not_found_or_not_accessible",
      message: "Column amt was not found or is not accessible",
      path: ["formula", "sum"],
    });
    const user = userEvent.setup();
    renderWithProviders(
      <MeasureDialog sourceId={SOURCE_ID} onClose={vi.fn()} />
    );
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const error = await screen.findByText(/Column amt was not found/);
    expect(error).toHaveTextContent("formula.sum");
    expect(error.closest("[data-field='formula']")).not.toBeNull();
    expect(post).toHaveBeenCalledWith(`/v1/sources/${SOURCE_ID}/measures`, {
      name: "paid_revenue",
      description: "Revenue of paid orders",
      table: "orders",
      formula: { sum: "amt" },
    });
  });

  it("refuses formula text that is not JSON without asking the server", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MeasureDialog sourceId={SOURCE_ID} onClose={vi.fn()} />
    );
    await user.type(field("Name"), "paid_revenue");
    await pickOption(user, field("Table"), "orders");
    await user.type(field("Description"), "x");
    await user.type(field("Formula \\(JSON\\)"), "not json");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/not valid JSON/i)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("previews the draft and shows its value", async () => {
    post.mockResolvedValue({
      data: {
        columns: [{ name: "paid_revenue", type: "number" }],
        rows: [[1234.5]],
        truncated: false,
      },
    });
    const user = userEvent.setup();
    renderWithProviders(
      <MeasureDialog sourceId={SOURCE_ID} onClose={vi.fn()} />
    );
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        `/v1/sources/${SOURCE_ID}/measures/preview`,
        {
          measure: {
            name: "paid_revenue",
            description: "Revenue of paid orders",
            table: "orders",
            formula: { sum: "amt" },
          },
        }
      )
    );
    expect(
      await screen.findByTestId("measure-preview-value")
    ).toHaveTextContent("1,234.5");
  });

  it("clears the preview when the draft changes", async () => {
    post.mockResolvedValue({
      data: {
        columns: [{ name: "paid_revenue", type: "number" }],
        rows: [[1234.5]],
        truncated: false,
      },
    });
    const user = userEvent.setup();
    renderWithProviders(
      <MeasureDialog sourceId={SOURCE_ID} onClose={vi.fn()} />
    );
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByTestId("measure-preview-value");
    await user.type(field("Formula \\(JSON\\)"), " ");
    expect(screen.queryByTestId("measure-preview-value")).toBeNull();
  });

  it("shows a preview's plan error under the field at its path", async () => {
    post.mockRejectedValue({
      status: 400,
      code: "not_found_or_not_accessible",
      message: "Column amt was not found or is not accessible",
      path: ["formula", "sum"],
    });
    const user = userEvent.setup();
    renderWithProviders(
      <MeasureDialog sourceId={SOURCE_ID} onClose={vi.fn()} />
    );
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const error = await screen.findByText(/Column amt was not found/);
    expect(error).toHaveTextContent("formula.sum");
    expect(error.closest("[data-field='formula']")).not.toBeNull();
  });

  it("keeps a preview error that is not the measure's in the preview", async () => {
    post.mockRejectedValue({
      status: 502,
      code: "source_unreachable",
      message: "The source could not be reached",
    });
    const user = userEvent.setup();
    renderWithProviders(
      <MeasureDialog sourceId={SOURCE_ID} onClose={vi.fn()} />
    );
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const error = await screen.findByText("The source could not be reached");
    expect(error.closest("[data-field]")).toBeNull();
  });

  it("warns that a rename stops the saved queries and panels using it", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MeasureDialog
        sourceId={SOURCE_ID}
        measure={makeMeasure()}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByText(/will stop working/)).toBeNull();
    await user.type(field("Name"), "_v2");
    expect(
      screen.getByText(
        /used by 2 saved queries and 1 panel; they will stop working/
      )
    ).toBeInTheDocument();
  });
});
