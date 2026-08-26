#!/usr/bin/env node
// Per-member dice-tray-model preference data layer (0045_dice_tray_
// preference.sql + src/data-access/diceTrayPreference.ts). Prompt 8a is
// data/plumbing only — no UI, upload flow, or 3D rendering change — so
// there's no browser flow to drive with Playwright; instead this exercises
// the exact query shapes diceTrayPreference.ts issues (a single-row select,
// a batched not-null select, and a count-checked update) against the real,
// running Supabase stack, the verify-seat-offsets.mjs shape. Confirms: a
// member with no stored preference reads back the default; a member can set
// their own preference to reference a real asset_library row and read it
// back exactly; another member (any campaign roster member, not just the
// DM) can read that back through the batched roster query; a member canNOT
// write a DIFFERENT member's preference (RLS blocks it); the paired
// source/assetId CHECK constraint rejects a mismatched combination even
// when issued directly against Postgres (bypassing setDiceTrayPreference's
// own client-side validation); the FK's ON DELETE RESTRICT blocks deleting
// an asset_library row currently referenced by a member's preference; and a
// member can clear their own preference back to the default.
//
// Needs the local Supabase stack (no app server / Playwright browser
// needed for this one — nothing renders yet).
// Usage: node scripts/db/verify-dice-tray-preference.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY;

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

async function makeTestUser(label) {
  const email = `dice-tray-pref-test-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);

  await admin.from("profiles").insert({ id: data.user.id, display_name: `Dice Tray Pref Test ${label}` });

  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);

  return { id: data.user.id, client };
}

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
let campaignId;
let assetId;

try {
  campaignId = crypto.randomUUID();
  await dm.client.from("campaigns").insert({ id: campaignId, name: "Verify-dice-tray-preference test", creator: dm.id });
  await dm.client.from("campaign_members").insert({ campaign_id: campaignId, user_id: dm.id, role: "dm" });

  const { data: campaign } = await dm.client.from("campaigns").select("invite_code").eq("id", campaignId).single();
  await player.client.rpc("join_campaign_by_invite_code", { p_invite_code: campaign.invite_code }).single();

  // A real custom asset_library row for this campaign (DM-only INSERT RLS,
  // 0015) — the "custom uploaded asset" a member's preference can point at.
  const { data: asset, error: assetError } = await dm.client
    .from("asset_library")
    .insert({ name: "Fancy Dice Tray", source_type: "custom", model_ref: `${campaignId}/tray.glb`, campaign_id: campaignId })
    .select()
    .single();
  if (assetError) throw new Error(`creating test asset: ${assetError.message}`);
  assetId = asset.id;

  // 1. getDiceTrayPreference's own query shape: a member with no stored preference.
  const { data: initialRow, error: initialError } = await player.client
    .from("campaign_members")
    .select("dice_tray_source, dice_tray_asset_id")
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id)
    .maybeSingle();
  check(
    "a member who has never chosen a tray model reads back dice_tray_source = null",
    !initialError && initialRow?.dice_tray_source === null && initialRow?.dice_tray_asset_id === null,
    JSON.stringify({ initialError, initialRow })
  );

  // 2. setDiceTrayPreference's own query shape: a member writes their OWN row.
  const { error: ownWriteError, count: ownWriteCount } = await player.client
    .from("campaign_members")
    .update({ dice_tray_source: "custom", dice_tray_asset_id: assetId }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id);
  check(
    "a member can set their own preference to a real asset_library row (count 1, no error)",
    !ownWriteError && ownWriteCount === 1,
    JSON.stringify({ ownWriteError, ownWriteCount })
  );

  const { data: readBack } = await player.client
    .from("campaign_members")
    .select("dice_tray_source, dice_tray_asset_id")
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id)
    .maybeSingle();
  check(
    "reading it back returns the exact stored source/assetId",
    readBack?.dice_tray_source === "custom" && readBack?.dice_tray_asset_id === assetId,
    JSON.stringify(readBack)
  );

  // 3. getDiceTrayPreferencesForCampaign's own query shape, run as a
  // DIFFERENT member (the DM) — confirms the roster-wide SELECT policy
  // covers these two new columns too, not just the owning member's own reads.
  const { data: batched, error: batchedError } = await dm.client
    .from("campaign_members")
    .select("user_id, dice_tray_source, dice_tray_asset_id")
    .eq("campaign_id", campaignId)
    .not("dice_tray_source", "is", null);
  const batchedMap = new Map((batched ?? []).map((row) => [row.user_id, row]));
  const playerEntry = batchedMap.get(player.id);
  check(
    "another member (the DM) can read the player's preference back through the batched roster query",
    !batchedError && batchedMap.size === 1 && playerEntry?.dice_tray_asset_id === assetId,
    JSON.stringify({ batchedError, batched })
  );

  // 4. RLS negative case: the player tries to write the DM's row.
  const { error: crossWriteError, count: crossWriteCount } = await player.client
    .from("campaign_members")
    .update({ dice_tray_source: "custom", dice_tray_asset_id: assetId }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", dm.id);
  check(
    "a member canNOT write a DIFFERENT member's dice tray preference (RLS blocks it: zero rows affected, no thrown error)",
    !crossWriteError && crossWriteCount === 0,
    JSON.stringify({ crossWriteError, crossWriteCount })
  );

  const { data: dmRowAfterAttack } = await dm.client
    .from("campaign_members")
    .select("dice_tray_source")
    .eq("campaign_id", campaignId)
    .eq("user_id", dm.id)
    .maybeSingle();
  check(
    "the DM's own row is untouched by the blocked cross-member write",
    dmRowAfterAttack?.dice_tray_source === null,
    JSON.stringify(dmRowAfterAttack)
  );

  // 5. The paired CHECK constraint itself, issued directly (bypassing
  // setDiceTrayPreference's own client-side validation) — 'custom' with no
  // assetId must be rejected by Postgres, not just the app layer.
  const { error: checkViolationError } = await player.client
    .from("campaign_members")
    .update({ dice_tray_source: "custom", dice_tray_asset_id: null })
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id);
  check(
    "the database rejects 'custom' with no assetId even bypassing the app-layer check",
    !!checkViolationError && /campaign_members_dice_tray_asset_requires_custom/.test(checkViolationError.message ?? ""),
    JSON.stringify(checkViolationError)
  );

  // Restore the valid custom preference the check-violation attempt above
  // didn't actually apply (the whole statement was rejected), just to keep
  // state predictable for step 6 below.
  await player.client
    .from("campaign_members")
    .update({ dice_tray_source: "custom", dice_tray_asset_id: assetId })
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id);

  // 6. ON DELETE RESTRICT: the DM cannot delete an asset a member's
  // preference currently points at.
  const { error: deleteBlockedError } = await dm.client.from("asset_library").delete().eq("id", assetId);
  check(
    "deleting an asset currently referenced by a member's dice tray preference is blocked (FK restrict)",
    !!deleteBlockedError,
    JSON.stringify(deleteBlockedError)
  );

  // 7. Clearing an override back to the computed default (null/null).
  const { error: clearError, count: clearCount } = await player.client
    .from("campaign_members")
    .update({ dice_tray_source: null, dice_tray_asset_id: null }, { count: "exact" })
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id);
  const { data: afterClear } = await player.client
    .from("campaign_members")
    .select("dice_tray_source, dice_tray_asset_id")
    .eq("campaign_id", campaignId)
    .eq("user_id", player.id)
    .maybeSingle();
  check(
    "a member can clear their own preference back to the default (null/null)",
    !clearError && clearCount === 1 && afterClear?.dice_tray_source === null && afterClear?.dice_tray_asset_id === null,
    JSON.stringify({ clearError, clearCount, afterClear })
  );

  // Now that nothing references it, the asset can actually be deleted —
  // confirms step 6's block really was the FK, not some unrelated failure.
  const { error: deleteNowOkError } = await dm.client.from("asset_library").delete().eq("id", assetId);
  check(
    "once cleared, the previously-referenced asset can be deleted normally",
    !deleteNowOkError,
    JSON.stringify(deleteNowOkError)
  );
  assetId = null; // already deleted — skip the finally block's cleanup attempt
} finally {
  if (assetId) await admin.from("asset_library").delete().eq("id", assetId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll dice-tray-preference data-layer checks passed.");
