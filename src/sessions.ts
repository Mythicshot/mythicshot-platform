// Sessions and sign-in codes. Stub: every function is still to be written.
import type { Deps } from "./ports.ts";

export const SESSION_COOKIE = "__Host-dp_session";
export const SESSION_MS = 2_592_000_000;
export const SESSION_TOUCH_MS = 3_600_000;
export const SIGNIN_CODE_MS = 900_000;
export const SWEEP_PAGE = 200;
export const REVOKED_KEPT_MS = 2_592_000_000;
export const CODE_KEPT_MS = 86_400_000;

const todo = (): never => {
  throw new Error("not written yet");
};

export function readSessionCookie(_req: Request): string | null {
  return todo();
}
export function sessionCookiePresent(_req: Request): boolean {
  return todo();
}
export function sessionHost(_req: Request, _deps: Deps): boolean {
  return todo();
}
export function sessionCookie(_secret: string): string {
  return todo();
}
export function clearedCookie(): string {
  return todo();
}
export function csrfFor(_secret: string): Promise<string> {
  return todo();
}
export function sameOriginChange(_req: Request): boolean {
  return todo();
}
export function sessionLabel(_userAgent: string | null): string {
  return todo();
}
export function createSignInCode(_deps: Deps, _userId: string): Promise<string> {
  return todo();
}
export function redeemSignInCode(_deps: Deps, _code: string, _label: string, _replaces: string | null): Promise<{ secret: string; sessionId: string; userId: string } | null> {
  return todo();
}
export function resolveSession(_req: Request, _deps: Deps): Promise<{ sessionId: string; userId: string; workspaceId: string; admin: boolean; secret: string } | null> {
  return todo();
}
export function revokeSession(_deps: Deps, _userId: string, _sessionId: string, _event: "signout" | "session_revoked" = "session_revoked"): Promise<boolean> {
  return todo();
}
export function revokeAll(_deps: Deps, _userId: string): Promise<void> {
  return todo();
}
export function sweepSessions(_deps: Deps): Promise<void> {
  return todo();
}
