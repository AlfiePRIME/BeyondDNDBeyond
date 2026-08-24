"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/data-access/supabase-server";

export async function logout() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export interface FormActionState {
  error?: string;
}
