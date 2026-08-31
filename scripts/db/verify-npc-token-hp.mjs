#!/usr/bin/env node
// NPC HP outside combat: the project owner's DM ask — "the DM can't see NPC
// health or track it per NPC/enemy" — closed for the OUTSIDE-of-combat gap.
//
// Before this feature, a stat-blocked NPC token's HP (map_tokens.current_hp,
// migration 0089) was only ever visible/adjustable via CombatPanel's own
// damage/heal control, and only once the token had been seated as a
// combatant in an active encounter (apply_npc_hp_delta is keyed on an
// EXISTING combat_combatants row). TokenPanel.tsx — the always-visible token
// side panel, unlike CombatPanel — had zero current_hp/max_hp references at
// all. This script verifies the new TokenPanel display + DM-only damage/heal
// control, wired to the token directly via applyNpcTokenHpDelta
// (mapTokens.ts, a plain clamped map_tokens.current_hp update — no RPC, no
// migration), riding the SAME TOKEN_EVENT broadcast + local-apply mechanism
// every other map_tokens field change already uses for live sync.
//
// Covers:
//   1. The HP display appears for a stat-blocked NPC token outside combat,
//      defaulting current_hp to the stat block's own max_hp when null.
//   2. Damage/Heal actually persists to map_tokens.current_hp, clamped to
//      [0, max_hp] — verified both via the DB directly and via the DOM.
//   3. The damage/heal CONTROL is DM-only — a player's TokenPanel never
//      shows it (the display itself is not restricted).
//   4. A SECOND already-connected client sees the HP change live, with no
//      reload — the same TOKEN_EVENT mechanism token allegiance/position
//      changes already ride.
//   5. A bare, unstatted NPC token (no monster_stat_block_id) shows neither
//      the HP display nor the control — matching CombatPanel's own existing
//      scope limit for such a token.
//   6. Bonus: once a token is seated as the active encounter's own
//      combatant, TokenPanel's control steps aside (display only) so
//      CombatPanel's existing control remains the single write path for
//      combat_combatants.npc_current_hp — the two HP counters never get two
//      independent writers.
//
// Needs the local dev server pointed at this project's configured Supabase
// instance; starts `yarn dev` itself (and polls /api/health) if the
// configured port isn't already serving. Uses its own fixed, unusual port
// to avoid colliding with another agent's dev server.
// Usage: node scripts/db/verify-npc-token-hp.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.VERIFY_PORT ?? "6142";
const APP_URL = `http://localhost:${PORT}`;
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
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on ${APP_URL} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev", "-p", String(PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on ${APP_URL} within 120s`);
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
  const email = `npc-token-hp-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `NPC HP ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function tokenRow(id) {
  const { data } = await admin.from("map_tokens").select().eq("id", id).single();
  return data;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "NPC token HP test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice Vanguard",
    race: "Human",
    class: "Fighter",
    level: 3,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    current_hp: 30,
    max_hp: 30,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "NPC HP test map",
    grid_width: 5,
    grid_height: 5,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const { data: statBlock } = await admin
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Goblin",
      max_hp: 30,
      armor_class: 15,
      attacks: [{ name: "Scimitar", bonus: 4, damageNotation: "1d6+2" }],
    })
    .select()
    .single();

  const aliceTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  const bareTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharacterId, x: 0, y: 0, elevation: 0, allegiance: "party" },
    {
      id: goblinTokenId,
      map_id: mapId,
      npc_name: statBlock.name,
      monster_stat_block_id: statBlock.id,
      x: 2,
      y: 2,
      elevation: 0,
      allegiance: "hostile",
    },
    {
      // A bare, unstatted NPC — no monster_stat_block_id, exactly the
      // TokenPanel free-text "Goblin, cultist, mysterious figure…" NPC
      // placement shape. Must get NEITHER the HP display NOR the control,
      // matching CombatPanel's own existing scope limit for such a token.
      id: bareTokenId,
      map_id: mapId,
      npc_name: "Mysterious Figure",
      monster_stat_block_id: null,
      x: 4,
      y: 4,
      elevation: 0,
      allegiance: "neutral",
    },
  ]);

  // ── DM's own browser: display, control, persistence, clamping. ──
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector('[data-testid="token-panel"]', { timeout: 30000 });
  await dmPage.waitForSelector(`[data-testid="token-${goblinTokenId}"]`, { timeout: 15000 });

  const goblinHpText = await dmPage.textContent(`[data-testid="token-hp-${goblinTokenId}"]`);
  check(
    "the HP display appears for a stat-blocked NPC token outside combat, current_hp defaulting to the stat block's own max_hp (null means full)",
    (goblinHpText ?? "").includes("30/30"),
    goblinHpText
  );

  const hpControlsVisible = await dmPage.locator(`[data-testid="hp-controls-${goblinTokenId}"]`).isVisible();
  check("the DM sees the damage/heal control for the stat-blocked NPC token", hpControlsVisible);

  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "npc-token-hp-dm-initial.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "npc-token-hp-dm-initial.png")}`);

  // Bare unstatted NPC: no display, no control.
  const bareHpDisplayCount = await dmPage.locator(`[data-testid="token-hp-${bareTokenId}"]`).count();
  const bareHpControlsCount = await dmPage.locator(`[data-testid="hp-controls-${bareTokenId}"]`).count();
  check(
    "a bare unstatted NPC token (no monster_stat_block_id) shows no HP display and no HP control at all",
    bareHpDisplayCount === 0 && bareHpControlsCount === 0,
    JSON.stringify({ display: bareHpDisplayCount, controls: bareHpControlsCount })
  );

  // Damage: 30 -> 18.
  await dmPage.fill(`[data-testid="hp-amount-input-${goblinTokenId}"]`, "12");
  await dmPage.click(`[data-testid="apply-damage-${goblinTokenId}"]`);
  await dmPage
    .waitForFunction(
      (testId) => document.querySelector(testId)?.textContent?.includes("18/30"),
      `[data-testid="token-hp-${goblinTokenId}"]`,
      { timeout: 10000 }
    )
    .catch(() => null);
  const afterDamageDb = await tokenRow(goblinTokenId);
  const afterDamageDomText = await dmPage.textContent(`[data-testid="token-hp-${goblinTokenId}"]`).catch(() => null);
  check(
    "Damage actually persists to map_tokens.current_hp (30 - 12 = 18), and the DOM reflects it immediately",
    afterDamageDb?.current_hp === 18 && (afterDamageDomText ?? "").includes("18/30"),
    JSON.stringify({ db: afterDamageDb?.current_hp, dom: afterDamageDomText })
  );

  // Heal: 18 -> 23.
  await dmPage.fill(`[data-testid="hp-amount-input-${goblinTokenId}"]`, "5");
  await dmPage.click(`[data-testid="apply-heal-${goblinTokenId}"]`);
  await dmPage
    .waitForFunction(
      (testId) => document.querySelector(testId)?.textContent?.includes("23/30"),
      `[data-testid="token-hp-${goblinTokenId}"]`,
      { timeout: 10000 }
    )
    .catch(() => null);
  const afterHealDb = await tokenRow(goblinTokenId);
  check("Heal actually persists to map_tokens.current_hp (18 + 5 = 23)", afterHealDb?.current_hp === 23, afterHealDb?.current_hp);

  // Overkill clamps at 0, never negative.
  await dmPage.fill(`[data-testid="hp-amount-input-${goblinTokenId}"]`, "999");
  await dmPage.click(`[data-testid="apply-damage-${goblinTokenId}"]`);
  await dmPage
    .waitForFunction(
      (testId) => document.querySelector(testId)?.textContent?.includes("0/30"),
      `[data-testid="token-hp-${goblinTokenId}"]`,
      { timeout: 10000 }
    )
    .catch(() => null);
  const afterOverkillDb = await tokenRow(goblinTokenId);
  check("overkill damage clamps at 0, never negative", afterOverkillDb?.current_hp === 0, afterOverkillDb?.current_hp);

  // Overheal clamps at the stat block's max_hp, never above.
  await dmPage.fill(`[data-testid="hp-amount-input-${goblinTokenId}"]`, "999");
  await dmPage.click(`[data-testid="apply-heal-${goblinTokenId}"]`);
  await dmPage
    .waitForFunction(
      (testId) => document.querySelector(testId)?.textContent?.includes("30/30"),
      `[data-testid="token-hp-${goblinTokenId}"]`,
      { timeout: 10000 }
    )
    .catch(() => null);
  const afterOverhealDb = await tokenRow(goblinTokenId);
  check(
    "overheal clamps at the stat block's own max_hp, never above",
    afterOverhealDb?.current_hp === 30,
    afterOverhealDb?.current_hp
  );

  // ── Second client (Alice, a player) sees the change live, no reload. ──
  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await alicePage.waitForSelector('[data-testid="token-panel"]', { timeout: 30000 });
  await alicePage.waitForSelector(`[data-testid="token-${goblinTokenId}"]`, { timeout: 15000 });
  // Let the realtime campaign channel finish subscribing before relying on
  // it for the live-sync check just below — the same settle delay
  // verify-click-to-attack.mjs uses after a fresh page load.
  await sleep(2000);

  // DM-only: a player never sees the damage/heal control, even though the
  // read-only HP display is visible to everyone.
  const playerControlsCount = await alicePage.locator(`[data-testid="hp-controls-${goblinTokenId}"]`).count();
  check("a player's TokenPanel never shows the damage/heal control, even for a stat-blocked NPC token", playerControlsCount === 0);

  // Now the DM applies a fresh change with Alice's page already open and
  // idle — this must reach her WITHOUT a reload, the same TOKEN_EVENT
  // mechanism token allegiance/position changes already ride.
  await dmPage.fill(`[data-testid="hp-amount-input-${goblinTokenId}"]`, "10");
  await dmPage.click(`[data-testid="apply-damage-${goblinTokenId}"]`);
  await alicePage
    .waitForFunction(
      (testId) => document.querySelector(testId)?.textContent?.includes("20/30"),
      `[data-testid="token-hp-${goblinTokenId}"]`,
      { timeout: 15000 }
    )
    .catch(() => null);
  const aliceVisibleHp = await alicePage.textContent(`[data-testid="token-hp-${goblinTokenId}"]`).catch(() => null);
  const dbAfterLiveSync = await tokenRow(goblinTokenId);
  check(
    "a second, already-connected client (a player) sees the HP change live, with no reload",
    (aliceVisibleHp ?? "").includes("20/30") && dbAfterLiveSync?.current_hp === 20,
    JSON.stringify({ alicePage: aliceVisibleHp, db: dbAfterLiveSync?.current_hp })
  );
  await alicePage.screenshot({ path: join(SCREENSHOT_DIR, "npc-token-hp-player-live-sync.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "npc-token-hp-player-live-sync.png")}`);

  // ── Bonus: once the token is seated as the active encounter's own
  //    combatant, TokenPanel's own control steps aside (display only) so
  //    CombatPanel's existing control stays the single write path for
  //    combat_combatants.npc_current_hp — the two HP counters can never
  //    get two independent writers. ──
  // Started through the REAL "Start combat" button (not a direct RPC call)
  // so the DM's own already-open page runs its own handleStartCombat ->
  // runCombatAction -> refreshCombat path and actually learns about it —
  // a direct admin/RPC-side start would never reach this already-connected
  // page's own React state at all (that's a real gap in the test harness,
  // not a product behavior).
  await dmPage.waitForSelector('[data-testid="start-combat-button"]', { timeout: 15000 });
  await dmPage.click('[data-testid="start-combat-button"]');
  await dmPage
    .waitForFunction(
      (testId) => document.querySelector(testId) === null,
      `[data-testid="hp-controls-${goblinTokenId}"]`,
      { timeout: 15000 }
    )
    .catch(() => null);
  const { data: encounterRow } = await admin
    .from("combat_encounters")
    .select()
    .eq("campaign_id", campaignId)
    .is("ended_at", null)
    .maybeSingle();
  check("combat starts normally via the real Start combat button (unrelated to this feature, just seeding the bonus check)", !!encounterRow);
  const controlsWhileSeated = await dmPage.locator(`[data-testid="hp-controls-${goblinTokenId}"]`).count();
  const displayWhileSeated = await dmPage.textContent(`[data-testid="token-hp-${goblinTokenId}"]`).catch(() => null);
  check(
    "once seated as the active encounter's own combatant, TokenPanel's damage/heal control steps aside (CombatPanel's own control owns it now) while the read-only display keeps showing",
    controlsWhileSeated === 0 && (displayWhileSeated ?? "").includes("20/30"),
    JSON.stringify({ controls: controlsWhileSeated, display: displayWhileSeated })
  );

  await dmContext.close();
  await aliceContext.close();
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already gone.
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll NPC token HP (outside combat) checks passed.");
process.exit(0);
