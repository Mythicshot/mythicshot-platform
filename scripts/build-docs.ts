// npm run build:docs: regenerates src/docs/viewer-assets.ts and src/docs/site-assets.ts
// (see scripts/docs-bundle.ts).
import { writeFileSync } from "node:fs";
import { SITE_MODULE, siteModule, VIEWER_MODULE, viewerModule } from "./docs-bundle.ts";

writeFileSync(VIEWER_MODULE, viewerModule());
console.log("wrote src/docs/viewer-assets.ts");
writeFileSync(SITE_MODULE, await siteModule());
console.log("wrote src/docs/site-assets.ts");
