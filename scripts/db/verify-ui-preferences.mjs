#!/usr/bin/env node
// Phase B (UI overhaul) verification: per-user Game Room panel layout
// (position + collapsed state), persisted on profiles.ui_preferences
// (migration 0040_ui_preferences.sql) and rendered through DraggablePanel.
//
// The verify-character-edit.mjs hybrid arrangement: direct-DB checks (the
// column/default, RLS, a round-trip) via the admin/service-role client and
// per-user anon clients, PLUS a real browser driving the actual Game Room
// to confirm the end-to-end feature — default positions on a fresh
// profile, a drag persisting and surviving reload, a collapse persisting
// and surviving reload, MonsterPanel/DmOverridesPanel staying outside this
// whole system (Phase 4's DM's book hosts both now — see verify-dm-book.mjs
// for that feature itself; this file just re-confirms neither ever gained
// a DraggablePanel wrapper), and the cross-campaign persistence requirement
// (layout is per-USER, not per-campaign).
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving — set PORT to
// avoid colliding with another dev server (this repo's other verify-*.mjs
// scripts assume :3000 is free; this one respects PORT so it can run
// alongside other concurrent worktrees/dev servers).
// Usage: PORT=3030 node scripts/db/verify-ui-preferences.mjs

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
  const email = `ui-prefs-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `UI Prefs ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

/** Drags a panel by its content's data-testid (the retrofitted panel
 * component's own <aside data-testid="...">), grabbing its first child —
 * the reused header/drag-handle, per DraggablePanel's structural contract
 * — and releasing `dx`/`dy` pixels away. */
async function dragPanelBy(page, asideTestId, dx, dy) {
  const handle = page.locator(`[data-testid="${asideTestId}"] > :first-child`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`could not find a draggable handle for ${asideTestId}`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 5 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

async function wrapperBox(page, panelId) {
  return page.locator(`[data-testid="draggable-panel-${panelId}"]`).boundingBox();
}

async function readUiPreferences(userId) {
  const { data, error } = await admin.from("profiles").select("ui_preferences").eq("id", userId).single();
  if (error) throw error;
  return data.ui_preferences;
}

// DraggablePanel positions an untouched panel with a CSS anchor class
// (DEFAULT_ANCHOR_CLASS in DraggablePanel.tsx), not a fixed pixel pair —
// deliberately, so it stays exactly as viewport-responsive as the
// `position: absolute` rule it replaces (a hardcoded number is wrong on
// any viewport shorter/narrower than whatever it was measured against, OR
// — for a bottom-anchored panel — whenever its own content height
// differs even at the SAME viewport size). So rather than asserting one
// hardcoded pixel snapshot (which would be fragile against this script's
// own seed data — e.g. the tokens panel's height depends on how many
// tokens are seeded below), this checks the actual ANCHOR INVARIANT each
// panel's old `position: absolute` rule encoded — self-consistent against
// each panel's own measured width/height, exactly like room.module.css's
// original right/bottom/top/left/centered rules were.
const PANEL_WIDTH = {
  combat: 300,
  handout: 320,
  quickActions: 400,
  opportunityAttack: 440,
  map: 320,
  tokens: 300,
  diceLog: 360,
};
const PANEL_ANCHOR = {
  combat: "topLeft",
  handout: "topRight",
  quickActions: "topCenter",
  opportunityAttack: "topCenterLow",
  map: "bottomRight",
  tokens: "bottomLeft",
  diceLog: "bottomCenter",
};
function expectedDefaultPosition(panelId, viewport, measuredHeight) {
  const width = PANEL_WIDTH[panelId];
  switch (PANEL_ANCHOR[panelId]) {
    case "topLeft":
      return { x: 24, y: 64 };
    case "topRight":
      return { x: viewport.width - width - 24, y: 64 };
    case "topCenter":
      return { x: (viewport.width - width) / 2, y: 64 };
    case "topCenterLow":
      return { x: (viewport.width - width) / 2, y: 64 + 0.3 * viewport.height + 12 };
    case "bottomRight":
      return { x: viewport.width - width - 24, y: viewport.height - measuredHeight - 24 };
    case "bottomLeft":
      return { x: 24, y: viewport.height - measuredHeight - 24 };
    case "bottomCenter":
      return { x: (viewport.width - width) / 2, y: viewport.height - measuredHeight - 24 };
    default:
      throw new Error(`unknown anchor for ${panelId}`);
  }
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const other = await makeTestUser("other");
const browser = await chromium.launch();

try {
  // ---------------------------------------------------------------------
  // Part 1 — direct-DB checks: column/default, RLS, round-trip.
  // ---------------------------------------------------------------------

  const dmProfile = await readUiPreferences(dm.id);
  check(
    "profiles.ui_preferences defaults to {} for a freshly created profile",
    dmProfile && typeof dmProfile === "object" && Object.keys(dmProfile).length === 0,
    JSON.stringify(dmProfile)
  );

  // Owner writes their own ui_preferences — the setUiPreferences shape.
  const sampleLayout = { panelLayout: { combat: { x: 111, y: 222, collapsed: false } } };
  const { error: ownWriteError, count: ownWriteCount } = await dm.client
    .from("profiles")
    .update({ ui_preferences: sampleLayout }, { count: "exact" })
    .eq("id", dm.id);
  check(
    "a user can write their own ui_preferences",
    !ownWriteError && ownWriteCount === 1,
    ownWriteError?.message ?? `count=${ownWriteCount}`
  );

  // Round-trip: read it back, byte-for-byte.
  const roundTripped = await readUiPreferences(dm.id);
  check(
    "a saved layout round-trips exactly",
    JSON.stringify(roundTripped) === JSON.stringify(sampleLayout),
    JSON.stringify(roundTripped)
  );

  // Another authenticated member CAN read it — profiles' existing
  // "readable by any authenticated user" SELECT policy (0001) is
  // unweakened and unwidened by this feature, the same posture as
  // display_name/avatar_ref; this isn't a gap introduced here.
  const { data: otherRead, error: otherReadError } = await other.client
    .from("profiles")
    .select("ui_preferences")
    .eq("id", dm.id)
    .maybeSingle();
  check(
    "another authenticated user can READ it (existing profiles SELECT policy, unchanged)",
    !otherReadError && JSON.stringify(otherRead?.ui_preferences) === JSON.stringify(sampleLayout),
    otherReadError?.message
  );

  // But another user's WRITE to someone else's ui_preferences is rejected
  // by the existing self-only UPDATE policy — the real security boundary.
  const { data: otherWrite, error: otherWriteError } = await other.client
    .from("profiles")
    .update({ ui_preferences: { panelLayout: { combat: { x: 999, y: 999, collapsed: true } } } })
    .eq("id", dm.id)
    .select();
  const afterOtherWrite = await readUiPreferences(dm.id);
  check(
    "another user cannot write a DIFFERENT user's ui_preferences (existing self-only UPDATE policy)",
    (otherWrite ?? []).length === 0 && JSON.stringify(afterOtherWrite) === JSON.stringify(sampleLayout),
    JSON.stringify({ returned: otherWrite, error: otherWriteError?.message, stored: afterOtherWrite })
  );

  // Reset the DM's row to the true default before the browser checks below
  // — those specifically need a NEVER-customized profile to exercise the
  // hardcoded defaults.
  await admin.from("profiles").update({ ui_preferences: {} }).eq("id", dm.id);

  // ---------------------------------------------------------------------
  // Part 2 — a real browser driving the actual Game Room.
  // ---------------------------------------------------------------------

  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "UI prefs test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  const mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "UI Prefs Map", grid_width: 20, grid_height: 20 });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  await admin.from("map_tokens").insert([
    { id: crypto.randomUUID(), map_id: mapId, npc_name: "Goblin", x: 2, y: 2, elevation: 0, allegiance: "hostile" },
    { id: crypto.randomUUID(), map_id: mapId, npc_name: "Ally", x: 3, y: 3, elevation: 0, allegiance: "party" },
  ]);
  await admin.from("roll_log").insert({
    id: crypto.randomUUID(),
    campaign_id: campaignId,
    roller_user_id: dm.id,
    kind: "freeform",
    total: 14,
    breakdown: {
      type: "dice",
      label: "Free-form roll",
      notation: "1d20",
      groups: [{ count: 1, sides: 20, sign: 1, results: [14] }],
      modifier: 0,
    },
  });

  // A second campaign for the cross-campaign persistence check — same DM,
  // no map (Phase B's layout is per-user, so this campaign's room never
  // needs its own map/tokens to prove the point).
  const campaignId2 = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId2, name: "UI prefs test 2", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId2, user_id: dm.id, role: "dm" }]);

  // QuickActionsPanel and OpportunityAttackPanel only render SOMETHING
  // while combat is active (the former needs a current PC combatant the
  // viewer can act for; the latter needs a pending offer) — GameRoom
  // mounts both unconditionally and lets them decide, so their default
  // position can only be observed with that state actually seeded. A DM
  // normally has no PC, but nothing stops one from owning a character for
  // this check — combat_encounters/combat_combatants/opportunity_attacks
  // seeded directly (the verify-quick-actions.mjs/verify-opportunity-
  // attacks.mjs precedent: start_combat is DM-browser territory, verified
  // elsewhere, not re-derived here).
  const dmCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: dmCharacterId,
    campaign_id: campaignId,
    owner_id: dm.id,
    name: "DM's Test PC",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 14,
    dexterity: 12,
    constitution: 13,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 12,
    max_hp: 12,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });
  const dmTokenId = crypto.randomUUID();
  const goblinTokenId2 = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: dmTokenId, map_id: mapId, character_id: dmCharacterId, x: 5, y: 5, elevation: 0, allegiance: "party" },
    { id: goblinTokenId2, map_id: mapId, npc_name: "Reactor Goblin", x: 6, y: 5, elevation: 0, allegiance: "hostile" },
  ]);
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const { data: combatantRows } = await admin
    .from("combat_combatants")
    .insert([
      { encounter_id: encounterId, token_id: dmTokenId, character_id: dmCharacterId, initiative: 20 },
      { encounter_id: encounterId, token_id: goblinTokenId2, npc_name: "Reactor Goblin", initiative: 10 },
    ])
    .select();
  const dmCombatantId = combatantRows.find((row) => row.character_id === dmCharacterId).id;
  const goblinCombatantId = combatantRows.find((row) => row.character_id === null).id;
  const { error: oaInsertError } = await admin.from("opportunity_attacks").insert({
    campaign_id: campaignId,
    encounter_id: encounterId,
    mover_combatant_id: goblinCombatantId,
    reactor_combatant_id: dmCombatantId,
    status: "pending",
  });
  if (oaInsertError) console.error("opportunity_attacks seed insert failed:", oaInsertError.message);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(sessionCookies(dm.session));
  const page = await context.newPage();
  const roomUrl = (id) => `${APP_URL}/campaigns/${id}/room`;

  await page.goto(roomUrl(campaignId));
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 30000 });
  await page.waitForTimeout(1500); // let the 3D scene / async panels settle

  // -- 2a. Every retrofitted panel renders at its historical default
  //    anchor position on a first-ever (no saved preference) load. --
  const viewport900 = { width: 1440, height: 900 };
  for (const panelId of Object.keys(PANEL_WIDTH)) {
    const box = await wrapperBox(page, panelId);
    const expected = box ? expectedDefaultPosition(panelId, viewport900, box.height) : null;
    check(
      `"${panelId}" panel renders at its default anchor position on first load` +
        (expected ? ` (${Math.round(expected.x)}, ${Math.round(expected.y)})` : ""),
      box !== null &&
        expected !== null &&
        Math.round(box.x) === Math.round(expected.x) &&
        Math.round(box.y) === Math.round(expected.y),
      JSON.stringify(box)
    );
  }

  // -- 2a-bis. Viewport-responsiveness regression check: an UNTOUCHED
  //    bottom/right-anchored panel must stay fully on-screen at a SHORTER
  //    viewport too — proof the default position is a CSS anchor (which
  //    is always viewport-relative), not a fixed pixel pair baked in for
  //    one specific screen size (which would push it off-screen below a
  //    shorter viewport, exactly the regression this check guards). Reuses
  //    this same page/session — no separate browser context needed.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(300);
  const diceLogAtShortViewport = await wrapperBox(page, "diceLog");
  const tokensAtShortViewport = await wrapperBox(page, "tokens");
  check(
    "an untouched bottom-anchored panel (diceLog) stays fully within a SHORTER 720px-tall viewport",
    diceLogAtShortViewport !== null && diceLogAtShortViewport.y + diceLogAtShortViewport.height <= 720,
    JSON.stringify(diceLogAtShortViewport)
  );
  check(
    "an untouched bottom-anchored panel (tokens) stays fully within a SHORTER 720px-tall viewport",
    tokensAtShortViewport !== null && tokensAtShortViewport.y + tokensAtShortViewport.height <= 720,
    JSON.stringify(tokensAtShortViewport)
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  // -- 2b. MonsterPanel/DmOverridesPanel are completely unaffected by
  //    Phase B: no draggable-panel wrapper exists for either. STALE
  //    ASSUMPTION UPDATE (Phase 4): this section originally assumed Phase
  //    C's abandoned Peel-reveal tabs ("monster-panel-tab"/"dm-controls-
  //    panel-tab", never actually wired into GameRoom before that attempt
  //    was reverted) — those testids never existed on a real page. Phase 4
  //    replaced that reserved territory for real: both panels now live
  //    inside the DM's book (DmBook.tsx), opened via "dm-book-toggle" and
  //    switched to via "dm-book-tab-enemies"/"dm-book-tab-dmControls".
  //    Still confirms: no DraggablePanel wrapper for either, and the book
  //    itself (not either panel) is the only thing that could ever move —
  //    dragging a panel's own header does nothing, because the book is a
  //    fixed-position overlay outside the whole drag/collapse system. --
  check(
    "MonsterPanel has NO DraggablePanel wrapper (Phase 4: hosted by the DM's book instead)",
    (await page.locator('[data-testid="draggable-panel-monster"]').count()) === 0
  );
  check(
    "DmOverridesPanel has NO DraggablePanel wrapper (Phase 4: hosted by the DM's book instead)",
    (await page.locator('[data-testid="draggable-panel-dmControls"]').count()) === 0
  );
  await page.getByTestId("dm-book-toggle").click();
  await page.waitForSelector('[data-testid="dm-book-panel"]', { timeout: 10000 });
  // The book defaults to its Enemies page, so MonsterPanel is already
  // showing; DM Controls needs its own tab.
  const monsterBox = await page.locator('[data-testid="monster-panel"]').boundingBox();
  check("MonsterPanel renders inside the open book", monsterBox !== null, JSON.stringify(monsterBox));
  await page.getByTestId("dm-book-tab-dmControls").click();
  await page.waitForTimeout(300);
  const dmControlsBox = await page.locator('[data-testid="dm-controls-panel"]').boundingBox();
  check("DmOverridesPanel renders inside the open book", dmControlsBox !== null, JSON.stringify(dmControlsBox));
  await page.getByTestId("dm-book-tab-enemies").click();
  await page.waitForTimeout(300);
  const bookBoxBeforeDrag = await page.locator('[data-testid="dm-book-panel"]').boundingBox();
  const monsterBoxBeforeDrag = await page.locator('[data-testid="monster-panel"]').boundingBox();
  // Attempting to drag MonsterPanel's header must not move it, or the book
  // around it — the book is fixed-position, not part of DraggablePanel.
  await dragPanelBy(page, "monster-panel", 200, 50);
  await page.waitForTimeout(300);
  const bookBoxAfterDrag = await page.locator('[data-testid="dm-book-panel"]').boundingBox();
  const monsterBoxAfterDrag = await page.locator('[data-testid="monster-panel"]').boundingBox();
  check(
    "MonsterPanel (and the book around it) does not move when its header is dragged — the book is fixed-position, not draggable",
    monsterBoxBeforeDrag !== null &&
      monsterBoxAfterDrag !== null &&
      bookBoxBeforeDrag !== null &&
      bookBoxAfterDrag !== null &&
      Math.round(monsterBoxBeforeDrag.x) === Math.round(monsterBoxAfterDrag.x) &&
      Math.round(monsterBoxBeforeDrag.y) === Math.round(monsterBoxAfterDrag.y) &&
      Math.round(bookBoxBeforeDrag.x) === Math.round(bookBoxAfterDrag.x) &&
      Math.round(bookBoxBeforeDrag.y) === Math.round(bookBoxAfterDrag.y),
    JSON.stringify({ monsterBefore: monsterBoxBeforeDrag, monsterAfter: monsterBoxAfterDrag, bookBefore: bookBoxBeforeDrag, bookAfter: bookBoxAfterDrag })
  );
  // Close the book so it doesn't cover any later panel this script checks.
  await page.getByTestId("dm-book-close").click();
  await page.waitForTimeout(300);

  // -- 2c. Drag the combat panel to a new spot; confirm it persists to the
  //    database (after the debounce) and survives a reload. --
  // combat is topLeft-anchored (a fixed 24, 64 regardless of content or
  // viewport), so its default needs no height measurement.
  const combatDefault = expectedDefaultPosition("combat", viewport900, 0);
  await dragPanelBy(page, "combat-panel", 260, 180);
  const expectedCombatPos = { x: combatDefault.x + 260, y: combatDefault.y + 180 };
  await page.waitForTimeout(300);
  const combatBoxAfterDrag = await wrapperBox(page, "combat");
  check(
    "dragging the combat panel moves it immediately (client-side)",
    combatBoxAfterDrag !== null &&
      Math.round(combatBoxAfterDrag.x) === expectedCombatPos.x &&
      Math.round(combatBoxAfterDrag.y) === expectedCombatPos.y,
    JSON.stringify(combatBoxAfterDrag)
  );

  // Debounce is 500ms — give it real margin.
  let persistedLayout = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    persistedLayout = (await readUiPreferences(dm.id)).panelLayout;
    if (persistedLayout?.combat) break;
  }
  check(
    "the dragged position is persisted to profiles.ui_preferences after the debounce",
    persistedLayout?.combat?.x === expectedCombatPos.x && persistedLayout?.combat?.y === expectedCombatPos.y,
    JSON.stringify(persistedLayout?.combat)
  );

  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 30000 });
  await page.waitForTimeout(1000);
  const combatBoxAfterReload = await wrapperBox(page, "combat");
  check(
    "the dragged position survives a full page reload",
    combatBoxAfterReload !== null &&
      Math.round(combatBoxAfterReload.x) === expectedCombatPos.x &&
      Math.round(combatBoxAfterReload.y) === expectedCombatPos.y,
    JSON.stringify(combatBoxAfterReload)
  );

  // -- 2d. Collapse the combat panel; confirm it persists and survives a
  //    reload (the panel's body hides, its header/drag-handle stays). --
  // Active combat is seeded above (for the quickActions/opportunityAttack
  // default-position checks), so the combat panel's body here is the
  // ACTIVE-encounter view (current-turn-indicator), not the "no combat yet"
  // start-combat-button branch.
  check(
    "the combat panel's body is visible before collapsing",
    await page.locator('[data-testid="current-turn-indicator"]').isVisible()
  );
  await page.locator('[data-testid="collapse-toggle-combat"]').click();
  await page.waitForTimeout(300);
  check(
    "collapsing hides the panel's body while its header stays",
    !(await page.locator('[data-testid="current-turn-indicator"]').isVisible()) &&
      (await page.locator('[data-testid="collapse-toggle-combat"]').isVisible())
  );

  let persistedCollapsed = null;
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    persistedCollapsed = (await readUiPreferences(dm.id)).panelLayout?.combat?.collapsed;
    if (persistedCollapsed === true) break;
  }
  check("the collapsed state is persisted after the debounce", persistedCollapsed === true, String(persistedCollapsed));

  await page.reload();
  await page.waitForSelector('[data-testid="map-panel"]', { timeout: 30000 });
  await page.waitForTimeout(1000);
  check(
    "the collapsed state survives a full page reload",
    !(await page.locator('[data-testid="current-turn-indicator"]').isVisible()) &&
      (await page.locator('[data-testid="collapse-toggle-combat"]').isVisible())
  );

  // Expand it again for the next check's sanity (not strictly required,
  // but keeps this script's own state easy to reason about if extended).
  await page.locator('[data-testid="collapse-toggle-combat"]').click();
  await page.waitForTimeout(800);

  // -- 2e. Cross-campaign persistence: the SAME moved position appears in
  //    a totally different campaign's Game Room, because layout is
  //    per-user, not per-campaign (profiles.ui_preferences, not a
  //    campaigns column). --
  await page.goto(roomUrl(campaignId2));
  await page.waitForSelector('[data-testid="combat-panel"]', { timeout: 30000 });
  await page.waitForTimeout(1000);
  const combatBoxOtherCampaign = await wrapperBox(page, "combat");
  check(
    "the moved combat panel position follows the user into a DIFFERENT campaign's room",
    combatBoxOtherCampaign !== null &&
      Math.round(combatBoxOtherCampaign.x) === expectedCombatPos.x &&
      Math.round(combatBoxOtherCampaign.y) === expectedCombatPos.y,
    JSON.stringify(combatBoxOtherCampaign)
  );
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(other.id);
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
console.log("\nAll ui-preferences checks passed.");
process.exit(0);
