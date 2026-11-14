import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrincipalPicker } from "./PrincipalPicker";
import userEvent from "@testing-library/user-event";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api/errors")>(
    "@/lib/api/errors"
  )),
  api: { get, post },
}));

const ID = "00000000-0000-4000-8000-0000000000aa";

const setup = () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PrincipalPicker value={null} onChange={onChange} />
    </QueryClientProvider>
  );
  return { onChange, user };
};

describe("PrincipalPicker", () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({
      data: {
        data: [
          {
            type: "user",
            id: ID,
            name: "Ada Lovelace",
            email: "ada@x.test",
            status: "active",
          },
        ],
      },
    });
    post.mockReset();
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("searches nothing for one character", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Search by name or email"), "a");
    await wait(450);
    expect(get).not.toHaveBeenCalled();
  });

  it("searches once, 300 ms after typing 'ada', and calls onChange on a pick", async () => {
    const { user, onChange } = setup();
    await user.type(screen.getByLabelText("Search by name or email"), "ada");
    expect(get).not.toHaveBeenCalled();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await wait(450);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1].params).toEqual({
      type: "user",
      q: "ada",
      limit: 10,
    });

    await user.click(
      await screen.findByRole("button", { name: /Ada Lovelace/ })
    );
    expect(onChange).toHaveBeenCalledWith({ type: "user", id: ID });
  });

  it("looks up a pasted UUID with the chosen type and lets it be selected", async () => {
    post.mockResolvedValue({
      data: {
        data: [{ type: "group", id: ID, name: "Analysts", status: "active" }],
      },
    });
    const { user, onChange } = setup();
    await user.click(screen.getByRole("button", { name: "Groups" }));
    fireEvent.change(screen.getByLabelText("Or paste an id"), {
      target: { value: ID },
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toEqual({
      principals: [{ type: "group", id: ID }],
    });
    expect(await screen.findByText("Analysts")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith({ type: "group", id: ID });
  });

  it("cannot select a pasted id that is orphaned", async () => {
    post.mockResolvedValue({
      data: {
        data: [
          { type: "user", id: ID, name: null, email: null, status: "orphaned" },
        ],
      },
    });
    setup();
    fireEvent.change(screen.getByLabelText("Or paste an id"), {
      target: { value: ID },
    });
    expect(await screen.findByText(/orphaned/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Select" })
    ).not.toBeInTheDocument();
  });

  it("still selects a pasted id when the lookup is unavailable", async () => {
    post.mockRejectedValue({
      status: 502,
      code: "tereo_unreachable",
      message: "down",
    });
    const { user, onChange } = setup();
    fireEvent.change(screen.getByLabelText("Or paste an id"), {
      target: { value: ID },
    });
    expect(await screen.findByText(/name unavailable/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith({ type: "user", id: ID });
  });
});
