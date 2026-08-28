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

  try {
    await updateAppSettings(supabase, { activeProvider, openaiApiKey, ollamaHostUrl, ollamaModel });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save settings." };
  }

  revalidatePath("/admin");
  return { success: true };
}
