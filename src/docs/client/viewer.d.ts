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

/** Starting the viewer gives back its own object, which the page script does not keep. */
declare const SwaggerUIBundle: { (options: ViewerOptions): unknown; presets: { apis: unknown } } | undefined;
