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
 * UPDATE) is exactly what's meant to authorize this, matching D1's design
 * note that only D3's separate, narrow isAiConfigured() check needs the
 * elevated service-role read this table was built to avoid requiring here.
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
