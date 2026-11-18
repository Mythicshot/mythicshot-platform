// The part of the reference viewer's global that the page script uses. The viewer's own
// script (src/docs/viewer-assets.ts) defines it; the page loads that script first.

type ViewerRequest = import("./rules.ts").ViewerRequest;

type ViewerOptions = {
  url: string;
  dom_id: string;
  layout: "BaseLayout";
  presets: unknown[];
  validatorUrl: null;
  persistAuthorization: false;
  deepLinking: boolean;
  docExpansion: "list" | "full" | "none";
  defaultModelsExpandDepth: number;
  requestSnippetsEnabled: boolean;
  withCredentials: false;
  requestInterceptor: (req: ViewerRequest) => ViewerRequest;
  onComplete: () => void;
};

/** One request of the description, as the viewer lists it: an immutable map with "path" and "method". */
type ViewerOperation = { get(key: "path" | "method"): string };

/** What starting the viewer gives back; only what "Forget token" needs. */
type ViewerSystem = {
  specSelectors?: { operations?: () => Iterable<ViewerOperation> };
  specActions?: { clearRequest?: (path: string, method: string) => void; clearResponse?: (path: string, method: string) => void };
};

declare const SwaggerUIBundle: { (options: ViewerOptions): ViewerSystem; presets: { apis: unknown } } | undefined;
