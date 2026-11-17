import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorNotice } from "./ErrorNotice";

describe("ErrorNotice", () => {
  it("shows the message, issues without a field, and findings", () => {
    render(
      <ErrorNotice
        error={{
          status: 400,
          code: "invalid_request",
          message: "Bad body",
          issues: [
            { path: "", message: "Whole-body problem" },
            { path: "name", message: "Required" },
          ],
          findings: [{ code: "no_key", detail: "No key columns" }],
        }}
      />
    );
    expect(screen.getByText("Bad body")).toBeInTheDocument();
    expect(screen.getByText("Whole-body problem")).toBeInTheDocument();
    expect(screen.getByText("name: Required")).toBeInTheDocument();
    expect(screen.getByText(/No key columns/)).toBeInTheDocument();
  });

  it("leaves out issues whose path the screen shows beside a field", () => {
    render(
      <ErrorNotice
        fieldPaths={["name"]}
        error={{
          status: 400,
          code: "invalid_request",
          message: "Bad body",
          issues: [
            { path: "name", message: "Required" },
            { path: "settings.ca", message: "Not a PEM" },
          ],
        }}
      />
    );
    expect(screen.queryByText(/Required/)).not.toBeInTheDocument();
    expect(screen.getByText("settings.ca: Not a PEM")).toBeInTheDocument();
  });

  it("says the server could not be reached for status null", () => {
    render(
      <ErrorNotice
        error={{
          status: null,
          code: "network",
          message: "zeteo could not be reached",
        }}
      />
    );
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it("mentions retryAfter on a 429", () => {
    render(
      <ErrorNotice
        error={{
          status: 429,
          code: "too_many_requests",
          message: "Slow",
          retryAfter: 7,
        }}
      />
    );
    expect(screen.getByText(/7 seconds/)).toBeInTheDocument();
  });

  it("renders nothing without an error", () => {
    const { container } = render(<ErrorNotice error={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
