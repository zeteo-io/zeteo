import { makeTable, makeTableDetail } from "@/features/tables/testFixtures";
import { MergedTableEditPage, MergedTableNewPage } from "./MergedTablePage";
import { FS_ID, makeUploadSource, sheetOrigin } from "../testFixtures";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: ["zeteo.uploads.write"],
    api: { get, post, put },
  })
);

const A = "a1000000-1c7a-4a53-9d0e-6a3b1f2c4d01";
const B = "a2000000-1c7a-4a53-9d0e-6a3b1f2c4d02";
const C = "a3000000-1c7a-4a53-9d0e-6a3b1f2c4d03";
const M = "a4000000-1c7a-4a53-9d0e-6a3b1f2c4d04";
const SHEET = sheetOrigin();

const tables = [
  makeTable({ id: A, name: "watermelon", origin: SHEET }),
  makeTable({ id: B, name: "chomchom", origin: SHEET }),
  makeTable({
    id: C,
    name: "gone",
    origin: SHEET,
    missing_since: "2026-11-01",
  }),
  makeTable({
    id: M,
    name: "all_brands",
    origin: { kind: "merged", members: 2 },
  }),
];

const union = {
  columns: [
    { name: "sku", type: "text", types: ["text"], members: [A, B] },
    { name: "price", type: "text", members: [A, B], types: ["number", "text"] },
    { name: "vivo_sku", type: "text", types: ["text"], members: [A] },
  ],
  labels: { [A]: "Watermelon Ball", [B]: "ChomChom" },
};

const answer = (detail?: unknown) => (url: string) => {
  if (url === `/v1/sources/${FS_ID}`)
    return Promise.resolve({ data: makeUploadSource() });
  if (url === `/v1/sources/${FS_ID}/tables`)
    return Promise.resolve({ data: { data: tables, next_cursor: null } });
  if (url.startsWith(`/v1/sources/${FS_ID}/merged-tables/columns`))
    return Promise.resolve({ data: union });
  if (url === `/v1/sources/${FS_ID}/tables/${M}`)
    return Promise.resolve({ data: detail });
  return Promise.reject({ status: 404, code: "not_found", message: url });
};

const renderNew = () =>
  renderWithProviders(
    <Routes>
      <Route
        path="/sources/:sourceId/merged/new"
        element={<MergedTableNewPage />}
      />
      <Route
        path="/sources/:sourceId/tables/:tableId"
        element={<p>Table page</p>}
      />
    </Routes>,
    { route: `/sources/${FS_ID}/merged/new` }
  );

const pickMembers = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByLabelText("watermelon"));
  await user.click(screen.getByLabelText("chomchom"));
};

describe("the merged table editor", () => {
  beforeEach(() => {
    get.mockReset().mockImplementation(answer());
    post.mockReset().mockResolvedValue({ data: makeTable({ id: M }) });
    put.mockReset().mockResolvedValue({ data: makeTable({ id: M }) });
  });

  it("lists only live, non-merged tables as members", async () => {
    renderNew();
    await screen.findByLabelText("watermelon");
    expect(screen.getByLabelText("chomchom")).toBeInTheDocument();
    expect(screen.queryByLabelText("gone")).toBeNull();
    expect(screen.queryByLabelText("all_brands")).toBeNull();
  });

  it("disables Save with fewer than two members", async () => {
    const user = userEvent.setup();
    renderNew();
    await user.click(await screen.findByLabelText("watermelon"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("ticks columns in every member and leaves partial ones unticked", async () => {
    const user = userEvent.setup();
    renderNew();
    await pickMembers(user);
    await screen.findByText("vivo_sku");
    expect(screen.getByLabelText("Include sku")).toBeChecked();
    expect(screen.getByLabelText("Include price")).toBeChecked();
    expect(screen.getByLabelText("Include vivo_sku")).not.toBeChecked();
    expect(screen.getAllByText("2 of 2")).toHaveLength(2);
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    for (const h of ["Column", "In", "Type", "Include", "Name"])
      expect(screen.getByRole("columnheader", { name: h })).toBeInTheDocument();
  });

  it("warns on a column whose members disagree on the type", async () => {
    const user = userEvent.setup();
    renderNew();
    await pickMembers(user);
    await screen.findByText("vivo_sku");
    expect(
      screen.getAllByText("Members disagree on the type; it will be text")
    ).toHaveLength(1);
  });

  it("pre-fills the labels from the server and lets them be edited", async () => {
    const user = userEvent.setup();
    renderNew();
    await pickMembers(user);
    const label = await screen.findByLabelText("Label for watermelon");
    await waitFor(() => expect(label).toHaveValue("Watermelon Ball"));
    expect(screen.getByLabelText("Label for chomchom")).toHaveValue("ChomChom");
    await user.clear(label);
    await user.type(label, "WM");
    expect(label).toHaveValue("WM");
  });

  it("posts the exact body then goes to the merged table", async () => {
    const user = userEvent.setup();
    renderNew();
    await pickMembers(user);
    await screen.findByText("vivo_sku");
    await waitFor(() =>
      expect(screen.getByLabelText("Label for watermelon")).toHaveValue(
        "Watermelon Ball"
      )
    );
    await user.type(screen.getByLabelText("Name"), "all");
    await user.click(screen.getByLabelText("Include vivo_sku"));
    const rename = screen.getByLabelText("Name of column price");
    await user.clear(rename);
    await user.type(rename, "cost");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(`/v1/sources/${FS_ID}/merged-tables`, {
      name: "all",
      label_column: "source",
      members: [
        { table_id: A, label: "Watermelon Ball" },
        { table_id: B, label: "ChomChom" },
      ],
      columns: [
        { name: "sku", from_name: "sku", include: true },
        { name: "cost", from_name: "price", include: true },
        { name: "vivo_sku", from_name: "vivo_sku", include: true },
      ],
    });
    expect(await screen.findByText("Table page")).toBeInTheDocument();
  });

  it("shows a server error above the form", async () => {
    const user = userEvent.setup();
    post.mockRejectedValue({
      status: 409,
      code: "table_name_taken",
      message: "A table with that name exists.",
    });
    renderNew();
    await pickMembers(user);
    await screen.findByText("vivo_sku");
    await waitFor(() =>
      expect(screen.getByLabelText("Label for watermelon")).toHaveValue(
        "Watermelon Ball"
      )
    );
    await user.type(screen.getByLabelText("Name"), "all");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const message = await screen.findByText("A table with that name exists.");
    const form = message.closest("form")!;
    expect(
      form.firstElementChild!.contains(message) ||
        form.firstElementChild === message.closest("div")
    ).toBe(true);
  });

  it("edits a merged table: PUTs the definition", async () => {
    const user = userEvent.setup();
    get.mockImplementation(
      answer({
        ...makeTableDetail({ id: M, name: "all_brands" }),
        merged: {
          label_column: "brand",
          members: [
            { table_id: A, name: "watermelon", label: "WM", missing: false },
            { table_id: B, name: "chomchom", label: "CC", missing: false },
          ],
          columns: [
            {
              id: "x1",
              name: "sku",
              from_name: "sku",
              type: "text",
              members: [A, B],
              missing: false,
            },
          ],
          available: [],
          warnings: [],
        },
      })
    );
    renderWithProviders(
      <Routes>
        <Route
          path="/sources/:sourceId/tables/:tableId/merged/edit"
          element={<MergedTableEditPage />}
        />
        <Route
          path="/sources/:sourceId/tables/:tableId"
          element={<p>Table page</p>}
        />
      </Routes>,
      { route: `/sources/${FS_ID}/tables/${M}/merged/edit` }
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("all_brands")
    );
    expect(screen.getByLabelText("Label column")).toHaveValue("brand");
    expect(await screen.findByLabelText("Label for watermelon")).toHaveValue(
      "WM"
    );
    await screen.findByText("vivo_sku");
    expect(screen.getByLabelText("Include sku")).toBeChecked();
    expect(screen.getByLabelText("Include price")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]![0]).toBe(
      `/v1/sources/${FS_ID}/tables/${M}/merged`
    );
    expect(put.mock.calls[0]![1].members).toEqual([
      { table_id: A, label: "WM" },
      { table_id: B, label: "CC" },
    ]);
  });

  const detailWith = (over: object) => ({
    ...makeTableDetail({ id: M, name: "all_brands" }),
    merged: {
      label_column: "brand",
      members: [
        { table_id: A, name: "watermelon", label: "WM", missing: false },
        { table_id: C, name: "gone", label: "Gone", missing: true },
      ],
      columns: [
        {
          id: "x1",
          name: "item",
          from_name: "sku",
          type: "text",
          members: [A],
          missing: false,
        },
      ],
      available: [],
      warnings: [],
      ...over,
    },
  });
  const renderEdit = () =>
    renderWithProviders(
      <Routes>
        <Route
          path="/sources/:sourceId/tables/:tableId/merged/edit"
          element={<MergedTableEditPage />}
        />
        <Route
          path="/sources/:sourceId/tables/:tableId"
          element={<p>Table page</p>}
        />
      </Routes>,
      { route: `/sources/${FS_ID}/tables/${M}/merged/edit` }
    );

  it("shows a renamed column ticked under its member name with the new name", async () => {
    get.mockImplementation(answer(detailWith({})));
    renderEdit();
    await screen.findByText("vivo_sku");
    expect(screen.getByLabelText("Include sku")).toBeChecked();
    expect(screen.getByLabelText("Name of column sku")).toHaveValue("item");
    expect(screen.getByLabelText("Include price")).not.toBeChecked();
  });

  it("keeps a missing member selected, flagged, with its label editable", async () => {
    const user = userEvent.setup();
    get.mockImplementation(answer(detailWith({})));
    renderEdit();
    const box = await screen.findByLabelText(/^gone/);
    expect(box).toBeChecked();
    expect(screen.getByText("Missing")).toBeInTheDocument();
    const label = screen.getByLabelText("Label for gone");
    await user.clear(label);
    await user.type(label, "G2");
    await screen.findByText("vivo_sku");
    // Unticking it on purpose leaves one member: Save is off.
    await user.click(box);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(box);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]![1].members).toEqual([
      { table_id: A, label: "WM" },
      { table_id: C, label: "G2" },
    ]);
  });

  it("keeps a missing merged column ticked and flagged, and sends it", async () => {
    const user = userEvent.setup();
    get.mockImplementation(
      answer(
        detailWith({
          members: [
            { table_id: A, name: "watermelon", label: "WM", missing: false },
            { table_id: B, name: "chomchom", label: "CC", missing: false },
          ],
          columns: [
            {
              id: "x1",
              name: "sku",
              from_name: "sku",
              type: "text",
              members: [A, B],
              missing: false,
            },
            {
              id: "x2",
              name: "old_code",
              from_name: "old",
              type: "number",
              members: [],
              missing: true,
            },
          ],
        })
      )
    );
    renderEdit();
    await screen.findByText("vivo_sku");
    expect(screen.getByLabelText("Include old")).toBeChecked();
    expect(screen.getByLabelText("Name of column old")).toHaveValue("old_code");
    expect(screen.getAllByText("Missing")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0]![1].columns).toContainEqual({
      name: "old_code",
      from_name: "old",
      include: true,
    });
  });

  it("refuses a duplicate member label", async () => {
    const user = userEvent.setup();
    renderNew();
    await pickMembers(user);
    await screen.findByText("vivo_sku");
    await user.type(screen.getByLabelText("Name"), "all");
    const second = screen.getByLabelText("Label for chomchom");
    await waitFor(() => expect(second).toHaveValue("ChomChom"));
    await user.clear(second);
    await user.type(second, "Watermelon Ball");
    expect(
      screen.getByText("Each member needs its own label")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("refuses a label over 100 characters", async () => {
    const user = userEvent.setup();
    renderNew();
    await pickMembers(user);
    await screen.findByText("vivo_sku");
    await user.type(screen.getByLabelText("Name"), "all");
    const first = screen.getByLabelText("Label for watermelon");
    expect(first).toHaveAttribute("maxlength", "100");
    await waitFor(() => expect(first).toHaveValue("Watermelon Ball"));
    fireEvent.change(first, { target: { value: "x".repeat(101) } });
    expect(screen.getByText("At most 100 characters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("counts a label's length in characters, not UTF-16 units", async () => {
    const user = userEvent.setup();
    renderNew();
    await pickMembers(user);
    await screen.findByText("vivo_sku");
    await user.type(screen.getByLabelText("Name"), "all");
    const first = screen.getByLabelText("Label for watermelon");
    await waitFor(() => expect(first).toHaveValue("Watermelon Ball"));
    fireEvent.change(first, { target: { value: "\u{1F349}".repeat(100) } });
    expect(screen.queryByText("At most 100 characters.")).toBeNull();
    fireEvent.change(first, { target: { value: "\u{1F349}".repeat(101) } });
    expect(screen.getByText("At most 100 characters.")).toBeInTheDocument();
  });

  it("refuses a label column that is not a lowercase identifier", async () => {
    const user = userEvent.setup();
    renderNew();
    await pickMembers(user);
    await screen.findByText("vivo_sku");
    await user.type(screen.getByLabelText("Name"), "all");
    const column = screen.getByLabelText("Label column");
    await user.clear(column);
    await user.type(column, "Brand Name");
    expect(
      screen.getByText(/Start with a lowercase letter/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(column);
    await user.type(column, "brand_name");
    expect(screen.queryByText(/Start with a lowercase letter/)).toBeNull();
  });
});
