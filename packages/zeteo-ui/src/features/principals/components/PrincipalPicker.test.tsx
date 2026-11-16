import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrincipalPicker } from "./PrincipalPicker";
import userEvent from "@testing-library/user-event";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({ api: { get, post } })
);

const ID = "00000000-0000-4000-8000-0000000000aa";

const setup = (types?: ("user" | "group")[], search?: boolean) => {
  const onChange = vi.fn();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PrincipalPicker
        value={null}
        onChange={onChange}
        types={types}
        search={search}
      />
    </QueryClientProvider>
  );
  return { onChange, user };
};

const pasteBox = () => screen.getByLabelText("Or paste an id");
const openPaste = () =>
  fireEvent.click(
    screen.getByRole("button", {
      name: "Paste an id instead (for a service account)",
    })
  );
const paste = (value: string) =>
  fireEvent.change(pasteBox(), { target: { value } });
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("PrincipalPicker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
  afterEach(() => vi.useRealTimers());

  it("without search, has no search box and sends no search, but still looks up a pasted id", async () => {
    post.mockResolvedValue({
      data: { data: [{ type: "user", id: ID, name: "Ada", status: "active" }] },
    });
    const { onChange, user } = setup(["user"], false);
    expect(screen.queryByLabelText("Search by name or email")).toBeNull();
    paste(ID);
    await advance(350);
    await user.click(await screen.findByRole("button", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith({ type: "user", id: ID });
    expect(get).not.toHaveBeenCalled();
  });

  it("with one type has no switch and searches and looks up that type only", async () => {
    post.mockResolvedValue({
      data: { data: [{ type: "user", id: ID, name: "Ada", status: "active" }] },
    });
    const { user } = setup(["user"]);
    expect(
      screen.queryByRole("button", { name: "Groups" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Users" })
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Search by name or email"), "ada");
    await advance(550);
    expect(get.mock.calls[0][1].params.type).toBe("user");
    openPaste();
    paste(ID);
    await advance(50);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toEqual({
      principals: [{ type: "user", id: ID }],
    });
  });

  it("can be limited to groups", async () => {
    const { user } = setup(["group"]);
    expect(
      screen.queryByRole("button", { name: "Users" })
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Search by group name"), "ana");
    await advance(550);
    expect(get.mock.calls[0][1].params.type).toBe("group");
  });

  it("searches nothing for two characters", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Search by name or email"), "ad");
    await advance(1000);
    expect(get).not.toHaveBeenCalled();
  });

  it("searches once, 500 ms after typing 'ada', and calls onChange on a pick", async () => {
    const { user, onChange } = setup();
    await user.type(screen.getByLabelText("Search by name or email"), "ada");
    await advance(400);
    expect(get).not.toHaveBeenCalled();
    await advance(150);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1].params).toEqual({
      type: "user",
      q: "ada",
      limit: 10,
    });

    await user.click(
      await screen.findByRole("option", { name: /Ada Lovelace/ })
    );
    expect(onChange).toHaveBeenCalledWith({ type: "user", id: ID });
  });

  it("says why when the search fails", async () => {
    get.mockRejectedValue({
      status: 502,
      code: "tereo_unreachable",
      message: "Tereo could not be reached",
    });
    const { user } = setup();
    await user.type(screen.getByLabelText("Search by name or email"), "ada");
    await advance(550);
    expect(
      await screen.findByText("Tereo could not be reached")
    ).toBeInTheDocument();
  });

  it("keeps the paste-an-id field behind a link while search is offered", () => {
    setup();
    expect(screen.queryByLabelText("Or paste an id")).not.toBeInTheDocument();
    openPaste();
    expect(pasteBox()).toBeInTheDocument();
  });

  it("looks up a pasted UUID with the chosen type, selects it, and clears the field", async () => {
    post.mockResolvedValue({
      data: {
        data: [{ type: "group", id: ID, name: "Analysts", status: "active" }],
      },
    });
    const { user, onChange } = setup();
    await user.click(screen.getByRole("button", { name: "Groups" }));
    openPaste();
    paste(ID);
    await advance(50);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1]).toEqual({
      principals: [{ type: "group", id: ID }],
    });
    expect(await screen.findByText("Analysts")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith({ type: "group", id: ID });
    expect(pasteBox()).toHaveValue("");
    expect(screen.queryByText("Analysts")).not.toBeInTheDocument();
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
    openPaste();
    paste(ID);
    await advance(50);
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
    openPaste();
    paste(ID);
    await advance(50);
    expect(await screen.findByText(/name unavailable/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith({ type: "user", id: ID });
  });

  it("shows the message and does not allow selecting on a 403", async () => {
    post.mockRejectedValue({
      status: 403,
      code: "forbidden",
      message: "You may not look this up",
    });
    setup();
    openPaste();
    paste(ID);
    await advance(50);
    expect(
      await screen.findByText("You may not look this up")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Select" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("allows selecting as name unavailable after a network failure", async () => {
    post.mockRejectedValue({
      status: null,
      code: "network",
      message: "zeteo could not be reached",
    });
    const { user, onChange } = setup();
    openPaste();
    paste(ID);
    await advance(50);
    expect(await screen.findByText(/name unavailable/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith({ type: "user", id: ID });
  });
});
