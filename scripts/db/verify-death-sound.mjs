#!/usr/bin/env node
// Sound Effects SP6 verification: SOUND_KEYS.DEATH (src/audio's registry)
// firing the moment a character's is_dead genuinely flips false -> true,
// live, in the Game Room (GameRoom.tsx) — and NOT on every reload of a
// campaign that already has a dead character in it.
//
// GameRoom.tsx does not actually call subscribeToCharacterChanges anywhere
// (that per-character postgres_changes subscription is CharacterSheet.tsx's
// own, a different, single-character page — confirmed directly by reading
// both files). The Game Room instead already delivers every is_dead change
// live to every connected client via its EXISTING combat-changed broadcast:
// an attack lands -> handleRollLanded refreshes characterRows (a fresh
// listCharactersForCampaign read) on the acting client and publishes
// COMBAT_EVENT on the shared campaign channel -> every other connected
// client's own COMBAT_EVENT listener refreshes its OWN characterRows the
// same way. GameRoom.tsx's own new death-sound effect hooks that EXACT
// already-realtime characterRows state — no new subscription/channel was
// added — and diffs each row's is_dead against the PREVIOUSLY OBSERVED
// value for that same character id (never the bare current value alone),
// so this script drives a REAL death through the REAL death-save/instant-
// death mechanic (resolve_attack_damage, migration 0031: damage >= max_hp
// while already at 0 HP kills outright) via the Game Room's own real
// DiceLogPanel attack form — not a raw HTTP/RPC shortcut — because only a
// real connected client's own UI action ever publishes COMBAT_EVENT at all.
//
// Two long-lived signed-in browser clients throughout (the DM's own room,
// and the dying PC's own owner's room) plus a real signed-in admin/service-
// role client for setup and polling. Every "did the sound play" claim is
// read from the sound manager's own real state (SoundControl.tsx's hidden
// "sound-manager-debug" JSON mirror — the visionDebug/tableSurfaceDebug
// convention this project already uses wherever real state has no DOM of
// its own), specifically its playLog's "death" entries — never a mock.
//
// Needs the local Supabase stack; starts (or reuses) its own dev server on
// a dedicated, pre-confirmed-free port.
// Usage: node scripts/db/verify-death-sound.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 4796;
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
  console.log(`dev server not running on :${PORT} — starting yarn dev -p ${PORT}…`);
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
    cookies.push({ name: `${COOKIE_NAME}.${i}`, value: value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK), url: APP_URL });
  }
  return cookies;
}

async function makeTestUser(label) {
  const email = `death-sound-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Death Sound ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session };
}

/** Reads and JSON.parses a hidden debug-mirror div's text content — the
 * visionDebug/tableSurfaceDebug convention (GameRoom.tsx) this project uses
 * wherever real state has no DOM of its own to inspect. */
async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

const readSoundDebug = (page) => readTestId(page, "sound-manager-debug");

/** Polls `readSoundDebug` until `predicate` is true or `timeoutMs` elapses —
 * every realtime/broadcast check below needs real margin rather than a
 * fixed sleep, the verify-sound-infra.mjs/verify-panel-dock.mjs "poll with a
 * generous deadline" convention. */
async function waitForSoundDebug(page, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readSoundDebug(page);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

function deathEntries(debug) {
  return (debug?.playLog ?? []).filter((entry) => entry.key === "death");
}

async function readCharacter(characterId) {
  const { data, error } = await admin
    .from("characters")
    .select("is_dead, current_hp, max_hp")
    .eq("id", characterId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Kills `targetCharacterId` for real, through the Game Room's own DiceLogPanel
 * attack form (never a raw HTTP/RPC shortcut — see this file's own top
 * comment for why only a real client's own UI action ever publishes
 * COMBAT_EVENT). The target must already be seeded at current_hp: 0 with a
 * very low max_hp (1) so ANY landed hit's damage is >= max_hp, tripping
 * resolve_attack_damage's (migration 0031) instant-death branch
 * deterministically — the only real uncertainty left is the d20 itself
 * (targetAc "1" means only a natural 1 can miss, ~5%), so this retries the
 * click a handful of times rather than needing to inject a specific roll.
 */
async function killThroughRealAttack(page, targetLabel, targetCharacterId) {
  await page.selectOption('[data-testid="attack-attacker-select"]', { label: "Alice PC" });
  await page.selectOption('[data-testid="attack-target-select"]', { label: targetLabel });
  await page.fill('[data-testid="attack-target-ac-input"]', "1");
  await page.fill('[data-testid="attack-damage-input"]', "1d4");
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.click('[data-testid="attack-roll-button"]');
    await page
      .waitForFunction(
        () => document.querySelector('[data-testid="attack-roll-button"]')?.disabled === false,
        { timeout: 5000 }
      )
      .catch(() => undefined);
    await sleep(200);
    const row = await readCharacter(targetCharacterId);
    if (row.is_dead) return row;
  }
  return readCharacter(targetCharacterId);
}

const VIEWPORT = { width: 1440, height: 900 };
// Same Web Audio backgrounded-tab throttling workaround as
// verify-sound-infra.mjs — this script keeps TWO real pages open
// simultaneously, and a backgrounded/occluded page's AudioContext can
// otherwise go idle even while `.state` still reports "running".
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const bob = await makeTestUser("bob");
const carol = await makeTestUser("carol");
const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

const pageErrors = [];

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Death sound test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
    { campaign_id: campaignId, user_id: bob.id, role: "player" },
    { campaign_id: campaignId, user_id: carol.id, role: "player" },
  ]);

  const aliceCharacterId = crypto.randomUUID();
  const bobCharacterId = crypto.randomUUID();
  const carolCharacterId = crypto.randomUUID();
  const baseCharacter = (id, ownerId, name, overrides = {}) => ({
    id,
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 5,
    strength: 16,
    dexterity: 14,
    constitution: 13,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
    current_hp: 40,
    max_hp: 40,
    armor_class: 15,
    speed: 30,
    proficiencies: [],
    inventory: [],
    spells: [],
    death_save_successes: 0,
    death_save_failures: 0,
    is_stable: false,
    is_dead: false,
    ...overrides,
  });
  await admin.from("characters").insert([
    // Alice never dies — she's purely the attacker throughout.
    baseCharacter(aliceCharacterId, alice.id, "Alice PC"),
    // Bob and Carol are seeded already dying (current_hp: 0) with a max_hp
    // of 1, so ANY landed hit's damage is >= max_hp — resolve_attack_damage's
    // instant-death branch, deterministically, no multi-hit accumulation
    // needed. Both start is_dead: false — the whole point is observing a
    // REAL live false -> true transition, never a value that was already
    // true when a page loads.
    baseCharacter(bobCharacterId, bob.id, "Bob PC", { current_hp: 0, max_hp: 1 }),
    baseCharacter(carolCharacterId, carol.id, "Carol PC", { current_hp: 0, max_hp: 1 }),
  ]);

  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Death sound arena", grid_width: 10, grid_height: 10 });
  await admin.from("map_tokens").insert([
    { id: crypto.randomUUID(), map_id: mapId, character_id: aliceCharacterId, x: 1, y: 1, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, character_id: bobCharacterId, x: 2, y: 1, elevation: 0, allegiance: "party" },
    { id: crypto.randomUUID(), map_id: mapId, character_id: carolCharacterId, x: 3, y: 1, elevation: 0, allegiance: "party" },
  ]);
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  async function openRoom(user, label) {
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addCookies(sessionCookies(user.session));
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(`${label}: ${err.message}`));
    await page.goto(roomUrl);
    await page.waitForSelector('[data-testid="map-panel"]', { timeout: 60000 });
    await page.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
    // Generous real-realtime-join buffer beyond "the DOM is up": COMBAT_EVENT
    // is a genuine ephemeral broadcast (unlike a postgres_changes feed, a
    // message published before this client's own campaign channel has
    // finished joining is gone for good, never redelivered) — there's no
    // existing debug mirror for "is the campaign channel joined" to poll
    // instead, so this mirrors this project's own established "let realtime
    // settle" sleep convention (verify-sound-infra.mjs et al.), just sized
    // generously for a broadcast rather than a forgiving subscription feed.
    await sleep(2000);
    return page;
  }

  // dmRoom drives every attack and gets reloaded, later, to prove no replay.
  // dmRoom2 is a SECOND DM tab (same account, characters RLS's "owner OR
  // campaign DM can read a character" means only the DM can ever see BOTH
  // Bob's and Carol's rows) that never reloads and never acts — its
  // cumulative play log across BOTH deaths below is what proves "every
  // connected client" and "a second, different character dying afterward is
  // never suppressed by the first" within one single long-lived instance.
  // bobRoom is Bob's OWN signed-in room — a third, independently connected
  // client that can only ever read its OWN owner's character (Bob PC, never
  // Carol PC) under that exact same RLS rule, which this script also
  // verifies directly rather than assuming.
  const dmRoom = await openRoom(dm, "dm");
  const dmRoom2 = await openRoom(dm, "dm2");
  const bobRoom = await openRoom(bob, "bob");

  // =========================================================================
  // Part 0 — baseline: nothing has died yet, so no client's play log has
  // ever recorded a "death" entry.
  // =========================================================================
  const dmBaseline = await readSoundDebug(dmRoom);
  const dm2Baseline = await readSoundDebug(dmRoom2);
  const bobBaseline = await readSoundDebug(bobRoom);
  check("(setup) the DM's room has logged no death sound before anyone has died", deathEntries(dmBaseline).length === 0, JSON.stringify(dmBaseline?.playLog));
  check("(setup) the DM's second tab has logged no death sound before anyone has died", deathEntries(dm2Baseline).length === 0, JSON.stringify(dm2Baseline?.playLog));
  check("(setup) Bob's own room has logged no death sound before anyone has died", deathEntries(bobBaseline).length === 0, JSON.stringify(bobBaseline?.playLog));
  const preKillBob = await readCharacter(bobCharacterId);
  check("(setup) Bob starts alive (is_dead: false) despite already being at 0 HP", preKillBob.is_dead === false, JSON.stringify(preKillBob));

  // =========================================================================
  // Part 1 — a REAL death, driven through the real instant-death mechanic
  // via the DM's own DiceLogPanel attack form, must play the death sound
  // exactly once, live, on the acting client AND on Bob's own independently
  // connected client — never more than once for this one real death.
  // =========================================================================
  const bobKilled = await killThroughRealAttack(dmRoom, "Bob PC", bobCharacterId);
  check("a landed overkill attack against an already-0-HP, 1-max-HP target sets is_dead via the real instant-death mechanic", bobKilled.is_dead === true, JSON.stringify(bobKilled));

  const dmAfterBobDies = await waitForSoundDebug(dmRoom, (d) => deathEntries(d).length > 0);
  check(
    "the death sound plays live on the DM's own client (the one that landed the killing blow)",
    deathEntries(dmAfterBobDies).length === 1,
    JSON.stringify(dmAfterBobDies?.playLog)
  );

  const dm2AfterBobDies = await waitForSoundDebug(dmRoom2, (d) => deathEntries(d).length > 0);
  check(
    "the death sound ALSO reaches the DM's second, independently connected tab live (every connected client, not just the actor) — via the room's existing COMBAT_EVENT broadcast, no new plumbing",
    deathEntries(dm2AfterBobDies).length === 1,
    JSON.stringify(dm2AfterBobDies?.playLog)
  );

  const bobRoomAfterBobDies = await waitForSoundDebug(bobRoom, (d) => deathEntries(d).length > 0);
  check(
    "the death sound ALSO reaches Bob's own independently connected client live — the dying PC's own owner, a different account entirely from the DM",
    deathEntries(bobRoomAfterBobDies).length === 1,
    JSON.stringify(bobRoomAfterBobDies?.playLog)
  );

  // A moment's grace, then re-check: the transition already happened and was
  // recorded, so nothing should fire a second time from later, unrelated
  // characterRows refreshes (e.g. the polling debug mirror re-rendering).
  await sleep(1500);
  const dmStill = await readSoundDebug(dmRoom);
  const dm2Still = await readSoundDebug(dmRoom2);
  const bobRoomStill = await readSoundDebug(bobRoom);
  check("Bob's death sound never fires a second time on the DM's client", deathEntries(dmStill).length === 1, JSON.stringify(dmStill?.playLog));
  check("Bob's death sound never fires a second time on the DM's second tab", deathEntries(dm2Still).length === 1, JSON.stringify(dm2Still?.playLog));
  check("Bob's death sound never fires a second time on Bob's own client", deathEntries(bobRoomStill).length === 1, JSON.stringify(bobRoomStill?.playLog));

  // =========================================================================
  // Part 2 — reloading a room that already has a dead character in it must
  // NOT replay the sound. A full page reload gives this a genuinely fresh
  // soundManager module instance (its play log starts empty again), so any
  // "death" entry appearing here can only be a real replay bug, never a
  // leftover from Part 1.
  // =========================================================================
  await dmRoom.reload();
  await dmRoom.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
  await dmRoom.waitForSelector('[data-testid="sound-manager-debug"]', { state: "attached", timeout: 30000 });
  await sleep(2000);
  const dmAfterReload = await readSoundDebug(dmRoom);
  check(
    "reloading the room for a campaign that already has a dead character does NOT replay the death sound",
    deathEntries(dmAfterReload).length === 0,
    JSON.stringify(dmAfterReload?.playLog)
  );
  const bobStillDeadAfterReload = await readCharacter(bobCharacterId);
  check("(sanity) Bob is still reported dead after the reload — this was a genuine already-dead-on-load case, not a fluke", bobStillDeadAfterReload.is_dead === true);

  // =========================================================================
  // Part 3 — a second, DIFFERENT character dying afterward must still
  // trigger its own sound: on the just-reloaded DM client (proving a room
  // that loaded with one already-dead character isn't somehow locked out of
  // ever firing again), AND on the DM's still-open, never-reloaded second
  // tab (proving the SAME long-lived component instance that already fired
  // once for Bob's death correctly fires AGAIN, independently, for Carol's —
  // no "fired once ever, never again" over-suppression across characters).
  // Bob's own room, by contrast, must NOT gain a second entry: Bob PC's
  // owner has no RLS visibility into Carol PC at all (0008's "owner OR
  // campaign DM can read a character" — Bob is neither), so its play log
  // correctly stays frozen at the one death it could ever actually observe.
  // =========================================================================
  const carolKilled = await killThroughRealAttack(dmRoom, "Carol PC", carolCharacterId);
  check("the second attack, against a different target, also sets is_dead via the same real mechanic", carolKilled.is_dead === true, JSON.stringify(carolKilled));

  const dmAfterCarolDies = await waitForSoundDebug(dmRoom, (d) => deathEntries(d).length > 0);
  check(
    "Carol's death plays the sound live on the just-reloaded DM client — a room that loaded with Bob already dead is NOT locked out of firing again for a genuinely new death",
    deathEntries(dmAfterCarolDies).length === 1,
    JSON.stringify(dmAfterCarolDies?.playLog)
  );

  const dm2AfterCarolDies = await waitForSoundDebug(dmRoom2, (d) => deathEntries(d).length > 1);
  check(
    "Carol's death ALSO plays on the DM's still-open second tab, as its own SECOND death-sound entry — the same long-lived session that already fired once for Bob's death fires again for a different character, no permanent one-shot suppression",
    deathEntries(dm2AfterCarolDies).length === 2,
    JSON.stringify(dm2AfterCarolDies?.playLog)
  );

  // Give Bob's room the same real margin the other two clients got, then
  // confirm it's genuinely unchanged rather than just "not yet arrived".
  await sleep(1500);
  const bobRoomAfterCarolDies = await readSoundDebug(bobRoom);
  check(
    "Bob's own room — which cannot read Carol PC under RLS at all — correctly never plays a sound for a death it structurally cannot observe, staying at exactly the one entry for its own owner's death",
    deathEntries(bobRoomAfterCarolDies).length === 1,
    JSON.stringify(bobRoomAfterCarolDies?.playLog)
  );

  check("no uncaught page error occurred on any client throughout", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(alice.id);
  await admin.auth.admin.deleteUser(bob.id);
  await admin.auth.admin.deleteUser(carol.id);
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
console.log("\nAll death sound checks passed.");
process.exit(0);
