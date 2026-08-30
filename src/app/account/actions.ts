"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/data-access/supabase-server";
import {
  upsertProfile,
  renameCampaign,
  deleteCampaign,
  leaveCampaign,
  updateCharacter,
  deleteCharacter,
} from "@/data-access";
import type { FormActionState } from "../actions";

export async function updateDisplayNameAction(
  _prevState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  const displayName = String(formData.get("displayName") ?? "").trim();
  if (!displayName) {
    return { error: "A display name is required." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    await upsertProfile(supabase, user.id, { displayName });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not save your display name." };
  }

  revalidatePath("/account");
  revalidatePath("/");
  return {};
}

export async function renameCampaignAction(
  campaignId: string,
  _prevState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "Campaign name is required." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    await renameCampaign(supabase, campaignId, name);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not rename the campaign." };
  }

  revalidatePath("/account");
  revalidatePath("/campaigns");
  revalidatePath(`/campaigns/${campaignId}`);
  return {};
}

export async function deleteCampaignAction(campaignId: string): Promise<FormActionState> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    await deleteCampaign(supabase, campaignId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not delete the campaign." };
  }

  revalidatePath("/account");
  revalidatePath("/campaigns");
  return {};
}

export async function leaveCampaignAction(campaignId: string): Promise<FormActionState> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    await leaveCampaign(supabase, campaignId, user.id);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not leave the campaign." };
  }

  revalidatePath("/account");
  revalidatePath("/campaigns");
  return {};
}

export async function renameCharacterAction(
  characterId: string,
  _prevState: FormActionState,
  formData: FormData
): Promise<FormActionState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "A character name is required." };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    await updateCharacter(supabase, characterId, { name });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not rename the character." };
  }

  revalidatePath("/account");
  return {};
}

export async function deleteCharacterAction(characterId: string): Promise<FormActionState> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  try {
    await deleteCharacter(supabase, characterId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not delete the character." };
  }

  revalidatePath("/account");
  return {};
}
