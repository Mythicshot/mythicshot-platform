// The part of the reference viewer's global that the page script uses. The viewer's own
// script (src/docs/viewer-assets.ts) defines it; the page loads that script first.

/** A request the viewer is about to send, as its interceptor sees it. */
type ViewerRequest = { url: string; method?: string; credentials?: string; headers: Record<string, string> };

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
  requestInterceptor?: (req: ViewerRequest) => ViewerRequest;
};

declare const SwaggerUIBundle: { (options: ViewerOptions): unknown; presets: { apis: unknown } } | undefined;
