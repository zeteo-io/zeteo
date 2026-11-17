import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../api/usePrincipalNames";
import { render, screen } from "@testing-library/react";
import { PrincipalLabel } from "./PrincipalLabel";

const names = vi.hoisted(() => vi.fn());
vi.mock("../api/usePrincipalNames", () => ({ usePrincipalNames: names }));

const ref = {
  type: "user" as const,
  id: "00000000-0000-4000-8000-000000000001",
};
const resolved = (p: Partial<Principal>) =>
  names.mockReturnValue({
    get: () => ({
      ...ref,
      name: "Ada",
      email: "ada@x.test",
      status: "active",
      ...p,
    }),
    unavailable: false,
  });

describe("PrincipalLabel", () => {
  beforeEach(() => names.mockReset());

  it("shows a user's name and email", () => {
    resolved({});
    render(<PrincipalLabel refValue={ref} />);
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText(/ada@x\.test/)).toBeInTheDocument();
  });

  it("flags an inactive one", () => {
    resolved({ status: "inactive" });
    render(<PrincipalLabel refValue={ref} />);
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("shows an orphaned badge", () => {
    resolved({ name: null, email: null, status: "orphaned" });
    render(<PrincipalLabel refValue={ref} />);
    expect(screen.getByText("Orphaned")).toBeInTheDocument();
    expect(screen.getByText(ref.id)).toBeInTheDocument();
  });

  it("does not call an active principal without a name orphaned", () => {
    resolved({ name: null, email: null, status: "active" });
    render(<PrincipalLabel refValue={ref} />);
    expect(screen.queryByText(/orphaned/i)).not.toBeInTheDocument();
    expect(screen.getByText(ref.id)).toBeInTheDocument();
  });

  it("shows the id and name unavailable, with no orphaned badge, when names are unavailable", () => {
    names.mockReturnValue({ get: () => undefined, unavailable: true });
    render(<PrincipalLabel refValue={ref} />);
    expect(screen.getByText(ref.id)).toBeInTheDocument();
    expect(screen.getByText(/name unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/orphaned/i)).not.toBeInTheDocument();
  });
});
