// @module-tag unit
// @module-tag platform
import { HostNotAllowedError } from "../../utils/errors.js";
import { describe, expect, it } from "vitest";
import {
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

  it("unwraps a mapped address before matching a CIDR rule", async () => {
    const allow = rules("10.0.0.0/8");
    const target = await resolveAllowed("::ffff:10.1.2.3", allow);
    expect(target).toEqual({
      host: "::ffff:10.1.2.3",
      address: "::ffff:10.1.2.3",
      family: 6,
    });
    await refused("::ffff:11.1.2.3", allow);
    const wide = rules("::ffff:0:0/96");
    expect((await resolveAllowed("1.2.3.4", wide)).address).toBe("1.2.3.4");
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
    expect(
      await resolveAllowed("0.0.0.0", rules("1.0.0.0/8")).catch(() => "no")
    ).toBe("no");
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

  it("lets a resolver failure through unchanged", async () => {
    const boom = new Error("ENOTFOUND");
    const resolver: Resolver = async () => {
      throw boom;
    };
    await expect(
      resolveAllowed("db.internal", rules("db.internal"), resolver)
    ).rejects.toBe(boom);
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
