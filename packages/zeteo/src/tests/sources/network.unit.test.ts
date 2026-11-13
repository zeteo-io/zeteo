// @module-tag unit
// @module-tag platform
import { HostNotAllowedError } from "../../utils/errors.js";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../../utils/logger.js";
import {
  LOOKUP_TIMEOUT_MS,
  parseAllowedHosts,
  resolveAllowed,
  type AllowRule,
  type Resolver,
} from "../../sources/network.js";

type Answer = { address: string; family: 4 | 6 }[];

/** A resolver that answers from a table and counts its calls. */
const fakeResolver = (table: Record<string, string[]> = {}) => {
  const calls: string[] = [];
  const resolver: Resolver = async (host) => {
    calls.push(host);
    const answer: Answer = (table[host] ?? []).map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    return answer;
  };
  return { resolver, calls };
};

const rules = (raw: string) => parseAllowedHosts(raw);

const refused = async (
  host: string,
  allow: AllowRule[],
  table: Record<string, string[]> = {}
) => {
  const { resolver, calls } = fakeResolver(table);
  await expect(resolveAllowed(host, allow, resolver)).rejects.toBeInstanceOf(
    HostNotAllowedError
  );
  return calls;
};

describe("HostNotAllowedError", () => {
  it("is a 422 host_not_allowed that does not say which rule failed", () => {
    const err = new HostNotAllowedError();
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("host_not_allowed");
    expect(err.message).toBe("The host is not permitted");
  });
});

describe("parseAllowedHosts", () => {
  it("parses hostnames, suffixes, IPs and CIDRs", () => {
    expect(
      rules("db.internal, *.Example.com. ,10.0.0.0/8,10.1.2.3,::1/128,::1,")
    ).toEqual([
      { kind: "host", host: "db.internal" },
      { kind: "suffix", suffix: "example.com" },
      { kind: "cidr", base: 10n << 24n, bits: 8, family: 4 },
      { kind: "cidr", base: 0x0a010203n, bits: 32, family: 4 },
      { kind: "cidr", base: 1n, bits: 128, family: 6 },
      { kind: "cidr", base: 1n, bits: 128, family: 6 },
    ]);
  });

  it("is empty for an empty value", () => {
    expect(rules("")).toEqual([]);
    expect(rules(" , ")).toEqual([]);
  });

  it("masks the host bits of a CIDR", () => {
    expect(rules("10.1.2.3/8")).toEqual([
      { kind: "cidr", base: 10n << 24n, bits: 8, family: 4 },
    ]);
  });

  it.each([
    "http://x",
    "db.internal:5432",
    "user@db.internal",
    "db.internal/path",
    "*",
    "*.",
    "*.*.example.com",
    "a*.example.com",
    "10.0.0.0/33",
    "10.0.0.0/-1",
    "10.0.0.0/08",
    "10.0.0.0/",
    "::1/129",
    "10.0.0/8",
    "010.0.0.1",
    "2852039166",
    "0xa9fea9fe",
    "fe80::1%eth0",
    "[::1]",
    "bad host",
    "a..b",
    "-a.example.com",
    "a.123",
  ])("throws on %j", (entry) => {
    expect(() => rules(entry)).toThrow(/SOURCE_ALLOWED_HOSTS/);
  });

  it("names the entry in the message", () => {
    expect(() => rules("db.internal,http://x")).toThrow(/http:\/\/x/);
  });
});

describe("resolveAllowed: rules", () => {
  it("refuses everything with no rules", async () => {
    await refused("db.internal", [], { "db.internal": ["10.0.0.5"] });
    await refused("10.1.2.3", []);
    await refused("127.0.0.1", []);
  });

  it("does not resolve when no rule could match", async () => {
    expect(await refused("db.internal", [])).toEqual([]);
    expect(await refused("db.internal", rules("other.internal"))).toEqual([]);
  });

  it("allows a host rule, a suffix rule, and neither lookalike", async () => {
    const allow = rules("db.internal,*.db.internal");
    const table = {
      "db.internal": ["10.0.0.5"],
      "x.db.internal": ["10.0.0.6"],
      "a.b.db.internal": ["10.0.0.7"],
      "evil-db.internal": ["10.0.0.8"],
      "evildb.internal": ["10.0.0.9"],
    };
    const { resolver } = fakeResolver(table);
    expect((await resolveAllowed("db.internal", allow, resolver)).address).toBe(
      "10.0.0.5"
    );
    expect(
      (await resolveAllowed("x.db.internal", allow, resolver)).address
    ).toBe("10.0.0.6");
    expect(
      (await resolveAllowed("a.b.db.internal", allow, resolver)).address
    ).toBe("10.0.0.7");
    await refused("evil-db.internal", allow, table);
    await refused("evildb.internal", allow, table);
  });

  it("does not let a suffix rule match the bare domain", async () => {
    const table = { "example.com": ["10.0.0.5"] };
    await refused("example.com", rules("*.example.com"), table);
  });

  it("compares names case-insensitively and ignores one trailing dot", async () => {
    const { resolver, calls } = fakeResolver({ "db.internal": ["10.0.0.5"] });
    const allow = rules("DB.Internal");
    const target = await resolveAllowed("Db.INTERNAL.", allow, resolver);
    expect(target).toEqual({
      host: "db.internal",
      address: "10.0.0.5",
      family: 4,
    });
    expect(calls).toEqual(["db.internal"]);
    await refused("db.internal..", allow, { "db.internal": ["10.0.0.5"] });
  });

  it("allows an address a CIDR rule covers and refuses one it does not", async () => {
    const allow = rules("10.0.0.0/8");
    expect(await resolveAllowed("10.1.2.3", allow)).toEqual({
      host: "10.1.2.3",
      address: "10.1.2.3",
      family: 4,
    });
    await refused("11.0.0.1", allow);
  });

  it("allows a name whose address a CIDR rule covers", async () => {
    const { resolver } = fakeResolver({ "db.corp": ["10.9.9.9"] });
    const target = await resolveAllowed(
      "db.corp",
      rules("10.0.0.0/8"),
      resolver
    );
    expect(target.address).toBe("10.9.9.9");
    await refused("db.corp", rules("192.168.0.0/16"), {
      "db.corp": ["10.9.9.9"],
    });
  });

  it("allows an IPv6 address a CIDR rule covers", async () => {
    const allow = rules("2001:db8::/32");
    expect((await resolveAllowed("2001:db8::1", allow)).family).toBe(6);
    await refused("2001:db9::1", allow);
  });

  it("does not match an IPv4 rule against an IPv6 address or the reverse", async () => {
    await refused("::1", rules("0.0.0.0/0"));
    await refused("127.0.0.1", rules("::/0"));
  });

  it("refuses loopback without a rule and allows it with one", async () => {
    await refused("127.0.0.1", []);
    await refused("127.0.0.1", rules("10.0.0.0/8"));
    expect(
      (await resolveAllowed("127.0.0.1", rules("127.0.0.0/8"))).address
    ).toBe("127.0.0.1");
    expect((await resolveAllowed("::1", rules("::1/128"))).address).toBe("::1");
    const { resolver } = fakeResolver({ localhost: ["127.0.0.1", "::1"] });
    expect(
      (
        await resolveAllowed(
          "localhost",
          rules("127.0.0.0/8,::1/128,localhost"),
          resolver
        )
      ).address
    ).toBe("127.0.0.1");
  });
});

describe("resolveAllowed: always refused", () => {
  const everything = rules("0.0.0.0/0,::/0,*.test,host.test");
  const refusedAddresses = [
    "169.254.169.254",
    "169.254.0.1",
    "169.254.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "0.255.255.255",
    "::",
    "fe80::1",
    "febf::1",
    "FE80::ABCD",
    "fd00:ec2::254",
    "FD00:EC2:0:0:0:0:0:254",
    "224.0.0.1",
    "239.255.255.255",
    "ff02::1",
    "ff00::",
    // Platform metadata and agent addresses outside the link-local range.
    "168.63.129.16",
    "100.100.100.200",
    "192.0.0.192",
  ];

  it.each(refusedAddresses)(
    "refuses %s as a literal and as a name's answer",
    async (address) => {
      await refused(address, everything);
      await refused("host.test", everything, { "host.test": [address] });
    }
  );

  it.each([
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::FFFF:A9FE:A9FE",
    "0:0:0:0:0:ffff:a9fe:a9fe",
    "::ffff:0.0.0.0",
    "::ffff:224.0.0.1",
    "::ffff:e000:1",
    "::169.254.169.254",
    "::a9fe:a9fe",
    "64:ff9b::169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::0.1.2.3",
  ])("refuses the wrapped form %s", async (address) => {
    await refused(address, everything);
    await refused("host.test", everything, { "host.test": [address] });
  });

  it("refuses the platform addresses' mapped forms and allows their neighbours", async () => {
    for (const address of [
      "::ffff:168.63.129.16",
      "::ffff:100.100.100.200",
      "::ffff:192.0.0.192",
    ]) {
      await refused(address, everything);
    }
    for (const address of ["168.63.129.17", "100.100.100.201", "192.0.0.193"]) {
      await expect(resolveAllowed(address, everything)).resolves.toMatchObject({
        address,
      });
    }
  });

  it("allows what is not in a refused range", async () => {
    for (const address of [
      "169.253.0.1",
      "170.0.0.1",
      "1.0.0.1",
      "223.0.0.1",
      "fec0::1",
      "fd00:ec3::254",
    ]) {
      expect((await resolveAllowed(address, everything)).address).toBe(address);
    }
  });

  it("checks a mapped address as IPv4 and returns it as IPv4", async () => {
    const allow = rules("10.0.0.0/8");
    for (const literal of ["::ffff:10.1.2.3", "::FFFF:A01:203"]) {
      expect(await resolveAllowed(literal, allow)).toEqual({
        host: literal.toLowerCase(),
        address: "10.1.2.3",
        family: 4,
      });
    }
    await refused("::ffff:11.1.2.3", allow);
    const wide = rules("::ffff:0:0/96");
    expect((await resolveAllowed("1.2.3.4", wide)).address).toBe("1.2.3.4");
  });

  it("returns a mapped resolver answer as IPv4", async () => {
    const { resolver } = fakeResolver({
      "x.h.test": ["::ffff:10.0.0.5"],
      "y.h.test": ["::ffff:a00:6"],
    });
    expect(
      await resolveAllowed("x.h.test", rules("10.0.0.0/8"), resolver)
    ).toEqual({ host: "x.h.test", address: "10.0.0.5", family: 4 });
    expect(
      await resolveAllowed("y.h.test", rules("y.h.test"), resolver)
    ).toEqual({ host: "y.h.test", address: "10.0.0.6", family: 4 });
  });

  it("returns exactly what plain literals and mixed answers were checked as", async () => {
    expect(await resolveAllowed("10.1.2.3", rules("10.0.0.0/8"))).toEqual({
      host: "10.1.2.3",
      address: "10.1.2.3",
      family: 4,
    });
    expect(await resolveAllowed("2001:DB8::1", rules("2001:db8::/32"))).toEqual(
      {
        host: "2001:db8::1",
        address: "2001:db8::1",
        family: 6,
      }
    );
    const { resolver } = fakeResolver({
      "m.h.test": [
        "169.254.169.254",
        "::a00:5",
        "64:ff9b::a00:5",
        "::ffff:a9fe:a9fe",
        "::ffff:10.0.0.7",
      ],
    });
    expect(
      await resolveAllowed("m.h.test", rules("10.0.0.0/8"), resolver)
    ).toEqual({ host: "m.h.test", address: "10.0.0.7", family: 4 });
  });

  describe("IPv4-compatible and NAT64 forms", () => {
    const catchAll = rules("0.0.0.0/0,::/0");
    const forms = [
      "::a00:5",
      "::10.0.0.5",
      "::2",
      "64:ff9b::a00:5",
      "64:ff9b::10.0.0.5",
      "64:FF9B::8.8.8.8",
    ];

    it.each(forms)("refuses %s as a literal", async (address) => {
      await refused(address, catchAll);
      await refused(address, rules("10.0.0.0/8"));
    });

    it.each(forms)("skips %s as a resolver answer", async (address) => {
      const table = { "x.h.test": [address] };
      await refused("x.h.test", catchAll, table);
      await refused("x.h.test", rules("x.h.test"), table);
      const { resolver } = fakeResolver({ "x.h.test": [address, "10.0.0.5"] });
      expect(await resolveAllowed("x.h.test", catchAll, resolver)).toEqual({
        host: "x.h.test",
        address: "10.0.0.5",
        family: 4,
      });
    });

    it("still allows ::1 and ordinary IPv6 under a catch-all", async () => {
      expect((await resolveAllowed("::1", catchAll)).address).toBe("::1");
      expect((await resolveAllowed("64:ff9a::1", catchAll)).address).toBe(
        "64:ff9a::1"
      );
    });

    it.each([
      "::a00:0/104",
      "::10.0.0.5",
      "64:ff9b::/96",
      "64:ff9b::a00:5/128",
    ])("parseAllowedHosts refuses the rule %s", (entry) => {
      expect(() => rules(entry)).toThrow(/SOURCE_ALLOWED_HOSTS/);
    });

    it("parseAllowedHosts keeps ::/0, ::1 and ::/128", () => {
      expect(rules("::/0,::1,::/128")).toHaveLength(3);
    });
  });

  it("keeps a loopback rule from admitting a refused neighbour", async () => {
    await refused("169.254.169.254", rules("127.0.0.0/8,169.254.169.254"));
  });
});

describe("resolveAllowed: host spellings", () => {
  const everything = rules("0.0.0.0/0,::/0,*.test,host.test");

  it.each([
    "2852039166",
    "0xa9fea9fe",
    "0251.0376.0251.0376",
    "0xa9.0xfe.0xa9.0xfe",
    "169.254.43518",
    "169.16689662",
    "169.254.169",
    "127.1",
    "127.0.0.1.",
    "1",
    "0",
    "017700000001",
    "127.00.0.1",
    "127.0.0.01",
    "1.2.3.256",
    "1.2.3.4.5",
    "host.test.123",
    "host.test.0x1f",
    "::ffff:169.254.169.254.",
    "::ffff:169.254.169.254%eth0",
    "[::1]",
    "[::ffff:a9fe:a9fe]",
    "fe80::1%eth0",
    "fe80::1%25eth0",
    "::1%1",
    "::ffff:169.254.169.0254",
    "::ffff:0251.0376.0251.0376",
    "1::2::3",
    ":::",
    "host.test\u0000",
    "host.test\n",
    " host.test",
    "host.test ",
    "host .test",
    "host.test\t",
    "host.test․evil",
    "höst.test",
    "a.test:5432",
    "http://host.test",
    "host.test/",
    "host.test@evil",
    "",
    ".",
    ".test",
    "a..test",
    "host.test..",
    "a".repeat(64) + ".test",
    "a.".repeat(130) + "test",
  ])("refuses %j without resolving", async (host) => {
    const calls = await refused(host, everything, {
      [host]: ["10.0.0.5"],
    });
    expect(calls).toEqual([]);
  });

  it("refuses a numeric-looking host even against a catch-all rule", async () => {
    await refused("2852039166", rules("0.0.0.0/0"));
  });

  it("accepts the canonical forms", async () => {
    expect((await resolveAllowed("10.0.0.1", everything)).address).toBe(
      "10.0.0.1"
    );
    await refused("0.0.0.0", everything);
    expect((await resolveAllowed("2001:DB8::1", everything)).address).toBe(
      "2001:db8::1"
    );
  });

  it("allows hostnames with digits, hyphens and underscores", async () => {
    const { resolver } = fakeResolver({ "pg_1-a.test": ["10.0.0.5"] });
    expect(
      (await resolveAllowed("pg_1-a.test", everything, resolver)).address
    ).toBe("10.0.0.5");
  });
});

describe("resolveAllowed: resolver use", () => {
  it("calls the resolver exactly once and returns an address it returned", async () => {
    const { resolver, calls } = fakeResolver({
      "db.internal": ["10.0.0.5", "10.0.0.6"],
    });
    const target = await resolveAllowed(
      "db.internal",
      rules("db.internal"),
      resolver
    );
    expect(calls).toEqual(["db.internal"]);
    expect(["10.0.0.5", "10.0.0.6"]).toContain(target.address);
    expect(target.address).toBe("10.0.0.5");
    expect(target.host).toBe("db.internal");
  });

  it("returns the allowed address when the resolver returns a refused one first", async () => {
    const { resolver, calls } = fakeResolver({
      "db.internal": ["169.254.169.254", "::ffff:a9fe:a9fe", "10.0.0.5"],
    });
    const target = await resolveAllowed(
      "db.internal",
      rules("db.internal"),
      resolver
    );
    expect(calls).toHaveLength(1);
    expect(target).toEqual({
      host: "db.internal",
      address: "10.0.0.5",
      family: 4,
    });
  });

  it("refuses a name whose every address is refused", async () => {
    await refused("db.internal", rules("db.internal"), {
      "db.internal": ["169.254.169.254", "fe80::1"],
    });
  });

  it("refuses a name that resolves to nothing", async () => {
    await refused("db.internal", rules("db.internal"), { "db.internal": [] });
  });

  it("skips a resolver answer that is not a canonical address", async () => {
    const resolver: Resolver = async () => [
      { address: "2852039166", family: 4 },
      { address: "fe80::1%eth0", family: 6 },
      { address: "010.0.0.1", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    const target = await resolveAllowed(
      "db.internal",
      rules("db.internal"),
      resolver
    );
    expect(target.address).toBe("10.0.0.5");
    const onlyBad: Resolver = async () => [{ address: "010.0.0.1", family: 4 }];
    await expect(
      resolveAllowed("db.internal", rules("db.internal"), onlyBad)
    ).rejects.toBeInstanceOf(HostNotAllowedError);
  });

  it("takes the family from the address, not from what the resolver claims", async () => {
    const resolver: Resolver = async () => [{ address: "10.0.0.5", family: 6 }];
    const target = await resolveAllowed(
      "db.internal",
      rules("db.internal"),
      resolver
    );
    expect(target).toEqual({
      host: "db.internal",
      address: "10.0.0.5",
      family: 4,
    });
  });

  it("does not resolve an IP literal", async () => {
    const { resolver, calls } = fakeResolver();
    await resolveAllowed("10.1.2.3", rules("10.0.0.0/8"), resolver);
    expect(calls).toEqual([]);
  });

  it("turns a resolver failure into the same refusal", async () => {
    const resolver: Resolver = async () => {
      throw new Error("getaddrinfo ENOTFOUND db.internal");
    };
    const err = await resolveAllowed(
      "db.internal",
      rules("db.internal"),
      resolver
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostNotAllowedError);
    expect((err as Error).message).toBe("The host is not permitted");
  });

  it("refuses when the lookup does not settle within the timeout", async () => {
    vi.useFakeTimers();
    try {
      const resolver: Resolver = () => new Promise(() => {});
      const outcome = resolveAllowed(
        "db.internal",
        rules("db.internal"),
        resolver
      ).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS - 1);
      let settled = false;
      void outcome.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBeInstanceOf(HostNotAllowedError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave a timer behind after a successful lookup", async () => {
    vi.useFakeTimers();
    try {
      const { resolver } = fakeResolver({ "db.internal": ["10.0.0.5"] });
      await resolveAllowed("db.internal", rules("db.internal"), resolver);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs the addresses tried and why each was not used", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const { resolver } = fakeResolver({
        "x.h.test": ["169.254.169.254", "11.0.0.1", "::a00:5"],
      });
      await expect(
        resolveAllowed("x.h.test", rules("10.0.0.0/8"), resolver)
      ).rejects.toBeInstanceOf(HostNotAllowedError);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({
        host: "x.h.test",
        candidates: [
          { address: "169.254.169.254", reason: "always_refused" },
          { address: "11.0.0.1", reason: "no_rule" },
          { address: "::a00:5", reason: "unsupported_form" },
        ],
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a resolver failure under err", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const cause = new Error("ENOTFOUND");
      const resolver: Resolver = async () => {
        throw cause;
      };
      await expect(
        resolveAllowed("db.internal", rules("db.internal"), resolver)
      ).rejects.toBeInstanceOf(HostNotAllowedError);
      expect(warn.mock.calls.at(-1)![0]).toMatchObject({
        host: "db.internal",
        err: cause,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("gives the same refusal for every cause", async () => {
    const messages = new Set<string>();
    const cases: [string, AllowRule[], Record<string, string[]>][] = [
      ["db.internal", [], {}],
      ["169.254.169.254", rules("0.0.0.0/0"), {}],
      ["2852039166", rules("0.0.0.0/0"), {}],
      [
        "db.internal",
        rules("db.internal"),
        { "db.internal": ["169.254.169.254"] },
      ],
    ];
    for (const [host, allow, table] of cases) {
      const { resolver } = fakeResolver(table);
      try {
        await resolveAllowed(host, allow, resolver);
      } catch (err) {
        messages.add((err as Error).message);
      }
    }
    expect([...messages]).toEqual(["The host is not permitted"]);
  });
});
