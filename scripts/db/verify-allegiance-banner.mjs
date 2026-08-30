#!/usr/bin/env node
// Global Party Members (the project owner's own ask): "We need 'Global
// party members' for followers and new party members joining, there
// should be a banner animation and it should announce the NPC/enemy has
// become a party member, in the same sense members can leave as neutral
// and as enemy."
//
// What this ships (confirmed by reading the actual current code before
// writing this script, not assumed):
//   - "party members" has no meaning beyond map_tokens.allegiance ===
//     'party' in this codebase — no separate followers/roster concept was
//     added, matching the project owner's own framing.
//   - A NEW AllegianceBanner.tsx component (+ AllegianceBanner.module.css),
//     mounted once in GameRoom.tsx, fed by a NEW GameRoom.tsx callback,
//     pushAllegianceBannerIfNeeded, called from the ONLY two places an
//     allegiance change can ever reach a client: the DM's own local
//     optimistic apply in handleSetAllegiance, and the EXISTING TOKEN_EVENT
//     broadcast subscribe handler every OTHER connected client already
//     runs for every token update — NO new broadcast event, NO new
//     subscription, NO new persistence.
//   - Trigger condition: previous.allegiance !== next.allegiance AND the
//     change involves 'party' in either direction. A bare hostile<->neutral
//     flip never announces anything.
//   - Wording: "<name> has joined the party." (-> party), "<name> has
//     turned hostile." (party -> hostile), "<name> has become neutral."
//     (party -> neutral) — GameRoom.tsx's own allegianceBannerText.
//   - Name resolution reuses the exact character-then-roster-fallback chain
//     the token hover-label code already established (0103's
//     character_roster_names view) — GameRoom.tsx's resolveTokenDisplayName.
//   - Auto-dismisses after AUTO_DISMISS_MS (4000ms, matching
//     CampaignRoster.tsx's own RECONNECTED_CONFIRMATION_MS convention).
//   - Multiple rapid changes queue one-at-a-time (FIFO, capped at
//     MAX_QUEUED_ALLEGIANCE_BANNERS = 5) rather than stacking or replacing
//     — see AllegianceBanner.tsx's own doc comment for the full reasoning.
//   - A hidden `[data-testid="allegiance-banner-state"]` debug mirror
//     exposes the FULL pending queue (not just the one currently showing),
//     so the rapid-fire check below can assert nothing was silently dropped
//     without racing the real 4-second auto-dismiss timer.
//
// Covers:
//   1. The DM sets an NPC token's allegiance to 'party' in a real browser —
//      a banner naming it correctly ("Grix the Goblin has joined the
//      party.") appears on the DM's OWN client.
//   2. A SECOND, already-connected client (Alice, a player who never
//      reloaded) ALSO sees the exact same banner live — proving the
//      existing TOKEN_EVENT broadcast alone is enough, no new plumbing.
//   3. Flipping that same token from 'party' to 'hostile' shows "Grix the
//      Goblin has turned hostile."
//   4. Flipping from 'hostile' to 'neutral' (never touching 'party') shows
//      NO banner at all.
//   5. Flipping 'neutral' -> 'party' -> 'neutral' shows "has joined the
//      party." then "has become neutral." — the third wording variant.
//   6. A PC token (character_id, not npc_name) flipping to 'hostile' names
//      it via the character's real name, not npc_name (which is always
//      null for a PC token) — proving the name-resolution reuse, not just
//      the NPC path.
//   7. Each banner auto-dismisses on its own within a generous window —
//      never stays up forever, never needs a manual dismiss.
//   8. Three allegiance changes fired back-to-back (no waiting between
//      them) queue rather than crash or silently drop — checked via the
//      hidden debug mirror's full queue, not by racing real display timing.
//   9. A real screenshot of the banner actually rendered on-screen with
//      real, readable text.
//
// Needs the real dev server (starts `yarn dev` itself if the target port
// isn't already serving) and the real shared Supabase instance this
// project's .env points at. Ephemeral test users/campaign/map/tokens are
// created here and torn down in `finally`.
// Usage: node scripts/db/verify-allegiance-banner.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port not used by any other verify script in this
// repo (grepped at authoring time) — this machine runs several concurrent
// agent worktrees, each potentially squatting on common ports with their
// OWN checkout's dev server.
const PORT = 6510;
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}`;
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
  console.log(`dev server not running on :${PORT} — starting this worktree's own…`);
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
  const email = `allegiance-banner-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Allegiance ${label}` });
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

async function loadRoomPage(page, campaignId) {
  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="token-panel"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="allegiance-banner-state"]', { state: "attached", timeout: 30000 });
  // Let the realtime channel actually reach SUBSCRIBED before anything else
  // happens — the same settle window verify-day-night-mode.mjs/verify-
  // token-hover-roster-names.mjs already rely on before treating a client
  // as "really listening".
  await sleep(2000);
}

async function bannerState(page) {
  const text = await page.textContent('[data-testid="allegiance-banner-state"]');
  return JSON.parse(text);
}

async function waitForBannerText(page, expectedText, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await bannerState(page);
    if (last.currentText === expectedText) return last;
    await sleep(150);
  }
  return last;
}

async function waitForNoBanner(page, timeoutMs = 3000) {
  await sleep(timeoutMs);
  return bannerState(page);
}

async function waitForQueueEmpty(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await bannerState(page);
    if (last.queueLength === 0) return last;
    await sleep(200);
  }
  return last;
}

async function setAllegiance(page, tokenId, allegiance) {
  await page.click(`[data-testid="set-allegiance-${tokenId}-${allegiance}"]`);
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const alice = await makeTestUser("alice");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  // -------------------------------------------------------------------
  // Setup: dm + alice, a small map, alice's own character (placed as a
  // party token — the ordinary state for a placed PC), and an NPC token
  // ("Grix the Goblin") starting at 'neutral' so the very first real
  // transition tested is a genuine -> party join.
  // -------------------------------------------------------------------
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Allegiance Banner Test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: alice.id, role: "player" },
  ]);

  const charAlice = baseCharacter({
    campaign_id: campaignId,
    owner_id: alice.id,
    name: "Aria Stormwind",
    level: 4,
  });
  await admin.from("characters").insert(charAlice);

  const GRID = 6;
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Allegiance Banner Arena",
    grid_width: GRID,
    grid_height: GRID,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const npcTokenId = crypto.randomUUID();
  const pcTokenId = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: npcTokenId, map_id: mapId, npc_name: "Grix the Goblin", x: 2, y: 2, elevation: 0, allegiance: "neutral" },
    { id: pcTokenId, map_id: mapId, character_id: charAlice.id, x: 3, y: 2, elevation: 0, allegiance: "party" },
  ]);

  // -------------------------------------------------------------------
  // Both clients join the same live room BEFORE any allegiance change —
  // Alice's page is opened once here and never reloaded for the rest of
  // this script, so any banner she sees later can only have arrived via
  // the live TOKEN_EVENT broadcast.
  // -------------------------------------------------------------------
  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await loadRoomPage(dmPage, campaignId);

  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await aliceContext.addCookies(sessionCookies(alice.session));
  const alicePage = await aliceContext.newPage();
  await loadRoomPage(alicePage, campaignId);

  check(
    "both clients start with an empty banner queue",
    (await bannerState(dmPage)).queueLength === 0 && (await bannerState(alicePage)).queueLength === 0
  );

  // -------------------------------------------------------------------
  // 1 & 2. neutral -> party: "has joined the party." on the DM's own
  // client (the acting client), AND on Alice's already-open, never-
  // reloaded second client — the actual "no new sync plumbing needed"
  // claim this feature makes.
  // -------------------------------------------------------------------
  await setAllegiance(dmPage, npcTokenId, "party");
  const dmJoined = await waitForBannerText(dmPage, "Grix the Goblin has joined the party.");
  check(
    "DM's OWN client shows the correct 'joined the party' banner immediately after clicking",
    dmJoined?.currentText === "Grix the Goblin has joined the party.",
    JSON.stringify(dmJoined)
  );
  const aliceJoined = await waitForBannerText(alicePage, "Grix the Goblin has joined the party.");
  check(
    "a SECOND, already-connected client (Alice, who clicked nothing) sees the same banner live via the existing TOKEN_EVENT broadcast",
    aliceJoined?.currentText === "Grix the Goblin has joined the party.",
    JSON.stringify(aliceJoined)
  );

  // A real screenshot of the banner actually rendered, with real text.
  await dmPage.locator('[data-testid="allegiance-banner"]').waitFor({ state: "visible", timeout: 5000 });
  const bannerVisibleText = await dmPage.locator('[data-testid="allegiance-banner"]').textContent();
  check(
    "the visible banner element (not just the hidden debug mirror) renders the correct text",
    bannerVisibleText === "Grix the Goblin has joined the party.",
    bannerVisibleText
  );
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "allegiance-banner-joined.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "allegiance-banner-joined.png")}`);

  // -------------------------------------------------------------------
  // 7. Auto-dismiss: the banner goes away on its own, with no manual
  // dismiss action, well within a generous window.
  // -------------------------------------------------------------------
  const dmAfterDismiss = await waitForQueueEmpty(dmPage, 8000);
  check(
    "the banner auto-dismisses on its own (no manual action) within a generous window",
    dmAfterDismiss?.queueLength === 0,
    JSON.stringify(dmAfterDismiss)
  );
  const bannerGone = await dmPage.locator('[data-testid="allegiance-banner"]').count();
  check("the banner element is actually gone from the DOM after auto-dismiss", bannerGone === 0, bannerGone);

  // -------------------------------------------------------------------
  // 3. party -> hostile: "has turned hostile." — the explicit "left the
  // party as an enemy" wording from the project owner's own ask.
  // -------------------------------------------------------------------
  await setAllegiance(dmPage, npcTokenId, "hostile");
  const turnedHostile = await waitForBannerText(dmPage, "Grix the Goblin has turned hostile.");
  check(
    "party -> hostile shows the correct 'turned hostile' banner",
    turnedHostile?.currentText === "Grix the Goblin has turned hostile.",
    JSON.stringify(turnedHostile)
  );
  await waitForQueueEmpty(dmPage, 8000);

  // -------------------------------------------------------------------
  // 4. hostile -> neutral: never touches 'party' — NO banner at all.
  // -------------------------------------------------------------------
  await setAllegiance(dmPage, npcTokenId, "neutral");
  const afterHostileToNeutral = await waitForNoBanner(dmPage, 3000);
  check(
    "hostile -> neutral (never touching party) shows NO banner",
    afterHostileToNeutral.queueLength === 0 && afterHostileToNeutral.currentText === null,
    JSON.stringify(afterHostileToNeutral)
  );

  // Symmetric direction too: neutral -> hostile, still no banner.
  await setAllegiance(dmPage, npcTokenId, "hostile");
  const afterNeutralToHostile = await waitForNoBanner(dmPage, 3000);
  check(
    "neutral -> hostile (never touching party) ALSO shows NO banner",
    afterNeutralToHostile.queueLength === 0 && afterNeutralToHostile.currentText === null,
    JSON.stringify(afterNeutralToHostile)
  );

  // -------------------------------------------------------------------
  // 5. The third wording variant: party -> neutral = "has become
  // neutral." (hostile -> party first, to re-enter the party.)
  // -------------------------------------------------------------------
  await setAllegiance(dmPage, npcTokenId, "party");
  await waitForBannerText(dmPage, "Grix the Goblin has joined the party.");
  await waitForQueueEmpty(dmPage, 8000);
  await setAllegiance(dmPage, npcTokenId, "neutral");
  const becameNeutral = await waitForBannerText(dmPage, "Grix the Goblin has become neutral.");
  check(
    "party -> neutral shows the correct 'become neutral' banner (the third wording variant)",
    becameNeutral?.currentText === "Grix the Goblin has become neutral.",
    JSON.stringify(becameNeutral)
  );
  await waitForQueueEmpty(dmPage, 8000);

  // -------------------------------------------------------------------
  // 6. A PC token flipping to hostile is named via the CHARACTER's real
  // name (Aria Stormwind), not npc_name (always null for a PC token) —
  // proving the name-resolution reuse covers both token kinds, not just
  // the NPC path this feature's own example wording centers on.
  // -------------------------------------------------------------------
  await setAllegiance(dmPage, pcTokenId, "hostile");
  const pcTurnedHostile = await waitForBannerText(dmPage, "Aria Stormwind has turned hostile.");
  check(
    "a PC token flipping party -> hostile is named via the character's real name, not npc_name",
    pcTurnedHostile?.currentText === "Aria Stormwind has turned hostile.",
    JSON.stringify(pcTurnedHostile)
  );
  await waitForQueueEmpty(dmPage, 8000);
  // Restore Aria to party for tidiness (not strictly required before
  // teardown, but leaves the fixture in a sane state if inspected). Waits
  // for the resulting banner to actually APPEAR first, not just for the
  // queue to read empty — waitForQueueEmpty alone can race a click whose
  // resulting push hasn't landed yet and return on the pre-click "empty"
  // state, which would otherwise leak this banner into the next section's
  // own queue assertions (confirmed by a real run during this script's own
  // development).
  await setAllegiance(dmPage, pcTokenId, "party");
  await waitForBannerText(dmPage, "Aria Stormwind has joined the party.");
  await waitForQueueEmpty(dmPage, 8000);

  // -------------------------------------------------------------------
  // 8. Rapid-fire: three genuine allegiance changes fired back-to-back
  // with no waiting between them. Asserts via the hidden debug mirror
  // (the FULL pending queue) that every one of them was captured — never
  // crashed, never silently dropped — without racing the real 4-second
  // per-banner display timing. Uses the NPC token again, currently
  // 'neutral' after step 5 above.
  // -------------------------------------------------------------------
  const preRapidState = await bannerState(dmPage);
  check("queue is empty before the rapid-fire burst", preRapidState.queueLength === 0, JSON.stringify(preRapidState));

  const consoleErrors = [];
  const onConsole = (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  };
  dmPage.on("console", onConsole);
  const onPageError = (err) => consoleErrors.push(String(err));
  dmPage.on("pageerror", onPageError);

  await setAllegiance(dmPage, npcTokenId, "party"); // neutral -> party: "joined"
  await setAllegiance(dmPage, npcTokenId, "hostile"); // party -> hostile: "turned hostile"
  await setAllegiance(dmPage, npcTokenId, "neutral"); // hostile -> neutral: no banner
  await setAllegiance(dmPage, npcTokenId, "party"); // neutral -> party: "joined" (again)

  // Give React a brief moment to process all four clicks, then read the
  // full queue — three of the four transitions above involve 'party' and
  // should all have been captured (in order), the fourth (hostile ->
  // neutral) contributes nothing.
  await sleep(1000);
  const rapidState = await bannerState(dmPage);
  check(
    "a rapid-fire burst of allegiance changes never crashes the page (no console errors/pageerrors)",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors)
  );
  check(
    "the rapid-fire burst queued exactly the 3 party-involving changes, in order, none dropped",
    JSON.stringify(rapidState.queuedTexts) ===
      JSON.stringify([
        "Grix the Goblin has joined the party.",
        "Grix the Goblin has turned hostile.",
        "Grix the Goblin has joined the party.",
      ]),
    JSON.stringify(rapidState)
  );
  dmPage.off("console", onConsole);
  dmPage.off("pageerror", onPageError);

  // A real screenshot mid-queue, showing only ONE banner on screen at a
  // time even though three are pending — not stacked, not garbled.
  await dmPage.locator('[data-testid="allegiance-banner"]').waitFor({ state: "visible", timeout: 5000 });
  const visibleBannerCount = await dmPage.locator('[data-testid="allegiance-banner"]').count();
  check("exactly ONE banner element is ever in the DOM at a time, even with a queue pending", visibleBannerCount === 1, visibleBannerCount);
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "allegiance-banner-rapid-queue.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "allegiance-banner-rapid-queue.png")}`);

  // Let the whole queue drain naturally (each banner gets its own full
  // display time) and confirm it empties out cleanly.
  const drainedState = await waitForQueueEmpty(dmPage, 20000);
  check("the whole rapid-fire queue drains to empty on its own, one at a time", drainedState?.queueLength === 0, JSON.stringify(drainedState));
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
console.log("\nAll allegiance banner checks passed.");
process.exit(0);
