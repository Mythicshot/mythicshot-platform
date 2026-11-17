// Types for the vendored rules file (tour-core.js, a byte-for-byte copy refreshed by
// scripts/sync-core.ts). The bundler wraps its CommonJS export, so main.ts imports it as
// the default export.
type Side = "bottom" | "top" | "right" | "left" | "none" | "docked";
type AvoidBox = { x0: number; y0: number; x1: number; y1: number };
declare const TourCore: {
  placeCard(imgW: number, imgH: number, cardW: number, cardH: number, avoid: AvoidBox | null, placement: string): { x: number; y: number; side: Side };
  zoomOffset(viewW: number, viewH: number, focusX: number, focusY: number, k: number): { tx: number; ty: number };
  parseBold(text: unknown): { text: string; bold: boolean }[];
  cleanText(s: unknown, max: number, multiline: boolean): string;
  safeUrl(s: unknown): string | null;
  num(v: unknown, lo: number, hi: number, fallback: number): number;
  color<T>(v: unknown, fallback: T): string | T;
};
export default TourCore;
