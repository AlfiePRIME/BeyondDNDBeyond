#!/usr/bin/env node
// "the player Character manager plage the DM users doesn't apply effects to
// the live game/ character changes, please can this be implemented" — the DM
// Party Dashboard (/campaigns/:id/party) awards XP, applies conditions,
// grants advantage/disadvantage, and runs the level-up wizard, but none of
// that ever reached an already-open Game Room tab. Confirmed root cause by
// reading the code: GameRoom.tsx keeps its own `characterRows` state fresh
// via refreshCombat(), called from specific IN-ROOM trigger points (a roll,
// a rest, damage, the room's own COMBAT_EVENT broadcast) — it never
// subscribed to the `characters` table directly, unlike PartyDashboard.tsx
// (subscribeToCampaignCharacterChanges) and CharacterSheet.tsx
// (subscribeToCharacterConditionChanges). A dashboard write reached an open
// Game Room only by accident, on the next unrelated refreshCombat() call, or
// a reload.
//
// The fix (GameRoom.tsx): two new postgres_changes subscriptions, mirroring
// this file's own existing conventions exactly —
//   1. subscribeToCampaignCharacterChanges: merges the updated row into
//      characterRows by id (applyItemTaken's own
//      `setCharacterRows((rows) => rows.map(...))` shape), guarded by
//      `updated_at` so a slow refreshCombat racing this subscription can
//      never clobber a newer row with a stale one. Covers XP, level-up
//      (level/HP/subclass/ability scores), and pending_roll_mode.
//   2. subscribeToCombatantConditionChanges: a payload-free poke ->
//      refreshCombat(), the exact shape subscribeToCombatantHiddenFromChanges
//      already uses just above it. Covers the dashboard's condition
//      apply/remove, which mirrors onto combatant_conditions (a direct table
//      write PartyDashboard.tsx makes with NO broadcast) while the character
//      has a live combatant.
//
// This script seeds one DM, one player, a campaign, one character IN AN
// ACTIVE COMBAT ENCOUNTER (so combatant-hp-/combatant-conditions- render —
// Game Room's condition badges are combat-scoped by design, confirmed by
// reading GameRoom.tsx's conditionLabelsByTokenId), opens the DM's Game
// Room tab, the DM's Party Dashboard tab, and a separate player's Game Room
// tab — NONE of them ever reloaded — and drives every change from the
// dashboard tab, asserting the two already-open Game Room tabs reflect it:
//   - an XP award crossing a level threshold + running the level-up wizard
//     (level/current_hp/max_hp all change on one row)
//   - a condition applied, then removed, from the dashboard
//   - a DM-granted advantage flag, consumed by a REAL roll POSTed from the
//     player's own already-open Game Room tab (the roll route re-reads
//     pending_roll_mode from the DB itself server-side — always correct,
//     confirmed by reading roll/route.ts — so this checks the full player-
//     facing scenario, not the subscription specifically)
// ...and finally a regression pass: the EXISTING in-room damage/heal path
// (CombatPanel's own DM controls, the COMBAT_EVENT broadcast) still works
// correctly and settles on the right value with the new subscription also
// listening — no double-apply, no clobber.
//
// Needs the real dev server (starts `yarn dev` itself if the target port
// isn't already serving) and the real shared Supabase instance this
// project's .env points at. Ephemeral test users/campaign/character are
// created here and torn down in `finally`.
// Usage: node scripts/db/verify-gameroom-character-live-sync.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 6499;
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
const SCREENSHOT_DIR =
  process.env.SCREENSHOT_DIR ??
  "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";

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
  console.log(`dev server not running on :${PORT} — starting this checkout's own…`);
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
  const email = `room-char-sync-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `RoomSync ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session };
}

/** Polls a Game Room tab's DOM for `predicate` to go true, with NO reload —
 * the whole point of this script. Returns whether it actually happened
 * (never throws), so a genuine regression shows as a FAIL, not a crash. */
async function waitForLiveText(page, testId, expectedSubstring, timeout = 15000) {
  return page
    .waitForFunction(
      ({ selector, expected }) => (document.querySelector(selector)?.textContent ?? "").includes(expected),
      { selector: `[data-testid="${testId}"]`, expected: expectedSubstring },
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

async function waitForLiveAbsence(page, testId, timeout = 15000) {
  return page
    .waitForFunction(
      (selector) => document.querySelector(selector) === null,
      `[data-testid="${testId}"]`,
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

await ensureDevServer();

// Non-destructive migration probe (0101_dm_party_dashboard.sql) — the
// dashboard has been live in this project for a while now, so this should
// always be applied, but probing costs nothing and keeps this script honest
// if it's ever run against a fresher database.
const probe = await admin.from("characters").select("xp, pending_roll_mode").limit(1);
const migrationApplied = !probe.error;
console.log(
  migrationApplied
    ? "migration 0101_dm_party_dashboard.sql is APPLIED — running the full live-sync suite.\n"
    : "migration 0101_dm_party_dashboard.sql is NOT applied — this script cannot exercise the dashboard at all; BLOCKING.\n"
);

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();
const fighterId = crypto.randomUUID();

try {
  if (!migrationApplied) {
    skipBlocked("the full live-sync suite", "migration 0101 not applied — run `node scripts/db/migrate.mjs`, then re-run this script");
  } else {
    await admin.from("campaigns").insert({ id: campaignId, name: "Room Char Sync Test", creator: dm.id });
    await admin.from("campaign_members").insert([
      { campaign_id: campaignId, user_id: dm.id, role: "dm" },
      { campaign_id: campaignId, user_id: player.id, role: "player" },
    ]);

    // Fighter, d10 hit die, CON 10 — same known SRD average level-up gain
    // (+6 HP) verify-party-dashboard.mjs already relies on, so 1->2 is a
    // deterministic 10/10 -> 16/16.
    await admin.from("characters").insert({
      id: fighterId,
      campaign_id: campaignId,
      owner_id: player.id,
      name: "Bram Oakenshield",
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

    // Combat, live from the start: Game Room's condition badges
    // (conditionLabelsByTokenId) are combat-scoped by design (a character
    // condition needs a combatant row to attach to), so the condition-badge
    // portion of this scenario needs an active encounter with the fighter
    // seated in it — verify-conditions.mjs's exact recipe.
    const mapId = crypto.randomUUID();
    await admin.from("campaign_maps").insert({
      id: mapId,
      campaign_id: campaignId,
      name: "Room Sync Arena",
      grid_width: 10,
      grid_height: 10,
    });
    await admin.from("map_tokens").insert({
      id: crypto.randomUUID(),
      map_id: mapId,
      character_id: fighterId,
      x: 1,
      y: 1,
      elevation: 0,
      allegiance: "party",
    });
    await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

    const { data: encounterId, error: startError } = await dm.client.rpc("start_combat", {
      p_campaign_id: campaignId,
    });
    if (startError) throw new Error(`starting combat: ${startError.message}`);
    const { data: combatants } = await admin
      .from("combat_combatants")
      .select()
      .eq("encounter_id", encounterId);
    const fighterCombatant = combatants.find((row) => row.character_id === fighterId);
    if (!fighterCombatant) throw new Error("fighter never got seated as a combatant");
    const combatantId = fighterCombatant.id;

    // -------------------------------------------------------------------
    // Open three tabs, NONE ever reloaded from here on: the DM's Game Room,
    // the DM's Party Dashboard (a second tab, exactly the real "Manage
    // characters" new-tab flow), and the player's own Game Room.
    // -------------------------------------------------------------------
    const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await dmContext.addCookies(sessionCookies(dm.session));
    const dmRoomPage = await dmContext.newPage();
    const dmDashPage = await dmContext.newPage();

    const playerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await playerContext.addCookies(sessionCookies(player.session));
    const playerRoomPage = await playerContext.newPage();

    await dmRoomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await dmRoomPage.waitForSelector(`[data-testid="combatant-row-${combatantId}"]`, { timeout: 60000 });
    await playerRoomPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    await playerRoomPage.waitForSelector(`[data-testid="combatant-row-${combatantId}"]`, { timeout: 60000 });
    await dmDashPage.goto(`${APP_URL}/campaigns/${campaignId}/party`);
    await dmDashPage.waitForSelector(`[data-testid="party-card-${fighterId}"]`, { timeout: 30000 });

    check(
      "baseline: the DM's Game Room shows the fighter's starting HP",
      (await dmRoomPage.textContent(`[data-testid="combatant-hp-${combatantId}"]`))?.replace(/\s/g, "").includes("10/10")
    );
    check(
      "baseline: the player's own (separate) Game Room shows the same starting HP",
      (await playerRoomPage.textContent(`[data-testid="combatant-hp-${combatantId}"]`))?.replace(/\s/g, "").includes("10/10")
    );
    await dmRoomPage.screenshot({ path: join(SCREENSHOT_DIR, "room-sync-00-baseline-dm-room.png") });
    await dmDashPage.screenshot({ path: join(SCREENSHOT_DIR, "room-sync-00-baseline-dashboard.png"), fullPage: true });
    console.log(`Screenshots saved under: ${SCREENSHOT_DIR}`);

    // -------------------------------------------------------------------
    // Phase A — XP award + level-up run from the DASHBOARD tab reaches
    // BOTH already-open Game Room tabs live, no reload anywhere.
    // -------------------------------------------------------------------
    await dmDashPage.fill(`[data-testid="party-award-input-${fighterId}"]`, "350");
    await dmDashPage.click(`[data-testid="party-award-button-${fighterId}"]`);
    await dmDashPage.waitForSelector(`[data-testid="party-levelup-row-${fighterId}"]`, { timeout: 15000 });
    {
      const { data } = await admin.from("characters").select("xp, level").eq("id", fighterId).single();
      check("the dashboard's XP award persisted (350 xp, level still 1 pre-confirm)", data?.xp === 350 && data?.level === 1, JSON.stringify(data));
    }
    await dmDashPage.click(`[data-testid="party-levelup-${fighterId}"]`);
    await dmDashPage.waitForSelector('[data-testid="levelup-step-features"]', { timeout: 15000 });
    await dmDashPage.click('[data-testid="levelup-next"]');
    await dmDashPage.waitForSelector('[data-testid="levelup-step-hp"]', { timeout: 15000 });
    await dmDashPage.click('[data-testid="levelup-next"]');
    await dmDashPage.waitForSelector('[data-testid="levelup-step-review"]', { timeout: 15000 });
    await dmDashPage.click('[data-testid="levelup-confirm"]');
    await dmDashPage.waitForSelector('[data-testid="level-up-wizard"]', { state: "detached", timeout: 15000 });
    {
      const { data } = await admin
        .from("characters")
        .select("xp, level, current_hp, max_hp")
        .eq("id", fighterId)
        .single();
      check(
        "confirming the level-up wizard from the dashboard applies level 2 + SRD HP gain (10/10 -> 16/16)",
        data?.level === 2 && data?.current_hp === 16 && data?.max_hp === 16,
        JSON.stringify(data)
      );
    }

    const dmSeesLevelUp = await waitForLiveText(dmRoomPage, `combatant-hp-${combatantId}`, "16/16");
    check(
      "THE FIX: the DM's already-open Game Room tab shows the new HP (16/16) live, with NO reload",
      dmSeesLevelUp
    );
    const playerSeesLevelUp = await waitForLiveText(playerRoomPage, `combatant-hp-${combatantId}`, "16/16");
    check(
      "THE FIX: the player's separate, already-open Game Room tab ALSO shows it live, with NO reload",
      playerSeesLevelUp
    );
    await dmRoomPage.screenshot({ path: join(SCREENSHOT_DIR, "room-sync-01-after-levelup-dm-room.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "room-sync-01-after-levelup-dm-room.png")}`);

    // -------------------------------------------------------------------
    // Phase B — a condition applied (and removed) from the dashboard
    // reaches both open Game Room tabs live. The dashboard mirrors onto
    // combatant_conditions for a character with a live combatant (a direct
    // table write, no broadcast) — this is what subscribeToCombatantCondition-
    // Changes -> refreshCombat in GameRoom.tsx now picks up.
    // -------------------------------------------------------------------
    await dmDashPage.selectOption(`[data-testid="party-condition-select-${fighterId}"]`, "poisoned");
    await dmDashPage.click(`[data-testid="party-condition-apply-${fighterId}"]`);
    await dmDashPage.waitForSelector(`[data-testid="party-condition-poisoned-${fighterId}"]`, { timeout: 15000 });
    {
      const { data } = await admin
        .from("combatant_conditions")
        .select()
        .eq("combatant_id", combatantId)
        .eq("condition_key", "poisoned")
        .maybeSingle();
      check("the dashboard's condition apply mirrored onto the live combatant row", data !== null);
    }
    const dmSeesCondition = await waitForLiveText(dmRoomPage, `combatant-conditions-${combatantId}`, "Poisoned");
    check(
      "THE FIX: the DM's Game Room shows the Poisoned badge live, with NO reload",
      dmSeesCondition
    );
    const playerSeesCondition = await waitForLiveText(playerRoomPage, `combatant-conditions-${combatantId}`, "Poisoned");
    check(
      "THE FIX: the player's Game Room ALSO shows the Poisoned badge live, with NO reload",
      playerSeesCondition
    );
    await dmRoomPage.screenshot({ path: join(SCREENSHOT_DIR, "room-sync-02-condition-dm-room.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "room-sync-02-condition-dm-room.png")}`);

    await dmDashPage.click(`[data-testid="party-condition-remove-poisoned-${fighterId}"]`);
    await dmDashPage.waitForSelector(`[data-testid="party-condition-poisoned-${fighterId}"]`, {
      state: "detached",
      timeout: 15000,
    });
    const dmSeesRemoval = await waitForLiveAbsence(dmRoomPage, `condition-badge-poisoned-${combatantId}`);
    check("removing the condition from the dashboard clears the badge live in the DM's Game Room too", dmSeesRemoval);
    const playerSeesRemoval = await waitForLiveAbsence(playerRoomPage, `condition-badge-poisoned-${combatantId}`);
    check("...and in the player's Game Room", playerSeesRemoval);

    // -------------------------------------------------------------------
    // Phase C — a DM-granted advantage flag reaches the live scenario: the
    // roll route re-reads pending_roll_mode straight from the DB itself
    // (confirmed by reading roll/route.ts's consumeDmGrantedMode) so this
    // was never blocked by the characterRows staleness bug — Game Room has
    // no UI surface for this flag at all (confirmed: no reference to
    // pending_roll_mode anywhere under src/app/campaigns/[id]/room). What's
    // checked here is the real end-user scenario: granting it from the
    // dashboard, then a roll POSTed from the PLAYER's own already-open (never
    // reloaded) Game Room tab honors it — plus that granting it (a write to
    // the SAME characters row already carrying the fresh level/HP) doesn't
    // regress the level-up sync just proven above.
    // -------------------------------------------------------------------
    await dmDashPage.click(`[data-testid="party-mode-advantage-${fighterId}"]`);
    await sleep(1000);
    {
      const { data } = await admin.from("characters").select("pending_roll_mode").eq("id", fighterId).single();
      check("granting advantage from the dashboard persists to characters.pending_roll_mode", data?.pending_roll_mode === "advantage", JSON.stringify(data));
    }
    check(
      "granting advantage (a write to the SAME row) doesn't clobber the level-up's HP already synced into the DM's Game Room",
      (await dmRoomPage.textContent(`[data-testid="combatant-hp-${combatantId}"]`))?.replace(/\s/g, "").includes("16/16")
    );

    const rollResult = await playerRoomPage.evaluate(
      async ({ campaignId, characterId }) => {
        const res = await fetch(`/campaigns/${campaignId}/roll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "check", characterId, ability: "strength" }),
        });
        return res.json();
      },
      { campaignId, characterId: fighterId }
    );
    check(
      "a roll POSTed from the player's own already-open Game Room tab (no reload) honors the dashboard-granted advantage: two d20s",
      rollResult?.ok && rollResult.roll?.breakdown?.mode === "advantage" && rollResult.roll?.breakdown?.d20Rolls?.length === 2,
      JSON.stringify(rollResult)
    );
    {
      const { data } = await admin.from("characters").select("pending_roll_mode").eq("id", fighterId).single();
      check("the grant cleared itself after that one roll", data?.pending_roll_mode === "normal", JSON.stringify(data));
    }

    // -------------------------------------------------------------------
    // Phase D — regression: the EXISTING in-room damage/heal path
    // (CombatPanel's DM controls -> applyHpDelta -> the COMBAT_EVENT
    // broadcast) still works correctly with the new characters/
    // combatant_conditions subscriptions also listening — no double-apply,
    // no clobber, settles on the right number both ways.
    // -------------------------------------------------------------------
    await dmRoomPage.click(`[data-testid="combatant-select-${combatantId}"]`);
    await dmRoomPage.waitForSelector(`[data-testid="hp-controls-${combatantId}"]`, { timeout: 10000 });
    await dmRoomPage.fill(`[data-testid="hp-amount-input-${combatantId}"]`, "5");
    await dmRoomPage.click(`[data-testid="apply-damage-${combatantId}"]`);
    {
      const damaged = await waitForLiveText(playerRoomPage, `combatant-hp-${combatantId}`, "11/16");
      check(
        "regression check: the EXISTING in-room damage path (DM's Damage button) still reaches the player's Game Room live",
        damaged
      );
      const { data } = await admin.from("characters").select("current_hp").eq("id", fighterId).single();
      check("...and persisted correctly to the DB (16 - 5 = 11)", data?.current_hp === 11, JSON.stringify(data));
    }
    await dmRoomPage.fill(`[data-testid="hp-amount-input-${combatantId}"]`, "5");
    await dmRoomPage.click(`[data-testid="apply-heal-${combatantId}"]`);
    {
      const healed = await waitForLiveText(playerRoomPage, `combatant-hp-${combatantId}`, "16/16");
      check(
        "regression check: healing back settles cleanly at 16/16 on the player's Game Room too — no leftover stale/duplicate state",
        healed
      );
    }

    await dmRoomPage.screenshot({ path: join(SCREENSHOT_DIR, "room-sync-03-final-dm-room.png") });
    await playerRoomPage.screenshot({ path: join(SCREENSHOT_DIR, "room-sync-03-final-player-room.png") });
    console.log(`Screenshots saved: room-sync-03-final-{dm,player}-room.png`);

    await dmContext.close();
    await playerContext.close();
  }
} finally {
  await browser.close();
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

console.log(`\n${failures} failure(s), ${blocked} blocked check(s).`);
if (failures > 0) {
  console.error("Game Room character live-sync verification FAILED.");
  process.exit(1);
}
console.log(
  blocked > 0
    ? "Every runnable check passed; the full suite is BLOCKED pending migration 0101 — apply it, then re-run."
    : "All Game Room character live-sync checks passed."
);
process.exit(0);
