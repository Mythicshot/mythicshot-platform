// Placeholder: the sign-in pages' routes are written after their tests.
import type { Hono } from "hono";
import type { Deps } from "./ports.ts";

export const ACCOUNT_PAGE_HEADERS: Readonly<Record<string, string>> = {};

export function pageRoutesForAccounts(_app: Hono, _deps: Deps): void {}
