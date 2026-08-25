#!/usr/bin/env node
// Phase C (UI overhaul) verification: the "turn the page" peel-reveal for
// MonsterPanel and DmOverridesPanel — the two Game Room panels that are
// entirely, unconditionally DM-only (every other panel is at least partly
// shared, which is why those seven got Phase B's drag/collapse system
// instead of this treatment — see DraggablePanel.tsx's PanelId doc
// comment). Reserved territory: this script asserts these two are STILL
// untouched by DraggablePanel (no wrapper, no collapse toggle) — Phase B's
// own verify-ui-preferences.mjs already covers that from its side; this
// one covers Phase C's actual feature.
//
// The verify-character-edit.mjs hybrid arrangement, same as
// verify-ui-preferences.mjs: no direct-DB setup is needed beyond seeding a
// campaign, since there's no new schema here — this is a real browser
// driving the actual Game Room end to end, checking:
//   1. On a fresh DM room load, neither panel is present in the DOM (not
//      just visually hidden) — genuinely uncluttered by default.
//   2. Both panels' peel-tab triggers ARE present, clearly DM-labeled, and
//      NOT present for a player in the same room.
//   3. Clicking a tab reveals its panel, `aria-expanded` flips true.
//   4. THE critical check the brief called out: the revealed panel is
//      actually usable, not just visible — typing into real inputs and
//      clicking real buttons (MonsterPanel: create AND edit a stat block;
//      DmOverridesPanel: flip the action-economy toggle) must reach the
//      database, proving interactivity survives real mouse movement
//      between fields/buttons rather than being tied to a hover zone.
//   5. Clicking the tab again dismisses the panel (declutter) and
//      `aria-expanded` flips back to false.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — set PORT to
// avoid colliding with another dev server (this repo's other verify-*.mjs
// scripts assume :3000 is free; this one respects PORT so it can run
// alongside other concurrent worktrees/dev servers).
// Usage: PORT=3040 node scripts/db/verify-dm-peel-reveal.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = process.env.PORT ?? "3000";
const APP_URL = `http://localhost:${PORT}`;

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
  console.log(`dev server not running on :${PORT} — starting yarn dev…`);
  devServer = spawn("yarn", ["dev"], { cwd: rootDir, stdio: "ignore", detached: true, env: { ...process.env, PORT } });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error("dev server did not become healthy within 120s");
}

const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;
function sessionCookies(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return [{ name: COOKIE_NAME, value, url: APP_URL }];
  const cookies = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `dm-peel-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `DM Peel ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const player = await makeTestUser("player");
const browser = await chromium.launch();

try {
  // ---------------------------------------------------------------------
  // Seed a campaign with a live map for the DM, and a separate room
  // membership for the player-view check.
  // ---------------------------------------------------------------------
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "DM peel reveal test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);
  const mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "DM Peel Map", grid_width: 20, grid_height: 20 });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  // ---------------------------------------------------------------------
  // Part 1 — DM view: closed by default, tabs present, panels not.
  // ---------------------------------------------------------------------
  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="map-panel"]', { timeout: 30000 });
  await dmPage.waitForTimeout(1500); // let the 3D scene / async panels settle

  const monsterTab = dmPage.locator('[data-testid="monster-panel-tab"]');
  const dmControlsTab = dmPage.locator('[data-testid="dm-controls-panel-tab"]');
  const monsterPanel = dmPage.locator('[data-testid="monster-panel"]');
  const dmControlsPanel = dmPage.locator('[data-testid="dm-controls-panel"]');

  check(
    "MonsterPanel is NOT in the DOM on a fresh room load (genuinely uncluttered, not just visually hidden)",
    (await monsterPanel.count()) === 0
  );
  check(
    "DmOverridesPanel is NOT in the DOM on a fresh room load",
    (await dmControlsPanel.count()) === 0
  );
  check("the Monsters peel tab IS present for the DM", (await monsterTab.count()) === 1);
  check("the DM Controls peel tab IS present for the DM", (await dmControlsTab.count()) === 1);
  // The tab's data-testid is the real (transparent) click target — see
  // DmToolPeel.tsx's point 2 for why the visible "MONSTERS DM"/"DM
  // CONTROLS DM" label lives in a decorative sibling instead, so the
  // accessible name is asserted via aria-label rather than innerText.
  check(
    "the Monsters tab reads as a DM-only affordance, not an unlabeled glitch",
    ((await monsterTab.getAttribute("aria-label")) ?? "").toLowerCase().includes("monsters") &&
      ((await monsterTab.getAttribute("aria-label")) ?? "").toLowerCase().includes("dm only")
  );
  check(
    "the DM Controls tab reads as a DM-only affordance",
    ((await dmControlsTab.getAttribute("aria-label")) ?? "").toLowerCase().includes("dm controls") &&
      ((await dmControlsTab.getAttribute("aria-label")) ?? "").toLowerCase().includes("dm only")
  );
  check(
    "the Monsters tab's visible decorative label also reads MONSTERS/DM (not just its aria-label)",
    ((await monsterTab.locator("..").innerText()) ?? "").toUpperCase().includes("MONSTERS")
  );
  check("the Monsters tab starts collapsed (aria-expanded=false)", (await monsterTab.getAttribute("aria-expanded")) === "false");
  check(
    "the DM Controls tab starts collapsed (aria-expanded=false)",
    (await dmControlsTab.getAttribute("aria-expanded")) === "false"
  );

  // Neither panel has a DraggablePanel wrapper — Phase C's reserved
  // territory stays out of Phase B's system (belt-and-braces alongside
  // verify-ui-preferences.mjs's own check of this from its side).
  check(
    "MonsterPanel has no DraggablePanel wrapper",
    (await dmPage.locator('[data-testid="draggable-panel-monster"]').count()) === 0
  );
  check(
    "DmOverridesPanel has no DraggablePanel wrapper",
    (await dmPage.locator('[data-testid="draggable-panel-dmControls"]').count()) === 0
  );

  // ---------------------------------------------------------------------
  // Part 2 — clicking the Monsters tab reveals a REAL, USABLE panel: the
  // critical check given the brief's hover-vs-click interactivity
  // concern. Creates one stat block, then edits it — two separate clicks
  // with real mouse travel across the panel between them, exactly the
  // scenario that would break if reveal were tied to a hover zone instead
  // of a click-toggle.
  // ---------------------------------------------------------------------
  await monsterTab.click();
  await dmPage.waitForTimeout(400);
  check("clicking the Monsters tab reveals MonsterPanel", (await monsterPanel.count()) === 1);
  check("the Monsters tab reflects the open state (aria-expanded=true)", (await monsterTab.getAttribute("aria-expanded")) === "true");

  await dmPage.locator('[data-testid="stat-block-name-input"]').fill("Peel Test Goblin");
  await dmPage.locator('[data-testid="stat-block-hp-input"]').fill("7");
  await dmPage.locator('[data-testid="stat-block-ac-input"]').fill("13");
  await dmPage.locator('[data-testid="stat-block-pp-input"]').fill("9");
  await dmPage.locator('[data-testid="stat-block-attack-name-0"]').fill("Bite");
  await dmPage.locator('[data-testid="stat-block-attack-bonus-0"]').fill("3");
  await dmPage.locator('[data-testid="stat-block-attack-damage-0"]').fill("1d4+1");
  await dmPage.locator('[data-testid="stat-block-save"]').click();
  await dmPage.waitForTimeout(800);

  const { data: created } = await admin
    .from("monster_stat_blocks")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("name", "Peel Test Goblin");
  check(
    "a real click inside the revealed MonsterPanel actually created a stat block in the database",
    Array.isArray(created) && created.length === 1 && created[0].max_hp === 7 && created[0].armor_class === 13,
    JSON.stringify(created)
  );
  const statBlockId = created?.[0]?.id;

  // Edit it — a second real interaction (Edit button, change a field,
  // Save changes) after the DM's cursor has already travelled across the
  // panel once.
  if (statBlockId) {
    await dmPage.locator(`[data-testid="edit-stat-block-${statBlockId}"]`).click();
    await dmPage.waitForTimeout(200);
    const hpInput = dmPage.locator('[data-testid="stat-block-hp-input"]');
    await hpInput.fill("");
    await hpInput.fill("22");
    await dmPage.locator('[data-testid="stat-block-save"]').click();
    await dmPage.waitForTimeout(800);
  }
  const { data: edited } = await admin.from("monster_stat_blocks").select("max_hp").eq("id", statBlockId).maybeSingle();
  check(
    "a follow-up edit inside the same revealed panel also reaches the database (sustained interactivity, not a one-shot click)",
    edited?.max_hp === 22,
    JSON.stringify(edited)
  );

  // Dismiss it again — the brief's "declutter once done".
  await monsterTab.click();
  await dmPage.waitForTimeout(400);
  check("clicking the Monsters tab again dismisses MonsterPanel", (await monsterPanel.count()) === 0);
  check(
    "the Monsters tab reflects the closed state again (aria-expanded=false)",
    (await monsterTab.getAttribute("aria-expanded")) === "false"
  );

  // ---------------------------------------------------------------------
  // Part 3 — same real-interactivity check for DmOverridesPanel: reveal,
  // flip the action-economy toggle via a real click, confirm it reached
  // campaigns.action_economy_strict, then dismiss.
  // ---------------------------------------------------------------------
  const { data: beforeToggle } = await admin
    .from("campaigns")
    .select("action_economy_strict")
    .eq("id", campaignId)
    .single();
  check("action_economy_strict starts at its default (true/strict)", beforeToggle.action_economy_strict === true);

  await dmControlsTab.click();
  await dmPage.waitForTimeout(400);
  check("clicking the DM Controls tab reveals DmOverridesPanel", (await dmControlsPanel.count()) === 1);
  check(
    "the DM Controls tab reflects the open state (aria-expanded=true)",
    (await dmControlsTab.getAttribute("aria-expanded")) === "true"
  );

  await dmPage.locator('[data-testid="economy-freeform-button"]').click();
  await dmPage.waitForTimeout(800);
  const { data: afterToggle } = await admin
    .from("campaigns")
    .select("action_economy_strict")
    .eq("id", campaignId)
    .single();
  check(
    "a real click inside the revealed DmOverridesPanel actually flipped action_economy_strict in the database",
    afterToggle.action_economy_strict === false,
    JSON.stringify(afterToggle)
  );

  await dmControlsTab.click();
  await dmPage.waitForTimeout(400);
  check("clicking the DM Controls tab again dismisses DmOverridesPanel", (await dmControlsPanel.count()) === 0);

  // ---------------------------------------------------------------------
  // Part 4 — a PLAYER (non-DM) in the same room sees neither the panels
  // nor their peel tabs at all — the existing DM-only mount condition
  // (`currentUserIsDM && …`) still holds; DmToolPeel adds nothing extra
  // for a player to even discover.
  // ---------------------------------------------------------------------
  const playerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await playerContext.addCookies(sessionCookies(player.session));
  const playerPage = await playerContext.newPage();
  await playerPage.goto(roomUrl);
  await playerPage.waitForSelector('[data-testid="map-panel"]', { timeout: 30000 });
  await playerPage.waitForTimeout(1500);

  check(
    "a player sees NO Monsters peel tab",
    (await playerPage.locator('[data-testid="monster-panel-tab"]').count()) === 0
  );
  check(
    "a player sees NO DM Controls peel tab",
    (await playerPage.locator('[data-testid="dm-controls-panel-tab"]').count()) === 0
  );
  check(
    "a player sees NO MonsterPanel",
    (await playerPage.locator('[data-testid="monster-panel"]').count()) === 0
  );
  check(
    "a player sees NO DmOverridesPanel",
    (await playerPage.locator('[data-testid="dm-controls-panel"]').count()) === 0
  );
} finally {
  await browser.close();
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll dm-peel-reveal checks passed.");
process.exit(0);
