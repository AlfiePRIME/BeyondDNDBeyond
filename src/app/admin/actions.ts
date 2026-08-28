"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import { getProfile, updateAppSettings, type AiProvider } from "@/data-access";

export interface AdminSettingsActionState {
  error?: string;
  success?: boolean;
}

const VALID_PROVIDERS: readonly AiProvider[] = ["anthropic", "openai", "ollama"];

/**
 * Saves the admin settings form. Re-checks session + is_admin here too
 * (not just at the page level) — a Server Action is its own reachable
 * endpoint regardless of which page rendered the <form>, so the page-level
 * redirect alone wouldn't stop a crafted direct POST. updateAppSettings'
 * own RLS-backed zero-rows-affected check is the last, DB-enforced layer
 * below both of these.
 */
export async function updateAppSettingsAction(
  _prevState: AdminSettingsActionState,
  formData: FormData
): Promise<AdminSettingsActionState> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);
  if (!profile?.is_admin) redirect("/");

  const activeProviderRaw = String(formData.get("activeProvider") ?? "");
  if (!VALID_PROVIDERS.includes(activeProviderRaw as AiProvider)) {
    return { error: "Choose a valid provider." };
  }
  const activeProvider = activeProviderRaw as AiProvider;

  // The masked key field is three-way, matching AppSettingsUpdate's own
  // openaiApiKey contract: the "clear" checkbox wins if checked (explicit
  // removal); otherwise a non-empty typed value replaces the stored key;
  // otherwise (blank, not clearing) the stored key is left untouched.
  const clearOpenaiKey = formData.get("clearOpenaiKey") === "on";
  const openaiApiKeyInput = String(formData.get("openaiApiKey") ?? "").trim();
  const openaiApiKey = clearOpenaiKey ? null : openaiApiKeyInput ? openaiApiKeyInput : undefined;

  const ollamaHostUrl = String(formData.get("ollamaHostUrl") ?? "").trim() || null;
  const ollamaModel = String(formData.get("ollamaModel") ?? "").trim() || null;

  // Map Art Generation E2: comfyuiHostUrl/comfyuiStylePrompt are a separate,
  // independent axis from the AI text-provider fields above (see
  // appSettings.ts's AppSettings doc comment) — neither is a secret, so
  // both are plain trimmed-or-null strings, no masking/three-way contract
  // needed (unlike openaiApiKey above).
  const comfyuiHostUrl = String(formData.get("comfyuiHostUrl") ?? "").trim() || null;
  const comfyuiStylePrompt = String(formData.get("comfyuiStylePrompt") ?? "").trim() || null;

  try {
    await updateAppSettings(supabase, {
      activeProvider,
      openaiApiKey,
      ollamaHostUrl,
      ollamaModel,
      comfyuiHostUrl,
      comfyuiStylePrompt,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save settings." };
  }

  revalidatePath("/admin");
  return { success: true };
}

export interface ComfyUiConnectionTestResult {
  ok: boolean;
  message: string;
}

/**
 * Map Art Generation E2's minimal "test connection" check — a real
 * server-side fetch to the given ComfyUI host's own `/system_stats`
 * endpoint (E1's research spike, docs/map-art-generation-research.md
 * §3, confirmed this is the real health-check shape ComfyUI exposes:
 * `{system: {...}, devices: [{name, vram_total, vram_free, ...}]}`).
 *
 * Deliberately NOT wired through useActionState/a <form action> — it's
 * called directly from the client component (a plain async Server Action
 * invocation, same as any other "use server" export) so it can check
 * whatever host URL is CURRENTLY TYPED into the form, whether or not that
 * value has been saved yet. Re-checks session + is_admin here too, same
 * defense-in-depth reasoning as updateAppSettingsAction above — this
 * performs an outbound network request an admin triggers, so it shouldn't
 * be reachable by a non-admin even though it never touches app_settings
 * itself (no DB read/write at all; the host URL comes from the caller's own
 * argument, not a stored value).
 */
export async function testComfyUiConnection(hostUrl: string): Promise<ComfyUiConnectionTestResult> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const profile = await getProfile(supabase, user.id);
  if (!profile?.is_admin) redirect("/");

  const trimmed = hostUrl.trim();
  if (!trimmed) {
    return { ok: false, message: "Enter a host URL first." };
  }

  let statsUrl: URL;
  try {
    statsUrl = new URL("/system_stats", trimmed);
  } catch {
    return { ok: false, message: "That doesn't look like a valid URL." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(statsUrl, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      return { ok: false, message: `ComfyUI responded with HTTP ${res.status}.` };
    }
    const stats: unknown = await res.json().catch(() => null);
    const deviceName =
      stats && typeof stats === "object" && Array.isArray((stats as { devices?: unknown[] }).devices)
        ? (stats as { devices: Array<{ name?: string }> }).devices[0]?.name
        : undefined;
    return { ok: true, message: deviceName ? `Reachable — ${deviceName}` : "Reachable." };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? `Could not reach ComfyUI: ${err.message}` : "Could not reach ComfyUI.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
