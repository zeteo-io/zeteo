import { parseAllowedHosts, resolveAllowed } from "../../sources/network.js";
import type { PostgresSettings } from "../../adapters/postgres/settings.js";
import type { ResolvedTarget, Resolver } from "../../sources/network.js";
import { lookup } from "node:dns/promises";

export const FIXTURE_DATABASE = "zeteo_fixture";

export const FIXTURE_ROLES = {
  ro: { user: "zeteo_ro", password: "ro-test-password" },
  rw: { user: "zeteo_rw", password: "rw-test-password" },
  owner: { user: "zeteo_owner", password: "owner-test-password" },
} as const;

/** The test server's address, taken from the test `DATABASE_URL`. */
const serverOf = () => {
  const url = new URL(process.env.DATABASE_URL!);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
};

/** Settings for the fixture database as one of its roles; no TLS, the fixture server has none. */
export const fixtureSettings = (
  role: "ro" | "rw" | "owner",
  overrides: Partial<PostgresSettings> = {}
): PostgresSettings => ({
  host: serverOf().host,
  port: serverOf().port,
  database: FIXTURE_DATABASE,
  ...FIXTURE_ROLES[role],
  tls: "off",
  ...overrides,
});

/** Settings for the fixture database as the server's own (super)user. */
export const fixtureAdminSettings = (): PostgresSettings => {
  const { host, port, user, password } = serverOf();
  return {
    host,
    port,
    database: FIXTURE_DATABASE,
    user,
    password,
    tls: "off",
  };
};

// `localhost` can resolve to ::1 first, where a published container port is
// often not listening: IPv4 first, as the test server expects.
const ipv4First: Resolver = async (host) => {
  const found = await lookup(host, { all: true, verbatim: false });
  return found.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

export const fixtureTarget = (): Promise<ResolvedTarget> =>
  resolveAllowed(
    serverOf().host,
    parseAllowedHosts(process.env.SOURCE_ALLOWED_HOSTS ?? ""),
    ipv4First
  );
