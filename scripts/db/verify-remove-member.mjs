#!/usr/bin/env node
// "The DM needs a way to remove characters from the campaign" feature
// request. The project owner's own explicit, confirmed answer to a
// clarifying question: removing a player is a CLEAN, COMPLETE removal —
// their character(s) in that campaign are deleted too, not left as an
// orphaned row.
//
// What this ships (confirmed by reading the actual code/migrations before
// writing this script, not assumed):
//   - migration 0099_dm_remove_member.sql: a NEW campaign_members DELETE
//     policy, "the DM can remove another member" — is_campaign_dm(campaign_id)
//     AND user_id <> auth.uid() AND role = 'player'. 0011 gave the DM no
//     delete permission on campaign_members at all (not even their own row,
//     deliberately, so a campaign never ends up DM-less); this is the
//     natural complement it never added.
//   - data-access/characters.ts: deleteCharacter(characterId) — 0008's
//     EXISTING "owner or campaign DM can delete a character" policy already
//     covers this, no new RLS needed. map_tokens/character_resources/
//     action_overrides/character_pawns all cascade off characters (0019/
//     0007/0033/0080); roll_log.character_id is ON DELETE SET NULL by
//     design (0030) — a campaign's roll history survives a removed
//     character on purpose.
//   - data-access/campaigns.ts: removeCampaignMember(campaignId,
//     targetUserId) — deletes the MEMBERSHIP ROW FIRST (gated by the new
//     policy above), and only on success deletes the target's character(s)
//     in that campaign. That order is deliberate: if the membership delete
//     is RLS-blocked for ANY reason (wrong caller, DM targeting themself,
//     or — exactly the situation THIS script runs under — the policy not
//     having reached the database yet), NOTHING about the target's
//     characters is ever touched. Fail-safe, not fail-destructive.
//   - UI: campaigns/[id]/page.tsx's new "Remove a player" panel (DM-only,
//     otherPlayers only — never the DM themself), RemoveMemberForm.tsx's
//     per-row two-step confirm (CampaignManageRow's own "delete campaign"
//     shape: a single click only reveals a real are-you-sure step showing
//     the player's name AND their character name(s); nothing is deleted
//     until "Confirm remove" is actually clicked).
//
// IMPORTANT — this script was authored and run BEFORE migration
// 0099_dm_remove_member.sql was applied to the real database (the task
// this was built under explicitly forbids an agent from applying it —
// left for a human to review and run via `node scripts/db/migrate.mjs`).
// There is no non-destructive way to "probe" whether an RLS policy exists
// (unlike a column, you can't just SELECT it) — so Phase 3 below IS the
// real attempt, and its own outcome (0 rows vs 1 row affected) is the
// probe. Every check that depends on the new policy actually being live
// is reported as BLOCKED, not FAIL, when it comes back 0 rows — the
// verify-dm-tray-drag.mjs "probe first, blocked-not-failed" convention,
// reused verbatim in shape. Everything that does NOT depend on the new
// policy (character deletion + its cascade, which 0008 already permits
// today; every RLS-blocks-a-player check; DM-can't-target-themself; every
// UI-rendering/confirm-gating check) runs for real regardless, including a
// real browser-driven click-through with screenshots.
//
// Needs the real dev server (starts `yarn dev` itself if the target port
// isn't already serving) and the real shared Supabase instance this
// project's .env points at. Ephemeral test users/campaign/characters are
// created here and torn down in `finally`.
// Usage: node scripts/db/verify-remove-member.mjs
//        APP_URL=http://localhost:3120 node scripts/db/verify-remove-member.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 6453;
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
const SCREENSHOT_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";

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
let blocked = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}
function skipBlocked(label, reason) {
  console.log(`BLOCKED  ${label} — ${reason}`);
  blocked++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${PORT} — starting this worktree's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 120s`);
}

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
  const email = `remove-member-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `RemoveMember ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

function baseCharacter(overrides) {
  return {
    id: crypto.randomUUID(),
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
    ...overrides,
  };
}

async function loadCampaignPage(page, campaignId) {
  await page.goto(`${APP_URL}/campaigns/${campaignId}`);
  await page.waitForSelector("text=Roster", { timeout: 30000 });
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player1 = await makeTestUser("target");
const player2 = await makeTestUser("bystander");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Remove Member Test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player1.id, role: "player" },
    { campaign_id: campaignId, user_id: player2.id, role: "player" },
  ]);

  // A shared live map to place tokens on, so the cascade-to-map_tokens
  // check is real (0019: map_tokens.character_id references characters ON
  // DELETE CASCADE).
  const mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "Cascade Test Map", grid_width: 10, grid_height: 10 });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // player1 (the removal target) gets TWO characters — the confirmation
  // message and the "character(s)" plural both depend on this. player2
  // (the bystander) gets one — everything about them must survive
  // untouched.
  const char1a = baseCharacter({ campaign_id: campaignId, owner_id: player1.id, name: "Aldric Ironbrand" });
  const char1b = baseCharacter({ campaign_id: campaignId, owner_id: player1.id, name: "Sela Nightwhisper" });
  const char2 = baseCharacter({ campaign_id: campaignId, owner_id: player2.id, name: "Borin Stonefist" });
  await admin.from("characters").insert([char1a, char1b, char2]);

  const token1a = crypto.randomUUID();
  const token1b = crypto.randomUUID();
  const token2 = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: token1a, map_id: mapId, character_id: char1a.id, x: 1, y: 1, allegiance: "party" },
    { id: token1b, map_id: mapId, character_id: char1b.id, x: 2, y: 2, allegiance: "party" },
    { id: token2, map_id: mapId, character_id: char2.id, x: 3, y: 3, allegiance: "party" },
  ]);

  // -------------------------------------------------------------------
  // Phase 1 — RLS checks that are ALWAYS true, independent of whether
  // migration 0099 has been applied: a player has never had, and never
  // gains from this feature, any way to remove another member's row or
  // delete another owner's character; a DM has never had, and never
  // gains, a way to remove THEMSELF via this path.
  // -------------------------------------------------------------------
  {
    const { error, count } = await player2.client
      .from("campaign_members")
      .delete({ count: "exact" })
      .eq("campaign_id", campaignId)
      .eq("user_id", player1.id);
    check(
      "a PLAYER cannot delete another member's campaign_members row via direct API (RLS blocks it: 0 rows affected)",
      !error && count === 0,
      JSON.stringify({ error, count })
    );
  }
  {
    const { data } = await admin
      .from("campaign_members")
      .select("user_id")
      .eq("campaign_id", campaignId)
      .eq("user_id", player1.id)
      .maybeSingle();
    check("player1's membership row is still there after the blocked cross-write attempt", data?.user_id === player1.id);
  }
  {
    const { error, count } = await player2.client
      .from("characters")
      .delete({ count: "exact" })
      .eq("id", char1a.id);
    check(
      "a PLAYER cannot delete another owner's character via direct API either (RLS blocks it: 0 rows affected)",
      !error && count === 0,
      JSON.stringify({ error, count })
    );
  }
  {
    const { error, count } = await dm.client
      .from("campaign_members")
      .delete({ count: "exact" })
      .eq("campaign_id", campaignId)
      .eq("user_id", dm.id);
    check(
      "the DM cannot remove THEMSELF via the same remove-a-member query shape (0 rows affected)",
      !error && count === 0,
      JSON.stringify({ error, count })
    );
  }
  {
    const { data } = await admin
      .from("campaign_members")
      .select("role")
      .eq("campaign_id", campaignId)
      .eq("user_id", dm.id)
      .maybeSingle();
    check("the DM is still the campaign's DM after their own blocked self-removal attempt", data?.role === "dm");
  }

  // -------------------------------------------------------------------
  // Phase 2 — the character-delete half needs NO new migration at all
  // (0008's existing "owner or campaign DM can delete a character" policy
  // already grants this). Deleting char1a directly, as the DM, for real,
  // proves both that permission AND the map_tokens cascade (0019, also
  // pre-existing) — independent of migration 0099's status.
  // -------------------------------------------------------------------
  {
    const { error, count } = await dm.client.from("characters").delete({ count: "exact" }).eq("id", char1a.id);
    check(
      "the DM CAN delete a player's character directly — already fully permitted today, no new RLS needed (0008)",
      !error && count === 1,
      JSON.stringify({ error, count })
    );
  }
  {
    const { data } = await admin.from("map_tokens").select("id").eq("id", token1a);
    check(
      "deleting that character cascades to its map_tokens row (already-existing ON DELETE CASCADE, 0019)",
      (data ?? []).length === 0
    );
  }
  {
    const { data: char1bStill } = await admin.from("characters").select("id").eq("id", char1b.id).maybeSingle();
    const { data: char2Still } = await admin.from("characters").select("id").eq("id", char2.id).maybeSingle();
    check("player1's OTHER character (char1b) is untouched by that single-character delete", char1bStill?.id === char1b.id);
    check("player2's character is completely untouched", char2Still?.id === char2.id);
  }

  // -------------------------------------------------------------------
  // Phase 3 — the real UI, driven by an actual browser. player1 now has
  // exactly one character left (char1b) — the confirmation message's
  // "character" (singular) wording gets exercised here rather than
  // "characters" (plural), covering the other branch of that message.
  // -------------------------------------------------------------------
  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await loadCampaignPage(dmPage, campaignId);

  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "remove-member-before.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "remove-member-before.png")}`);

  check(
    "the DM sees a Remove control for player1",
    (await dmPage.$(`[data-testid="remove-member-button-${player1.id}"]`)) !== null
  );
  check(
    "the DM sees a Remove control for player2 too",
    (await dmPage.$(`[data-testid="remove-member-button-${player2.id}"]`)) !== null
  );
  check(
    "the DM does NOT see a Remove control targeting THEMSELF — the control never even renders for the DM's own row",
    (await dmPage.$(`[data-testid="remove-member-button-${dm.id}"]`)) === null
  );

  // A single click reveals the confirm step ONLY — no network deletion has
  // happened yet.
  await dmPage.click(`[data-testid="remove-member-button-${player1.id}"]`);
  const confirmHint = await dmPage.textContent(`[data-testid="remove-member-confirm-hint-${player1.id}"]`);
  check(
    "the confirm hint names player1's display name",
    (confirmHint ?? "").includes("RemoveMember target"),
    confirmHint ?? ""
  );
  check(
    "the confirm hint names player1's one remaining character (char1b) by name",
    (confirmHint ?? "").includes(char1b.name),
    confirmHint ?? ""
  );
  check(
    'the confirm hint uses the singular "character" (not "characters") for exactly one remaining character',
    /\bcharacter\b(?!s)/.test((confirmHint ?? "").replace("This can't be undone", "")),
    confirmHint ?? ""
  );

  {
    const { data } = await admin
      .from("campaign_members")
      .select("user_id")
      .eq("campaign_id", campaignId)
      .eq("user_id", player1.id)
      .maybeSingle();
    check("a single click alone has NOT removed player1 — their membership row is still there", data?.user_id === player1.id);
  }
  {
    const { data } = await admin.from("characters").select("id").eq("id", char1b.id).maybeSingle();
    check("a single click alone has NOT deleted player1's remaining character", data?.id === char1b.id);
  }

  // Cancel returns to the unconfirmed state.
  await dmPage.click(`[data-testid="remove-member-cancel-${player1.id}"]`);
  check(
    "Cancel returns the row to its unconfirmed state (the Remove button reappears)",
    (await dmPage.$(`[data-testid="remove-member-button-${player1.id}"]`)) !== null
  );

  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "remove-member-confirming.png") });
  // Re-open the confirm step for the real attempt below.
  await dmPage.click(`[data-testid="remove-member-button-${player1.id}"]`);
  await dmPage.waitForSelector(`[data-testid="remove-member-confirm-${player1.id}"]`);
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "remove-member-confirming.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "remove-member-confirming.png")}`);

  // ---------------------------------------------------------------
  // THE real attempt — this is simultaneously the "does the migration
  // exist yet" probe (there is no non-destructive way to check an RLS
  // policy's existence) and the actual functional test.
  // ---------------------------------------------------------------
  await dmPage.click(`[data-testid="remove-member-confirm-${player1.id}"]`);
  await sleep(1500);

  const memberRowAfter = await admin
    .from("campaign_members")
    .select("user_id")
    .eq("campaign_id", campaignId)
    .eq("user_id", player1.id)
    .maybeSingle();
  const migrationApplied = memberRowAfter.data === null;

  if (migrationApplied) {
    console.log("\nmigration 0099_dm_remove_member.sql has been applied — running full live checks.\n");
    check("player1's membership row is gone after confirming removal", memberRowAfter.data === null);

    const { data: char1bAfter } = await admin.from("characters").select("id").eq("id", char1b.id).maybeSingle();
    check("player1's last remaining character is deleted too — the clean, complete removal the project owner chose", char1bAfter === null);

    const { data: token1bAfter } = await admin.from("map_tokens").select("id").eq("id", token1b);
    check("that character's map token is gone too (cascade)", (token1bAfter ?? []).length === 0);

    const { data: player2MemberAfter } = await admin
      .from("campaign_members")
      .select("user_id")
      .eq("campaign_id", campaignId)
      .eq("user_id", player2.id)
      .maybeSingle();
    const { data: char2After } = await admin.from("characters").select("id").eq("id", char2.id).maybeSingle();
    const { data: token2After } = await admin.from("map_tokens").select("id").eq("id", token2);
    check("player2 (the bystander) is completely untouched — still a member", player2MemberAfter?.user_id === player2.id);
    check("player2's character is completely untouched", char2After?.id === char2.id);
    check("player2's map token is completely untouched", (token2After ?? []).length === 1);

    await dmPage.waitForSelector(`[data-testid="remove-member-row-${player1.id}"]`, { state: "detached", timeout: 15000 });
    check(
      "the DM's own page reflects the removal live (revalidatePath) — player1's row disappears from the panel",
      (await dmPage.$(`[data-testid="remove-member-row-${player1.id}"]`)) === null
    );

    await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "remove-member-after.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "remove-member-after.png")}`);
  } else {
    // Fail-safe branch (the one this run actually exercises, since the
    // task this script was built under explicitly forbids applying the
    // migration): removeCampaignMember deletes the membership row FIRST,
    // so an RLS-blocked membership delete must leave EVERYTHING about
    // player1's character(s) untouched too.
    check("player1's membership row is (still, correctly) unaffected — the policy hasn't reached the DB yet", memberRowAfter.data?.user_id === player1.id);

    const errorText = await dmPage.textContent(`[data-testid="remove-member-error-${player1.id}"]`).catch(() => "");
    check(
      "the failed confirm surfaces a clear, visible error rather than a silent no-op or a crash",
      /remove|member/i.test(errorText ?? ""),
      `remove-member-error text: ${JSON.stringify(errorText)}`
    );

    const { data: char1bStillThere } = await admin.from("characters").select("id").eq("id", char1b.id).maybeSingle();
    check(
      "player1's remaining character is STILL there — the deliberate membership-row-first ordering means the blocked membership delete never let character deletion run at all",
      char1bStillThere?.id === char1b.id
    );
    const { data: token1bStillThere } = await admin.from("map_tokens").select("id").eq("id", token1b);
    check("that character's map token is likewise untouched", (token1bStillThere ?? []).length === 1);

    const { data: player2MemberStill } = await admin
      .from("campaign_members")
      .select("user_id")
      .eq("campaign_id", campaignId)
      .eq("user_id", player2.id)
      .maybeSingle();
    check("player2 (the bystander) is completely unaffected by the failed attempt", player2MemberStill?.user_id === player2.id);

    await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "remove-member-blocked.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "remove-member-blocked.png")}`);

    skipBlocked(
      "the confirmed removal actually deletes player1's campaign_members row",
      "migration 0099_dm_remove_member.sql has not been applied yet (deliberately, per this task's own instructions) — apply it via `node scripts/db/migrate.mjs`, then re-run this script"
    );
    skipBlocked("the removal deletes player1's remaining character too", "depends on the same unapplied migration — see above");
    skipBlocked("that character's map token is gone via cascade", "depends on the same unapplied migration — see above");
    skipBlocked(
      "the DM's own page reflects the removal live (player1's row disappears from the panel)",
      "depends on the same unapplied migration — see above"
    );
  }

  // -------------------------------------------------------------------
  // Phase 4 — DM-only UI gating: a player's own page shows no remove-a-
  // player affordance at all (RLS is the real boundary — Phase 1 already
  // proved that directly — this just confirms the UI doesn't even offer
  // the (non-functional, for a player) control in the first place).
  // -------------------------------------------------------------------
  const player2Context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await player2Context.addCookies(sessionCookies(player2.session));
  const player2Page = await player2Context.newPage();
  await loadCampaignPage(player2Page, campaignId);
  check(
    "a PLAYER's own page has no remove-member-panel at all (DM-only gated, same as Transfer DM)",
    (await player2Page.$('[data-testid="remove-member-panel"]')) === null
  );
  await player2Context.close();

  await dmContext.close();
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player1.id);
  await admin.auth.admin.deleteUser(player2.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

console.log(`\n${failures} failure(s), ${blocked} blocked (migration pending) check(s).`);
if (failures > 0) {
  console.error("Remove-member verification FAILED.");
  process.exit(1);
}
console.log(
  blocked > 0
    ? "Remove-member verification PASSED every check runnable today; the rest are BLOCKED pending the (deliberately unapplied) migration 0099_dm_remove_member.sql — see the console notes above."
    : "All remove-member checks passed."
);
process.exit(0);
