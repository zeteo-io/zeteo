import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useUuidParam } from "./useUuidParam";

const ID = "5f0c8f0e-1c7a-4a53-9d0e-6a3b1f2c4d55";

const Show = () => <p>{useUuidParam("id") ?? "none"}</p>;

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/x/:id" element={<Show />} />
        <Route path="/y" element={<Show />} />
      </Routes>
    </MemoryRouter>
  );

describe("useUuidParam", () => {
  it.each([
    [`/x/${ID}`, ID],
    [`/x/${ID.toUpperCase()}`, ID],
    ["/x/not-a-uuid", "none"],
    [`/x/${ID}x`, "none"],
    ["/x/a%3Fb", "none"],
    ["/y", "none"],
  ])("reads %s as %s", (path, shown) => {
    at(path);
    expect(screen.getByText(shown)).toBeInTheDocument();
  });
});
