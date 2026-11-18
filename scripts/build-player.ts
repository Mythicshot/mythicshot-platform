// npm run build:player: regenerates src/player/assets.ts (see scripts/player-bundle.ts).
import { writeFileSync } from "node:fs";
import { assetsModule, ASSETS_MODULE } from "./player-bundle.ts";

writeFileSync(ASSETS_MODULE, await assetsModule());
console.log("wrote src/player/assets.ts");
