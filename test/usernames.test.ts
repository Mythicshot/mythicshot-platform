import { describe, expect, it } from "vitest";
import { DASH_LINK_PAGES, DASH_PAGES } from "../src/dash/routes.ts";
import { HOST_RULES } from "../src/host-gate.ts";
import { RESERVED, USERNAME_MAX, USERNAME_MIN, parseUsername } from "../src/usernames.ts";

const SHAPE = { ok: false, problem: "shape" };
const RESERVED_ANSWER = { ok: false, problem: "reserved" };
const taken = (username: string) => ({ ok: true, username });

/** The names the plan lists, in the plan's order (`me` is in it and is two characters), then the ones added at review. */
const PLAN_LIST =
  "admin administrator root system support help security abuse postmaster hostmaster webmaster noreply no-reply mail email info contact hello api app www web tours tour img media static assets cdn docs blog status billing account accounts settings signin sign-in signout sign-out login logout signup sign-up register invite invites setup dashboard workspace workspaces team teams user users me you null undefined none anonymous everyone owner official staff mod moderator mythicshot mythic mythiclab mythic-lab demo test example deleted unknown guest nobody removed sysadmin superuser admins moderators mods helpdesk service bot notifications legal privacy terms dmca copyright trust safety sales press pricing feedback report cpanel webmail ftp autodiscover autoconfig smtp imap localhost dev staging beta healthz player auth oauth session sessions upload uploads embed share public home new search true false nan ember connect connections dash gifs images openapi storage tokens usage".split(
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
      "admin1",
      "the-admin",
      "nulls",
      "mythic-fan",
      "ad-vance",
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
    // Space, tab, CR and LF are the only outer characters dropped.
    expect(parseUsername(" \t\r\n alex \n\r\t ")).toEqual(taken("alex"));
    for (const outer of ["\u00a0", "\ufeff", "\u2028", "\u2029", "\u3000", "\u000b", "\u000c", "\u0085", "\u1680", "\u2003", "\u202f", "\u205f", "\u200b", "\u0000"]) {
      expect(parseUsername(outer + "alex"), JSON.stringify(outer)).toEqual(SHAPE);
      expect(parseUsername("alex" + outer), JSON.stringify(outer)).toEqual(SHAPE);
      expect(parseUsername(" " + outer + "alex" + outer + " "), JSON.stringify(outer)).toEqual(SHAPE);
      expect(parseUsername(outer + "admin"), JSON.stringify(outer)).toEqual(SHAPE);
    }
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
      "alex\u00e9", // \u00e9
      "\u00e9lex",
      "\u0430dmin", // Cyrillic \u0430
      "\u0251dmin", // Latin alpha
      "adm\u0131n", // dotless i
      "ADM\u0130N", // capital dotted I: lowercases to i plus a combining dot
      "\u212aelvin", // Kelvin sign: lowercases to k
      "kelvin\u212a",
      "\uff41lex", // fullwidth a
      "\uff21lex", // fullwidth A
      "ale\u03c7", // Greek chi
      "stra\u00dfe", // \u00df
      "a\u0301lex", // a plus a combining accent
      "alex\u200b", // zero-width space
      "al\u200dex", // zero-width joiner
      "al\u00adex", // soft hyphen
      "alex\u202e", // right-to-left override
      "a\u2010b", // Unicode hyphen
      "a\u2013b", // en dash
      "a\u2212b", // minus sign
      "al\u00a0ex", // no-break space inside
      "\ud83d\ude00abc", // emoji
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
    // Outer characters that are not dropped, in bulk.
    expect(parseUsername("\u00a0".repeat(1_000_000) + "alex")).toEqual(SHAPE);
    expect(parseUsername("alex" + "\t\r\n ".repeat(500_000))).toEqual(taken("alex"));
    expect(parseUsername("\n".repeat(2_000_000) + "a" + "\n".repeat(2_000_000) + "b" + "\n".repeat(2_000_000))).toEqual(SHAPE);
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
    for (const name of ["\u0430dmin", "adm\u0131n", "admin\u200b", "ad\u00admin", "admin.", "admin_", "ad-min-", "r\u043e\u043et"]) {
      expect(parseUsername(name), JSON.stringify(name)).toEqual(SHAPE);
    }
  });

  it("a reserved name with hyphens added or taken out is refused", () => {
    for (const name of [
      "ad-min",
      "a-d-m-i-n",
      "Ad-Min",
      " A-D-M-I-N ",
      "mythic-shot",
      "sup-port",
      "no-rep-ly",
      "nore-ply",
      "sig-nin",
      "s-ign-in",
      "signi-n",
      "mythi-clab",
      "my-thic-lab",
      "r-o-o-t",
      "ro-ot",
      "sys-admin",
      "super-user",
      "help-desk",
      "web-mail",
      "local-host",
      "auto-discover",
      "n-u-l-l",
      "t-rue",
      "a-p-i",
      "w-w-w",
      "mod-s",
      "s-t-a-f-f",
      "of-fi-ci-al",
    ]) {
      expect(parseUsername(name), name).toEqual(RESERVED_ANSWER);
    }
    // Every reserved name, with a hyphen put between each pair of its characters.
    for (const reserved of RESERVED) {
      const spelled = reserved.replaceAll("-", "").split("").join("-");
      if (spelled.length <= USERNAME_MAX) expect(parseUsername(spelled), spelled).toEqual(RESERVED_ANSWER);
      const squashed = reserved.replaceAll("-", "");
      expect(parseUsername(squashed), squashed).toEqual(RESERVED_ANSWER);
      const split = squashed.slice(0, -1) + "-" + squashed.slice(-1);
      expect(parseUsername(split), split).toEqual(RESERVED_ANSWER);
    }
    // A hyphen in a wrong place is still a shape problem first.
    for (const name of ["-admin", "admin-", "ad--min", "a-d-m-i-n-"]) expect(parseUsername(name), name).toEqual(SHAPE);
    // Only the whole name counts: a reserved word inside a longer name is free.
    for (const name of ["the-admin", "admin1", "admin-1", "root-beer", "supporter", "api-fan", "nullable", "test-pilot", "mod-ern", "raid-team"]) {
      expect(parseUsername(name), name).toEqual(taken(name));
    }
  });

  it("a name that holds the product name is refused, with or without hyphens", () => {
    for (const name of [
      "mythicshot",
      "mythic-shot",
      "mythicshot-support",
      "official-mythicshot",
      "mythic-shot-team",
      "mythicshots",
      "mythicshot1",
      "xmythicshotx",
      "the-mythicshot-fan",
      "m-y-t-h-i-c-s-h-o-t",
      "a-m-y-t-h-i-c-s-h-o-t-9",
      "my-thic-shot-help",
      "MythicShot-Support",
      " MYTHIC-SHOT-TEAM ",
      "not-mythicshot",
      "a".repeat(20) + "mythicshot",
      "mythicshot" + "a".repeat(20),
    ]) {
      expect(parseUsername(name), name).toEqual(RESERVED_ANSWER);
    }
    // Close, but not the name.
    for (const name of ["mythic-fan", "mythics", "mythicshop", "mythic-shop", "shot-mythic", "mythicsho", "ythicshot"]) {
      expect(parseUsername(name), name).toEqual(taken(name));
    }
    // A look-alike of it is a shape problem.
    expect(parseUsername("mythicsh\u043et")).toEqual(SHAPE);
    expect(parseUsername("mythic_shot")).toEqual(SHAPE);
    expect(parseUsername("mythic.shot")).toEqual(SHAPE);
    expect(parseUsername("mythic shot")).toEqual(SHAPE);
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

  it("every top-level path of the app, and every first part of an API path, is reserved", () => {
    // The first part of each route's path, as a word: `/connections` is connections,
    // `/:file{player(...)...}` is player, `/api/v1/openapi.json` is openapi. Parameters are skipped.
    const words = new Set<string>();
    const wordOf = (part: string | undefined): string | null => {
      if (part === undefined || part === "") return null;
      if (part.startsWith(":")) return /\{([a-z][a-z0-9-]*)/.exec(part)?.[1] ?? null;
      return /^([a-z][a-z0-9-]*)/.exec(part)?.[1] ?? null;
    };
    const paths = [...Object.keys(HOST_RULES).map((key) => key.slice(key.indexOf(" ") + 1)), ...[...DASH_PAGES, ...DASH_LINK_PAGES].flatMap((p) => [p.path, p.script.path])];
    for (const path of paths) {
      const parts = path.split("/");
      const top = wordOf(parts[1]);
      if (top !== null) words.add(top);
      if (parts[1] === "api" && parts[2] === "v1") {
        const second = wordOf(parts[3]);
        if (second !== null) words.add(second);
      }
    }
    // The routes are really read: a few that must be among them.
    for (const w of ["connections", "dash", "images", "gifs", "storage", "signin", "invite", "tokens", "connect", "usage", "player", "openapi"]) expect(words, w).toContain(w);
    const free = [...words].filter((w) => w.length >= USERNAME_MIN && parseUsername(w).ok);
    expect(free, "add these to RESERVED_NAMES in src/usernames.ts (and to PLAN_LIST here): a name cannot be taken back once registered").toEqual([]);
    // The one-letter paths (i, r, s, p, t) and me are shorter than any username.
    for (const w of [...words].filter((x) => x.length < USERNAME_MIN)) expect(parseUsername(w), w).toEqual(SHAPE);
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
