// The sign-in lifetimes on the Node target: read from the environment into the config, listed
// in NODE_SETTINGS, never a reason to stop, said in one fixed line each by the entry when they
// cannot be used, and passed on by every install path. The rules themselves are tested in
// test/lifetimes.test.ts, on both targets.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIFETIME_SETTINGS } from "../src/lifetimes.ts";
import { NODE_SETTINGS, configFromEnv } from "../src/node/config.ts";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the sign-in lifetimes on Node", () => {
  it("reach the config when they change a default; unset, empty, default or unusable leave the config as it was and never stop the start", () => {
    expect(configFromEnv({ SESSION_MAX_DAYS: "30", CONNECTION_IDLE_DAYS: "OFF", CONNECTION_MAX_DAYS: " 365 " }).lifetimes).toEqual({ sessionMaxDays: 30, connectionIdleDays: null, connectionMaxDays: 365 });
    for (const v of [undefined, "", "  ", "90", "-1", "3651", "ninety"]) {
      expect(() => configFromEnv({ SESSION_MAX_DAYS: v, CONNECTION_IDLE_DAYS: v }), String(v)).not.toThrow();
      expect("lifetimes" in configFromEnv({ SESSION_MAX_DAYS: v, CONNECTION_IDLE_DAYS: v }), String(v)).toBe(false);
    }
    for (const name of LIFETIME_SETTINGS) expect(NODE_SETTINGS).toContain(name);
  });

  it("the entry writes the one fixed line for each value it cannot use, and goes on", () => {
    expect(read("../src/node/entry.ts")).toContain("  for (const line of lifetimesSetting(process.env).problems) console.error(line);\n");
  });

  it("are passed on by the cPanel startup file, the tunnel stack and its copy in install.sh, and kept by the Cloudflare update", () => {
    for (const name of LIFETIME_SETTINGS) {
      expect(read("../deploy/cpanel/app.cjs"), name).toContain(name);
      expect(read("../deploy/tunnel/docker-compose.yml"), name).toContain(`      ${name}: \${${name}:-}\n`);
      expect(read("../deploy/install.sh"), name).toContain(`      ${name}: \${${name}:-}\n`);
      expect(read("../scripts/setup-cloudflare.ts"), name).toMatch(new RegExp(`const KEPT_VARS = \\[[^\\]]*"${name}"[^\\]]*\\] as const;`));
      for (const guide of ["../docs/hosting/cpanel.md", "../docs/runbook-docker.md", "../docs/runbook-cloudflare.md"]) expect(read(guide), `${guide} ${name}`).toContain(name);
    }
  });
});
