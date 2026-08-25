#!/usr/bin/env node
// Campaign onboarding verification (Phase 7 acceptance criteria):
//
//   1. Creating a campaign redirects straight into its detail page (not
//      back to the campaigns list).
//   2. Joining a campaign by invite code redirects straight into its
//      detail page.
//   3. The campaign detail page shows the invite code to the DM, and NOT
//      to a non-DM member.
//   4. A viewer with no character of their own, in a campaign that
//      ALREADY has another member's character, still sees a personalized
//      "create your character" prompt — the actual bug being fixed, not
//      just the trivial fully-empty-campaign case.
//   5. Once that viewer creates a character, the personalized prompt
//      disappears for them specifically.
//
// Important RLS wrinkle (migration 0008_character_rls_policies.sql):
// characters' SELECT policy is "owner_id = auth.uid() OR is_campaign_dm(...)"
// — a non-DM player's `listCharactersForCampaign` query only ever returns
// THEIR OWN character(s), never another member's (RLS filters those rows
// out entirely, campaign-mates or not). Only the DM's query returns every
// character in the campaign. So "the campaign-wide list is non-empty but
// I personally have no character" is a state a non-DM player can never
// actually observe — it's only reachable from the DM's own view (DM's
// query sees a player's already-created character while the DM has none
// of their own). This script therefore exercises check #4 from the DM's
// side, which is the only role for which it's a real, reachable state;
// check #5 (prompt disappears once you have your own character) is
// exercised for both roles since that part doesn't depend on RLS breadth.
//
// Needs the local Supabase stack (already running) and a `next dev`
// reachable at APP_URL (defaults to http://localhost:3090 — pick a free
// port since other concurrent worktree agents may already be on :3000;
// this script does not spawn one itself).
//
// Usage: APP_URL=http://localhost:3090 node scripts/db/verify-campaign-onboarding.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = process.env.APP_URL ?? "http://localhost:3090";

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

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

// Same deterministic cookie-injection dance as verify-start-session-threshold.mjs:
// signs a real Supabase session in via the anon client, then hands it to
// Playwright as the sb-*-auth-token cookie the ssr helper reads server-side.
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;
function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `campaign-onboarding-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Onboarding ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

function seedCharacter({ campaignId, ownerId, name }) {
  return admin.from("characters").insert({
    id: crypto.randomUUID(),
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 10,
    max_hp: 10,
    armor_class: 10,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });
}

if (!(await healthOk())) {
  throw new Error(`No app reachable at ${APP_URL} — start it first (e.g. PORT=3090 yarn dev).`);
}

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");

const browser = await chromium.launch();
try {
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();

  // ── 1. Creating a campaign redirects straight into its detail page ──
  await dmPage.goto(`${APP_URL}/campaigns`, { waitUntil: "networkidle" });
  const campaignName = `Onboarding Test ${Date.now()}`;
  await dmPage.getByLabel("Campaign name").fill(campaignName);
  await dmPage.getByRole("button", { name: "Create campaign" }).click();
  await dmPage.waitForURL(/\/campaigns\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });

  const campaignId = new URL(dmPage.url()).pathname.split("/").pop();
  check(
    "creating a campaign redirects straight into its detail page (not the campaigns list)",
    dmPage.url() === `${APP_URL}/campaigns/${campaignId}`
  );

  const { data: campaignRow, error: campaignFetchError } = await admin
    .from("campaigns")
    .select("invite_code")
    .eq("id", campaignId)
    .single();
  if (campaignFetchError) throw campaignFetchError;
  const inviteCode = campaignRow.invite_code;

  // ── 3a. The DM sees their campaign's invite code on the detail page ──
  const dmInviteCodeEl = dmPage.getByTestId("invite-code");
  await dmInviteCodeEl.waitFor({ state: "visible", timeout: 10000 });
  check("the DM sees an invite-code control on the campaign detail page", await dmInviteCodeEl.isVisible());
  const dmInviteCodeText = (await dmInviteCodeEl.textContent()) ?? "";
  check(
    "the displayed invite code matches the campaign's actual invite_code",
    dmInviteCodeText.includes(inviteCode),
    `displayed="${dmInviteCodeText}" actual="${inviteCode}"`
  );

  // ── 2. Joining a campaign via invite code redirects straight into its detail page ──
  const playerContext = await browser.newContext();
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`${APP_URL}/campaigns`, { waitUntil: "networkidle" });
  await playerPage.getByLabel("Invite code").fill(inviteCode);
  await playerPage.getByRole("button", { name: "Join campaign" }).click();
  await playerPage.waitForURL(`${APP_URL}/campaigns/${campaignId}`, { timeout: 15000 });
  check(
    "joining a campaign via invite code redirects straight into its detail page",
    playerPage.url() === `${APP_URL}/campaigns/${campaignId}`
  );

  // ── 3b. A non-DM member does NOT see the invite-code control ──
  check(
    "a non-DM member does not see the invite-code control",
    (await playerPage.getByTestId("invite-code").count()) === 0
  );

  // Both members are characterless right now (campaign is genuinely
  // empty) — sanity-check the trivial case works for both before moving
  // to the actual regression.
  await dmPage.reload({ waitUntil: "networkidle" });
  check(
    "fully-empty case: the DM (no characters exist yet) sees the personalized prompt",
    await dmPage.getByTestId("personal-character-cta").isVisible().catch(() => false)
  );
  check(
    "fully-empty case: the player (no characters exist yet) sees the personalized prompt",
    await playerPage.getByTestId("personal-character-cta").isVisible().catch(() => false)
  );

  // ── 4. The actual bug: seed ONLY the player's character. Because
  //       characters' SELECT RLS is "owner_id = auth.uid() OR
  //       is_campaign_dm(...)", the DM's query now sees this row (DM sees
  //       every character in the campaign) while the DM still owns none —
  //       campaign-wide list is non-empty, but the CURRENT VIEWER (the DM)
  //       still has no character of their own. ──
  const { error: playerCharInsertError } = await seedCharacter({
    campaignId,
    ownerId: player.id,
    name: "Player's Own Hero",
  });
  if (playerCharInsertError) throw playerCharInsertError;

  await dmPage.reload({ waitUntil: "networkidle" });
  check(
    "the campaign-wide 'no characters yet' empty state does NOT show for the DM (the player's character makes the list non-empty)",
    (await dmPage.getByText("No characters yet — create one to join the adventure.").count()) === 0
  );
  check(
    "the DM still sees their own personalized create-a-character prompt even though a player already has one (the actual reported bug)",
    await dmPage.getByTestId("personal-character-cta").isVisible().catch(() => false)
  );

  // The player, meanwhile, now owns a character — their own personalized
  // prompt should have disappeared for them specifically.
  await playerPage.reload({ waitUntil: "networkidle" });
  check(
    "once the player has their own character, the personalized prompt disappears for them specifically",
    (await playerPage.getByTestId("personal-character-cta").count()) === 0
  );

  // ── 5. Now the DM creates their own character too — their personalized
  //       prompt should disappear for them specifically as well. ──
  const { error: dmCharInsertError } = await seedCharacter({
    campaignId,
    ownerId: dm.id,
    name: "Dungeon Master's Own Hero",
  });
  if (dmCharInsertError) throw dmCharInsertError;

  await dmPage.reload({ waitUntil: "networkidle" });
  check(
    "once the DM has their own character, the personalized prompt disappears for the DM specifically",
    (await dmPage.getByTestId("personal-character-cta").count()) === 0
  );

  await dmContext.close();
  await playerContext.close();
} finally {
  await browser.close();
  await admin.from("campaigns").delete().eq("creator", dm.id);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
}

console.log(failures === 0 ? "\nAll campaign-onboarding checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
