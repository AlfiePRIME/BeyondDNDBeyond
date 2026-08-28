import type { SupabaseClient } from "@supabase/supabase-js";

/** app_settings.active_provider's own check constraint (0072). */
export type AiProvider = "anthropic" | "openai" | "ollama";

/**
 * AI Backend & Admin D2's own view of app_settings (0072) for the admin
 * settings UI — deliberately NEVER carries the actual openai_api_key value,
 * only whether one is currently set. getAppSettings below has to read the
 * real column to compute that boolean, but the plaintext is discarded
 * before this function returns — it never survives past this stack frame,
 * so it can never end up serialized into a Server Component's props/RSC
 * payload sent to the browser, which passing the raw row straight through
 * would risk. Read/write both go through the CALLER's own session (not a
 * service-role client) — app_settings' RLS (is_app_admin()-gated SELECT/
 * UPDATE) is exactly what's meant to authorize this. D3 adds the separate,
 * narrow service-role reads this table was built to avoid requiring here —
 * see getRawAiProviderConfig below and src/ai/activeProvider.ts.
 */
export interface AppSettings {
  activeProvider: AiProvider;
  openaiApiKeySet: boolean;
  ollamaHostUrl: string | null;
  ollamaModel: string | null;
}

/**
 * Returns null only if the singleton row is missing entirely (shouldn't
 * happen post-0072, which seeds it) or RLS hides it from a non-admin caller
 * — both cases the admin page treats the same way (nothing to show).
 */
export async function getAppSettings(supabase: SupabaseClient): Promise<AppSettings | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("active_provider, openai_api_key, ollama_host_url, ollama_model")
    .eq("singleton", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    activeProvider: data.active_provider,
    openaiApiKeySet: !!data.openai_api_key,
    ollamaHostUrl: data.ollama_host_url,
    ollamaModel: data.ollama_model,
  };
}

/**
 * openaiApiKey is deliberately three-way: `undefined` leaves the stored key
 * untouched (the admin left the masked field blank — not "clear it"),
 * `null` clears it, a non-empty string replaces it. This is the "way to
 * replace it" the masked field needs without ever round-tripping the old
 * value back through the form.
 */
export interface AppSettingsUpdate {
  activeProvider: AiProvider;
  openaiApiKey?: string | null;
  ollamaHostUrl: string | null;
  ollamaModel: string | null;
}

/**
 * Plain column write through app_settings' own UPDATE RLS (0072,
 * is_app_admin()-gated) under the caller's session — the setActionEconomyStrict/
 * setDayNightMode/setHouseRules shape exactly, including the same
 * zero-rows-affected-means-not-authorized detection, so a non-admin who
 * somehow reaches this function (defense in depth below the page-level
 * gate) gets a clear error instead of a silent no-op.
 */
export async function updateAppSettings(supabase: SupabaseClient, patch: AppSettingsUpdate): Promise<void> {
  const update: Record<string, unknown> = {
    active_provider: patch.activeProvider,
    ollama_host_url: patch.ollamaHostUrl,
    ollama_model: patch.ollamaModel,
  };
  if (patch.openaiApiKey !== undefined) update.openai_api_key = patch.openaiApiKey;

  const { error, count } = await supabase
    .from("app_settings")
    .update(update, { count: "exact" })
    .eq("singleton", true);

  if (error) throw error;
  if (count === 0) throw new Error("Only an app admin can update these settings.");
}

/**
 * The RAW row — including the actual openai_api_key plaintext — for
 * AI Backend & Admin D3's internal use ONLY: resolving which real backend
 * an actual generateText() call should hit and what credential/host to use.
 * This is deliberately a different function from getAppSettings above, not
 * a variant of it — getAppSettings' entire reason for existing is to NEVER
 * carry the plaintext key past its own return value (for the admin UI,
 * under the admin's own session); this function's entire reason for
 * existing is the opposite: something server-side has to see the real
 * secret to ever call OpenAI/Ollama with it.
 *
 * Callers MUST pass a service-role client (see
 * @/data-access/supabase-service-role) — never the caller's own session
 * client, since app_settings' RLS would reject a non-admin's read of this
 * table entirely, which is exactly the case a DM's own "Generate" action
 * needs to keep working through. Callers MUST also never let this return
 * value escape their own function's stack frame (src/ai/activeProvider.ts
 * is the only caller; its own doc comment covers the two narrow, boolean-
 * or-immediately-consumed-only uses this feeds).
 */
export interface RawAiProviderConfig {
  activeProvider: AiProvider;
  openaiApiKey: string | null;
  ollamaHostUrl: string | null;
  ollamaModel: string | null;
}

export async function getRawAiProviderConfig(
  supabase: SupabaseClient
): Promise<RawAiProviderConfig | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("active_provider, openai_api_key, ollama_host_url, ollama_model")
    .eq("singleton", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    activeProvider: data.active_provider,
    openaiApiKey: data.openai_api_key,
    ollamaHostUrl: data.ollama_host_url,
    ollamaModel: data.ollama_model,
  };
}
