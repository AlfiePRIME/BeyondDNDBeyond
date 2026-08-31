#!/usr/bin/env node
// Attack Weapon/Spell Picker verification (the click-to-attack modal's
// pendingAttack scope, GameRoom.tsx) — the DM's ask was "when users attack
// enemies it should offer all their possible attack weapons/spells/
// cantrips, please make a nice ui for this." Replaces the old manual
// "pick a category, type dice notation from memory" form with a real
// computeQuickActions-built card picker (the exact same pure engine
// QuickActionsPanel already relies on), fed this modal's own fixed
// attacker/target instead of a combat turn's whole hostile roster.
//
// Drives a real browser against a seeded campaign (no active combat
// required — click-to-attack itself works whether or not combat is
// formally active, unaffected by this change). Covers:
//   1. A character with a tagged melee weapon AND a tagged cantrip AND a
//      leveled spell sees all three offered distinctly, grouped, when
//      attacking a real in-range hostile token.
//   2. Picking each one in turn correctly pre-fills the attack kind/damage
//      before rolling — verified by inspecting the REAL roll_log row each
//      Roll! produces (attackKind + damage.notation), not by reading
//      hidden form state.
//   3. A resource-blocked leveled spell (no matching-level slot left)
//      renders disabled with its reason, WITHOUT hiding the character's
//      still-usable weapon/cantrip alongside it, and clicking the disabled
//      card is a no-op (never becomes "selected").
//   4. The roll itself still POSTs correctly and applies damage exactly as
//      it does today — a regression check against the existing click-to-
//      attack mechanics: the target's stored HP moves by exactly the
//      landed roll's own hit/damage outcome, whichever it turns out to be.
//   5. A character with nothing tagged at all (no weapon attackKind, no
//      spells) gets the original manual kind+notation form as a sensible
//      fallback, with a clear "nothing tagged" pointer at the character
//      sheet — and that manual path still rolls/applies damage correctly.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if the target port isn't already serving. Uses port 6531 —
// deliberately NOT 3000 (this host's real, live production server) and not
// any port another verify-*.mjs script already claims.
// Usage: node scripts/db/verify-attack-weapon-spell-picker.mjs
// Override: APP_URL=http://localhost:<port> node scripts/db/verify-attack-weapon-spell-picker.mjs

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 6531;
// Explicit env override always wins (never silently fall back to :3000 —
// that's this host's real, live production server, not a disposable dev
// instance). With no override, use OUR OWN fixed, non-3000 port.
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;

const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
const SCREENSHOT_DIR = join(SCRATCH_DIR, "attack-picker-screenshots");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

// Started only if the target port isn't already serving; if we started it,
// we kill it (its whole detached process group) on the way out. Since
// APP_URL/PORT here are never :3000, this can never accidentally treat the
// live production server as "already healthy, reuse it".
let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on ${APP_URL} — starting this worktree's own…`);
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
  const email = `attack-picker-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Attack Picker ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function tokenRow(id) {
  const { data } = await admin.from("map_tokens").select().eq("id", id).single();
  return data;
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function readMirror(page, testid) {
  const text = await page.textContent(`[data-testid="${testid}"]`);
  return JSON.parse(text);
}

const selectionState = (page) => readMirror(page, "token-selection-state");

/** verify-token-click-select.mjs's own blind grid scan, unchanged (see
 * verify-click-to-attack.mjs, which reuses it the exact same way). */
async function scanGridClick(page, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 34, settleMs = 160, onMiss } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 1.5],
  ]) {
    const points = [];
    for (let y = box.y + box.height * yFrom + offset; y <= box.y + box.height * yTo; y += step) {
      for (let x = box.x + box.width * xFrom + offset; x <= box.x + box.width * xTo; x += step) {
        points.push({ x, y });
      }
    }
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    points.sort((a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2));
    for (const point of points) {
      await page.mouse.click(point.x, point.y);
      await sleep(settle);
      if (await done(point)) return point;
      if (onMiss) await onMiss(point);
    }
  }
  return null;
}

/** verify-click-to-attack.mjs's own fine local scan around a known screen
 * point — the whole grid renders at only a small fraction of the canvas,
 * far smaller than scanGridClick's own coarse step, so finding one
 * SPECIFIC adjacent cell (not "any" reachable cell) needs a small-step,
 * small-radius, nearest-first search. */
async function scanLocalGrid(page, center, done, opts = {}) {
  const { radius = 30, step = 3, settleMs = 150, onMiss } = opts;
  const points = [];
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      points.push({ x: center.x + dx, y: center.y + dy });
    }
  }
  points.sort((a, b) => (a.x - center.x) ** 2 + (a.y - center.y) ** 2 - ((b.x - center.x) ** 2 + (b.y - center.y) ** 2));
  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    await sleep(settleMs);
    if (await done(point)) return point;
    if (onMiss) await onMiss(point);
  }
  return null;
}

/** Like scanLocalGrid, but for the specific "find the target's cell, given
 * the attacker is already selected" step: re-checks (and, if needed,
 * restores) the attacker's own selection BEFORE every candidate click,
 * not just reactively after a miss. A reactive-only reselect (onMiss)
 * leaves a real gap — a candidate point that happens to land on a
 * DIFFERENT party token (silently switching the live selection, per
 * handleTokenSelect's own "switching between two friendly selections"
 * branch) is only caught on the FOLLOWING iteration, so if the training
 * arena's other PC token sits at a comparable on-screen distance to the
 * real target, a later click can land on the target's cell while that
 * wrong token is still selected, opening this modal for the WRONG
 * attacker — confirmed via a real screenshot during this test's own
 * development (Alice's own tagged picker opening instead of the
 * untagged character's fallback). Checking selection state up front, on
 * every single candidate, closes that gap entirely. */
async function scanForTargetCell(page, attackerTokenId, attackerPoint, opts = {}) {
  const { radius = 110, step = 8, settleMs = 150 } = opts;
  const points = [];
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      points.push({ x: attackerPoint.x + dx, y: attackerPoint.y + dy });
    }
  }
  points.sort(
    (a, b) =>
      (a.x - attackerPoint.x) ** 2 + (a.y - attackerPoint.y) ** 2 -
      ((b.x - attackerPoint.x) ** 2 + (b.y - attackerPoint.y) ** 2)
  );
  for (const point of points) {
    const state = await selectionState(page);
    if (state.selectedTokenId !== attackerTokenId) {
      await page.mouse.click(attackerPoint.x, attackerPoint.y);
      await sleep(200);
    }
    await page.mouse.click(point.x, point.y);
    await sleep(settleMs);
    if (await isVisible(page, "attack-prompt-modal")) return point;
  }
  return null;
}

/** Select `attackerTokenId`, then move it onto the Goblin's own cell to
 * open the attack prompt — the exact click-to-attack gesture verify-
 * click-to-attack.mjs already validated. Returns the attacker's own
 * screen point (for re-selection) or null if the prompt never opened. */
// `seedPoint` (an already-known, stable screen point near the attacker's
// own token — e.g. another token discovered earlier in this same arena,
// since none of these tokens ever move) lets a tight cluster of tokens
// use the FINE local scan to find the attacker itself, not just the
// target cell — this grid renders at a tiny on-screen footprint (a few
// dozen px across the whole board at this camera framing), which
// scanGridClick's coarse full-canvas step can trivially skip clean over
// for a SPECIFIC nearby token the way it can't for "any" reachable cell.
// With no seed, falls back to the full blind scan (verify-click-to-
// attack.mjs's own proven technique) for the very first selection.
async function openAttackPromptOnce(page, attackerTokenId, seedPoint) {
  const point = seedPoint
    ? await scanLocalGrid(page, seedPoint, async () => (await selectionState(page)).selectedTokenId === attackerTokenId, {
        radius: 90,
        step: 4,
        settleMs: 150,
      })
    : await scanGridClick(page, async () => (await selectionState(page)).selectedTokenId === attackerTokenId);
  if (!point) return null;
  // The target's own cell can be a full diagonal cell or more away from the
  // attacker's own screen point at this arena's camera scale (confirmed via
  // a real screenshot: ~80-90px per cell at the 1400x900 viewport this
  // script uses) — a plain adjacent-cell default radius (30, tuned for a
  // smaller default viewport elsewhere) can undershoot that by a wide
  // margin, so this search gets a generously larger radius instead of
  // assuming the target renders within one small step of the attacker —
  // see scanForTargetCell's own doc comment for why it also re-verifies
  // the attacker's own selection before every candidate click, not just
  // reactively after a miss.
  const opened = await scanForTargetCell(page, attackerTokenId, point, { radius: 130, step: 8, settleMs: 150 });
  return opened ? point : null;
}

// This script re-opens the SAME modal several times in a row on the same
// token (once per picker entry, plus the resource-blocked reopen) — this
// repo's own documented baseline for blind-canvas-click Playwright scripts
// (verify-token-click-select.mjs/verify-hit-sounds.mjs) is that a stray
// miss now and then is expected noise from the scanning technique itself,
// not a product regression signal by itself. A short retry absorbs that
// noise instead of failing the whole run on one unlucky scan.
async function openAttackPrompt(page, attackerTokenId, opts = {}) {
  const { attempts = 2, seedPoint } = opts;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const point = await openAttackPromptOnce(page, attackerTokenId, seedPoint);
    if (point) return point;
    console.log(`  (attack prompt didn't open on attempt ${attempt}/${attempts} for token ${attackerTokenId} with the fast seeded scan — retrying)`);
    await sleep(500);
  }
  // Fall back to the slower, but independently proven (verify-click-to-
  // attack.mjs's own technique), full blind canvas scan — a different
  // search strategy rather than repeating the same one, in case the seed
  // point itself has drifted (camera nudge, animation) rather than the
  // token being genuinely hard to hit.
  if (seedPoint) {
    console.log("  (falling back to a full blind canvas scan)");
    const point = await openAttackPromptOnce(page, attackerTokenId, undefined);
    if (point) return point;
  }
  return null;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  const campaignId = crypto.randomUUID();
  // Freeform action economy: this script fires several attacks from the
  // same character in one "turn" on purpose, to exercise all three picker
  // entries in sequence — Strict mode (the default) would reject the
  // second and later ones with "You've already used your action this
  // turn." That gate is pre-existing, unrelated action-economy behavior
  // (verify-action-economy.mjs's own scope), not something this feature
  // touches.
  await admin
    .from("campaigns")
    .insert({ id: campaignId, name: "Attack picker test", creator: dm.id, action_economy_strict: false });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // Sorcerer: spellcasting ability CHA, so spell quick actions are legal
  // for the roll route; a tagged melee Shortsword, a tagged cantrip (Fire
  // Bolt, attack-flagged in the SRD catalog), and a tagged 1st-level spell
  // (Chromatic Orb, also attack-flagged) — the three distinct sources the
  // DM's own ask names ("weapons/spells/cantrips"). High CHA/STR so the
  // attack bonus is comfortably positive against the AC 1 target below.
  const aliceCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: aliceCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Alice Spellblade",
    race: "Human",
    class: "Sorcerer",
    level: 3,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 16,
    current_hp: 30,
    max_hp: 30,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [{ name: "Shortsword", quantity: 1, attackKind: "melee", damageNotation: "1d6+3" }],
    spells: [
      { name: "Fire Bolt", level: 0 },
      { name: "Chromatic Orb", level: 1 },
    ],
  });
  const slotInsert = await admin
    .from("character_resources")
    .insert({
      character_id: aliceCharacterId,
      name: "1st-Level Spell Slots",
      max_uses: 2,
      current_uses: 1,
      recharge: "long_rest",
    })
    .select()
    .single();
  const slotResourceId = slotInsert.data.id;

  // A second PC, same owner (Alice), with NOTHING tagged at all — the
  // "sensible fallback" case. Owned by the same user so one browser
  // session/context covers both (draggable/selectable gates on
  // ownCharacterIds, not "whichever PC is the room's default").
  const noTagsCharacterId = crypto.randomUUID();
  await admin.from("characters").insert({
    id: noTagsCharacterId,
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Nora Bystander",
    race: "Human",
    class: "Fighter",
    level: 1,
    strength: 10,
    dexterity: 10,
    constitution: 10,
    intelligence: 10,
    wisdom: 10,
    charisma: 10,
    current_hp: 20,
    max_hp: 20,
    armor_class: 12,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
  });

  const GRID = 7;
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Attack picker arena",
    grid_width: GRID,
    grid_height: GRID,
  });

  // AC 1 (only a natural 1 misses) and generous HP so several rolls in a
  // row never risk dropping it to 0 mid-test; the exact hit/miss/damage
  // outcome of each individual roll is read back from its own roll_log row
  // rather than assumed, so this is about keeping the target alive, not
  // about forcing a guaranteed hit.
  const { data: statBlock } = await admin
    .from("monster_stat_blocks")
    .insert({
      campaign_id: campaignId,
      name: "Training Goblin",
      max_hp: 500,
      armor_class: 1,
      attacks: [{ name: "Scimitar", bonus: 4, damageNotation: "1d6+2" }],
    })
    .select()
    .single();

  const center = Math.floor(GRID / 2);
  const aliceTokenId = crypto.randomUUID();
  const noTagsTokenId = crypto.randomUUID();
  const goblinTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: aliceTokenId, map_id: mapId, character_id: aliceCharacterId, x: center, y: center, elevation: 0, allegiance: "party" },
    // In a straight line past the Goblin (not equidistant with Alice) —
    // confirmed via a real screenshot during this test's own development
    // that an equidistant-ish placement lets a widened target-cell scan
    // (needed for the diagonal case) wander onto ALICE's own token first,
    // since she was actually the CLOSER token from NoTags's own screen
    // position, occasionally opening Alice's own (tagged) picker instead
    // of NoTags's fallback. Placing NoTags two cells past the Goblin keeps
    // the Goblin unambiguously nearest to her.
    { id: noTagsTokenId, map_id: mapId, character_id: noTagsCharacterId, x: center, y: center + 2, elevation: 0, allegiance: "party" },
    {
      id: goblinTokenId,
      map_id: mapId,
      npc_name: statBlock.name,
      monster_stat_block_id: statBlock.id,
      x: center,
      y: center + 1,
      elevation: 0,
      allegiance: "hostile",
    },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  // Deliberately NO active combat encounter: click-to-attack itself works
  // whether or not combat is formally active (handleSelectedTokenCellClick's
  // occupant-check runs unconditionally, before any reachable-set/budget
  // check), and a real screenshot taken during this test's own development
  // showed WHY that matters here too — an active encounter engages this
  // room's "turn camera" (GameTableScene's turnCameraActive) whenever the
  // viewing player's OWN character has the current turn, which reframes/
  // re-zooms the board around that turn's token. That's real product
  // behavior, not a bug, but it makes a blind-click scan's assumed on-
  // screen token layout unstable across page loads for this test's
  // purposes. Leaving combat out entirely keeps the camera in its plain
  // default framing, which is what every scan below assumes — stray scan
  // clicks are silent moves with no encounter/budget to reject them
  // against, which is harmless here since every assertion below re-reads
  // state by row id, never by an assumed board position.

  // Dock every floating panel — by default they cover most of the canvas,
  // and a DOM panel sitting on top of the canvas at a given pixel swallows
  // a page.mouse.click() there before it ever reaches the WebGL scene
  // beneath (verify-click-to-attack.mjs's own confirmed precedent). Also
  // used to re-settle the page on a fresh load below, ahead of the
  // nothing-tagged scenario — a clean reload rather than reusing a page
  // that's already been through several rolls/modal cycles.
  async function dockAllPanels() {
    for (const panelId of [
      "combat",
      "opportunityAttack",
      "quickActions",
      "diceLog",
      "handout",
      "diceTray",
      "hp",
      "liveObjects",
      "chatLog",
      "tokens",
      "map",
    ]) {
      await room.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 1000 }).catch(() => undefined);
    }
    await sleep(300);
  }

  // A larger-than-default viewport — confirmed via a real screenshot during
  // this test's own development that Playwright's default (1280x720)
  // renders this arena's tokens cramped enough to make the coarse blind
  // scan flaky; at 1400x900 the same three tokens render large and clearly
  // separated.
  let aliceContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  let room = await aliceContext.newPage();
  await room.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await room.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
  await sleep(2000);
  await dockAllPanels();

  // ── 0. Nothing tagged at all: sensible fallback, manual form still
  //    fully functional (regression against the pre-existing manual path).
  //    Done FIRST, on the freshest possible page/context, using the same
  //    full blind canvas scan (no seed) that's reliably found the "first
  //    thing selected on a fresh page" token in every run of this script —
  //    so this scenario runs before any of Alice's own multi-roll sequence
  //    below has a chance to leave anything behind. ──
  const openedNoTags = await openAttackPrompt(room, noTagsTokenId);
  check("selecting the untagged character and attacking the Goblin opens the prompt", openedNoTags !== null);
  const nothingTaggedText = await room.textContent('[data-testid="attack-prompt-nothing-tagged"]').catch(() => "");
  check(
    "a character with nothing tagged gets a clear message naming them, not a broken/empty modal",
    (nothingTaggedText ?? "").includes("Nora Bystander"),
    nothingTaggedText
  );
  check("no picker is shown when there's nothing to pick from", (await isVisible(room, "attack-prompt-picker")) === false);
  check("the original manual kind/notation form is the fallback", (await isVisible(room, "attack-prompt-kind")) && (await isVisible(room, "attack-prompt-damage")));
  await room.screenshot({ path: join(SCREENSHOT_DIR, "03-nothing-tagged-fallback.png") });

  // Only a natural 1 misses vs this AC-1 target, and (like rollAndVerify
  // above) a miss never rolls damage at all — retried up to a few times
  // so the notation assertion below always has a real hit to check
  // against, matching verify-quick-actions.mjs's own established
  // "retry a couple of times so the assertion isn't flaky" convention.
  let manualLanded = null;
  let goblinBeforeManualRaw = null;
  for (let attempt = 1; attempt <= 5 && !manualLanded; attempt++) {
    const goblinBeforeManual = await tokenRow(goblinTokenId);
    goblinBeforeManualRaw = goblinBeforeManual.current_hp;
    await room.selectOption('[data-testid="attack-prompt-kind"]', "melee");
    await room.fill('[data-testid="attack-prompt-damage"]', "1d6");
    await room.click('[data-testid="attack-prompt-roll"]');
    try {
      await room.waitForFunction(
        (testid) => !document.querySelector(`[data-testid="${testid}"]`),
        "attack-prompt-modal",
        { timeout: 15000 }
      );
    } catch (err) {
      const errorText = await room.textContent('[data-testid="attack-prompt-error"]').catch(() => null);
      await room.screenshot({ path: join(SCREENSHOT_DIR, "debug-roll-timeout-manual.png") }).catch(() => undefined);
      throw new Error(`Roll! never closed the modal for the manual fallback — attack-prompt-error: ${errorText}`, { cause: err });
    }
    await sleep(1200);
    const { data: manualRolls } = await admin
      .from("roll_log")
      .select()
      .eq("campaign_id", campaignId)
      .eq("kind", "attack")
      .order("created_at", { ascending: false })
      .limit(1);
    const landed = manualRolls?.[0] ?? null;
    if (landed?.breakdown?.attack?.hit || attempt === 5) {
      manualLanded = landed;
      break;
    }
    // A natural-1 miss: re-open the prompt for another try.
    const reopened = await openAttackPrompt(room, noTagsTokenId);
    if (!reopened) break;
  }
  check(
    "the manual fallback form still rolls correctly (regression: unrelated to the new picker)",
    manualLanded?.breakdown?.attack?.attackKind === "melee" &&
      manualLanded?.breakdown?.attack?.damage?.notation === "1d6" &&
      manualLanded?.character_id === noTagsCharacterId &&
      manualLanded?.breakdown?.attack?.targetTokenId === goblinTokenId,
    JSON.stringify(manualLanded?.breakdown?.attack)
  );
  const goblinAfterManual = await tokenRow(goblinTokenId);
  const manualAttack = manualLanded?.breakdown?.attack;
  const expectedManualHp = manualAttack?.hit
    ? Math.max(0, (goblinBeforeManualRaw ?? statBlock.max_hp) - (manualAttack.damage?.total ?? 0))
    : goblinBeforeManualRaw;
  check(
    "the manual fallback's roll still applies damage exactly as it does today",
    goblinAfterManual.current_hp === expectedManualHp,
    `before=${goblinBeforeManualRaw} after=${goblinAfterManual.current_hp}`
  );

  // Fresh context for Alice's own (longer, multi-roll) sequence below —
  // same reasoning as above, this time so NoTags's own roll/modal cycle
  // just now can't leave anything behind for Alice's turn either.
  await aliceContext.close();
  aliceContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  room = await aliceContext.newPage();
  await room.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await room.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
  await sleep(2000);
  await dockAllPanels();

  // ── 1. All three tagged actions surface, distinctly grouped, none
  //    blocked (the slot has 1 use left). ──
  const opened1 = await openAttackPrompt(room, aliceTokenId);
  check("selecting Alice and moving onto the Goblin's cell opens the attack prompt", opened1 !== null);
  check("the computeQuickActions picker (not the old bare form) is what's showing", await isVisible(room, "attack-prompt-picker"));
  check("the weapon is offered as a distinct card", await isVisible(room, "attack-prompt-action-weapon-shortsword"));
  check("the cantrip is offered as a distinct card", await isVisible(room, "attack-prompt-action-spell-fire-bolt"));
  check("the leveled spell is offered as a distinct card", await isVisible(room, "attack-prompt-action-spell-chromatic-orb"));
  const cantripText = await room.textContent('[data-testid="attack-prompt-action-spell-fire-bolt"]').catch(() => "");
  check('the cantrip card is labeled "cantrip", not a spell level', (cantripText ?? "").toLowerCase().includes("cantrip"));
  const leveledText = await room.textContent('[data-testid="attack-prompt-action-spell-chromatic-orb"]').catch(() => "");
  check('the leveled spell card is labeled "level 1"', (leveledText ?? "").includes("level 1"));
  check(
    "none of the three are blocked while the slot has a use left",
    (await isVisible(room, "attack-prompt-action-blocked-weapon-shortsword")) === false &&
      (await isVisible(room, "attack-prompt-action-blocked-spell-fire-bolt")) === false &&
      (await isVisible(room, "attack-prompt-action-blocked-spell-chromatic-orb")) === false
  );
  const pickerText = await room.textContent('[data-testid="attack-prompt-picker"]').catch(() => "");
  check(
    "the picker groups by Weapons/Cantrips/Spells, matching the DM's own ask",
    ["Weapons", "Cantrips", "Spells"].every((label) => (pickerText ?? "").includes(label))
  );
  await room.screenshot({ path: join(SCREENSHOT_DIR, "01-all-three-offered.png") });

  // ── 2. Picking the weapon pre-fills kind/damage; Roll! posts the
  //    weapon's own resolved values and applies damage exactly like today. ──
  // Damage (and so `damage.notation`, the proof the picker's own value
  // drove the roll) is ONLY rolled on a hit — the roll route leaves
  // `damage: null` on a miss — so a natural-1 miss against this AC-1
  // target (only a nat-1 can miss) can't verify the notation from the
  // landed row alone. Retried up to a few times on a miss, the same
  // "only a natural 1 misses vs AC 1 — retry so the assertion isn't
  // flaky" convention verify-quick-actions.mjs's own PC-target phase
  // already established, rather than weakening the assertion itself.
  async function rollAndVerify(label, actionKey, expectedAttackKind, expectedNotation, expectedModifierLabel) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = await tokenRow(goblinTokenId);
      await room.click(`[data-testid="attack-prompt-action-${actionKey}"]`);
      await sleep(200);
      if (attempt === 1) {
        const selected = await room.getAttribute(`[data-testid="attack-prompt-action-${actionKey}"]`, "aria-pressed");
        check(`picking ${label} highlights its own card as selected`, selected === "true");
      }
      await room.click('[data-testid="attack-prompt-roll"]');
      try {
        await room.waitForFunction(
          (testid) => !document.querySelector(`[data-testid="${testid}"]`),
          "attack-prompt-modal",
          { timeout: 15000 }
        );
      } catch (err) {
        const errorText = await room.textContent('[data-testid="attack-prompt-error"]').catch(() => null);
        await room.screenshot({ path: join(SCREENSHOT_DIR, `debug-roll-timeout-${actionKey}.png`) }).catch(() => undefined);
        throw new Error(`Roll! never closed the modal for ${label} — attack-prompt-error: ${errorText}`, { cause: err });
      }
      await sleep(1200);
      const { data: rolls } = await admin
        .from("roll_log")
        .select()
        .eq("campaign_id", campaignId)
        .eq("kind", "attack")
        .order("created_at", { ascending: false })
        .limit(1);
      const landed = rolls?.[0] ?? null;
      const attack = landed?.breakdown?.attack;
      if (!attack?.hit && attempt < 5) {
        // A natural-1 miss: nothing to verify the notation against yet —
        // re-open the prompt and retry rather than asserting on it.
        const reopened = await openAttackPrompt(room, aliceTokenId);
        if (!reopened) break;
        continue;
      }
      check(
        `picking ${label} rolled with its OWN pre-filled kind ("${expectedAttackKind}") and damage notation ("${expectedNotation}") — proof the picker, not stale defaults, drove the roll`,
        attack?.attackKind === expectedAttackKind &&
          attack?.damage?.notation === expectedNotation &&
          landed?.character_id === aliceCharacterId &&
          attack?.targetTokenId === goblinTokenId,
        JSON.stringify(attack)
      );
      if (expectedModifierLabel) {
        check(
          `${label}'s roll used the ${expectedModifierLabel} (the correct ability for this attack kind — unchanged mechanics)`,
          (landed?.breakdown?.modifiers ?? []).some((m) => m.label === expectedModifierLabel),
          JSON.stringify(landed?.breakdown?.modifiers)
        );
      }
      const after = await tokenRow(goblinTokenId);
      // map_tokens.current_hp is null until the first HP-affecting event
      // (its own documented "at full health, derive the ceiling from its
      // linked stat block" convention) — coalesced for the HIT-case math
      // exactly like the RPC does, but a MISS never writes anything at
      // all, so the raw stored value (however it stood before) is the
      // right expectation there, not the coalesced one.
      const expectedHp = attack?.hit
        ? Math.max(0, (before.current_hp ?? statBlock.max_hp) - (attack.damage?.total ?? 0))
        : before.current_hp;
      check(
        `${label}'s roll applies damage to the target's stored HP exactly as it does today (regression, not just the new picker UI)`,
        after.current_hp === expectedHp,
        `before=${before.current_hp} after=${after.current_hp} attack=${JSON.stringify(attack)}`
      );
      return landed;
    }
    check(`picking ${label} landed a verifiable hit within 5 attempts`, false, "every attempt rolled a natural 1 miss");
    return null;
  }

  await rollAndVerify("the tagged weapon", "weapon-shortsword", "melee", "1d6+3");
  const openedCantrip = await openAttackPrompt(room, aliceTokenId);
  check("re-opening the prompt for the cantrip pick works", openedCantrip !== null);
  await rollAndVerify("the tagged cantrip", "spell-fire-bolt", "spell", "1d10", "Charisma modifier");

  const openedSpell = await openAttackPrompt(room, aliceTokenId);
  check("re-opening the prompt for the leveled-spell pick works", openedSpell !== null);
  await rollAndVerify("the tagged leveled spell", "spell-chromatic-orb", "spell", "3d8", "Charisma modifier");
  // handleRollAttack (the roll mechanics) is deliberately UNCHANGED by this
  // feature — it never touched character_resources before, and still
  // doesn't: the picker only changes HOW kind/damage get chosen, not what
  // happens after Roll! is clicked. Confirms this out-of-scope boundary
  // rather than assuming it.
  const { data: slotAfterRoll } = await admin
    .from("character_resources")
    .select("current_uses")
    .eq("id", slotResourceId)
    .single();
  check(
    "firing a leveled spell through click-to-attack does NOT spend its slot (handleRollAttack's own roll mechanics are unchanged by this feature)",
    slotAfterRoll?.current_uses === 1,
    `current_uses=${slotAfterRoll?.current_uses}`
  );

  // ── 3. Exhaust the slot: the leveled spell renders BLOCKED with its
  //    reason, the weapon/cantrip stay fully usable alongside it. ──
  await admin.from("character_resources").update({ current_uses: 0 }).eq("id", slotResourceId);
  const openedBlocked = await openAttackPrompt(room, aliceTokenId);
  check("re-opening the prompt after exhausting the slot works", openedBlocked !== null);
  const blockedCardDisabled = await room
    .$eval('[data-testid="attack-prompt-action-spell-chromatic-orb"]', (el) => el.disabled)
    .catch(() => null);
  check("the resource-blocked leveled spell's card is disabled", blockedCardDisabled === true);
  const blockedReasonText = await room.textContent('[data-testid="attack-prompt-action-blocked-spell-chromatic-orb"]').catch(() => "");
  check(
    "the blocked card shows ITS OWN reason rather than being silently omitted",
    (blockedReasonText ?? "").includes("No 1st-level spell slots remaining"),
    blockedReasonText
  );
  check(
    "the weapon and cantrip stay fully visible and usable alongside the blocked spell (don't just hide the rest)",
    (await isVisible(room, "attack-prompt-action-weapon-shortsword")) &&
      (await isVisible(room, "attack-prompt-action-spell-fire-bolt")) &&
      (await room.$eval('[data-testid="attack-prompt-action-weapon-shortsword"]', (el) => el.disabled)) === false
  );
  await room.click('[data-testid="attack-prompt-action-spell-chromatic-orb"]', { force: true }).catch(() => undefined);
  await sleep(200);
  const blockedSelectedAfterClick = await room.getAttribute(
    '[data-testid="attack-prompt-action-spell-chromatic-orb"]',
    "aria-pressed"
  );
  check("clicking the disabled/blocked card is a no-op — it never becomes selected", blockedSelectedAfterClick === "false");
  await room.screenshot({ path: join(SCREENSHOT_DIR, "02-resource-blocked-spell.png") });
  await room.click('[data-testid="attack-prompt-cancel"]');
  await sleep(300);
  check("Cancel closes the prompt with nothing fired", !(await isVisible(room, "attack-prompt-modal")));
  await admin.from("character_resources").update({ current_uses: 1 }).eq("id", slotResourceId);

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
console.log("\nAll attack weapon/spell picker checks passed.");
process.exit(0);
