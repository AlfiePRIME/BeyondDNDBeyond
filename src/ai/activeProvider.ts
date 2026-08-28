import { getRawAiProviderConfig, type AiProvider, type SupabaseClient } from "@/data-access";
import { createServiceRoleSupabaseClient } from "@/data-access/supabase-service-role";

/**
 * The real access-control problem this file solves: D1's RLS restricts
 * app_settings to admins only (0072, is_app_admin()-gated), but
 * isAiConfigured() is called from ordinary page-level code (maps/[mapId]/
 * edit/page.tsx, the lore pages, npcs/page.tsx) to decide whether ANY
 * signed-in user — not just admins — sees a "Generate" button. Under a
 * normal user's own RLS-scoped session, a read of app_settings is flatly
 * denied, which would silently break the Generate button for every
 * non-admin DM the moment app_settings existed. Pre-D1, isAiConfigured()
 * had no auth story at all — it just read an env var — so this is a real
 * regression risk introduced by D1, not a pre-existing one, and this file
 * is what closes it.
 *
 * Why a service-role read is the only way to close it: Postgres/RLS has no
 * visibility into the Node process's own environment (ANTHROPIC_API_KEY),
 * so part of "is the active provider configured" can only ever be answered
 * in application code — and that code needs BOTH the env var and this
 * table's active_provider/secret-presence to answer correctly. A non-admin
 * still legitimately needs a yes/no answer to render their own UI, without
 * ever being granted (or even routed through) read access to the row
 * itself. createServiceRoleSupabaseClient() (@/data-access/supabase-
 * service-role) is that narrow, server-side-only, RLS-bypassing client —
 * the same service-role credential pattern this project's own
 * scripts/db/*.mjs scripts have always used for out-of-band setup/
 * assertions, now used for the first time inside real application code.
 * See that file's own doc comment for the full reasoning, and
 * getRawAiProviderConfig's doc comment (src/data-access/appSettings.ts) for
 * why it — not the redacted, admin-UI-facing getAppSettings — is what this
 * file reads.
 *
 * Exactly two things in this whole module ever call
 * createServiceRoleSupabaseClient()/getRawAiProviderConfig(): isAiConfigured
 * below (returns ONLY a boolean — never the row, never any secret value,
 * regardless of who calls it) and resolveActiveProvider (used only by
 * generateText.ts's own dispatch, to decide which provider implementation
 * to call and what credential/host to hand it — never returned to whoever
 * asked for generated text, which only ever gets the generated string
 * back). Both accept an optional client parameter purely for unit testing
 * (inject a stub instead of hitting a real database) — every real caller in
 * this app calls both with zero arguments, which is what constructs the
 * real service-role client.
 */
async function readRawConfig(client?: SupabaseClient) {
  const supabase = client ?? createServiceRoleSupabaseClient();
  return getRawAiProviderConfig(supabase);
}

/**
 * Whether the ACTIVE provider (app_settings.active_provider, 0072) is fully
 * usable right now — not just "is Anthropic's env var set," which is all
 * this function checked before D1 introduced other providers. Server-side
 * only, same as before: call it from Server Components/Route Handlers and
 * pass the boolean down, never from client code.
 *
 * Never throws — a transient read failure (or a missing row, which
 * shouldn't happen post-0072's seed insert) resolves to `false` rather than
 * surfacing an error to a page render, matching this function's pre-D1
 * always-succeeds-with-a-boolean contract.
 */
export async function isAiConfigured(client?: SupabaseClient): Promise<boolean> {
  try {
    const config = await readRawConfig(client);
    const provider: AiProvider = config?.activeProvider ?? "anthropic";
    switch (provider) {
      case "anthropic":
        return Boolean(process.env.ANTHROPIC_API_KEY);
      case "openai":
        return Boolean(config?.openaiApiKey);
      case "ollama":
        return Boolean(config?.ollamaHostUrl && config?.ollamaModel);
      default:
        return false;
    }
  } catch (err) {
    console.error("isAiConfigured: failed to read app_settings", err);
    return false;
  }
}

/** Internal — resolveActiveProvider's own return shape. Never barrel-
 * exported and never handed back to a generateText() caller; see this
 * file's own header comment. */
export interface ResolvedProvider {
  provider: AiProvider;
  openaiApiKey?: string;
  ollamaHostUrl?: string;
  ollamaModel?: string;
}

/**
 * Internal — used only by generateText.ts's dispatch to decide which
 * provider implementation to call and what credential/host to pass it.
 * Unlike isAiConfigured, this DOES propagate a read failure to its caller
 * (generateText()) rather than silently defaulting: a page deciding
 * whether to show a button should never break on a transient DB hiccup,
 * but an actual generation attempt that can't even determine which
 * provider to call should fail loudly and specifically, not silently fall
 * back to a provider the admin didn't choose.
 */
export async function resolveActiveProvider(client?: SupabaseClient): Promise<ResolvedProvider> {
  const config = await readRawConfig(client);
  const provider: AiProvider = config?.activeProvider ?? "anthropic";
  return {
    provider,
    openaiApiKey: config?.openaiApiKey ?? undefined,
    ollamaHostUrl: config?.ollamaHostUrl ?? undefined,
    ollamaModel: config?.ollamaModel ?? undefined,
  };
}
