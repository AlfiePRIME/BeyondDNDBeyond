#!/usr/bin/env node
// "can we add a button that opens a secondary tab with a new ui for the DM
// to manage characters and see all their info?" — the DM party dashboard,
// with the project owner's three explicitly-confirmed clarifications:
// REAL persisted XP (SRD thresholds, suggest-then-confirm level-up),
// conditions applicable OUTSIDE active combat, and a NEW persisted
// DM-settable advantage/disadvantage flag consumed by the character's
// next roll wherever it happens.
//
// What this verifies (confirmed by reading the actual code, not assumed):
//   - migration 0101_dm_party_dashboard.sql: characters.xp +
//     characters.pending_roll_mode (both DM-managed via the
//     characters_dm_managed_columns trigger), the award_xp /
//     consume_pending_roll_mode / apply_character_exhaustion_delta RPCs,
//     and the new character_conditions table (combat-independent
//     conditions, can_access_character RLS).
//   - the Game Room's DM-only "Manage characters" control — a REAL
//     <a target="_blank" rel="noopener noreferrer">, opening
//     /campaigns/:id/party in a genuinely separate tab.
//   - the dashboard page: DM-only (server redirect for players), every
//     campaign character with name/level/XP/HP/conditions, inline award/
//     level-up/condition/advantage controls, and links to the EXISTING
//     character sheet route.
//   - the roll route's consume-and-clear plumbing: a DM-granted advantage
//     genuinely changes the character's next roll (two d20s recorded in
//     roll_log) no matter which surface rolled, then clears itself.
//
// IMPORTANT — authored while migration 0101 is deliberately UNAPPLIED
// (this task forbids running it; a human applies it via
// `node scripts/db/migrate.mjs`). The verify-remove-member "probe first,
// blocked-not-failed" convention applies: the xp column's existence is
// probed non-destructively up front, and every check that depends on the
// migration reports BLOCKED (not FAIL) until it's applied — while
// everything that must work EITHER WAY (the new-tab control, the
// dashboard rendering, the player redirect, and crucially that ordinary
// rolls still succeed with the consume RPC absent) runs for real.
//
// Needs the real dev server (starts `yarn dev` itself if the target port
// isn't already serving) and the real shared Supabase instance this
// project's .env points at. Ephemeral test users/campaign/characters are
// created here and torn down in `finally`.
// Usage: node scripts/db/verify-party-dashboard.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 6471;
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
  const email = `party-dash-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `PartyDash ${label}` });
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

await ensureDevServer();

// ---------------------------------------------------------------------
// Non-destructive migration probe: a SELECT of the new column either
// works (applied) or errors (not applied) without touching any data.
// ---------------------------------------------------------------------
const probe = await admin.from("characters").select("xp").limit(1);
const migrationApplied = !probe.error;
console.log(
  migrationApplied
    ? "migration 0101_dm_party_dashboard.sql is APPLIED — running the full check suite.\n"
    : "migration 0101_dm_party_dashboard.sql is NOT applied — DB-dependent checks will report BLOCKED, everything else runs for real.\n"
);

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const bystander = await makeTestUser("bystander");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

const campaignId = crypto.randomUUID();

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Party Dashboard Test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
    { campaign_id: campaignId, user_id: bystander.id, role: "player" },
  ]);

  // Two characters so "lists EVERY character" is a real check — a Fighter
  // (d10 hit die, CON 10 → SRD average level-up gain of exactly 6 HP) for
  // the XP/level-up flow, and a second, different-owner character the
  // cross-player RLS checks target. NO combat encounter is ever created
  // in this campaign — the "conditions with no active combat" requirement
  // is exercised for real.
  const fighter = baseCharacter({ campaign_id: campaignId, owner_id: player.id, name: "Bram Oakenshield" });
  const rogue = baseCharacter({
    campaign_id: campaignId,
    owner_id: bystander.id,
    name: "Vex Shadowstep",
    class: "Rogue",
    level: 3,
    current_hp: 21,
    max_hp: 24,
  });
  await admin.from("characters").insert([fighter, rogue]);

  // -------------------------------------------------------------------
  // Phase 1 — the new-tab control and the dashboard page itself, real
  // browser, independent of the migration.
  // -------------------------------------------------------------------
  const dmContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();

  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="game-room-back-link"]', { timeout: 60000 });
  const manageLink = await dmPage.$('[data-testid="manage-characters-link"]');
  check("the DM sees the Manage characters control in the Game Room top bar", manageLink !== null);
  if (manageLink) {
    check(
      "it is a REAL anchor with target=_blank (new tab, right-clickable, popup-blocker-proof)",
      (await manageLink.getAttribute("target")) === "_blank"
    );
    check(
      'it carries rel="noopener noreferrer"',
      (await manageLink.getAttribute("rel")) === "noopener noreferrer"
    );
    check(
      "its href is the dashboard route",
      (await manageLink.getAttribute("href")) === `/campaigns/${campaignId}/party`
    );
  }
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "party-room-topbar.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "party-room-topbar.png")}`);

  // Clicking really opens a second tab on the dashboard URL.
  const [partyPage] = await Promise.all([
    dmContext.waitForEvent("page", { timeout: 30000 }),
    dmPage.click('[data-testid="manage-characters-link"]'),
  ]);
  await partyPage.waitForLoadState("domcontentloaded");
  await partyPage.waitForSelector('[data-testid="party-dashboard"]', { timeout: 30000 });
  check(
    "clicking it opens a genuinely separate tab at /campaigns/:id/party",
    partyPage !== dmPage && new URL(partyPage.url()).pathname === `/campaigns/${campaignId}/party`
  );

  // The roster: every character, correct name/level/HP (XP defensive-zero
  // until the migration lands).
  check(
    "the dashboard lists BOTH characters",
    (await partyPage.$(`[data-testid="party-card-${fighter.id}"]`)) !== null &&
      (await partyPage.$(`[data-testid="party-card-${rogue.id}"]`)) !== null
  );
  const fighterCardText = (await partyPage.textContent(`[data-testid="party-card-${fighter.id}"]`)) ?? "";
  check("the fighter's card shows their name", fighterCardText.includes("Bram Oakenshield"));
  check("the fighter's card shows class + level", fighterCardText.includes("Fighter 1"));
  const fighterHp = (await partyPage.textContent(`[data-testid="party-hp-${fighter.id}"]`)) ?? "";
  check("the fighter's card shows current/max HP", fighterHp.replace(/\s/g, "").includes("10/10"), fighterHp);
  const rogueHp = (await partyPage.textContent(`[data-testid="party-hp-${rogue.id}"]`)) ?? "";
  check("the rogue's card shows their different HP", rogueHp.replace(/\s/g, "").includes("21/24"), rogueHp);
  const fighterXpText = (await partyPage.textContent(`[data-testid="party-xp-${fighter.id}"]`)) ?? "";
  check(
    "the fighter's card shows an XP readout (0 + distance to level 2's 300 threshold)",
    fighterXpText.includes("0") && fighterXpText.includes("300"),
    fighterXpText
  );
  check(
    "each card links to the character's EXISTING sheet route",
    (await partyPage.getAttribute(`[data-testid="party-sheet-link-${fighter.id}"]`, "href")) ===
      `/campaigns/${campaignId}/characters/${fighter.id}`
  );
  await partyPage.screenshot({ path: join(SCREENSHOT_DIR, "party-dashboard.png"), fullPage: true });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "party-dashboard.png")}`);

  // -------------------------------------------------------------------
  // Phase 2 — a PLAYER cannot reach the dashboard at all (server-side
  // redirect, the dm-notes precedent), and ordinary rolls still work
  // even with migration 0101 absent (the roll route's
  // consumeDmGrantedMode failure-tolerance — a regression here would
  // break EVERY roll in the app).
  // -------------------------------------------------------------------
  const playerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  await playerPage.goto(`${APP_URL}/campaigns/${campaignId}/party`);
  await playerPage.waitForLoadState("domcontentloaded");
  await playerPage.waitForURL((url) => !url.pathname.endsWith("/party"), { timeout: 15000 }).catch(() => undefined);
  check(
    "a PLAYER navigating to /party is redirected away (server-side, not just hidden UI)",
    new URL(playerPage.url()).pathname === `/campaigns/${campaignId}`,
    playerPage.url()
  );

  await playerPage.goto(`${APP_URL}/campaigns/${campaignId}/characters/${fighter.id}`);
  await playerPage.waitForSelector('[data-testid="roll-check-strength"]', { timeout: 30000 });
  await playerPage.click('[data-testid="roll-check-strength"]');
  await playerPage.waitForSelector('[data-testid="sheet-roll-result"]', { timeout: 20000 });
  const { data: rollAfterPlain } = await admin
    .from("roll_log")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(
    "an ordinary sheet roll still works end-to-end (roll route tolerant of the not-yet-applied consume RPC)",
    rollAfterPlain?.breakdown?.type === "d20" && rollAfterPlain?.breakdown?.d20Rolls?.length === 1,
    JSON.stringify(rollAfterPlain?.breakdown ?? null)
  );

  // -------------------------------------------------------------------
  // Phase 3 — everything that needs migration 0101. Real when applied,
  // BLOCKED otherwise.
  // -------------------------------------------------------------------
  if (!migrationApplied) {
    skipBlocked("awarding XP from the dashboard persists to characters.xp", "migration 0101 not applied — run `node scripts/db/migrate.mjs`, then re-run this script");
    skipBlocked("crossing the SRD 300-XP threshold surfaces the suggest-then-confirm level-up and confirming applies level 2 + the SRD average HP gain", "same unapplied migration");
    skipBlocked("applying a condition with NO active combat encounter persists and shows on the dashboard AND the character sheet's Conditions panel", "same unapplied migration");
    skipBlocked("granting advantage persists, genuinely gives the character's next sheet roll two d20s, and clears back to normal afterward", "same unapplied migration");
    skipBlocked("a PLAYER cannot award XP / set advantage / write another character's conditions directly against the database (trigger + RLS)", "same unapplied migration");
  } else {
    // --- XP awards + suggest-then-confirm level-up ---
    await partyPage.click(`[data-testid="party-award-100-${fighter.id}"]`);
    await sleep(1200);
    {
      const { data } = await admin.from("characters").select("xp, level").eq("id", fighter.id).single();
      check("the +100 quick award persists to characters.xp", data?.xp === 100 && data?.level === 1, JSON.stringify(data));
    }
    check(
      "100 XP (under the 300 threshold) offers NO level-up",
      (await partyPage.$(`[data-testid="party-levelup-${fighter.id}"]`)) === null
    );
    await partyPage.fill(`[data-testid="party-award-input-${fighter.id}"]`, "250");
    await partyPage.click(`[data-testid="party-award-button-${fighter.id}"]`);
    await partyPage.waitForSelector(`[data-testid="party-levelup-${fighter.id}"]`, { timeout: 15000 });
    {
      const { data } = await admin.from("characters").select("xp, level").eq("id", fighter.id).single();
      check(
        "the custom 250 award lands (total 350, past the level 2 threshold) and the level did NOT silently change",
        data?.xp === 350 && data?.level === 1,
        JSON.stringify(data)
      );
    }
    check(
      "crossing the threshold surfaces the suggest-then-confirm level-up row instead",
      (await partyPage.$(`[data-testid="party-levelup-row-${fighter.id}"]`)) !== null
    );
    await partyPage.screenshot({ path: join(SCREENSHOT_DIR, "party-levelup-offered.png"), fullPage: true });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "party-levelup-offered.png")}`);
    await partyPage.click(`[data-testid="party-levelup-${fighter.id}"]`);
    await sleep(1500);
    {
      const { data } = await admin
        .from("characters")
        .select("xp, level, current_hp, max_hp")
        .eq("id", fighter.id)
        .single();
      check(
        "confirming applies level 2 with the SRD average Fighter gain (d10, CON 10 → +6: 10/10 → 16/16), XP untouched",
        data?.level === 2 && data?.current_hp === 16 && data?.max_hp === 16 && data?.xp === 350,
        JSON.stringify(data)
      );
    }

    // --- Conditions with NO combat encounter anywhere ---
    {
      const { data: encounters } = await admin.from("combat_encounters").select("id").eq("campaign_id", campaignId);
      check("precondition: this campaign has NO combat encounter at all", (encounters ?? []).length === 0);
    }
    await partyPage.selectOption(`[data-testid="party-condition-select-${fighter.id}"]`, "poisoned");
    await partyPage.click(`[data-testid="party-condition-apply-${fighter.id}"]`);
    await partyPage.waitForSelector(`[data-testid="party-condition-poisoned-${fighter.id}"]`, { timeout: 15000 });
    {
      const { data } = await admin
        .from("character_conditions")
        .select()
        .eq("character_id", fighter.id)
        .eq("condition_key", "poisoned")
        .maybeSingle();
      check("the condition persists in character_conditions with no combatant anywhere", data !== null);
    }
    // ...and the character's own sheet shows it (the merged Conditions panel).
    await playerPage.reload();
    await playerPage.waitForSelector('[data-testid="sheet-condition-poisoned"]', { timeout: 30000 });
    check(
      "the character sheet's Conditions panel shows the dashboard-applied condition (no combat required)",
      (await playerPage.$('[data-testid="sheet-condition-poisoned"]')) !== null
    );
    await playerPage.screenshot({ path: join(SCREENSHOT_DIR, "party-sheet-condition.png") });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "party-sheet-condition.png")}`);
    // Remove it again from the dashboard.
    await partyPage.click(`[data-testid="party-condition-remove-poisoned-${fighter.id}"]`);
    await sleep(1200);
    {
      const { data } = await admin
        .from("character_conditions")
        .select()
        .eq("character_id", fighter.id)
        .eq("condition_key", "poisoned");
      check("removing it from the dashboard deletes the row", (data ?? []).length === 0);
    }

    // --- The DM-granted next-roll advantage, consumed by a REAL roll ---
    await partyPage.click(`[data-testid="party-mode-advantage-${fighter.id}"]`);
    await sleep(1200);
    {
      const { data } = await admin.from("characters").select("pending_roll_mode").eq("id", fighter.id).single();
      check("granting advantage persists to characters.pending_roll_mode", data?.pending_roll_mode === "advantage", JSON.stringify(data));
    }
    await playerPage.reload();
    await playerPage.waitForSelector('[data-testid="sheet-pending-roll-mode"]', { timeout: 30000 });
    check(
      "the player's own sheet surfaces the DM-granted flag",
      ((await playerPage.textContent('[data-testid="sheet-pending-roll-mode"]')) ?? "").includes("advantage")
    );
    // The player rolls a plain STR check from the sheet, with the sheet's
    // own manual toggle untouched (Normal) — only the DM's grant is in play.
    await playerPage.click('[data-testid="roll-check-strength"]');
    await playerPage.waitForSelector('[data-testid="sheet-roll-result"]', { timeout: 20000 });
    await sleep(800);
    {
      const { data: latest } = await admin
        .from("roll_log")
        .select()
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      check(
        "the next roll genuinely rolled with advantage — mode 'advantage' and TWO d20s recorded in roll_log",
        latest?.breakdown?.mode === "advantage" && latest?.breakdown?.d20Rolls?.length === 2,
        JSON.stringify(latest?.breakdown ?? null)
      );
    }
    {
      const { data } = await admin.from("characters").select("pending_roll_mode").eq("id", fighter.id).single();
      check("the flag cleared itself after that one roll", data?.pending_roll_mode === "normal", JSON.stringify(data));
    }
    // A second roll goes back to one die.
    await playerPage.click('[data-testid="roll-check-strength"]');
    await sleep(1500);
    {
      const { data: latest } = await admin
        .from("roll_log")
        .select()
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      check(
        "the FOLLOWING roll is back to a single normal d20",
        latest?.breakdown?.mode === "normal" && latest?.breakdown?.d20Rolls?.length === 1,
        JSON.stringify(latest?.breakdown ?? null)
      );
    }

    // --- Real data-layer checks: a player cannot invoke the DM-only
    // mutations directly, UI or no UI ---
    {
      const { error } = await player.client.rpc("award_xp", { p_character_id: fighter.id, p_delta: 5000 });
      check(
        "a PLAYER calling award_xp directly on their OWN character is rejected (DM-only at the data layer)",
        error !== null,
        JSON.stringify(error)
      );
    }
    {
      const { error } = await player.client.from("characters").update({ xp: 999999 }).eq("id", fighter.id);
      const { data } = await admin.from("characters").select("xp").eq("id", fighter.id).single();
      check(
        "a PLAYER patching characters.xp directly is rejected by the trigger and the value is unchanged",
        error !== null && data?.xp === 350,
        JSON.stringify({ error, xp: data?.xp })
      );
    }
    {
      const { error } = await player.client
        .from("characters")
        .update({ pending_roll_mode: "advantage" })
        .eq("id", fighter.id);
      const { data } = await admin.from("characters").select("pending_roll_mode").eq("id", fighter.id).single();
      check(
        "a PLAYER granting THEMSELF advantage directly is rejected by the trigger",
        error !== null && data?.pending_roll_mode === "normal",
        JSON.stringify({ error, mode: data?.pending_roll_mode })
      );
    }
    {
      const { error, count } = await player.client
        .from("character_conditions")
        .insert({ character_id: rogue.id, condition_key: "poisoned" }, { count: "exact" });
      const { data } = await admin
        .from("character_conditions")
        .select()
        .eq("character_id", rogue.id);
      check(
        "a PLAYER cannot write conditions onto ANOTHER player's character (RLS: not owner, not DM)",
        (error !== null || count === 0) && (data ?? []).length === 0,
        JSON.stringify({ error, count, rows: data })
      );
    }
    {
      // The deliberate scope of the write rule (0029's DM-or-owner
      // spirit): the owner CAN mark their own character.
      const { error } = await player.client
        .from("character_conditions")
        .insert({ character_id: fighter.id, condition_key: "prone" });
      check("...while the owner CAN mark their OWN character (the 0029 DM-or-owner write rule)", error === null, JSON.stringify(error));
      await admin.from("character_conditions").delete().eq("character_id", fighter.id);
    }

    await partyPage.screenshot({ path: join(SCREENSHOT_DIR, "party-dashboard-final.png"), fullPage: true });
    console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "party-dashboard-final.png")}`);
  }

  await playerContext.close();
  await dmContext.close();
} finally {
  await browser.close();
  // The campaign (and its characters/conditions, via cascade) goes first,
  // then the ephemeral users.
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
  await admin.auth.admin.deleteUser(bystander.id);
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
  console.error("Party-dashboard verification FAILED.");
  process.exit(1);
}
console.log(
  blocked > 0
    ? "Party-dashboard verification PASSED every check runnable today; the rest are BLOCKED pending the (deliberately unapplied) migration 0101_dm_party_dashboard.sql — apply via `node scripts/db/migrate.mjs`, then re-run."
    : "All party-dashboard checks passed."
);
process.exit(0);
