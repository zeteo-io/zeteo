import { makeSheetsSource } from "../upload/testFixtures";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceStatus } from "./SourceStatus";

const sync = (over: object) => ({
  ...makeSheetsSource().sync!,
  ...over,
});

describe("SourceStatus", () => {
  it("shows Active for a synced Google Sheet", () => {
    render(<SourceStatus source={makeSheetsSource()} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows Stale when the sync is stale", () => {
    const failing = [
      {
        table_id: "t1",
        name: "orders",
        code: "sheet_not_accessible",
        message: "Not shared",
      },
    ];
    render(
      <SourceStatus
        source={makeSheetsSource({ sync: sync({ stale: true, failing }) })}
      />
    );
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("shows Sync failing for an error that is not yet stale", () => {
    const failing = [
      {
        table_id: "t1",
        name: "orders",
        code: "google_unavailable",
        message: "Down",
      },
    ];
    render(
      <SourceStatus source={makeSheetsSource({ sync: sync({ failing }) })} />
    );
    expect(screen.getByText("Sync failing")).toBeInTheDocument();
    expect(screen.queryByText("Stale")).toBeNull();
  });

  it("shows Deleted for a deleted Google Sheet", () => {
    render(
      <SourceStatus
        source={makeSheetsSource({ archived_at: "2026-11-18T10:00:00.000Z" })}
      />
    );
    expect(screen.getByText("Deleted")).toBeInTheDocument();
  });
});
