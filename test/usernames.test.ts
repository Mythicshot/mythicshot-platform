import { describe, expect, it } from "vitest";
import { RESERVED, USERNAME_MAX, USERNAME_MIN, parseUsername } from "../src/usernames.ts";

const SHAPE = { ok: false, problem: "shape" };
const RESERVED_ANSWER = { ok: false, problem: "reserved" };
const taken = (username: string) => ({ ok: true, username });

/** The list as the plan wrote it, in the plan's order. `me` is in it and is two characters. */
const PLAN_LIST =
  "admin administrator root system support help security abuse postmaster hostmaster webmaster noreply no-reply mail email info contact hello api app www web tours tour img media static assets cdn docs blog status billing account accounts settings signin sign-in signout sign-out login logout signup sign-up register invite invites setup dashboard workspace workspaces team teams user users me you null undefined none anonymous everyone owner official staff mod moderator mythicshot mythic mythiclab mythic-lab demo test example".split(
    " ",
  );

describe("usernames", () => {
  it("a name of 3 to 30 lowercase letters, digits and single hyphens is taken", () => {
    expect(USERNAME_MIN).toBe(3);
    expect(USERNAME_MAX).toBe(30);
    for (const name of [
      "abc",
      "alex",
      "a1b",
      "a-b",
      "a12",
      "x-1",
      "alex-the-2nd",
      "a-b-c-d-e-f",
      "raid-leader-42",
      "a".repeat(30),
      "a" + "-b".repeat(14) + "c", // 30 with a hyphen at every other place
      "a" + "9".repeat(29),
      // Close to a reserved name, but not one.
      "admins",
      "admin1",
      "the-admin",
      "nulls",
    ]) {
      expect(parseUsername(name), name).toEqual(taken(name));
    }
    // Only the two documented keys, and the name exactly as stored.
    expect(Object.keys(parseUsername("alex")).sort()).toEqual(["ok", "username"]);
    expect(Object.keys(parseUsername("-")).sort()).toEqual(["ok", "problem"]);
  });

  it("capitals and outer spaces are lowered and trimmed", () => {
    expect(parseUsername("Alex")).toEqual(taken("alex"));
    expect(parseUsername("ALEX-THE-2ND")).toEqual(taken("alex-the-2nd"));
    expect(parseUsername("  alex  ")).toEqual(taken("alex"));
    expect(parseUsername("\t Alex-1 \r\n")).toEqual(taken("alex-1"));
    // The length is measured after trimming.
    expect(parseUsername("  " + "A".repeat(30) + "  ")).toEqual(taken("a".repeat(30)));
    expect(parseUsername("   ab   ")).toEqual(SHAPE);
    expect(parseUsername(" ".repeat(40))).toEqual(SHAPE);
    // Trimming does not uncover a hyphen rule.
    expect(parseUsername(" -alex ")).toEqual(SHAPE);
    expect(parseUsername(" alex- ")).toEqual(SHAPE);
  });

  it("a digit or hyphen first, a hyphen last, two hyphens, a dot, an underscore, a space inside, a non-ASCII letter, 2 and 31 characters are refused", () => {
    const refused: unknown[] = [
      "1abc",
      "9lives",
      "-abc",
      "abc-",
      "a--b",
      "ab--",
      "a---b",
      "a-b--c",
      "a.b",
      "alex.smith",
      "a_b",
      "_abc",
      "a b",
      "al ex",
      "a\tb",
      "al\nex",
      "alex\nadmin",
      "ab",
      "a",
      "",
      "a-",
      "a".repeat(31),
      "a".repeat(30) + "-",
      "a" + "-b".repeat(15),
      // Non-ASCII letters, including the ones that read as ASCII or lowercase into it.
      "alexé", // é
      "élex",
      "аdmin", // Cyrillic а
      "ɑdmin", // Latin alpha
      "admın", // dotless i
      "ADMİN", // capital dotted I: lowercases to i plus a combining dot
      "Kelvin", // Kelvin sign: lowercases to k
      "kelvinK",
      "ａlex", // fullwidth a
      "Ａlex", // fullwidth A
      "aleχ", // Greek chi
      "straße", // ß
      "álex", // a plus a combining accent
      "alex​", // zero-width space
      "al‍ex", // zero-width joiner
      "al­ex", // soft hyphen
      "alex‮", // right-to-left override
      "a‐b", // Unicode hyphen
      "a–b", // en dash
      "a−b", // minus sign
      "al ex", // no-break space inside
      "😀abc", // emoji
      "abc\ud83d", // a lone surrogate
      "alex\u0000",
      "\u0000alex",
      "al\u0000ex",
      // Punctuation that means something in a path, a host, a mail address or markup.
      "a/b",
      "a\\b",
      "../abc",
      "a@b",
      "alex@example.com",
      "a:b",
      "a%2db",
      "a+b",
      "a*b",
      "a?b",
      "a#b",
      "a'b",
      'a"b',
      "<b>abc",
      "abc;",
      "a,b",
      "a=b",
      "a&b",
      "a|b",
      "a~b",
      "a!b",
      "a$b",
      "(abc)",
      "[abc]",
      "{abc}",
    ];
    for (const v of refused) expect(parseUsername(v), JSON.stringify(v)).toEqual(SHAPE);
  });

  it("what is not a string is refused and nothing throws", () => {
    const hostile = {
      toString() {
        throw new Error("toString was called");
      },
      valueOf() {
        throw new Error("valueOf was called");
      },
      [Symbol.toPrimitive]() {
        throw new Error("toPrimitive was called");
      },
    };
    const trapped = new Proxy(
      {},
      {
        get() {
          throw new Error("a property was read");
        },
        has() {
          throw new Error("a property was looked up");
        },
        ownKeys() {
          throw new Error("the keys were listed");
        },
        getPrototypeOf() {
          throw new Error("the prototype was read");
        },
      },
    );
    const notStrings: unknown[] = [
      undefined,
      null,
      true,
      false,
      0,
      123,
      1234,
      NaN,
      Infinity,
      10n ** 20n,
      Symbol("alex"),
      Symbol.iterator,
      [],
      ["alex"],
      ["a", "l", "e", "x"],
      {},
      { username: "alex" },
      { toString: () => "alex" },
      { length: 4, trim: () => "alex", toLowerCase: () => "alex" },
      new String("alex"),
      Object.create(null),
      () => "alex",
      new Date(0),
      /alex/,
      new Map(),
      new Uint8Array([97, 108, 101, 120]),
      hostile,
      trapped,
    ];
    for (const v of notStrings) {
      let answer: unknown;
      expect(() => {
        answer = parseUsername(v);
      }).not.toThrow();
      expect(answer).toEqual(SHAPE);
    }
    // No argument at all.
    expect((parseUsername as () => unknown)()).toEqual(SHAPE);
  });

  it("very long input is refused at once", () => {
    const started = Date.now();
    for (const v of [
      "a".repeat(5_000_000),
      "a-".repeat(2_500_000),
      "-".repeat(5_000_000),
      " ".repeat(5_000_000),
      " ".repeat(2_000_000) + "a".repeat(31) + " ".repeat(2_000_000),
      "a" + " ".repeat(5_000_000) + "b",
      "admin".repeat(1_000_000),
    ]) {
      expect(parseUsername(v)).toEqual(SHAPE);
    }
    // A generous bound: each case is one pass over the text, never a search that backs up.
    expect(Date.now() - started).toBeLessThan(5000);
    // Outer spaces alone never make a name too long.
    expect(parseUsername(" ".repeat(100_000) + "Alex" + " ".repeat(100_000))).toEqual(taken("alex"));
  });

  it("every reserved name is refused, also in capitals", () => {
    expect(RESERVED.size).toBeGreaterThan(0);
    for (const name of RESERVED) {
      expect(parseUsername(name), name).toEqual(RESERVED_ANSWER);
      expect(parseUsername(name.toUpperCase()), name).toEqual(RESERVED_ANSWER);
      expect(parseUsername(name[0].toUpperCase() + name.slice(1)), name).toEqual(RESERVED_ANSWER);
      expect(parseUsername("  " + name + "\n"), name).toEqual(RESERVED_ANSWER);
    }
    // Names that are a route, a host label or read as staff, spelled out.
    for (const name of ["admin", "Administrator", "ROOT", "support", "api", "www", "tours", "signin", "sign-in", "no-reply", "staff", "official", "Mythicshot", "mythic-lab", "null", "undefined"]) {
      expect(parseUsername(name), name).toEqual(RESERVED_ANSWER);
    }
    // A reserved name is not reached through a look-alike or a hidden character: those are a shape problem.
    for (const name of ["аdmin", "admın", "admin​", "ad­min", "admin.", "admin_", "ad-min-", "rооt"]) {
      expect(parseUsername(name), JSON.stringify(name)).toEqual(SHAPE);
    }
  });

  it("the reserved list is the approved one", () => {
    // Every name the plan lists is refused, whichever rule refuses it.
    for (const name of PLAN_LIST) expect(parseUsername(name).ok, name).toBe(false);
    // The set holds every listed name a person could otherwise choose, and no other.
    const choosable = PLAN_LIST.filter((name) => name.length >= USERNAME_MIN);
    expect([...RESERVED]).toEqual([...choosable].sort());
    // The only listed name left out is too short to be chosen at all.
    expect(PLAN_LIST.filter((name) => !RESERVED.has(name))).toEqual(["me"]);
    expect(parseUsername("me")).toEqual(SHAPE);
  });

  it("the reserved list is lowercase, sorted and passes the shape rule itself", () => {
    const names = [...RESERVED];
    expect(names.length).toBe(RESERVED.size);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    const shape = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,29}$/;
    for (const name of names) {
      expect(typeof name, name).toBe("string");
      expect(name, name).toBe(name.toLowerCase());
      expect(name, name).toBe(name.trim());
      expect(name.length, name).toBeGreaterThanOrEqual(USERNAME_MIN);
      expect(name.length, name).toBeLessThanOrEqual(USERNAME_MAX);
      expect(shape.test(name), name).toBe(true);
    }
  });

  it("the same input always gives the same answer", () => {
    // No state is kept between calls, as a global or sticky pattern would keep.
    for (let i = 0; i < 5; i++) {
      expect(parseUsername("alex")).toEqual(taken("alex"));
      expect(parseUsername("al ex")).toEqual(SHAPE);
      expect(parseUsername("admin")).toEqual(RESERVED_ANSWER);
    }
    // An answer the caller changes does not change the next one.
    const first = parseUsername("alex") as { ok: true; username: string };
    first.username = "admin";
    expect(parseUsername("alex")).toEqual(taken("alex"));
  });
});
