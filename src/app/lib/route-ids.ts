import { notFound } from "next/navigation";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A mistyped or truncated link id would otherwise reach Postgres as an
 * invalid uuid (error 22P02) and surface as a 500 — send it to the 404 page
 * instead. */
export function requireUuid(...ids: string[]): void {
  if (!ids.every((id) => UUID_PATTERN.test(id))) notFound();
}
