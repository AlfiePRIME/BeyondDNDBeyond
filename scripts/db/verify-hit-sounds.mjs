#!/usr/bin/env node
// Sound Effects SP5 verification: an ordinary hit, a critical hit, and a
// miss on a real attack roll each play the right sound category
// (hit_normal/hit_critical/hit_miss, src/audio's SOUND_KEYS) on EVERY
// already-connected client — not just the roller — via the SAME roll_log
// postgres_changes subscription DiceLogPanel already used for rendering
// (rolls.ts's subscribeToRollLog): no new plumbing, per this prompt's own
// framing.
//
// Real signed-in Playwright browsers throughout, two independent sessions
// (a DM who fires the attacks over the real roll route, and a player who
// never rolls anything but must still hear every hit/miss/crit): every
// claim is read off the sound manager's own real state (the hidden
// "sound-manager-debug" JSON mirror SoundControl.tsx already exposes,
// globally mounted in the Game Room — verify-sound-infra.mjs's own
// convention, reused verbatim here rather than inventing a second debug
// surface for SP5). Hit/miss/crit are forced for REAL via AC manipulation
// (natural 20 always hits+crits and natural 1 always misses regardless of
// AC — resolveAttackOutcome) plus the project's own established
// nat-20-retry pattern (verify-death-saves.mjs's own doc comment) — never
// a mocked die roll.
//
// Needs the local Supabase stack; starts (or reuses) its own dev server on
// a dedicated, pre-confirmed-free port.
// Usage: node scripts/db/verify-hit-sounds.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.HIT_SOUNDS_PORT ?? 4796);
const APP_URL = `http://localhost:${PORT}`;

// soundManager.ts's own SOUND_FILES pool for hit_normal (SOUND_KEYS.HIT_NORMAL) —
// mirrored here as a plain string list since this plain Node script (no
// tsconfig path-alias resolution) can't import the "@/audio" barrel
// directly the way app code must.
const HIT_NORMAL_FILES = ["/sounds/hit_normal_1.mp3", "/sounds/hit_normal_2.mp3", "/sounds/hit_normal_3.mp3"];

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

// The @supabase/ssr cookie format: sb-<host>-auth-token = "base64-" +
// base64url(JSON session), chunked at 3180 chars into name.0, name.1, ...
const COOKIE_NAME = `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
const MAX_CHUNK = 3180;

function sessionCookieHeader(session) {
  const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
  if (value.length <= MAX_CHUNK) return `${COOKIE_NAME}=${value}`;
  const chunks = [];
  for (let i = 0; i * MAX_CHUNK < value.length; i++) {
    chunks.push(`${COOKIE_NAME}.${i}=${value.slice(i * MAX_CHUNK, (i + 1) * MAX_CHUNK)}`);
  }
  return chunks.join("; ");
}

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
  const email = `hit-sounds-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Hit Sounds ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client, session: signIn.session, cookie: sessionCookieHeader(signIn.session) };
}

async function postRoll(user, campaignId, body) {
  const response = await fetch(`${APP_URL}/campaigns/${campaignId}/roll`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: user.cookie },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
}

function attackFacts(roll) {
  const breakdown = roll.body?.roll?.breakdown;
  return {
    ok: roll.status === 200 && !!roll.body?.ok,
    status: roll.status,
    id: roll.body?.roll?.id,
    total: roll.body?.roll?.total,
    attack: breakdown?.attack,
  };
}

/** The project's established nat-20-retry pattern (verify-death-saves.mjs's
 * own doc comment): fires REAL attack rolls against the real roll route
 * until `predicate` is satisfied (or `tries` is exhausted), since the d20
 * itself is genuine, uninjectable randomness (rules-engine/dice.ts's own
 * header comment). AC alone can't force a natural 20/1 (resolveAttackOutcome
 * always hits+crits on a natural 20 and always misses on a natural 1
 * regardless of AC), so a crit specifically always goes through this retry
 * loop; a plain hit/miss almost never retries more than once given the AC
 * chosen below. */
async function rollAttackUntil(user, campaignId, request, predicate, tries = 200) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = attackFacts(await postRoll(user, campaignId, { kind: "attack", ...request }));
    if (!last.ok) return last;
    if (predicate(last)) return last;
  }
  return last;
}

/** Reads and JSON.parses a hidden debug-mirror div's text content — the
 * visionDebug/tableSurfaceDebug convention (GameRoom.tsx) this project uses
 * wherever real state has no DOM of its own to inspect, applied here to
 * SoundControl.tsx's "sound-manager-debug" mirror (SP1's own surface —
 * globally mounted in the Game Room's top bar, so it's present regardless
 * of which DraggablePanel is docked/visible). */
async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

const readSoundDebug = (page) => readTestId(page, "sound-manager-debug");

/** The play log's own newest timestamp (recordPlay's `at`, performance.now()
 * -based and monotonically increasing — soundManager.ts) — used as a
 * watermark rather than array length/index, for two real reasons confirmed
 * directly during this script's own development:
 *   1. The nat-20/nat-1 retry loop (rollAttackUntil) can — and does —
 *      commit and PLAY several unrelated intervening attack rolls (each a
 *      genuine hit/miss of its own) before the one that finally satisfies
 *      the caller's predicate. "The next new entry to appear" is often one
 *      of those intervening rolls, not the outcome under test — this bit a
 *      first version of this script outright (a forced-critical roll's own
 *      hit_critical sound was skipped in favor of an intervening ordinary
 *      hit's hit_normal, which merely happened to land first).
 *   2. playLog is capped at 50 entries (PLAY_LOG_MAX_ENTRIES) — once a run
 *      crosses that (this script's later parts can, between the crit
 *      retries and the repeated-hits section), `.length` stops growing
 *      forever, permanently breaking any length-delta wait.
 * Watermarking by `at` and searching for the EXPECTED key/url anywhere
 * after it sidesteps both: unrelated intervening rolls carry a different
 * key (an intervening miss/crit during an ordinary-hit search, or an
 * intervening ordinary hit during a crit search), so they simply don't
 * match, and `at` keeps advancing even while `.length` is pinned at the
 * cap. */
function latestAt(debug) {
  const log = debug?.playLog ?? [];
  return log.length > 0 ? log[log.length - 1].at : 0;
}

/** Waits for a play-log entry matching `matchFn` whose `at` is strictly
 * after `baselineAt`, polling with a generous deadline (verify-sound-infra
 * .mjs's own convention). Returns `{ debug, entry }` — `entry` is `null` on
 * timeout. */
async function waitForPlayMatching(page, baselineAt, matchFn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let debug = null;
  while (Date.now() < deadline) {
    debug = await readSoundDebug(page);
    const entry = (debug?.playLog ?? []).find((candidate) => candidate.at > baselineAt && matchFn(candidate));
    if (entry) return { debug, entry };
    await sleep(150);
  }
  return { debug, entry: null };
}

// Real-audio verification (BeyondDNDBeyond override-sound-silence-fix
// investigation) — see verify-natural-roll-sounds.mjs's own identical
// top-of-block doc comment for the full rationale: waitForPlayMatching above
// only ever proves recordPlay's bookkeeping ran (an entry appears the
// instant .start() is CALLED), never that real, non-silent audio actually
// came out. soundManager.ts's masterOutputPeak (a live sample of the real
// post-gain master output) and playErrorLog (every real fetch/decode/
// scheduling failure, previously a silent unhandled rejection) close that
// gap. hit_critical and hit_miss both have real admin-configured overrides
// in the shared dev database (same as nat_20/nat_1) — hit_normal does not,
// so its own existing playLog-only checks are lower-risk, but hit_critical/
// hit_miss get the same upgrade nat_20/nat_1 did.
const AUDIBLE_PEAK_THRESHOLD = 0.02;

function latestErrorAt(debug) {
  const log = debug?.playErrorLog ?? [];
  return log.length > 0 ? log[log.length - 1].at : 0;
}

async function waitForAudiblePlayMatching(page, baselineAt, key, matchFn, timeoutMs = 20000) {
  const errorBaselineAt = latestErrorAt(await readSoundDebug(page));
  const deadline = Date.now() + timeoutMs;
  let debug = null;
  let entry = null;
  let peakSeen = 0;
  while (Date.now() < deadline && !entry) {
    debug = await readSoundDebug(page);
    peakSeen = Math.max(peakSeen, debug?.masterOutputPeak ?? 0);
    entry = (debug?.playLog ?? []).find((candidate) => candidate.at > baselineAt && matchFn(candidate));
    if (!entry) await sleep(50);
  }
  const extraDeadline = Date.now() + 600;
  while (Date.now() < extraDeadline) {
    debug = await readSoundDebug(page);
    peakSeen = Math.max(peakSeen, debug?.masterOutputPeak ?? 0);
    await sleep(50);
  }
  const newErrors = (debug?.playErrorLog ?? []).filter(
    (candidate) => candidate.at > errorBaselineAt && candidate.key === key
  );
  return { debug, entry, peakSeen, newErrors, audible: peakSeen >= AUDIBLE_PEAK_THRESHOLD };
}

function isHitNormalEntry(entry) {
  return entry?.key === "hit_normal" && HIT_NORMAL_FILES.includes(entry?.url);
}
// Key-only for hit_miss/hit_critical — NOT the literal baked default path.
// An admin can configure a real sound_overrides row for either key (SP2's
// admin override system), which resolveSoundUrl() correctly prefers over
// the baked default; asserting the exact default URL would false-fail the
// instant a legitimate override exists for that key, even though playback
// is working exactly as designed. hit_normal above is unaffected — it has
// no override configured in the shared dev database at the time of writing
// and its own check already tolerates any of its 3 pooled files, so this
// isn't a live problem there today, but hit_miss/hit_critical's own
// verify-natural-roll-sounds.mjs sibling already documents this exact
// failure mode against the same shared database (see that file's own
// isNat20Entry/isNat1Entry doc comment) — the identical fix applies here.
function isHitMissEntry(entry) {
  return entry?.key === "hit_miss";
}
function isHitCriticalEntry(entry) {
  return entry?.key === "hit_critical";
}

function baseCharacter(id, campaignId, ownerId, name, overrides = {}) {
  return {
    id,
    campaign_id: campaignId,
    owner_id: ownerId,
    name,
    race: "Human",
    class: "Fighter",
    level: 3,
    strength: 16,
    dexterity: 12,
    constitution: 14,
    intelligence: 10,
    wisdom: 10,
    charisma: 8,
    current_hp: 200,
    max_hp: 200,
    armor_class: 15,
    speed: 30,
    darkvision_feet: null,
    proficiencies: [],
    inventory: [],
    spells: [],
    ...overrides,
  };
}

const VIEWPORT = { width: 1440, height: 900 };
// Same real-Web-Audio-graph-can-idle-while-backgrounded workaround
// verify-sound-infra.mjs already needed — belt and braces alongside
// soundManager.ts's own defensive ensureContext() resume-on-every-call.
const AUDIO_THROTTLE_WORKAROUND_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

await ensureDevServer();

const dm = await makeTestUser("dm");
const playerA = await makeTestUser("player-a");
const browser = await chromium.launch({ args: [...GPU_LAUNCH_ARGS, ...AUDIO_THROTTLE_WORKAROUND_ARGS] });

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Hit sounds test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: playerA.id, role: "player" },
  ]);

  // The DM rolls AS this attacker (DM authorization covers any character in
  // the campaign — resolveAttackDamage's own "DM, or owner" doc comment) at
  // a tracked target owned by playerA, so a genuine hit runs the REAL
  // resolve_attack_damage RPC path (breakdown.attack.damage populated,
  // non-null `applied`) — not just the plain miss/untargeted insertRoll
  // path. No live map or combat encounter is needed: action-economy gating
  // (Prompt 53) only applies when the attacker IS a combatant in an ACTIVE
  // encounter (route.ts's own currentCombatantForAttacker/
  // getActiveCombatEncounter calls both return nothing outside one), so a
  // bare pair of characters is sufficient here.
  const attackerId = crypto.randomUUID();
  const targetId = crypto.randomUUID();
  await admin.from("characters").insert([
    baseCharacter(attackerId, campaignId, dm.id, "Sound Test Attacker", { strength: 18 }),
    baseCharacter(targetId, campaignId, playerA.id, "Sound Test Target"),
  ]);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

  // Two REAL, already-connected clients: the DM (who fires every attack
  // below) and playerA, who never rolls anything at all — playerA hearing
  // every hit/miss/crit is exactly this prompt's "every already-connected
  // client, not just the roller" acceptance bar.
  const pageErrors = [];
  const dmContext = await browser.newContext({ viewport: VIEWPORT });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  dmPage.on("pageerror", (err) => pageErrors.push(`[dm] ${err.message}`));

  const playerContext = await browser.newContext({ viewport: VIEWPORT });
  await playerContext.addCookies(sessionCookies(playerA.session));
  const playerPage = await playerContext.newPage();
  playerPage.on("pageerror", (err) => pageErrors.push(`[player] ${err.message}`));

  await dmPage.goto(roomUrl);
  await dmPage.waitForSelector('[data-testid="sound-control"]', { timeout: 60000 });
  await dmPage.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });

  await playerPage.goto(roomUrl);
  await playerPage.waitForSelector('[data-testid="sound-control"]', { timeout: 60000 });
  await playerPage.waitForSelector('[data-testid="dice-log-panel"]', { timeout: 30000 });
  await sleep(500);

  // ===========================================================================
  // Part 1 — an ordinary hit plays a random hit_normal variant on BOTH
  // connected clients.
  // ===========================================================================
  let dmAt = latestAt(await readSoundDebug(dmPage));
  let playerAt = latestAt(await readSoundDebug(playerPage));

  const hit = await rollAttackUntil(
    dm,
    campaignId,
    {
      characterId: attackerId,
      attackKind: "melee",
      damageNotation: "2d6+5",
      targetAc: 1, // any non-natural-1 roll hits; excluding natural 20 below keeps this a genuine ORDINARY hit
      targetCharacterId: targetId,
      targetTokenId: null,
      targetName: "Sound Test Target",
      mode: "normal",
    },
    (facts) => facts.attack?.hit === true && facts.attack?.critical === false
  );
  check(
    "(setup) a real ordinary (non-critical) hit was rolled against the live roll route",
    hit?.ok && hit.attack?.hit === true && hit.attack?.critical === false,
    JSON.stringify(hit)
  );

  const [dmAfterHit, playerAfterHit] = await Promise.all([
    waitForPlayMatching(dmPage, dmAt, isHitNormalEntry),
    waitForPlayMatching(playerPage, playerAt, isHitNormalEntry),
  ]);
  check(
    "the roller's OWN client hears the ordinary-hit sound — a random hit_normal variant",
    isHitNormalEntry(dmAfterHit.entry),
    JSON.stringify(dmAfterHit.entry)
  );
  check(
    "a SECOND, already-connected client who never rolled anything ALSO hears the ordinary-hit sound (roll_log's own every-client-sees-every-roll subscription, matched)",
    isHitNormalEntry(playerAfterHit.entry),
    JSON.stringify(playerAfterHit.entry)
  );

  // Regression check: DiceLogPanel's own rendering of the row is unaffected
  // by the new sound side effect — the roll entry, headline, and detail
  // still render normally on both clients.
  const dmRollText = await dmPage.locator(`[data-testid="roll-entry-${hit.id}"]`).textContent().catch(() => null);
  const playerRollText = await playerPage.locator(`[data-testid="roll-entry-${hit.id}"]`).textContent().catch(() => null);
  check(
    "DiceLogPanel still renders the hit roll's own entry normally (no regression) on the roller's client",
    (dmRollText ?? "").includes("Hit") && (dmRollText ?? "").includes("Melee attack"),
    dmRollText
  );
  check(
    "DiceLogPanel still renders the hit roll's own entry normally (no regression) on the second client",
    (playerRollText ?? "").includes("Hit") && (playerRollText ?? "").includes("Melee attack"),
    playerRollText
  );

  dmAt = dmAfterHit.entry?.at ?? dmAt;
  playerAt = playerAfterHit.entry?.at ?? playerAt;

  // ===========================================================================
  // Part 2 — a miss plays hit_miss on both clients.
  // ===========================================================================
  const miss = await rollAttackUntil(
    dm,
    campaignId,
    {
      characterId: attackerId,
      attackKind: "melee",
      damageNotation: "2d6+5",
      targetAc: 99, // unreachable unless natural 20, excluded below, so any other roll genuinely misses
      targetCharacterId: targetId,
      targetTokenId: null,
      targetName: "Sound Test Target",
      mode: "normal",
    },
    (facts) => facts.attack?.hit === false
  );
  check(
    "(setup) a real miss was rolled against the live roll route",
    miss?.ok && miss.attack?.hit === false,
    JSON.stringify(miss)
  );

  const [dmAfterMiss, playerAfterMiss] = await Promise.all([
    waitForAudiblePlayMatching(dmPage, dmAt, "hit_miss", isHitMissEntry),
    waitForAudiblePlayMatching(playerPage, playerAt, "hit_miss", isHitMissEntry),
  ]);
  check(
    "the roller's own client hears hit_miss on a genuine miss",
    isHitMissEntry(dmAfterMiss.entry),
    JSON.stringify(dmAfterMiss.entry)
  );
  check(
    "the second, already-connected client ALSO hears hit_miss on a genuine miss",
    isHitMissEntry(playerAfterMiss.entry),
    JSON.stringify(playerAfterMiss.entry)
  );
  check(
    "the roller's master output tap actually shows non-silent audio during hit_miss's play window (not just a playLog entry — hit_miss has a real admin override configured)",
    dmAfterMiss.audible,
    JSON.stringify({ peakSeen: dmAfterMiss.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  check(
    "the second client's master output tap also shows non-silent audio for hit_miss",
    playerAfterMiss.audible,
    JSON.stringify({ peakSeen: playerAfterMiss.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  check(
    "no real fetch/decode/scheduling failure was recorded for hit_miss on either client (playErrorLog)",
    dmAfterMiss.newErrors.length === 0 && playerAfterMiss.newErrors.length === 0,
    JSON.stringify({ dm: dmAfterMiss.newErrors, player: playerAfterMiss.newErrors })
  );

  const missRollText = await dmPage.locator(`[data-testid="roll-entry-${miss.id}"]`).textContent().catch(() => null);
  check(
    "DiceLogPanel renders the miss roll's own entry as a genuine miss (no regression)",
    (missRollText ?? "").includes("Miss"),
    missRollText
  );

  dmAt = dmAfterMiss.entry?.at ?? dmAt;
  playerAt = playerAfterMiss.entry?.at ?? playerAt;

  // ===========================================================================
  // Part 3 — a critical hit plays hit_critical on both clients. AC is
  // irrelevant here (a natural 20 always hits+crits) — this is purely the
  // nat-20-retry pattern. The retry loop below will commit AND play several
  // genuine ordinary hits before finally landing a natural 20 (~1/20 odds
  // per attempt) — waitForPlayMatching's key-specific search (not "whatever
  // new entry appears next") is exactly what keeps this deterministic.
  // ===========================================================================
  const crit = await rollAttackUntil(
    dm,
    campaignId,
    {
      characterId: attackerId,
      attackKind: "melee",
      damageNotation: "2d6+5",
      targetAc: 1,
      targetCharacterId: targetId,
      targetTokenId: null,
      targetName: "Sound Test Target",
      mode: "normal",
    },
    (facts) => facts.attack?.critical === true
  );
  check(
    "(setup) a real critical hit (natural 20) was rolled against the live roll route",
    crit?.ok && crit.attack?.critical === true,
    JSON.stringify(crit)
  );

  const [dmAfterCrit, playerAfterCrit] = await Promise.all([
    waitForAudiblePlayMatching(dmPage, dmAt, "hit_critical", isHitCriticalEntry, 20000),
    waitForAudiblePlayMatching(playerPage, playerAt, "hit_critical", isHitCriticalEntry, 20000),
  ]);
  check(
    "the roller's own client hears hit_critical on a genuine critical hit",
    isHitCriticalEntry(dmAfterCrit.entry),
    JSON.stringify(dmAfterCrit.entry)
  );
  check(
    "the second, already-connected client ALSO hears hit_critical on a genuine critical hit",
    isHitCriticalEntry(playerAfterCrit.entry),
    JSON.stringify(playerAfterCrit.entry)
  );
  check(
    "the roller's master output tap actually shows non-silent audio during hit_critical's play window (not just a playLog entry — hit_critical has a real admin override configured)",
    dmAfterCrit.audible,
    JSON.stringify({ peakSeen: dmAfterCrit.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  check(
    "the second client's master output tap also shows non-silent audio for hit_critical",
    playerAfterCrit.audible,
    JSON.stringify({ peakSeen: playerAfterCrit.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  check(
    "no real fetch/decode/scheduling failure was recorded for hit_critical on either client (playErrorLog)",
    dmAfterCrit.newErrors.length === 0 && playerAfterCrit.newErrors.length === 0,
    JSON.stringify({ dm: dmAfterCrit.newErrors, player: playerAfterCrit.newErrors })
  );

  const critRollText = await dmPage.locator(`[data-testid="roll-entry-${crit.id}"]`).textContent().catch(() => null);
  check(
    "DiceLogPanel renders the critical roll's own entry correctly (no regression)",
    (critRollText ?? "").includes("critical hit"),
    critRollText
  );

  // Advance the watermark to the LATEST entry each client has actually seen
  // (not just the matched hit_critical one) — the retry loop's own
  // intervening ordinary hits may have landed on one client microseconds
  // after the other's matched entry, and Part 4 below must not re-match any
  // of that backlog as one of ITS OWN repeated hits.
  dmAt = latestAt(dmAfterCrit.debug);
  playerAt = latestAt(playerAfterCrit.debug);

  // ===========================================================================
  // Part 4 — repeated ordinary hits GENUINELY vary which hit_normal file
  // plays (this prompt's own "not always the same file" bar) — observed on
  // BOTH clients independently, since each runs its own real Math.random()
  // pick inside its own subscription handler (resolveSoundUrl has no
  // server-side/shared seed to keep two clients in lockstep).
  // ===========================================================================
  const REPEATS = 15;
  const dmUrlsSeen = new Set();
  const playerUrlsSeen = new Set();
  for (let i = 0; i < REPEATS; i++) {
    const repeatHit = await rollAttackUntil(
      dm,
      campaignId,
      {
        characterId: attackerId,
        attackKind: "melee",
        damageNotation: "2d6+5",
        targetAc: 1,
        targetCharacterId: targetId,
        targetTokenId: null,
        targetName: "Sound Test Target",
        mode: "normal",
      },
      (facts) => facts.attack?.hit === true && facts.attack?.critical === false
    );
    if (!repeatHit?.ok) {
      check(`(setup) repeated ordinary hit #${i + 1} rolled successfully`, false, JSON.stringify(repeatHit));
      continue;
    }
    const [dmRepeat, playerRepeat] = await Promise.all([
      waitForPlayMatching(dmPage, dmAt, isHitNormalEntry),
      waitForPlayMatching(playerPage, playerAt, isHitNormalEntry),
    ]);
    if (dmRepeat.entry) dmUrlsSeen.add(dmRepeat.entry.url);
    if (playerRepeat.entry) playerUrlsSeen.add(playerRepeat.entry.url);
    dmAt = latestAt(dmRepeat.debug);
    playerAt = latestAt(playerRepeat.debug);
  }
  check(
    `${REPEATS} repeated ordinary hits each produced a hit_normal entry with a valid pooled file on the roller's client`,
    dmUrlsSeen.size > 0 && [...dmUrlsSeen].every((url) => HIT_NORMAL_FILES.includes(url)),
    JSON.stringify([...dmUrlsSeen])
  );
  check(
    `repeated ordinary hits GENUINELY vary which hit_normal file plays on the roller's client (>= 2 of the 3 pooled files observed across ${REPEATS} hits, not always the same file)`,
    dmUrlsSeen.size >= 2,
    `files heard: ${JSON.stringify([...dmUrlsSeen])}`
  );
  check(
    `the second, already-connected client independently observes the same real variation across its own ${REPEATS} triggers`,
    playerUrlsSeen.size >= 2,
    `files heard: ${JSON.stringify([...playerUrlsSeen])}`
  );

  // ===========================================================================
  // Part 5 — a non-attack roll (plain freeform) never plays a hit sound —
  // the negative case a broad "any new roll_log row" trigger would get
  // wrong.
  // ===========================================================================
  const freeformBaselineAt = latestAt(await readSoundDebug(dmPage));
  const freeformRoll = await postRoll(dm, campaignId, { kind: "freeform", notation: "1d20" });
  check("(setup) a plain freeform roll succeeds", freeformRoll.status === 200 && freeformRoll.body?.ok, JSON.stringify(freeformRoll));
  // Give the realtime echo a real window to land (confirmed via the roll
  // actually rendering), then confirm it did NOT add any play-log entry at
  // all — a freeform roll's breakdown carries no `attack`, so
  // attackRollSoundKey returns null and nothing plays.
  await dmPage.waitForSelector(`[data-testid="roll-entry-${freeformRoll.body.roll.id}"]`, { timeout: 10000 }).catch(() => null);
  await sleep(1000);
  const freeformAfter = await readSoundDebug(dmPage);
  const freeformNewEntries = (freeformAfter.playLog ?? []).filter((entry) => entry.at > freeformBaselineAt);
  check(
    "a plain freeform (non-attack) roll triggers NO hit/miss/crit sound — no new play-log entry at all",
    freeformNewEntries.length === 0,
    JSON.stringify(freeformNewEntries)
  );

  check("no uncaught page errors occurred on either client throughout", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(playerA.id);
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
console.log("\nAll hit sound checks passed.");
process.exit(0);
