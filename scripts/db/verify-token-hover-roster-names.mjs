#!/usr/bin/env node
// "hovering over enemy tokens shows the name, but party ones do not show
// their name" (the project owner's own bug report). Root cause, confirmed
// by reading the actual code before writing this script: GameRoom.tsx's
// token-building code's `name: character?.name ?? token.npc_name ??
// undefined` line reads `character` from the SAME per-viewer,
// characters-RLS-filtered `characters` array the HP bar already reads from
// — 0008's "owner or campaign DM can read a character" policy is
// deliberately narrower than campaign membership, so another player's row
// never comes back at all for a non-owner, non-DM viewer. An NPC/enemy
// token's name lives on map_tokens.npc_name instead (no such restriction),
// which is why enemy hover-names already worked for everyone.
//
// What this ships (confirmed by reading the actual code/migrations before
// writing this script, not assumed):
//   - migration 0103_character_roster_names_view.sql: a NEW view,
//     character_roster_names, selecting ONLY id/campaign_id/name/level from
//     `characters`, with its access check baked into the view's own WHERE
//     clause (is_campaign_member) rather than characters' owner-or-DM RLS —
//     the map_transition_anchors (0095) pattern applied to `characters`.
//     `characters` itself is COMPLETELY UNCHANGED: ability scores, HP,
//     inventory, spells stay exactly as private as before.
//   - data-access/characters.ts: listCharacterRosterNames(supabase,
//     campaignId) — reads the new view, returns a Map<id, {id,name,level}>.
//   - GameRoom.tsx's token-building code: a NEW `rosterFallback`, consulted
//     ONLY when `character` (the existing owner-or-DM path) came back
//     undefined for a token that DOES carry a character_id — i.e. another
//     player's PC. The existing path always wins when it has data; this
//     only fills the gap. npc_name/enemy-token handling is completely
//     untouched.
//
// IMPORTANT — this script was authored and run BEFORE migration
// 0103_character_roster_names_view.sql was applied to the real database
// (the task this was built under explicitly forbids an agent from applying
// it — left for a human to review and run via `node scripts/db/
// migrate.mjs`). Phase 0 below probes the real schema for the new view and
// branches accordingly — the verify-remove-member.mjs/verify-token-
// rotation.mjs "probe first, blocked-not-failed" convention, reused
// verbatim in shape:
//   - View MISSING (expected on first run): every check that does NOT
//     depend on the new view still runs for real — the baseline
//     characters-RLS regression check, hovering your OWN token, hovering
//     an enemy/NPC token, and the DM seeing every token's name (all
//     completely untouched by this fix) — plus a real fail-safe check that
//     hovering ANOTHER player's token shows no label at all (never a crash,
//     never leaked data) while the view doesn't exist yet. Every check that
//     genuinely needs the view is reported BLOCKED, not FAIL.
//   - View EXISTS (re-run after a human applies the migration): every
//     check below runs for real, including the actual bug-fix hover check
//     and the real RLS security probes against the view itself.
//
// Needs the real dev server (starts `yarn dev` itself if the target port
// isn't already serving) and the real shared Supabase instance this
// project's .env points at. Ephemeral test users/campaigns/characters are
// created here and torn down in `finally`.
// Usage: node scripts/db/verify-token-hover-roster-names.mjs

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
const PORT = 6491;
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
  const email = `hover-roster-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Hover ${label}` });
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

const PANEL_IDS = [
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
];

async function loadRoomPage(page, campaignId) {
  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="token-selection-state"]', { state: "attached", timeout: 60000 });
  await sleep(3000);
  // Dock (close) every floating panel — by default several cover most of
  // the canvas, and a DOM panel sitting on top of the canvas swallows a
  // page.mouse.move/click there before it ever reaches the WebGL scene
  // beneath (confirmed via a real screenshot during verify-click-to-
  // attack.mjs's own development — same fix reused here). A single 1000ms-
  // budget pass (that script's own default) was measured against THIS
  // script's own heavier scene (more panels populated with real content)
  // to be too tight on a cold dev-server compile — several panels were
  // still mid-transition/not yet "stable" and silently failed to close,
  // leaving the board obscured and every hover check failing. Two full
  // passes with a generous per-click timeout fixes that: the first pass
  // closes whatever's already settled, the second catches anything that
  // only became closable a moment later.
  for (let pass = 0; pass < 2; pass++) {
    for (const panelId of PANEL_IDS) {
      await page.click(`[data-testid="close-toggle-${panelId}"]`, { timeout: 4000 }).catch(() => undefined);
    }
    await sleep(300);
  }
}

async function hoverLabelVisible(page, tokenId) {
  return page.locator(`[data-testid="token-hover-label-${tokenId}"]`).isVisible().catch(() => false);
}
async function hoverLabelText(page, tokenId) {
  return page.locator(`[data-testid="token-hover-label-${tokenId}"]`).textContent().catch(() => null);
}

/** A blind full-canvas mouse-MOVE scan (verify-click-to-attack.mjs's own
 * scanGridClick, adapted from click to hover) — `done` is checked after
 * each move settles; the raycasted onPointerOver/Out pair on the token's
 * own invisible hit-box cylinder fires from a plain pointer move exactly
 * the same way it does from a click. `steps: 5` on every move (confirmed
 * necessary via a real standalone repro during this script's own
 * development: an un-stepped single-jump page.mouse.move — Playwright's own
 * default — reliably failed to register ANY hover across a full scan, while
 * the identical target coordinates DID register with a multi-step move; a
 * genuine hardware mouse is never a teleport either, so this is arguably
 * the more realistic input regardless). Sorted nearest-to-canvas-center-
 * first, and every test token below is placed near the grid's own center,
 * so a real match is normally found within the first handful of points, not
 * the full sweep.
 *
 * Deliberately does NOT move the mouse away on a successful find (a real
 * bug caught during this script's own development: an unconditional
 * "cleanup" move-away here, run right before returning, un-hovered the
 * token again before the CALLER ever got to read its label text — every
 * check reported a false FAIL despite the scan itself having genuinely
 * found and hovered the right token). The mouse is left sitting exactly on
 * the match; a caller wanting the label's text should read it immediately
 * after this returns, before doing anything else that might move the
 * pointer. Only a genuine miss (found stays null) recenters the mouse, so a
 * SUBSEQUENT scan for a different token still starts from a clean slate. */
async function scanGridHover(page, done, opts = {}) {
  const { xFrom = 0.12, xTo = 0.88, yFrom = 0.24, yTo = 0.7, step = 34, settleMs = 160 } = opts;
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("no canvas on the page");
  let found = null;
  for (const [offset, settle] of [
    [0, settleMs],
    [step / 2, settleMs * 1.5],
  ]) {
    if (found) break;
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
      await page.mouse.move(point.x, point.y, { steps: 5 });
      await sleep(settle);
      if (await done(point)) {
        found = point;
        break;
      }
    }
  }
  if (!found) {
    await page.mouse.move(box.x + 2, box.y + 2, { steps: 5 });
    await sleep(200);
  }
  return found;
}

await ensureDevServer();

const dm = await makeTestUser("dm");
const playerA = await makeTestUser("player-a");
const playerB = await makeTestUser("player-b");
const otherDm = await makeTestUser("other-dm");
const otherPlayer = await makeTestUser("other-player");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

try {
  // -------------------------------------------------------------------
  // Setup — the main campaign: dm + two players, each with one character,
  // placed near the center of a small grid (so scanGridHover's nearest-
  // center-first sweep finds them fast), plus one enemy/NPC token.
  // -------------------------------------------------------------------
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Hover Roster Names Test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: playerA.id, role: "player" },
    { campaign_id: campaignId, user_id: playerB.id, role: "player" },
  ]);

  const charA = baseCharacter({ campaign_id: campaignId, owner_id: playerA.id, name: "Aria Stormwind", level: 5 });
  const charB = baseCharacter({ campaign_id: campaignId, owner_id: playerB.id, name: "Borin Oakenshield", level: 3 });
  await admin.from("characters").insert([charA, charB]);

  const GRID = 7;
  const mapId = crypto.randomUUID();
  await admin.from("campaign_maps").insert({
    id: mapId,
    campaign_id: campaignId,
    name: "Hover Roster Names Arena",
    grid_width: GRID,
    grid_height: GRID,
  });
  await admin.from("campaigns").update({ live_map: mapId }).eq("id", campaignId);

  const center = Math.floor(GRID / 2);
  const tokenA = crypto.randomUUID();
  const tokenB = crypto.randomUUID();
  const npcToken = crypto.randomUUID();
  await admin.from("map_tokens").insert([
    { id: tokenA, map_id: mapId, character_id: charA.id, x: center, y: center, elevation: 0, allegiance: "party" },
    { id: tokenB, map_id: mapId, character_id: charB.id, x: center, y: center + 1, elevation: 0, allegiance: "party" },
    { id: npcToken, map_id: mapId, npc_name: "Goblin Scout", x: center - 1, y: center, elevation: 0, allegiance: "hostile" },
  ]);

  // A SEPARATE campaign playerA is NOT a member of, for the real RLS
  // security check below — proving is_campaign_member scoping is real, not
  // accidentally open to every authenticated user.
  const otherCampaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: otherCampaignId, name: "Other Campaign (not playerA's)", creator: otherDm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: otherCampaignId, user_id: otherDm.id, role: "dm" },
    { campaign_id: otherCampaignId, user_id: otherPlayer.id, role: "player" },
  ]);
  const charC = baseCharacter({
    campaign_id: otherCampaignId,
    owner_id: otherPlayer.id,
    name: "Secret Character",
    level: 10,
  });
  await admin.from("characters").insert(charC);

  // -------------------------------------------------------------------
  // Phase 0 — schema probe: does character_roster_names exist yet? There is
  // no non-destructive way to check a VIEW's existence other than querying
  // it — this IS the probe (verify-dm-tray-drag.mjs's own Phase 0 shape,
  // applied to a view instead of a column).
  // -------------------------------------------------------------------
  const probe = await admin.from("character_roster_names").select("id").limit(1);
  const viewExists = !probe.error;
  if (!viewExists) {
    console.log(
      `\nPhase 0: character_roster_names does NOT exist yet (${probe.error?.message ?? "unknown error"}).\n` +
        "Every check below that doesn't actually need the view still runs for real; every check that genuinely\n" +
        "needs it is reported as BLOCKED, not FAIL — apply migration 0103_character_roster_names_view.sql via\n" +
        "`node scripts/db/migrate.mjs`, then re-run this exact script for the full pass.\n"
    );
  } else {
    console.log("\nPhase 0: character_roster_names exists — running every check for real.\n");
  }

  // -------------------------------------------------------------------
  // Phase 1 — baseline RLS regression: characters' own owner-or-DM-only
  // policy (0008) is completely untouched by this fix, independent of
  // whether the new view has been applied.
  // -------------------------------------------------------------------
  {
    const { data, error } = await playerA.client.from("characters").select().eq("id", charB.id);
    check(
      "baseline UNCHANGED: playerA still cannot read playerB's full `characters` row directly (owner-or-DM RLS, 0008)",
      !error && (data ?? []).length === 0,
      JSON.stringify({ error, data })
    );
  }

  // -------------------------------------------------------------------
  // Phase 2 — the real view, if it exists: the actual RLS security checks
  // this task is really about.
  // -------------------------------------------------------------------
  if (viewExists) {
    {
      const { data, error } = await playerA.client
        .from("character_roster_names")
        .select()
        .eq("campaign_id", campaignId)
        .order("name", { ascending: true });
      const byId = new Map((data ?? []).map((row) => [row.id, row]));
      check(
        "playerA (a plain campaign member, not charB's owner or the DM) CAN read charA+charB's roster names via the new view",
        !error && byId.size === 2 && byId.get(charA.id)?.name === "Aria Stormwind" && byId.get(charB.id)?.name === "Borin Oakenshield",
        JSON.stringify({ error, data })
      );
      check(
        "the roster-names view also carries `level` correctly for both characters",
        byId.get(charA.id)?.level === 5 && byId.get(charB.id)?.level === 3,
        JSON.stringify(data)
      );
    }
    {
      const { data, error } = await playerA.client.from("character_roster_names").select("*").eq("id", charB.id).single();
      const keys = data ? Object.keys(data).sort() : [];
      check(
        "the view exposes ONLY id/campaign_id/name/level — no ability scores, HP, inventory, or spells leak through it",
        !error && JSON.stringify(keys) === JSON.stringify(["campaign_id", "id", "level", "name"]),
        JSON.stringify({ error, keys })
      );
    }
    // ---------------------------------------------------------------
    // THE real security check: playerA is a genuine, real member of the
    // FIRST campaign, but NOT of otherCampaignId — is_campaign_member must
    // block this, proving the scoping is real and per-campaign, not
    // accidentally open to any authenticated user.
    // ---------------------------------------------------------------
    {
      const { data, error } = await playerA.client
        .from("character_roster_names")
        .select()
        .eq("campaign_id", otherCampaignId);
      check(
        "SECURITY: playerA gets an EMPTY result querying character_roster_names for a campaign they are NOT a member of",
        !error && (data ?? []).length === 0,
        JSON.stringify({ error, data })
      );
    }
    {
      const { data, error } = await playerA.client.from("character_roster_names").select().eq("id", charC.id);
      check(
        "SECURITY: playerA gets nothing for charC's id directly either (not just campaign_id-filtered) — no leak by guessing an id",
        !error && (data ?? []).length === 0,
        JSON.stringify({ error, data })
      );
    }
    {
      // Symmetric check: otherPlayer (a member of the OTHER campaign) is
      // equally blocked from reading INTO the main campaign's roster.
      const { data, error } = await otherPlayer.client
        .from("character_roster_names")
        .select()
        .eq("campaign_id", campaignId);
      check(
        "SECURITY (symmetric): otherPlayer, a member of the OTHER campaign, gets nothing for THIS campaign's roster either",
        !error && (data ?? []).length === 0,
        JSON.stringify({ error, data })
      );
    }
  } else {
    skipBlocked(
      "playerA can read charA+charB's roster names via character_roster_names",
      "migration 0103_character_roster_names_view.sql has not been applied yet — see Phase 0 above"
    );
    skipBlocked("the view exposes only id/campaign_id/name/level", "depends on the same unapplied migration");
    skipBlocked("SECURITY: a non-member gets nothing from the view", "depends on the same unapplied migration");
  }

  // -------------------------------------------------------------------
  // Phase 3 — the real browser-driven hover checks.
  // -------------------------------------------------------------------
  const dmContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await loadRoomPage(dmPage, campaignId);

  // Regression: the DM already had full RLS access to every character via
  // `characters` itself (owner-or-DM) — untouched either way by this fix.
  {
    const point = await scanGridHover(dmPage, () => hoverLabelVisible(dmPage, tokenA));
    const text = point ? await hoverLabelText(dmPage, tokenA) : null;
    check("REGRESSION: the DM sees charA's token hover-name correctly (· Level 5)", text === "Aria Stormwind · Level 5", text);
  }
  {
    const point = await scanGridHover(dmPage, () => hoverLabelVisible(dmPage, tokenB));
    const text = point ? await hoverLabelText(dmPage, tokenB) : null;
    check("REGRESSION: the DM sees charB's token hover-name correctly too (· Level 3)", text === "Borin Oakenshield · Level 3", text);
  }
  await dmPage.screenshot({ path: join(SCREENSHOT_DIR, "hover-roster-dm.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "hover-roster-dm.png")}`);
  await dmContext.close();

  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await aliceContext.addCookies(sessionCookies(playerA.session));
  const alicePage = await aliceContext.newPage();
  await loadRoomPage(alicePage, campaignId);

  // Regression: hovering your OWN token already worked (character resolves
  // directly via the owner branch of 0008's RLS) — untouched by this fix.
  {
    const point = await scanGridHover(alicePage, () => hoverLabelVisible(alicePage, tokenA));
    const text = point ? await hoverLabelText(alicePage, tokenA) : null;
    check("REGRESSION: playerA still sees her OWN token's hover-name correctly (· Level 5)", text === "Aria Stormwind · Level 5", text);
  }
  // Regression: an enemy/NPC token's hover-name rides map_tokens.npc_name,
  // completely untouched by this fix — no "· Level N" suffix either.
  {
    const point = await scanGridHover(alicePage, () => hoverLabelVisible(alicePage, npcToken));
    const text = point ? await hoverLabelText(alicePage, npcToken) : null;
    check("REGRESSION: playerA still sees the enemy/NPC token's hover-name correctly, with NO level suffix", text === "Goblin Scout", text);
  }

  // THE actual bug fix: playerA hovering over playerB's OWN party token.
  {
    const point = await scanGridHover(alicePage, () => hoverLabelVisible(alicePage, tokenB));
    const text = point ? await hoverLabelText(alicePage, tokenB) : null;
    if (viewExists) {
      check(
        "THE FIX: playerA now sees playerB's party token's hover-name (· Level 3) — the actual reported bug",
        text === "Borin Oakenshield · Level 3",
        text
      );
    } else {
      // Fail-safe branch: with the view missing, listCharacterRosterNames
      // rejects and refreshCombat's own .catch(() => null) guard (see
      // GameRoom.tsx) leaves characterRosterNames as the initial empty Map
      // from page.tsx's own safe() fallback — rosterFallback stays
      // undefined, so this must render NO label at all: never a crash,
      // never a wrong/blank name, never a leak of some other field.
      check(
        "fail-safe (view not yet applied): hovering playerB's token shows NO label at all — no crash, no leaked data",
        point === null && text === null,
        JSON.stringify({ point, text })
      );
      skipBlocked(
        "playerA sees playerB's party token's hover-name (the actual reported bug fix)",
        "migration 0103_character_roster_names_view.sql has not been applied yet — see Phase 0 above"
      );
    }
  }

  await alicePage.screenshot({ path: join(SCREENSHOT_DIR, "hover-roster-playerA.png") });
  console.log(`Screenshot saved: ${join(SCREENSHOT_DIR, "hover-roster-playerA.png")}`);
  await aliceContext.close();
} finally {
  await browser.close();
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(playerA.id);
  await admin.auth.admin.deleteUser(playerB.id);
  await admin.auth.admin.deleteUser(otherDm.id);
  await admin.auth.admin.deleteUser(otherPlayer.id);
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
  console.error("Token hover roster-names verification FAILED.");
  process.exit(1);
}
console.log(
  blocked > 0
    ? "Token hover roster-names verification PASSED every check runnable today; the rest are BLOCKED pending the (deliberately unapplied) migration 0103_character_roster_names_view.sql — see the console notes above."
    : "All token hover roster-names checks passed."
);
process.exit(0);
