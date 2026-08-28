import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

/**
 * A FOURTH, deliberate sub-entry-point into data-access (alongside
 * supabase-server/supabase-browser/supabase-middleware — see the module
 * header comment on index.ts), and a genuinely new pattern for this
 * codebase: every other Supabase client this project constructs is scoped
 * to a caller's own session (cookies in Server Components/Actions/Route
 * Handlers, the browser session in Client Components, the request cookies
 * in edge middleware) and is therefore fully subject to RLS. This one is
 * not — it authenticates as the service role, which bypasses RLS entirely,
 * exactly like this project's own scripts/db/*.mjs admin scripts (see e.g.
 * verify-admin-role.mjs, verify-admin-settings-ui.mjs) that already use this
 * same credential/client-construction pattern for out-of-band DB setup and
 * assertions. This is the first time that pattern is used inside REAL
 * application code (src/ai — see its own doc comments) rather than a
 * one-off verification script.
 *
 * Why this exception is necessary rather than a shortcut: app_settings'
 * whole point (0072) is that an ordinary user's session — including a
 * non-admin DM who legitimately needs to know whether the "Generate" button
 * should be enabled, and legitimately needs their generation request to
 * actually use whichever provider an admin configured — can NEVER read this
 * table (its RLS is is_app_admin()-gated SELECT/UPDATE only, on purpose).
 * Postgres/RLS has no visibility into the Node process's own environment
 * (e.g. ANTHROPIC_API_KEY), so "is a provider fully configured" can only
 * ever be answered by application code that can see BOTH the env var AND
 * this table — and that code cannot run under the calling user's own
 * session without breaking the "non-admin can't read app_settings" property
 * D1 deliberately built. A narrow, server-side-only, service-role read is
 * the only way to close that gap. See src/ai/activeProvider.ts for the
 * exactly two call sites that use it, and the guarantees each one upholds
 * about never leaking this table's contents back to whoever asked.
 *
 * Server-side only, like the other three functions in this file's sibling
 * modules — never import this from a Client Component or let its result
 * cross into a client bundle. Fresh client per call (no shared/singleton
 * instance), matching every other create*Client function in this module.
 *
 * The two requireEnv() calls are deliberately INSIDE this function body, not
 * at module top level (a real bug found and fixed while building Map Art
 * Generation E4 — see that prompt's own report for the full repro): this
 * module's exports (via appSettings.ts's isMapArtConfigured/
 * getRawMapArtConfig/getRawAiProviderConfig) are re-exported from the MAIN
 * @/data-access barrel, which plenty of legitimate Client Components (e.g.
 * MapEditor.tsx) import from for entirely unrelated functions. A module-
 * top-level `requireEnv` throws the instant this file is EVALUATED — which
 * happens whenever anything imports @/data-access at all, since ES module
 * linking evaluates every `export ... from` target in a barrel regardless of
 * which specific bindings the importer actually uses. SUPABASE_SERVICE_ROLE_
 * KEY is never inlined into a client bundle (it isn't NEXT_PUBLIC_-
 * prefixed), so that eager check unconditionally crashed EVERY Client
 * Component's module instantiation the moment it (transitively) imported
 * @/data-access — not just ones that actually call this function. Moving
 * the check inside the function body means merely importing/bundling this
 * file (dead code, in a client bundle that never calls it) is inert; calling
 * it without the env var still throws immediately and specifically, exactly
 * as before.
 */
export function createServiceRoleSupabaseClient(): SupabaseClient {
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = requireEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
