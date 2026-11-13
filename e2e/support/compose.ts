import { execFileSync } from "node:child_process";
import { stack } from "./stack.js";

/** `docker compose` against the run's project. */
const compose = (...args: string[]): string =>
  execFileSync("docker", ["compose", ...stack.composeArgs, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A service's log lines since `since` (an ISO time), each parsed as JSON when it is. */
export const serviceLogs = (
  service: string,
  since: string
): Array<Record<string, unknown>> =>
  compose("logs", "--no-color", "--no-log-prefix", "--since", since, service)
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === "object" && parsed !== null
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });

/**
 * Tereo's log since `since`, one entry per element: in development mode it
 * logs pretty-printed, each entry a header line and indented fields.
 */
export const tereoLogEntries = (since: string): string[] =>
  compose("logs", "--no-color", "--no-log-prefix", "--since", since, "tereo")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\n(?=\[\d{4}-\d{2}-\d{2} )/);

/** Tereo's logged answers to `GET path` since `since`, as their statuses. */
export const tereoStatusesFor = (since: string, path: string): number[] =>
  tereoLogEntries(since)
    .filter((entry) => entry.includes(`path: "${path}"`))
    .map((entry) => Number(/status: (\d+)/.exec(entry)?.[1]));

/** A single value from SQL run with psql in zeteo's own database. */
export const zeteoDbValue = (sql: string): string =>
  compose(
    "exec",
    "-T",
    "zeteo-postgres",
    "psql",
    "-U",
    "zeteo",
    "-d",
    "zeteo",
    "-tAc",
    sql
  ).trim();
