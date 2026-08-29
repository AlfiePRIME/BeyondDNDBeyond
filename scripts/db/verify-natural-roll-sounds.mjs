#!/usr/bin/env node
// Sound Effects follow-up: a natural 20 or natural 1 on any NON-ATTACK d20
// roll (ability check, saving throw, skill check — every d20 shape funnels
// through the same rollD20() primitive, rules-engine/dice.ts) plays
// SOUND_KEYS.NAT_20/NAT_1 on every already-connected client, via the same
// roll_log postgres_changes subscription DiceLogPanel already used for
// hit/crit/miss (SP5's own precedent, reused verbatim). Attack rolls are
// explicitly excluded (a natural 20 there already always plays
// hit_critical, a natural 1 already always plays hit_miss —
// resolveAttackOutcome) — this script asserts nat_20/nat_1 do NOT also fire
// on an attack, which would double the sound. A freeform "1d20" roll is
// also asserted to NOT fire either — it's type: "dice", not "d20", and
// carries no natural-roll semantics at all.
//
// Real signed-in Playwright browsers, two independent sessions (a DM who
// rolls, and a player who never rolls anything but must still hear it) —
// every claim read off the sound manager's own real state (the hidden
// "sound-manager-debug" JSON mirror, verify-sound-infra.mjs's own
// convention). Natural 20/1 are forced for REAL via this project's
// established nat-20-retry pattern (verify-hit-sounds.mjs's own doc
// comment) — never a mocked die roll.
//
// Needs the local Supabase stack; starts (or reuses) its own dev server on
// a dedicated, pre-confirmed-free port.
// Usage: node scripts/db/verify-natural-roll-sounds.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.NAT_ROLL_SOUNDS_PORT ?? 4797);
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
  const email = `nat-roll-sounds-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Nat Roll Sounds ${label}` });
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

function d20Facts(roll) {
  const breakdown = roll.body?.roll?.breakdown;
  return {
    ok: roll.status === 200 && !!roll.body?.ok,
    status: roll.status,
    id: roll.body?.roll?.id,
    total: roll.body?.roll?.total,
    d20Result: breakdown?.d20Result,
    breakdownType: breakdown?.type,
    attack: breakdown?.attack,
  };
}

/** The project's established nat-20-retry pattern (verify-hit-sounds.mjs's
 * own doc comment): fires REAL rolls against the real roll route until
 * `predicate` is satisfied, since the d20 itself is genuine, uninjectable
 * randomness. */
async function rollUntil(user, campaignId, request, predicate, tries = 400) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = d20Facts(await postRoll(user, campaignId, request));
    if (!last.ok) return last;
    if (predicate(last)) return last;
  }
  return last;
}

async function readTestId(page, testId) {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const text = await el.textContent();
  return text ? JSON.parse(text) : null;
}

const readSoundDebug = (page) => readTestId(page, "sound-manager-debug");

function latestAt(debug) {
  const log = debug?.playLog ?? [];
  return log.length > 0 ? log[log.length - 1].at : 0;
}

/** Waits for a play-log entry matching `matchFn` whose `at` is strictly
 * after `baselineAt` — watermark-by-timestamp, not by array length/index
 * (verify-hit-sounds.mjs's own doc comment on why: intervening unrelated
 * rolls during a retry loop, and the play log's own 50-entry cap). */
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

/** Asserts NO entry matching `matchFn` appears within a short window after
 * `baselineAt` — used for the attack-exclusion and freeform-d20-exclusion
 * regression checks below, where the correct behavior is silence. */
async function assertNoPlayMatching(page, baselineAt, matchFn, windowMs = 3000) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const debug = await readSoundDebug(page);
    const entry = (debug?.playLog ?? []).find((candidate) => candidate.at > baselineAt && matchFn(candidate));
    if (entry) return entry;
    await sleep(150);
  }
  return null;
}

// ===========================================================================
// Real-audio verification (BeyondDNDBeyond override-sound-silence-fix
// investigation): the checks above only ever proved recordPlay's bookkeeping
// ran — playLog gets an entry the instant .start() is CALLED, which is real
// evidence the JS scheduling succeeded but NOT evidence that any actual,
// non-silent audio ever flowed through the graph (a scheduled source on a
// muted/zero-gain graph, or a buffer that failed to decode meaningfully,
// still "starts" with zero thrown error and zero playLog difference). This
// is precisely the gap a real manual tester's report can fall into that this
// script's own playLog-only checks were structurally unable to catch.
//
// soundManager.ts now exposes two new debug fields specifically to close
// this: `masterOutputPeak` (a REAL, live, this-instant sample of the actual
// post-gain master output — reads ~0 during genuine digital silence, well
// above it whenever real audio is flowing) and `playErrorLog` (every real
// fetch/decode/scheduling failure that used to be a silent, unhandled
// promise rejection — see soundManager.ts's own doc comments on both).
const AUDIBLE_PEAK_THRESHOLD = 0.02;

function latestErrorAt(debug) {
  const log = debug?.playErrorLog ?? [];
  return log.length > 0 ? log[log.length - 1].at : 0;
}

/** waitForPlayMatching's own contract, PLUS genuine audible-output
 * verification and a check that no new playErrorLog entry landed for `key`
 * in the same window. Polls masterOutputPeak continuously from the moment
 * this is called (not just once after the playLog entry is found) and for a
 * further 600ms afterward — a one-shot's actual audible samples follow the
 * .start() call by a few render quanta, so stopping the instant the log
 * entry appears would systematically under-read the true peak. */
async function waitForAudiblePlayMatching(page, baselineAt, key, matchFn, timeoutMs = 15000) {
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

// Key-only — NOT the literal baked default path. An admin can configure a
// real sound_overrides row for any of these keys (SP2's own admin override
// system), which resolveSoundUrl() correctly prefers over the baked
// default; asserting the exact default URL would false-fail the instant a
// legitimate override exists for that key, even though playback is working
// exactly as designed (confirmed live: this is what actually broke this
// script against the shared dev database, not a real regression).
const isNat20Entry = (entry) => entry?.key === "nat_20";
const isNat1Entry = (entry) => entry?.key === "nat_1";
const isHitCriticalEntry = (entry) => entry?.key === "hit_critical";
const isHitMissEntry = (entry) => entry?.key === "hit_miss";

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
  await admin.from("campaigns").insert({ id: campaignId, name: "Nat roll sounds test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: playerA.id, role: "player" },
  ]);

  const characterId = crypto.randomUUID();
  await admin.from("characters").insert([baseCharacter(characterId, campaignId, playerA.id, "Nat Roll Tester")]);

  const roomUrl = `${APP_URL}/campaigns/${campaignId}/room`;

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
  // Part 1 — a natural 20 on an ability check plays nat_20 on both clients.
  // ===========================================================================
  let dmAt = latestAt(await readSoundDebug(dmPage));
  let playerAt = latestAt(await readSoundDebug(playerPage));

  const nat20Check = await rollUntil(
    playerA,
    campaignId,
    { kind: "check", characterId, ability: "strength", mode: "normal" },
    (facts) => facts.d20Result === 20
  );
  check(
    "(setup) a real natural-20 ability check was rolled against the live roll route",
    nat20Check?.ok && nat20Check.d20Result === 20,
    JSON.stringify(nat20Check)
  );

  const [dmAfterNat20, playerAfterNat20] = await Promise.all([
    waitForAudiblePlayMatching(dmPage, dmAt, "nat_20", isNat20Entry),
    waitForAudiblePlayMatching(playerPage, playerAt, "nat_20", isNat20Entry),
  ]);
  check(
    "a second, already-connected client (the DM, who never rolled) hears nat_20 on a natural 20 check",
    isNat20Entry(dmAfterNat20.entry),
    JSON.stringify(dmAfterNat20.entry)
  );
  check(
    "the roller's own client also hears nat_20",
    isNat20Entry(playerAfterNat20.entry),
    JSON.stringify(playerAfterNat20.entry)
  );
  // Real audible-output verification (not just recordPlay's bookkeeping) —
  // see this file's own waitForAudiblePlayMatching doc comment for exactly
  // why playLog alone was never sufficient evidence.
  check(
    "the DM's master output tap actually shows non-silent audio during nat_20's play window (not just a playLog entry)",
    dmAfterNat20.audible,
    JSON.stringify({ peakSeen: dmAfterNat20.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  check(
    "the roller's master output tap actually shows non-silent audio during nat_20's play window",
    playerAfterNat20.audible,
    JSON.stringify({ peakSeen: playerAfterNat20.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  check(
    "no real fetch/decode/scheduling failure was recorded for nat_20 on either client (playErrorLog)",
    dmAfterNat20.newErrors.length === 0 && playerAfterNat20.newErrors.length === 0,
    JSON.stringify({ dm: dmAfterNat20.newErrors, player: playerAfterNat20.newErrors })
  );

  const checkRollText = await dmPage
    .locator(`[data-testid="roll-entry-${nat20Check.id}"]`)
    .textContent()
    .catch(() => null);
  check(
    "DiceLogPanel still renders the natural-20 check's own entry normally (no regression)",
    (checkRollText ?? "").includes("Strength check"),
    checkRollText
  );

  dmAt = dmAfterNat20.entry?.at ?? dmAt;
  playerAt = playerAfterNat20.entry?.at ?? playerAt;

  // ===========================================================================
  // Part 2 — a natural 1 on a saving throw plays nat_1 on both clients (a
  // DIFFERENT non-attack kind than Part 1, confirming the wiring is generic
  // across every d20 roll kind, not special-cased to "check").
  // ===========================================================================
  const nat1Save = await rollUntil(
    playerA,
    campaignId,
    { kind: "save", characterId, ability: "dexterity", mode: "normal" },
    (facts) => facts.d20Result === 1
  );
  check(
    "(setup) a real natural-1 saving throw was rolled against the live roll route",
    nat1Save?.ok && nat1Save.d20Result === 1,
    JSON.stringify(nat1Save)
  );

  const [dmAfterNat1, playerAfterNat1] = await Promise.all([
    waitForAudiblePlayMatching(dmPage, dmAt, "nat_1", isNat1Entry),
    waitForAudiblePlayMatching(playerPage, playerAt, "nat_1", isNat1Entry),
  ]);
  check(
    "a second, already-connected client hears nat_1 on a natural 1 saving throw",
    isNat1Entry(dmAfterNat1.entry),
    JSON.stringify(dmAfterNat1.entry)
  );
  check("the roller's own client also hears nat_1", isNat1Entry(playerAfterNat1.entry), JSON.stringify(playerAfterNat1.entry));
  check(
    "the DM's master output tap actually shows non-silent audio during nat_1's play window (not just a playLog entry)",
    dmAfterNat1.audible,
    JSON.stringify({ peakSeen: dmAfterNat1.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  check(
    "the roller's master output tap actually shows non-silent audio during nat_1's play window",
    playerAfterNat1.audible,
    JSON.stringify({ peakSeen: playerAfterNat1.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  check(
    "no real fetch/decode/scheduling failure was recorded for nat_1 on either client (playErrorLog)",
    dmAfterNat1.newErrors.length === 0 && playerAfterNat1.newErrors.length === 0,
    JSON.stringify({ dm: dmAfterNat1.newErrors, player: playerAfterNat1.newErrors })
  );

  const saveRollText = await dmPage
    .locator(`[data-testid="roll-entry-${nat1Save.id}"]`)
    .textContent()
    .catch(() => null);
  check(
    "DiceLogPanel still renders the natural-1 save's own entry normally (no regression)",
    (saveRollText ?? "").includes("Dexterity save"),
    saveRollText
  );

  dmAt = dmAfterNat1.entry?.at ?? dmAt;
  playerAt = playerAfterNat1.entry?.at ?? playerAt;

  // ===========================================================================
  // Part 2.5 — proving the new audible-output check above actually has teeth,
  // rather than trusting an assertion that might just always be true. Real,
  // reproducible silent-failure condition: mute the player's own client via
  // SoundControl's real master mute button (the same control a real user
  // has). playLog MUST still get an entry (a muted GainNode doesn't stop
  // .start() from succeeding or recordPlay from firing — this is exactly why
  // the OLD playLog-only checks structurally could not have caught this
  // class of silent failure), but masterOutputPeak must now genuinely read
  // silent. If this check ever goes green while muted, waitForAudiblePlayMatching
  // itself is broken and every other audible-output check in this file is
  // worthless.
  // ===========================================================================
  await playerPage.locator('[data-testid="sound-mute-toggle"]').click();
  await sleep(300); // let setMuted's real gain.value=0 actually apply
  playerAt = latestAt(await readSoundDebug(playerPage));
  const nat20WhileMuted = await rollUntil(
    playerA,
    campaignId,
    { kind: "check", characterId, ability: "wisdom", mode: "normal" },
    (facts) => facts.d20Result === 20 || facts.d20Result === 1
  );
  check(
    "(setup) a real natural 20/1 ability check was rolled while muted",
    nat20WhileMuted?.ok && (nat20WhileMuted.d20Result === 20 || nat20WhileMuted.d20Result === 1),
    JSON.stringify(nat20WhileMuted)
  );
  const mutedKey = nat20WhileMuted.d20Result === 20 ? "nat_20" : "nat_1";
  const mutedMatch = mutedKey === "nat_20" ? isNat20Entry : isNat1Entry;
  const playerWhileMuted = await waitForAudiblePlayMatching(playerPage, playerAt, mutedKey, mutedMatch);
  check(
    `while muted, playLog STILL records the ${mutedKey} entry (recordPlay fires regardless of gain — proves the OLD check alone would have falsely passed this)`,
    mutedMatch(playerWhileMuted.entry),
    JSON.stringify(playerWhileMuted.entry)
  );
  check(
    `while muted, the master output tap correctly reads silent for ${mutedKey} (peak stayed below ${AUDIBLE_PEAK_THRESHOLD}) — this is what the NEW check catches that the old one could not`,
    !playerWhileMuted.audible,
    JSON.stringify({ peakSeen: playerWhileMuted.peakSeen, threshold: AUDIBLE_PEAK_THRESHOLD })
  );
  playerAt = playerWhileMuted.entry?.at ?? playerAt;
  await playerPage.locator('[data-testid="sound-mute-toggle"]').click(); // unmute for every check below
  await sleep(300);

  // ===========================================================================
  // Part 3 — CRITICAL: a natural 20 on an ATTACK roll plays ONLY
  // hit_critical, never nat_20 too (which would double the sound). AC=1 so
  // any hit at all is possible — the retry predicate specifically demands a
  // natural 20 (always a critical regardless of AC).
  // ===========================================================================
  const nat20Attack = await rollUntil(
    playerA,
    campaignId,
    {
      kind: "attack",
      characterId,
      attackKind: "melee",
      damageNotation: "1d6",
      targetAc: 1,
      mode: "normal",
    },
    (facts) => facts.d20Result === 20
  );
  check(
    "(setup) a real natural-20 attack (a critical hit) was rolled against the live roll route",
    nat20Attack?.ok && nat20Attack.d20Result === 20 && nat20Attack.attack?.critical === true,
    JSON.stringify(nat20Attack)
  );

  const dmAfterCrit = await waitForPlayMatching(dmPage, dmAt, isHitCriticalEntry);
  check("a natural-20 attack still plays hit_critical as before", isHitCriticalEntry(dmAfterCrit.entry), JSON.stringify(dmAfterCrit.entry));

  const spuriousNat20OnAttack = await assertNoPlayMatching(dmPage, dmAt, isNat20Entry);
  check(
    "CRITICAL: a natural-20 attack does NOT also play nat_20 (would double the sound — hit_critical already covers it)",
    spuriousNat20OnAttack === null,
    JSON.stringify(spuriousNat20OnAttack)
  );

  dmAt = dmAfterCrit.entry?.at ?? dmAt;

  // ===========================================================================
  // Part 4 — CRITICAL: a natural 1 on an ATTACK roll plays ONLY hit_miss,
  // never nat_1 too. AC=99 so the retry predicate (natural 1, always a miss
  // regardless of AC) is the only realistic way this resolves.
  // ===========================================================================
  const nat1Attack = await rollUntil(
    playerA,
    campaignId,
    {
      kind: "attack",
      characterId,
      attackKind: "melee",
      damageNotation: "1d6",
      targetAc: 99,
      mode: "normal",
    },
    (facts) => facts.d20Result === 1
  );
  check(
    "(setup) a real natural-1 attack (a miss) was rolled against the live roll route",
    nat1Attack?.ok && nat1Attack.d20Result === 1 && nat1Attack.attack?.hit === false,
    JSON.stringify(nat1Attack)
  );

  const dmAfterAttackMiss = await waitForPlayMatching(dmPage, dmAt, isHitMissEntry);
  check("a natural-1 attack still plays hit_miss as before", isHitMissEntry(dmAfterAttackMiss.entry), JSON.stringify(dmAfterAttackMiss.entry));

  const spuriousNat1OnAttack = await assertNoPlayMatching(dmPage, dmAt, isNat1Entry);
  check(
    "CRITICAL: a natural-1 attack does NOT also play nat_1 (would double the sound — hit_miss already covers it)",
    spuriousNat1OnAttack === null,
    JSON.stringify(spuriousNat1OnAttack)
  );

  dmAt = dmAfterAttackMiss.entry?.at ?? dmAt;

  // ===========================================================================
  // Part 5 — a freeform "1d20" roll (damage/flavor, type: "dice" not "d20",
  // carries no d20Result at all) landing on 20 plays neither nat_20 nor any
  // other natural-roll sound — it has no natural-roll semantics.
  // ===========================================================================
  const freeform20 = await rollUntil(
    playerA,
    campaignId,
    { kind: "freeform", notation: "1d20" },
    (facts) => facts.total === 20
  );
  check(
    "(setup) a real freeform 1d20 roll landed on 20",
    freeform20?.ok && freeform20.total === 20 && freeform20.breakdownType === "dice",
    JSON.stringify(freeform20)
  );

  const spuriousNat20OnFreeform = await assertNoPlayMatching(dmPage, dmAt, isNat20Entry);
  check(
    "a freeform 1d20 rolling 20 does NOT play nat_20 (it's type:\"dice\", not a real natural-roll d20)",
    spuriousNat20OnFreeform === null,
    JSON.stringify(spuriousNat20OnFreeform)
  );

  check("no uncaught page error occurred on either client during this run", pageErrors.length === 0, pageErrors.join("; "));

  console.log(failures === 0 ? "\nAll natural-roll-sound checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
  if (devServer) {
    try {
      process.kill(-devServer.pid);
    } catch {
      // Already exited on its own.
    }
  }
}
