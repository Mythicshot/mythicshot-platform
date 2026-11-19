import type { Hono } from "hono";
import type { Deps } from "./ports.ts";

export const ADMIN_PAGE = 100;

export function adminRoutes(_app: Hono, _deps: Deps): void {}
