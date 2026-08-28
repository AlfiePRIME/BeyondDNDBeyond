import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleSupabaseClient } from "./supabase-service-role";

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
 *
 * comfyuiHostUrl/comfyuiStylePrompt (Map Art Generation E2, 0076) are a
 * completely separate axis from activeProvider/openaiApiKeySet/ollama*
 * above — ComfyUI is an independent, always-available-if-configured image
 * pipeline, not one of the text-generation provider choices, so a campaign
 * can have Anthropic active for narrative text AND a ComfyUI host
 * configured for map art at the same time. Unlike openaiApiKey, neither
 * field is a secret (a host URL and a style-prompt string aren't
 * credentials), so both round-trip as plain values here rather than a
 * redacted boolean — there's nothing to protect them from that
 * openaiApiKeySet's redaction exists for.
 */
export interface AppSettings {
  activeProvider: AiProvider;
  openaiApiKeySet: boolean;
  ollamaHostUrl: string | null;
  ollamaModel: string | null;
  comfyuiHostUrl: string | null;
  comfyuiStylePrompt: string | null;
}

/**
 * Returns null only if the singleton row is missing entirely (shouldn't
 * happen post-0072, which seeds it) or RLS hides it from a non-admin caller
 * — both cases the admin page treats the same way (nothing to show).
 */
export async function getAppSettings(supabase: SupabaseClient): Promise<AppSettings | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select(
      "active_provider, openai_api_key, ollama_host_url, ollama_model, comfyui_host_url, comfyui_style_prompt"
    )
    .eq("singleton", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    activeProvider: data.active_provider,
    openaiApiKeySet: !!data.openai_api_key,
    ollamaHostUrl: data.ollama_host_url,
    ollamaModel: data.ollama_model,
    comfyuiHostUrl: data.comfyui_host_url,
    comfyuiStylePrompt: data.comfyui_style_prompt,
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
  comfyuiHostUrl: string | null;
  comfyuiStylePrompt: string | null;
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
    comfyui_host_url: patch.comfyuiHostUrl,
    comfyui_style_prompt: patch.comfyuiStylePrompt,
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

/**
 * Map Art Generation E2 — carries over the exact fix AI Backend & Admin D3
 * had to make for isAiConfigured() (src/ai/activeProvider.ts — read that
 * file's own doc comment for the full reasoning this mirrors), applied to
 * the new ComfyUI columns instead of the text-provider ones: app_settings'
 * RLS (0072) is admin-only SELECT/UPDATE, but "is map art generation
 * configured" is a question the map editor route needs to answer for ANY
 * campaign DM, not just the app-wide admin — and a DM is very likely NOT
 * the global admin. Under a DM's own session, a read of app_settings is
 * flatly denied, so this — like isAiConfigured() — goes around RLS with a
 * narrow, server-side-only service-role read that returns ONLY a boolean,
 * never the row, never comfyui_host_url or comfyui_style_prompt itself.
 *
 * This lives here (data-access/appSettings.ts) rather than inside a future
 * ComfyUI-generation module — unlike isAiConfigured(), which lives in
 * src/ai because it's paired with generateText()'s own provider dispatch,
 * this is pure settings/config logic with no generation-client dependency,
 * so it belongs alongside this table's other accessors. It's exported from
 * the main @/data-access barrel (see index.ts) so a future dedicated
 * ComfyUI-client module (E4) — or any other caller — can import it the
 * same way every other data-access function is imported, no special-cased
 * entry point required.
 *
 * Accepts an optional client purely for unit testing (inject a stub instead
 * of hitting a real database); every real caller calls this with zero
 * arguments, which constructs the real service-role client. Never throws —
 * a transient read failure (or a missing row) resolves to `false` rather
 * than surfacing an error to a page render.
 */
export async function isMapArtConfigured(client?: SupabaseClient): Promise<boolean> {
  try {
    const supabase = client ?? createServiceRoleSupabaseClient();
    const { data, error } = await supabase
      .from("app_settings")
      .select("comfyui_host_url")
      .eq("singleton", true)
      .maybeSingle();

    if (error) throw error;
    return Boolean(data?.comfyui_host_url);
  } catch (err) {
    console.error("isMapArtConfigured: failed to read app_settings", err);
    return false;
  }
}
