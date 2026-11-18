// The documentation page's script. For now it only starts the reference viewer on the
// description this server hands out; the token box, the copy buttons and the request
// interceptor come with the page itself.
//
// Browser code: bundled by scripts/docs-bundle.ts into src/docs/site-assets.ts, and
// type-checked on its own with the DOM library (tsconfig.docs.json).

/** Where the viewer draws the reference. */
const MOUNT = "#reference";

function start(): void {
  if (typeof SwaggerUIBundle === "undefined" || document.querySelector(MOUNT) === null) return;
  SwaggerUIBundle({
    url: "/api/v1/openapi.json",
    dom_id: MOUNT,
    layout: "BaseLayout",
    presets: [SwaggerUIBundle.presets.apis],
    // The viewer would otherwise load a badge from its maker's validator site.
    validatorUrl: null,
    // Nothing a visitor enters is written to the browser's storage.
    persistAuthorization: false,
    deepLinking: true,
    docExpansion: "list",
    defaultModelsExpandDepth: -1,
    requestSnippetsEnabled: true,
    withCredentials: false,
  });
}

start();

export {};
