import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_ID } from "@/features/sources/testFixtures";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { makeMetric } from "../testFixtures";
import { MetricForm } from "./MetricForm";

const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { post, patch } })
);

const label = (text: string) => new RegExp(`^${text}( \\*)?$`);
const field = (text: string) => screen.getByLabelText(label(text));
type User = ReturnType<typeof userEvent.setup>;

const fill = async (user: User) => {
  await user.type(field("Name"), "margin_pct");
  await user.type(field("Description"), "Margin share");
  await user.click(field("Formula \\(JSON\\)"));
  await user.paste('{"div":[{"measure":"a"},{"measure":"b"}]}');
};

describe("MetricForm", () => {
  beforeEach(() => {
    post.mockReset();
    patch.mockReset();
  });

  it("creates a metric", async () => {
    post.mockResolvedValue({ data: makeMetric() });
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<MetricForm sourceId={SOURCE_ID} onDone={onDone} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(`/v1/sources/${SOURCE_ID}/metrics`, {
      name: "margin_pct",
      description: "Margin share",
      formula: { div: [{ measure: "a" }, { measure: "b" }] },
    });
  });

  it("shows a server error under the formula at its path", async () => {
    post.mockRejectedValue({
      status: 400,
      code: "not_found_or_not_accessible",
      message: "Measure a was not found or is not accessible",
      path: ["formula", "div", 0],
    });
    const user = userEvent.setup();
    renderWithProviders(<MetricForm sourceId={SOURCE_ID} onDone={vi.fn()} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const error = await screen.findByText(/Measure a was not found/);
    expect(error).toHaveTextContent("formula.div.0");
    expect(error.closest("[data-field='formula']")).not.toBeNull();
  });

  it("previews by month over the last 12 months as a small table", async () => {
    post.mockResolvedValue({
      data: {
        columns: [
          { name: "period", type: "date" },
          { name: "margin_pct", type: "number" },
        ],
        rows: [
          ["2026-10-01", 0.4],
          ["2026-11-01", 0.5],
        ],
        truncated: false,
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<MetricForm sourceId={SOURCE_ID} onDone={vi.fn()} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("2026-11-01")).toBeInTheDocument();
    const [url, body] = post.mock.calls[0]!;
    expect(url).toBe(`/v1/sources/${SOURCE_ID}/metrics/preview`);
    expect(body.bucket).toBe("month");
    expect(body.metric.name).toBe("margin_pct");
    expect(body.range.gte.date).toMatch(/^\d{4}-\d{2}-01$/);
    expect(body.range.lt).toBeUndefined();
    expect(screen.queryByText("Rows limited")).toBeNull();
  });

  it("marks a preview whose rows a row rule limits", async () => {
    post.mockResolvedValue({
      data: {
        columns: [
          { name: "period", type: "date" },
          { name: "margin_pct", type: "number" },
        ],
        rows: [["2026-11-01", 0.5]],
        truncated: false,
        rows_limited: true,
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<MetricForm sourceId={SOURCE_ID} onDone={vi.fn()} />);
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("2026-11-01")).toBeInTheDocument();
    expect(screen.getByText("Rows limited")).toBeInTheDocument();
  });

  it("sends only what changed when editing", async () => {
    patch.mockResolvedValue({ data: makeMetric() });
    const user = userEvent.setup();
    renderWithProviders(
      <MetricForm sourceId={SOURCE_ID} metric={makeMetric()} onDone={vi.fn()} />
    );
    await user.type(field("Description"), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        `/v1/sources/${SOURCE_ID}/metrics/${makeMetric().id}`,
        { description: "Margin as a share of revenue!" }
      )
    );
  });
});
