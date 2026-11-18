import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMIT_USER_ID, makeLimit } from "../testFixtures";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { LimitForm } from "./LimitForm";

const post = vi.hoisted(() => vi.fn());
const patch = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { post, patch } })
);
// Searching is not under test: a picker that chooses the user on one click.
vi.mock("@/features/principals", async () => {
  const actual = await vi.importActual<object>("@/features/principals");
  return {
    ...actual,
    PrincipalPicker: ({
      value,
      onChange,
    }: {
      value: unknown;
      onChange: (v: { type: "user"; id: string }) => void;
    }) => (
      <button onClick={() => onChange({ type: "user", id: LIMIT_USER_ID })}>
        {value ? "principal chosen" : "Choose principal"}
      </button>
    ),
    usePrincipalNames: () => ({
      get: () => undefined,
      unavailable: false,
      error: null,
    }),
  };
});

const createCalls = () =>
  post.mock.calls.filter(([url]) => url === "/v1/principal-limits");

const onClose = vi.fn();
const onConflict = vi.fn();

describe("LimitForm", () => {
  beforeEach(() => {
    onClose.mockReset();
    onConflict.mockReset();
    post
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === "/v1/principals/lookup"
          ? { data: { data: [] } }
          : { data: makeLimit() }
      );
    patch.mockReset().mockResolvedValue({ data: makeLimit() });
  });

  describe("create", () => {
    const renderCreate = () =>
      renderWithProviders(
        <LimitForm onClose={onClose} onConflict={onConflict} />
      );

    it("cannot be submitted without a value", async () => {
      const user = userEvent.setup();
      renderCreate();
      await user.click(
        screen.getByRole("button", { name: "Choose principal" })
      );
      await user.click(screen.getByRole("button", { name: "Create limit" }));
      expect(
        screen.getByText("Set at least one of the two limits.")
      ).toBeInTheDocument();
      expect(createCalls()).toHaveLength(0);
    });

    it("needs a principal", async () => {
      const user = userEvent.setup();
      renderCreate();
      await user.type(screen.getByLabelText("Queries at once"), "5");
      await user.click(screen.getByRole("button", { name: "Create limit" }));
      expect(screen.getByText("Choose a user or group.")).toBeInTheDocument();
      expect(createCalls()).toHaveLength(0);
    });

    it("rejects numbers out of range", async () => {
      const user = userEvent.setup();
      renderCreate();
      await user.click(
        screen.getByRole("button", { name: "Choose principal" })
      );
      // A number field; its range is checked by the form, with a message.
      expect(screen.getByLabelText("Exports at once")).toHaveAttribute(
        "type",
        "number"
      );
      await user.type(screen.getByLabelText("Queries at once"), "101");
      await user.click(screen.getByRole("button", { name: "Create limit" }));
      expect(
        screen.getByText("Queries at once is 1 to 100.")
      ).toBeInTheDocument();
      expect(createCalls()).toHaveLength(0);
    });

    it("omits an empty field", async () => {
      const user = userEvent.setup();
      renderCreate();
      await user.click(
        screen.getByRole("button", { name: "Choose principal" })
      );
      await user.type(screen.getByLabelText("Exports at once"), "4");
      await user.click(screen.getByRole("button", { name: "Create limit" }));
      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(post).toHaveBeenCalledWith("/v1/principal-limits", {
        principal_type: "user",
        principal_id: LIMIT_USER_ID,
        export_concurrency: 4,
      });
    });

    it("says a limit exists on 409 and hands the principal over", async () => {
      const user = userEvent.setup();
      post.mockImplementation(async (url: string) => {
        if (url === "/v1/principals/lookup") return { data: { data: [] } };
        throw {
          status: 409,
          code: "conflict",
          message: "The principal already has limits",
        };
      });
      renderCreate();
      await user.click(
        screen.getByRole("button", { name: "Choose principal" })
      );
      await user.type(screen.getByLabelText("Queries at once"), "4");
      await user.click(screen.getByRole("button", { name: "Create limit" }));
      expect(
        await screen.findByText("A limit already exists for this principal")
      ).toBeInTheDocument();
      expect(onConflict).toHaveBeenCalledWith({
        type: "user",
        id: LIMIT_USER_ID,
      });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("edit", () => {
    const renderEdit = () =>
      renderWithProviders(<LimitForm limit={makeLimit()} onClose={onClose} />);

    it("shows the principal read-only", () => {
      renderEdit();
      expect(screen.queryByText("Choose principal")).not.toBeInTheDocument();
      expect(screen.getByText(LIMIT_USER_ID)).toBeInTheDocument();
    });

    it("sends null for a cleared value and leaves the other out", async () => {
      const user = userEvent.setup();
      renderEdit();
      await user.clear(screen.getByLabelText("Exports at once"));
      await user.click(screen.getByRole("button", { name: "Save" }));
      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(patch).toHaveBeenCalledWith(
        `/v1/principal-limits/${makeLimit().id}`,
        { export_concurrency: null }
      );
    });

    it("sends only a changed value", async () => {
      const user = userEvent.setup();
      renderEdit();
      await user.clear(screen.getByLabelText("Queries at once"));
      await user.type(screen.getByLabelText("Queries at once"), "20");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(patch.mock.calls[0][1]).toEqual({ query_concurrency: 20 });
    });

    it("blocks clearing both and says to delete the limit", async () => {
      const user = userEvent.setup();
      renderEdit();
      await user.clear(screen.getByLabelText("Queries at once"));
      await user.clear(screen.getByLabelText("Exports at once"));
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByText(/delete the limit instead/i)).toBeInTheDocument();
      expect(patch).not.toHaveBeenCalled();
    });

    it("does not save when nothing changed", () => {
      renderEdit();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
  });
});
