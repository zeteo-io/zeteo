import { HostNotAllowedError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AllowRule =
  | { kind: "host"; host: string }
  | { kind: "suffix"; suffix: string }
  | { kind: "cidr"; base: bigint; bits: number; family: 4 | 6 };

export type Resolver = (
  host: string
) => Promise<{ address: string; family: 4 | 6 }[]>;

export interface ResolvedTarget {
  host: string;
  address: string;
  family: 4 | 6;
}

interface Ip {
  family: 4 | 6;
  value: bigint;
}

const WIDTH = { 4: 32, 6: 128 } as const;

const defaultResolver: Resolver = async (host) => {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

// Dotted decimal, four parts, no leading zeros.
const V4_PART = "(?:0|[1-9][0-9]{0,2})";
const V4 = new RegExp(`^${V4_PART}(?:\\.${V4_PART}){3}$`);

const parseV4 = (text: string): bigint | null => {
  if (!V4.test(text)) return null;
  let value = 0n;
  for (const part of text.split(".")) {
    if (Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return value;
};

const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

const parseV6 = (text: string): bigint | null => {
  // A zone ("%eth0") is not part of the address, and node accepts it.
  if (isIP(text) !== 6 || text.includes("%")) return null;
  let rest = text;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const v4 = parseV4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    rest = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === "" ? [] : half.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
    ...tail,
  ];
  if (all.length !== 8 || !all.every((g) => HEX_GROUP.test(g))) return null;
  return all.reduce((acc, g) => (acc << 16n) | BigInt(`0x${g}`), 0n);
};

/** An address in canonical form, or null. */
const parseIp = (text: string): Ip | null => {
  const v4 = parseV4(text);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseV6(text);
  return v6 === null ? null : { family: 6, value: v6 };
};

const mask = (family: 4 | 6, bits: number): bigint =>
  bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(WIDTH[family] - bits);

const inRange = (
  ip: Ip,
  range: { base: bigint; bits: number; family: 4 | 6 }
): boolean =>
  ip.family === range.family &&
  (ip.value & mask(range.family, range.bits)) ===
    (range.base & mask(range.family, range.bits));

const NAT64_PREFIX = 0x0064_ff9b_0000_0000_0000_0000n;

/**
 * The IPv4 address an IPv6 one carries, for the forms that reach it: mapped
 * (`::ffff:a.b.c.d`), compatible (`::a.b.c.d`) and NAT64 (`64:ff9b::/96`).
 * `::` and `::1` are not compatible addresses.
 */
const unwrap = (ip: Ip): Ip => {
  if (ip.family === 4) return ip;
  const high96 = ip.value >> 32n;
  const embedded =
    high96 === 0xffffn ||
    high96 === NAT64_PREFIX ||
    (high96 === 0n && ip.value > 1n);
  return embedded ? { family: 4, value: ip.value & 0xffff_ffffn } : ip;
};

const cidr = (text: string) => {
  const [base, bits] = text.split("/") as [string, string];
  const ip = parseIp(base)!;
  return { base: ip.value, bits: Number(bits), family: ip.family };
};

const ALWAYS_REFUSED = [
  "169.254.0.0/16",
  "0.0.0.0/8",
  "224.0.0.0/4",
  "fe80::/10",
  "fd00:ec2::254/128",
  "::/128",
  "ff00::/8",
].map(cidr);

const isAlwaysRefused = (ip: Ip): boolean =>
  ALWAYS_REFUSED.some((range) => inRange(ip, range));

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;

/**
 * A hostname in its comparable form: lower case, one trailing dot dropped.
 * Null for anything that is not a plain DNS name, and for a name whose last
 * label is numeric or `0x…`, which resolvers may read as a number.
 */
const normalizeHostname = (text: string): string | null => {
  const name = text.endsWith(".") ? text.slice(0, -1) : text;
  if (name.length === 0 || name.length > 253) return null;
  const labels = name.split(".");
  if (!labels.every((label) => LABEL.test(label))) return null;
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/i.test(labels[labels.length - 1]!)) return null;
  return name.toLowerCase();
};

const RULES_VAR = "SOURCE_ALLOWED_HOSTS";

const parseEntry = (entry: string): AllowRule | null => {
  if (entry.startsWith("*.")) {
    const suffix = normalizeHostname(entry.slice(2));
    return suffix === null ? null : { kind: "suffix", suffix };
  }
  const slash = entry.indexOf("/");
  const addressPart = slash === -1 ? entry : entry.slice(0, slash);
  const ip = parseIp(addressPart);
  if (ip !== null) {
    let bits: number = WIDTH[ip.family];
    if (slash !== -1) {
      const digits = entry.slice(slash + 1);
      if (!/^(?:0|[1-9][0-9]{0,2})$/.test(digits)) return null;
      bits = Number(digits);
      if (bits > WIDTH[ip.family]) return null;
    }
    // Addresses are unwrapped before they are matched, so a rule over the
    // mapped range is a rule over the IPv4 addresses inside it.
    if (ip.family === 6 && bits >= 96 && ip.value >> 32n === 0xffffn) {
      return {
        kind: "cidr",
        base: ip.value & 0xffff_ffffn & mask(4, bits - 96),
        bits: bits - 96,
        family: 4,
      };
    }
    return {
      kind: "cidr",
      base: ip.value & mask(ip.family, bits),
      bits,
      family: ip.family,
    };
  }
  if (slash !== -1) return null;
  const host = normalizeHostname(entry);
  return host === null ? null : { kind: "host", host };
};

/**
 * Parses the comma-separated `SOURCE_ALLOWED_HOSTS`: exact hostnames,
 * `*.example.com` suffixes, IPs and CIDRs. Throws on any other entry, so a bad
 * value stops the service at start.
 */
export const parseAllowedHosts = (raw: string): AllowRule[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const rule = parseEntry(entry);
      if (rule === null) {
        throw new Error(
          `${RULES_VAR}: "${entry}" is not a hostname, a *.suffix, an IP or a CIDR`
        );
      }
      return rule;
    });

const nameMatches = (host: string, rules: AllowRule[]): boolean =>
  rules.some(
    (rule) =>
      (rule.kind === "host" && rule.host === host) ||
      (rule.kind === "suffix" && host.endsWith(`.${rule.suffix}`))
  );

const refuse = (host: string, reason: string): never => {
  logger.warn({ host: host.slice(0, 256), reason }, "source host refused");
  throw new HostNotAllowedError();
};

/**
 * Decides whether a connection to `host` is permitted and names the address to
 * dial. The resolver runs once, and the address returned is one it returned
 * (an IP literal is its own address): the caller connects to that address, not
 * to the name, so the name cannot resolve elsewhere between check and connect.
 *
 * Allowed when the hostname matches a `host` or `suffix` rule or the address
 * matches a `cidr` rule, and the address is not in a range that is refused
 * whatever the rules say (link-local, metadata, unspecified, multicast).
 */
export const resolveAllowed = async (
  host: string,
  rules: AllowRule[],
  resolver: Resolver = defaultResolver
): Promise<ResolvedTarget> => {
  const literal = parseIp(host);
  let name: string;
  let candidates: { address: string }[];
  let byName = false;

  if (literal !== null) {
    name = host.toLowerCase();
    candidates = [{ address: name }];
  } else {
    const normalized = normalizeHostname(host);
    if (normalized === null)
      return refuse(host, "not a plain hostname or canonical IP");
    name = normalized;
    byName = nameMatches(name, rules);
    // With nothing that could match, the name is not looked up at all.
    if (!byName && !rules.some((rule) => rule.kind === "cidr")) {
      return refuse(host, "no rule matches");
    }
    candidates = await resolver(name);
  }

  for (const { address } of candidates) {
    const ip = parseIp(address);
    if (ip === null) continue;
    const effective = unwrap(ip);
    if (isAlwaysRefused(effective)) continue;
    const allowed =
      byName ||
      rules.some((rule) => rule.kind === "cidr" && inRange(effective, rule));
    if (allowed) return { host: name, address, family: ip.family };
  }
  return refuse(host, "no allowed address");
};
