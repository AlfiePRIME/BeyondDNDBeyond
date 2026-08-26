#!/usr/bin/env node
// Per-player vision rendering verification (Prompt 58 acceptance criteria).
//
// Drives real signed-in browsers (the verify-dice-ui.mjs/
// verify-quick-actions.mjs arrangement) against a seeded campaign whose
// live map is a 30x1 corridor: bright cells x 0-8, one dim cell at x 9,
// dark cells x 10-29, an NPC "Torchbearer" token at x 25 carrying a
// token-anchored bright light (radius 10 ft), and a player (Alice) who
// owns TWO characters. Checks: a player with no placed token sees the
// same unfiltered view a DM does; a placed token resolves as the active
// character, and the MOST RECENTLY placed token wins when she has two;
// bright-near renders normally while dark-beyond-darkvision renders
// hidden for her but not for the DM; moving her token re-masks live (no
// reload — the move arrives as a token-changed broadcast, exactly how
// another client's drag would); the carried torch's light brings a dark
// cell into visibility live as its carrier approaches; a previously-
// perceived cell she's moved away from renders "remembered" (with its
// map_seen_cells terrain snapshot stored); a blinded active combatant
// sees nothing currently-live regardless of light while remembered cells
// still render from memory; and the DM's own view is never masked at any
// point.
//
// The scene itself is WebGL (no DOM to locate), so assertions read the
// room's hidden [data-testid="vision-state"] mirror — the exact
// per-cell/per-token render states GameRoom hands MapSurface, which draws
// them deterministically (canvas drags themselves are out of scope for
// verify scripts, the verify-opportunity-attacks precedent). Note the
// masking under test is CLIENT-SIDE presentation by explicit design (a
// trusted friend group — see the Prompt 58 notes in GameRoom/README):
// this script verifies rendering behavior, not a security boundary.
//
// Needs the local Supabase stack; starts `yarn dev` itself (and polls
// /api/health) if :3000 isn't already serving.
// Usage: node scripts/db/verify-vision-rendering.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_URL = "http://localhost:3000";

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
  console.log("dev server not running — starting yarn dev…");
  devServer = spawn("yarn", ["dev"], { cwd: rootDir, stdio: "ignore", detached: true });
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
    cookies.push({
      name: `${COOKIE_NAME}.${i}`,
      value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK),
      url: APP_URL,
    });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `vision-rendering-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Vision ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

// The script's own realtime handle on the campaign channel (the same topic
// and wire shape src/realtime's joinCampaignChannel uses) — how token
// moves and combat pokes reach the OPEN pages live, exactly as another
// connected client's action would, with the DB row updated first (the
// app's persist-then-broadcast ordering).
let campaignChannel = null;
async function joinCampaignChannelAsDm(campaignId) {
  const channel = dm.client.channel(`campaign:${campaignId}`, {
    config: { presence: { key: dm.id } },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("campaign channel subscribe timed out")), 10000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(timer);
        reject(new Error(`campaign channel subscribe: ${status}`));
      }
    });
  });
  campaignChannel = channel;
}

async function moveTokenLive(tokenId, x, y) {
  await admin.from("map_tokens").update({ x, y }).eq("id", tokenId);
  const { data: token } = await admin.from("map_tokens").select().eq("id", tokenId).maybeSingle();
  await campaignChannel.send({ type: "broadcast", event: "token-changed", payload: { tokenId, token } });
}

async function pokeCombatLive(campaignId) {
  await campaignChannel.send({ type: "broadcast", event: "combat-changed", payload: { campaignId } });
}

async function visionState(page) {
  const text = await page.textContent('[data-testid="vision-state"]');
  return JSON.parse(text);
}

// Poll a page's vision-state mirror until the predicate holds — the "no
// reload" checks ride this: the page is never re-navigated, only its live
// recompute is awaited.
async function waitForVision(page, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await visionState(page);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

async function waitForSeenRow(mapId, userId, x, y, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("map_seen_cells")
      .select()
      .eq("map_id", mapId)
      .eq("user_id", userId)
      .eq("x", x)
      .eq("y", y)
      .maybeSingle();
    if (data) return data;
    await sleep(400);
  }
  return null;
}

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Vision rendering test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  // Two characters ALICE owns: the older one placed first, the newer one
  // (60 ft... no — 30 ft darkvision, the number every distance below is
  // tuned against) placed second, so most-recent resolution is observable.
  const charAId = crypto.randomUUID(); // no darkvision
  const charBId = crypto.randomUUID(); // darkvision 30 ft
  const baseCharacter = {
    campaign_id: campaignId,
    owner_id: alice.id,
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
  };
  await admin.from("characters").insert([
    { ...baseCharacter, id: charAId, name: "Old Pick", darkvision_feet: null },
    { ...baseCharacter, id: charBId, name: "Newest Hero", race: "Dwarf", darkvision_feet: 30 },
  ]);

  // The corridor: 30x1. Sparse default is bright, so only the dim cell
  // (x 9) and the dark stretch (x 10-29) need rows.
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Vision corridor",
    grid_width: 30,
    grid_height: 1,
  });
  const cellRows = [{ map_id: mapId, x: 9, y: 0, elevation: 0, terrain_type: "normal", light_level: "dim" }];
  for (let x = 10; x < 30; x++) {
    cellRows.push({ map_id: mapId, x, y: 0, elevation: 0, terrain_type: "normal", light_level: "dark" });
  }
  await admin.from("map_cells").insert(cellRows);

  // The torchbearer: an NPC token at x 25 carrying a token-anchored bright
  // light, radius 10 ft (reaches x 23-27).
  const torchTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: torchTokenId,
    map_id: mapId,
    npc_name: "Torchbearer",
    x: 25,
    y: 0,
    elevation: 0,
    allegiance: "neutral",
  });
  await admin.from("light_sources").insert({
    map_id: mapId,
    radius_feet: 10,
    brightness: "bright",
    token_id: torchTokenId,
  });

  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);
  await joinCampaignChannelAsDm(campaignId);

  const aliceContext = await browser.newContext();
  await aliceContext.addCookies(sessionCookies(alice.session));
  const aliceRoom = await aliceContext.newPage();
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmRoom = await dmContext.newPage();

  async function loadRoom(page) {
    await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
    // The mirror is a hidden element — wait for attachment, not visibility.
    await page.waitForSelector('[data-testid="vision-state"]', { state: "attached", timeout: 30000 });
  }

  // -- 1. No placed token: the player's view is as unfiltered as the DM's. --
  await loadRoom(aliceRoom);
  await loadRoom(dmRoom);
  let aliceVision = await visionState(aliceRoom);
  let dmVision = await visionState(dmRoom);
  check("a player with no placed token gets the unmasked view (masked: false)", aliceVision.masked === false && aliceVision.mapId === mapId, JSON.stringify(aliceVision));
  check("the DM's view is unmasked", dmVision.masked === false && dmVision.mapId === mapId, JSON.stringify(dmVision));

  // -- 2. Active-character resolution: her placed token, then the MOST
  //    RECENTLY placed of two. --
  const tokenAId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: tokenAId,
    map_id: mapId,
    character_id: charAId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
    created_at: "2026-08-20T10:00:00.000Z", // explicitly older
  });
  await loadRoom(aliceRoom);
  aliceVision = await visionState(aliceRoom);
  check(
    "placing a token makes its character the player's active character for vision",
    aliceVision.masked === true && aliceVision.observerCharacterId === charAId && aliceVision.observerTokenId === tokenAId,
    JSON.stringify({ masked: aliceVision.masked, observer: aliceVision.observerCharacterId })
  );

  const tokenBId = crypto.randomUUID();
  await admin.from("map_tokens").insert({
    id: tokenBId,
    map_id: mapId,
    character_id: charBId,
    x: 0,
    y: 0,
    elevation: 0,
    allegiance: "party",
  });
  await loadRoom(aliceRoom);
  aliceVision = await visionState(aliceRoom);
  check(
    "with two owned tokens placed, the MOST RECENTLY placed one's character wins",
    aliceVision.masked === true && aliceVision.observerCharacterId === charBId && aliceVision.observerTokenId === tokenBId,
    JSON.stringify({ observer: aliceVision.observerCharacterId })
  );

  // -- 3. Static masking from x 0 (darkvision 30 ft reaches x 6): bright
  //    near renders normally, dark far renders hidden — for her, not the DM. --
  check("a bright cell near her token renders normally (absent from the non-full set)", !("1,0" in aliceVision.cells), JSON.stringify(aliceVision.cells["1,0"]));
  check("the dim cell beyond darkvision renders dim", aliceVision.cells["9,0"] === "dim", aliceVision.cells["9,0"]);
  check("a dark cell beyond darkvision renders hidden (nothing drawn)", aliceVision.cells["20,0"] === "hidden", aliceVision.cells["20,0"]);
  check("the torch-lit dark cell renders normally even at range (bright is bright)", !("25,0" in aliceVision.cells), aliceVision.cells["25,0"]);
  check("the torchbearer token, standing in its own light, is visible", aliceVision.tokens[torchTokenId] === "full", aliceVision.tokens[torchTokenId]);
  dmVision = await visionState(dmRoom);
  check("the DM still sees everything (never masked) while the player is masked", dmVision.masked === false, JSON.stringify(dmVision));

  // -- 4. Seen-cells memory persists what she's perceived (debounced). --
  const seenOrigin = await waitForSeenRow(mapId, alice.id, 0, 0);
  check(
    "perceived cells land in map_seen_cells with their terrain snapshot",
    seenOrigin !== null && seenOrigin.terrain_type === "normal" && seenOrigin.elevation === 0 && seenOrigin.light_level === "bright",
    JSON.stringify(seenOrigin)
  );

  // -- 5. Moving her token re-masks live, no reload: from x 8, darkvision
  //    (30 ft) now reaches the dark cells x 10-14. --
  await moveTokenLive(tokenBId, 8, 0);
  aliceVision = await waitForVision(aliceRoom, (v) => v.masked && !("12,0" in v.cells));
  check(
    "moving her token brings in-darkvision dark cells into view live, without a reload",
    aliceVision.masked === true && !("12,0" in aliceVision.cells),
    JSON.stringify(aliceVision.cells["12,0"])
  );
  check("dark cells still beyond darkvision stay hidden after the move", aliceVision.cells["20,0"] === "hidden", aliceVision.cells["20,0"]);

  // -- 6. Remembered rendering: x 12 was perceived from x 8; once she's
  //    back at x 0 it's out of range again, but renders from memory. --
  const seenDark = await waitForSeenRow(mapId, alice.id, 12, 0);
  check(
    "the newly-perceived dark cell's snapshot is recorded (terrain + its DARK light level, not the tier)",
    seenDark !== null && seenDark.terrain_type === "normal" && seenDark.light_level === "dark",
    JSON.stringify(seenDark)
  );
  await moveTokenLive(tokenBId, 0, 0);
  aliceVision = await waitForVision(aliceRoom, (v) => v.masked && v.cells["12,0"] === "remembered");
  check(
    "a cell she saw earlier but can't currently perceive renders as REMEMBERED, not hidden",
    aliceVision.cells["12,0"] === "remembered",
    aliceVision.cells["12,0"]
  );
  check("a never-perceived dark cell still renders hidden alongside the remembered one", aliceVision.cells["16,0"] === "hidden", aliceVision.cells["16,0"]);

  // -- 7. A carried light moves with its carrier, live: the torchbearer
  //    walks to x 21, so its 10 ft radius now lights x 19-23 — x 20 was
  //    dark and hidden, and becomes visible to her from 100 ft away. --
  check("the target dark cell is hidden before the torch approaches", aliceVision.cells["20,0"] === "hidden", aliceVision.cells["20,0"]);
  await moveTokenLive(torchTokenId, 21, 0);
  aliceVision = await waitForVision(aliceRoom, (v) => v.masked && !("20,0" in v.cells));
  check(
    "a token-anchored light brings a previously-dark cell into visibility live as its carrier approaches",
    !("20,0" in aliceVision.cells),
    JSON.stringify(aliceVision.cells["20,0"])
  );

  // -- 8. Blinded: an active combatant condition with blocksVision wipes
  //    all CURRENT perception regardless of light; memory still renders. --
  const encounterId = crypto.randomUUID();
  await admin.from("combat_encounters").insert({ id: encounterId, campaign_id: campaignId });
  const combatantInsert = await admin
    .from("combat_combatants")
    .insert({ encounter_id: encounterId, token_id: tokenBId, character_id: charBId, initiative: 10 })
    .select()
    .single();
  await admin.from("combatant_conditions").insert({ combatant_id: combatantInsert.data.id, condition_key: "blinded" });
  await pokeCombatLive(campaignId);
  aliceVision = await waitForVision(aliceRoom, (v) => v.masked && v.cells["0,0"] !== undefined);
  check(
    "a blinded active combatant perceives NO cell currently-live (every cell non-full), even bright adjacent ones",
    Object.keys(aliceVision.cells).length === 30,
    `${Object.keys(aliceVision.cells).length} of 30 cells non-full`
  );
  check("while blinded, previously-remembered cells still render from memory", aliceVision.cells["0,0"] === "remembered" && aliceVision.cells["12,0"] === "remembered", JSON.stringify({ origin: aliceVision.cells["0,0"], dark: aliceVision.cells["12,0"] }));
  check("while blinded, a never-seen cell stays fully hidden", aliceVision.cells["29,0"] === "hidden", aliceVision.cells["29,0"]);
  check("while blinded, the lit torchbearer token is hidden too — no live perception at all", aliceVision.tokens[torchTokenId] === "hidden", aliceVision.tokens[torchTokenId]);

  // -- 9. The DM's view stayed unmasked through every phase above (their
  //    page received the same broadcasts live). --
  dmVision = await waitForVision(dmRoom, (v) => v.masked === false, 4000);
  check("the DM's own view is STILL unmasked after moves, lights, and blinding", dmVision.masked === false, JSON.stringify(dmVision));
} finally {
  try {
    if (campaignChannel) await dm.client.removeChannel(campaignChannel);
    dm.client.realtime.disconnect();
  } catch {
    // Best-effort channel teardown.
  }
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
console.log("\nAll vision-rendering checks passed.");
process.exit(0);
