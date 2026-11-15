import { describe, expect, it } from "vitest";
import { hasPermission } from "./permissions";

// The server's ladder (packages/zeteo/src/utils/permissions.ts), including
// every case its tests assert (middleware/auth.test.ts and
// middleware/auth.permissions.unit.test.ts): the UI must never hide a control
// the server would allow, nor show one it would refuse.
const CASES: [held: string[], wanted: string, allowed: boolean][] = [
  // From the server's tests.
  [[], "zeteo.sources.read", false],
  [["zeteo.sources.read"], "zeteo.sources.write", false],
  [["zeteo.sources.read"], "zeteo.sources.read", true],
  [["zeteo.sources.write"], "zeteo.sources.read", true],
  [["zeteo.grants.read"], "zeteo.grants.read", true],
  [["zeteo.runs.read"], "zeteo.runs.read", true],
  [["zeteo.grants.write"], "zeteo.grants.read", true],
  [["zeteo.runs.write"], "zeteo.runs.read", true],
  [["admin"], "zeteo.grants.read", true],
  [["zeteo.data.read"], "zeteo.grants.read", false],
  [["zeteo.data.read"], "zeteo.runs.read", false],

  // Bare admin covers everything, on or off the ladder.
  [["admin"], "zeteo.sources.write", true],
  [["admin"], "zeteo.data.export", true],
  [["admin"], "anything", true],

  // read < write < archive < delete < admin, within one base.
  [["zeteo.sources.archive"], "zeteo.sources.write", true],
  [["zeteo.sources.archive"], "zeteo.sources.read", true],
  [["zeteo.sources.delete"], "zeteo.sources.archive", true],
  [["zeteo.sources.delete"], "zeteo.sources.read", true],
  [["zeteo.sources.write"], "zeteo.sources.archive", false],
  [["zeteo.sources.archive"], "zeteo.sources.delete", false],
  [["zeteo.sources.delete"], "zeteo.sources.admin", false],

  // x.admin covers x itself and everything under it.
  [["zeteo.sources.admin"], "zeteo.sources.delete", true],
  [["zeteo.sources.admin"], "zeteo.sources.read", true],
  [["zeteo.sources.admin"], "zeteo.sources.admin", true],
  [["zeteo.sources.admin"], "zeteo.sources.tables.write", true],
  [["zeteo.sources.admin"], "zeteo.sources.refresh", true],
  [["zeteo.admin"], "zeteo.runs.read", true],
  [["zeteo.admin"], "zeteo.grants.write", true],
  [["zeteo.admin"], "zeteo.data.export", true],
  [["zeteo.sources.admin"], "zeteo.grants.read", false],
  [["zeteo.sources.admin"], "zeteo.sourcesx.read", false],
  [["zeteo.admin"], "other.thing.read", false],
  [["zeteo.admin"], "zeteo", false],

  // A level never crosses bases.
  [["zeteo.grants.write"], "zeteo.sources.read", false],
  [["zeteo.sources.write"], "zeteo.sources.tables.read", false],
  [["zeteo.sources.tables.write"], "zeteo.sources.read", false],

  // Off the ladder: granted only by itself or an admin above it.
  [["zeteo.data.export"], "zeteo.data.export", true],
  [["zeteo.data.read"], "zeteo.data.export", false],
  [["zeteo.data.delete"], "zeteo.data.export", false],
  [["zeteo.data.export"], "zeteo.data.read", false],
  [["zeteo.data.admin"], "zeteo.data.export", true],
  [["zeteo.runs"], "zeteo.runs.read", false],
  [["zeteo.x.constructor"], "zeteo.x.read", false],
  [["zeteo.x.read"], "zeteo.x.constructor", false],

  // One-segment permissions share the empty base, as on the server.
  [["read"], "read", true],
  [["write"], "read", true],
  [["read"], "write", false],
  [["read"], "zeteo.read", false],

  // Any one held permission is enough.
  [["zeteo.runs.read", "zeteo.grants.write"], "zeteo.grants.read", true],
];

describe("hasPermission", () => {
  it.each(CASES)("%j wanting %s: %s", (held, wanted, allowed) => {
    expect(hasPermission(held, wanted)).toBe(allowed);
  });
});
