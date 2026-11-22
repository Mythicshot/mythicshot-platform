// npm run build:brand: regenerates src/brand-assets.ts (see scripts/brand-bundle.ts).
import { writeFileSync } from "node:fs";
import { BRAND_MODULE, brandModule } from "./brand-bundle.ts";

writeFileSync(BRAND_MODULE, brandModule());
console.log("wrote src/brand-assets.ts");
