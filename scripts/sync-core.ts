// Refreshes the vendored copy of the recorder's shared tour rules and their cases.
//
//   npm run sync:core -- <path to the Mythicshot checkout>
//
// Copies crates/app/src/tour_core.js to src/player/vendor/tour-core.js and
// crates/app/tests/fixtures/tour-core-cases.json to test/fixtures/tour-core-cases.json,
// byte for byte, then prints the SHA-256 of both. test/node-tour-core.test.ts pins those
// hashes: after a sync, paste the printed values into it, run the tests, and rebuild the
// player (npm run build:player), so a change to the rules is always a reviewed commit.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export const COPIES = [
  { from: "crates/app/src/tour_core.js", to: "src/player/vendor/tour-core.js" },
  { from: "crates/app/tests/fixtures/tour-core-cases.json", to: "test/fixtures/tour-core-cases.json" },
] as const;

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main(): void {
  const checkout = process.argv[2];
  if (!checkout) {
    console.error("usage: npm run sync:core -- <path to the Mythicshot checkout>");
    process.exit(2);
  }
  const src = resolve(checkout);
  for (const c of COPIES) {
    if (!existsSync(join(src, c.from))) {
      console.error(`not found: ${join(src, c.from)}`);
      process.exit(1);
    }
  }
  for (const c of COPIES) {
    const to = join(ROOT, c.to);
    copyFileSync(join(src, c.from), to);
    console.log(`${sha256(to)}  ${c.to}`);
  }
  console.log("Record both hashes in test/node-tour-core.test.ts, then run npm test and npm run build:player.");
}

main();
