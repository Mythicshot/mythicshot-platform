// Placeholder: written after its tests.
export type InviteContact = { kind: "email"; address: string } | { kind: "url"; href: string };
export function inviteContactFrom(_raw: unknown): InviteContact | null {
  return null;
}
