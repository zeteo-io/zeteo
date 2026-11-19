import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { TopBar } from "./TopBar";

vi.mock("./ThemeToggleButton", () => ({ ThemeToggleButton: () => null }));

const held = vi.hoisted(() => ({ permissions: ["admin"] as string[] }));
vi.mock("@tereo-io/react", async () =>
  (await import("@/test/authMock")).mockTereo({
    permissions: () => held.permissions,
  })
);

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <TopBar />
    </MemoryRouter>
  );

const nav = () => screen.getByRole("navigation", { name: "Sections" });
const adminButton = () => within(nav()).getByRole("button", { name: /Admin/ });

describe("TopBar", () => {
  beforeEach(() => {
    held.permissions = ["admin"];
  });

  it("shows My Zeteo, Dashboards and Admin to an admin, in that order", () => {
    renderAt("/my");
    const items = [...nav().querySelectorAll("a, button")];
    expect(items.map((i) => i.textContent)).toEqual([
      "My Zeteo",
      "Dashboards",
      "Admin",
    ]);
  });

  it("lists the nine admin sections under Admin", async () => {
    renderAt("/my");
    const button = adminButton();
    expect(button).toHaveAttribute("aria-haspopup", "menu");
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const links = within(nav())
      .getAllByRole("link")
      .filter((l) => !["My Zeteo"].includes(l.textContent ?? ""));
    // The user's own Dashboards link comes first, then the admin items.
    expect(links.map((l) => l.textContent)).toEqual([
      "Dashboards",
      "Sources",
      "Connections",
      "Grants",
      "Limits",
      "Calendar",
      "Runs",
      "Saved queries",
      "Dashboards",
      "Saved panels",
    ]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/dashboards",
      "/sources",
      "/connections",
      "/grants",
      "/limits",
      "/calendar",
      "/runs",
      "/saved-queries",
      "/admin/dashboards",
      "/admin/saved-panels",
    ]);
  });

  it("shows no Admin item to someone who can only query", () => {
    held.permissions = ["zeteo.data.read"];
    renderAt("/my");
    expect(
      within(nav()).queryByRole("button", { name: /Admin/ })
    ).not.toBeInTheDocument();
    expect(
      within(nav())
        .getAllByRole("link")
        .map((l) => l.textContent)
    ).toEqual(["My Zeteo", "Dashboards"]);
  });

  it("lists the Calendar to one who may change it", async () => {
    held.permissions = ["zeteo.data.read", "zeteo.calendar.write"];
    renderAt("/my");
    await userEvent.click(adminButton());
    expect(
      within(nav())
        .getAllByRole("link")
        .map((l) => l.textContent)
    ).toEqual(["My Zeteo", "Dashboards", "Calendar"]);
  });

  it("lists only the admin sections the person may see", async () => {
    held.permissions = ["zeteo.runs.read"];
    renderAt("/runs");
    await userEvent.click(adminButton());
    expect(
      within(nav())
        .getAllByRole("link")
        .map((l) => l.textContent)
    ).toEqual(["Runs"]);
  });

  it("marks Admin active under an admin path, not the user's Dashboards", () => {
    renderAt("/admin/dashboards");
    expect(adminButton()).toHaveClass("active");
    expect(
      within(nav()).getByRole("link", { name: "Dashboards" })
    ).not.toHaveClass("active");
  });

  it("marks Admin active on /grants, and the user's Dashboards on /dashboards/x", () => {
    const { unmount } = renderAt("/grants");
    expect(adminButton()).toHaveClass("active");
    unmount();
    renderAt("/dashboards/abc");
    expect(adminButton()).not.toHaveClass("active");
    expect(within(nav()).getByRole("link", { name: "Dashboards" })).toHaveClass(
      "active"
    );
  });

  it("closes on Escape, returning focus to the button", async () => {
    renderAt("/my");
    const button = adminButton();
    await userEvent.click(button);
    await userEvent.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(
      within(nav()).queryByRole("link", { name: "Sources" })
    ).not.toBeInTheDocument();
  });

  it("closes when an item is clicked", async () => {
    renderAt("/my");
    await userEvent.click(adminButton());
    await userEvent.click(within(nav()).getByRole("link", { name: "Sources" }));
    expect(adminButton()).toHaveAttribute("aria-expanded", "false");
  });
});
