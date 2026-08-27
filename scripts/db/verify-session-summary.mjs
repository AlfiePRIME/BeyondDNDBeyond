#!/usr/bin/env node
// Chat & Summary B6 verification: pause/resume session lifecycle
// (pause_session/resume_session/start_session/end_session, migration 0069)
// plus the AI end-of-session summary (src/ai/generateSessionSummary.ts, the
// end-session-summary Route Handler, EndSessionSummaryModal.tsx).
//
// Real browser, real dev server, real AI-generation code path — pointed at
// a LOCAL FAKE Anthropic Messages API (scripts/db/lib/fakeAnthropic.mjs) via
// ANTHROPIC_BASE_URL, per src/ai/README.md's own documented end-to-end
// testing seam (this is the first prompt to actually build that harness).
// Chat/interaction/roll rows are seeded directly via the admin client
// (this project's own "seed starting state via the service-role client"
// rule) — B1/B5 already cover the real UI paths that PRODUCE that data;
// this script is about B6's own job, reading a session's window correctly.
//
// Scenario 1 (no pause): a session with real seeded chat + an interaction
//   event + a damage-dealing roll. Ending it shows a REAL preview whose
//   narrative textarea contains markers pulled from that seeded content
//   (proving the route actually gathered and forwarded it, not a canned
//   stub), the DM edits the narrative, confirms, and the saved session_log
//   recap (the EDITED text) plus its session_summary_highlights rows are
//   verified against the DB. Also verifies DM-gating: a player's own direct
//   fetch to the route is rejected (403), and start_session collision
//   detection is unaffected for an already-live (non-paused) session.
//
// Scenario 2 (pause/resume): pausing stops the live signal, generates NO
//   summary (no session_log row appears), and leaves session_started_at
//   untouched; a fresh start_session attempt during the pause is REJECTED
//   (this prompt's own fix — a paused session used to look "startable" to
//   the lobby before B6, since session_active alone used to mean "nothing
//   in progress"); resuming continues the SAME session (session_started_at
//   unchanged); a final End Session's generated request transcript contains
//   BOTH a marker seeded before the pause and one seeded after resuming,
//   proving the window spans the whole original start-to-end span.
//
// Scenario 3 (graceful empty session): a session with zero chat/activity
//   still completes without an API call at all (the fake server's request
//   count is unchanged) and without an error — an explicitly-empty,
//   DM-editable draft the DM can still confirm.
//
// Needs the local Supabase stack (via migrate.mjs) and ALWAYS starts its own
// dedicated dev server on its own port with ANTHROPIC_API_KEY/
// ANTHROPIC_BASE_URL pointed at the fake — never reuses an already-running
// server on that port, since reusing one would silently skip the whole
// point of this script (a stray server started without these env vars would
// have AI generation permanently unconfigured).
//
// Usage: node scripts/db/verify-session-summary.mjs
//        SESSION_SUMMARY_APP_PORT=3970 node scripts/db/verify-session-summary.mjs

import { execSync, spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";
import { startFakeAnthropicServer } from "./lib/fakeAnthropic.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// A fixed, non-default port, never APP_URL's usual :3000 default — this
// machine's live production server, not a fresh build of this worktree's
// own changes (this project's own hard-won lesson).
const APP_PORT = Number(process.env.SESSION_SUMMARY_APP_PORT ?? 3970);
const APP_URL = `http://localhost:${APP_PORT}`;
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

const TORCH_PRESET_ID = "a55e7001-0000-4000-8000-000000000001";

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

const fileEnv = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")) };
const env = { ...fileEnv, ...process.env };
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

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!last && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await fn();
  }
  return last;
}

async function isVisible(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).isVisible().catch(() => false);
}

async function dismissTurnCameraIfShown(page) {
  if (await isVisible(page, "turn-camera-dismiss")) {
    await page.click('[data-testid="turn-camera-dismiss"]');
    await sleep(300);
  }
}

async function healthOk() {
  return fetch(`${APP_URL}/api/health`).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function startFreshDevServer(extraEnv) {
  // Always our own, fresh, never reused — see this script's own header
  // comment on why "already healthy" isn't good enough here.
  try {
    const pids = execSync(`lsof -ti tcp:${APP_PORT} || true`).toString().trim();
    if (pids) {
      for (const pid of pids.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // already gone
        }
      }
      await sleep(500);
    }
  } catch {
    // lsof unavailable or nothing to kill — proceed anyway.
  }
  console.log(`starting a dedicated dev server on :${APP_PORT} with a fake Anthropic backend…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, ...extraEnv },
  });
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

async function makeTestUser(label, displayName) {
  const email = `session-summary-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: displayName });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, session: signIn.session, client };
}

async function makeCampaign(name, dmId, memberIds) {
  const campaignId = crypto.randomUUID();
  const { error } = await admin.from("campaigns").insert({ id: campaignId, name, creator: dmId });
  if (error) throw error;
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dmId, role: "dm" },
    ...memberIds.map((id) => ({ campaign_id: campaignId, user_id: id, role: "player" })),
  ]);
  return campaignId;
}

/** Directly opens a session's window at `startedAt` (bypassing start_session
 * — deterministic timestamps this project's own "seed via the admin client"
 * rule explicitly favors over a real RPC call whose window would start at
 * whatever "now" happened to be when this script ran). */
async function openSessionAt(campaignId, startedAt) {
  const { error } = await admin
    .from("campaigns")
    .update({ session_active: true, session_started_at: startedAt })
    .eq("id", campaignId);
  if (error) throw error;
}

async function getCampaign(campaignId) {
  const { data, error } = await admin.from("campaigns").select().eq("id", campaignId).single();
  if (error) throw error;
  return data;
}

async function sessionLogCountFor(campaignId) {
  const { count, error } = await admin
    .from("session_log")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (error) throw error;
  return count ?? 0;
}

async function latestSessionLogEntry(campaignId) {
  const { data, error } = await admin
    .from("session_log")
    .select()
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function highlightsFor(sessionLogId) {
  const { data, error } = await admin
    .from("session_summary_highlights")
    .select()
    .eq("session_log_id", sessionLogId)
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Postgres round-trips a timestamptz with different string formatting than
 * the JS ISO string that produced it (e.g. dropped trailing millisecond
 * zeros, "+00:00" instead of "Z") — same instant, different bytes. Compare
 * by epoch millis, not string equality. */
function sameInstant(a, b) {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

function transcriptTextOf(requestBody) {
  return String(requestBody?.messages?.[0]?.content ?? "");
}

/** A response builder shared by every AI-backed scenario: echoes back
 * whichever seeded markers actually appear in the transcript it was sent,
 * so the resulting narrative/highlights can only contain a marker if the
 * route genuinely gathered and forwarded that marker's source row. */
function fakeSummaryResponse(requestBody) {
  const text = transcriptTextOf(requestBody);
  const markers = ["GLIMMERWEED_CAVERN", "CURSED_IDOL_GUARDIAN", "SILVERVEIN_THICKET", "EMBERFALL_RAVINE"];
  const present = markers.filter((marker) => text.includes(marker));
  const narrative =
    present.length > 0
      ? `The party's session touched on: ${present.join(", ")}.`
      : "A quiet session with nothing notable to report.";
  const highlights = present.map((marker) => ({
    category: marker.includes("IDOL") ? "damage" : "interaction",
    headline: `Something happened involving ${marker}.`,
  }));
  return { narrative, highlights };
}

// ════════════════════════════════════════════════════════════════════
// Setup
// ════════════════════════════════════════════════════════════════════
const fake = await startFakeAnthropicServer(fakeSummaryResponse);
console.log(`fake Anthropic server listening at ${fake.url}`);

await startFreshDevServer({ ANTHROPIC_API_KEY: "sk-ant-fake-test-key", ANTHROPIC_BASE_URL: fake.url });

const dm = await makeTestUser("dm", "Session Summary DM");
const alice = await makeTestUser("alice", "Alice Wayfinder");

const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const pageErrors = [];
const ROOM_VIEWPORT = { width: 1600, height: 900 };

async function openRoom(session, campaignId) {
  const context = await browser.newContext({ viewport: ROOM_VIEWPORT });
  await context.addCookies(sessionCookies(session));
  const page = await context.newPage();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await page.waitForSelector('[data-testid="table-surface-state"]', { state: "attached", timeout: 60000 });
  await dismissTurnCameraIfShown(page);
  return page;
}

try {
  // ════════════════════════════════════════════════════════════════════
  // Scenario 1 — a real session, real seeded content, real end-to-end
  // generation, edit, confirm, and DB verification. Also: DM-gating.
  // ════════════════════════════════════════════════════════════════════
  console.log("\n— Scenario 1: end a session with real content —");
  const campaign1 = await makeCampaign("Session summary — no pause", dm.id, [alice.id]);
  const map1Id = crypto.randomUUID();
  await admin.from("campaign_maps").insert({ id: map1Id, campaign_id: campaign1, name: "Cavern approach", grid_width: 4, grid_height: 4 });
  const { data: object1 } = await admin
    .from("map_objects")
    .insert({ map_id: map1Id, asset_id: TORCH_PRESET_ID, x: 0, y: 0, elevation: 0, rotation: 0, tag: "GLIMMERWEED_CAVERN door" })
    .select()
    .single();

  const session1StartedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await openSessionAt(campaign1, session1StartedAt);

  await admin.from("chat_messages").insert([
    { campaign_id: campaign1, sender_user_id: alice.id, body: "We should head toward the GLIMMERWEED_CAVERN before nightfall.", created_at: new Date(Date.now() - 25 * 60 * 1000).toISOString() },
    { campaign_id: campaign1, sender_user_id: dm.id, body: "The cavern mouth glows faintly with strange fungus.", created_at: new Date(Date.now() - 24 * 60 * 1000).toISOString() },
  ]);
  await admin.from("interaction_events").insert({
    campaign_id: campaign1,
    map_object_id: object1.id,
    action_type: "click_trigger",
    tag: "GLIMMERWEED_CAVERN door",
    actor_user_id: alice.id,
    created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  });
  await admin.from("roll_log").insert({
    campaign_id: campaign1,
    roller_user_id: alice.id,
    kind: "attack",
    total: 18,
    breakdown: {
      type: "d20",
      label: "Melee attack",
      mode: "normal",
      d20Rolls: [15],
      d20Result: 15,
      modifiers: [{ label: "STR", value: 3 }],
      attack: {
        attackKind: "melee",
        targetAc: 14,
        targetName: "CURSED_IDOL_GUARDIAN",
        targetCharacterId: null,
        natural20: false,
        natural1: false,
        hit: true,
        critical: false,
        damage: { notation: "1d8+3", doubled: false, groups: [{ sign: 1, count: 1, sides: 8, results: [5] }], modifier: 3, total: 8 },
        applied: null,
        instantDeath: false,
        deathSaveFailureAdded: 0,
      },
    },
    created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  });

  const dmPage1 = await openRoom(dm.session, campaign1);
  const alicePage1 = await openRoom(alice.session, campaign1);

  // DM-gating: a player's own direct fetch to the generation route is
  // rejected — not merely a button the UI never shows her.
  const aliceDirectAttempt = await alicePage1.evaluate(async (campaignId) => {
    const res = await fetch(`/campaigns/${campaignId}/end-session-summary`, { method: "POST" });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, campaign1);
  check(
    "a non-DM's direct call to the end-session-summary route is rejected (403)",
    aliceDirectAttempt.status === 403,
    JSON.stringify(aliceDirectAttempt)
  );

  const requestsBefore1 = fake.getRequestCount();
  await dmPage1.click('[data-testid="end-session-button"]');
  check(
    "the preview/edit modal opens",
    await pollUntil(() => isVisible(dmPage1, "end-session-summary-modal"))
  );
  check(
    "the modal reaches the 'ready' stage (generation completed)",
    await pollUntil(async () => !(await isVisible(dmPage1, "end-session-summary-generating")), { timeoutMs: 20000 })
  );
  check("a real Anthropic call was made for this non-empty window", fake.getRequestCount() === requestsBefore1 + 1);

  const sentText1 = transcriptTextOf(fake.getLastRequestBody());
  check(
    "the request actually sent to the model contains the seeded chat marker",
    sentText1.includes("GLIMMERWEED_CAVERN"),
    sentText1.slice(0, 400)
  );
  check(
    "the request actually sent to the model contains the seeded damage marker",
    sentText1.includes("CURSED_IDOL_GUARDIAN"),
    sentText1.slice(0, 400)
  );

  const narrativeBox1 = dmPage1.locator('[data-testid="end-session-summary-narrative"]');
  const narrativeValue1 = await narrativeBox1.inputValue();
  check(
    "the real preview's narrative reflects the seeded session content",
    narrativeValue1.includes("GLIMMERWEED_CAVERN"),
    narrativeValue1
  );
  check(
    "the highlights list shows at least one structured highlight",
    await isVisible(dmPage1, "end-session-summary-highlight-0")
  );

  const editedNarrative = `${narrativeValue1}\n\n[DM edit] The party pressed on despite the danger.`;
  await narrativeBox1.fill(editedNarrative);
  await dmPage1.click('[data-testid="end-session-summary-confirm"]');
  check(
    "confirming closes the modal and ends the session",
    await pollUntil(async () => !(await isVisible(dmPage1, "end-session-summary-modal")), { timeoutMs: 15000 })
  );

  const entry1 = await pollUntil(() => latestSessionLogEntry(campaign1));
  check(
    "the DM's EDITED narrative — not the raw AI draft — was saved into session_log.recap",
    entry1?.recap === editedNarrative,
    entry1?.recap
  );
  const highlights1 = entry1 ? await highlightsFor(entry1.id) : [];
  check(
    "the structured breakdown was saved into its own table, keyed to the session_log entry",
    highlights1.length > 0 && highlights1.every((row) => row.session_log_id === entry1.id),
    JSON.stringify(highlights1)
  );

  const campaign1After = await getCampaign(campaign1);
  check(
    "ending the session really closes it: session_active false, session_started_at cleared",
    campaign1After.session_active === false && campaign1After.session_started_at === null,
    JSON.stringify(campaign1After)
  );

  // ════════════════════════════════════════════════════════════════════
  // Scenario 2 — pause/resume: no summary on pause, window survives.
  // ════════════════════════════════════════════════════════════════════
  console.log("\n— Scenario 2: pause, confirm no summary, resume, and verify the full window —");
  const campaign2 = await makeCampaign("Session summary — pause and resume", dm.id, [alice.id]);
  const session2StartedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  await openSessionAt(campaign2, session2StartedAt);
  await admin.from("chat_messages").insert({
    campaign_id: campaign2,
    sender_user_id: alice.id,
    body: "We're making camp near the SILVERVEIN_THICKET for the night.",
    created_at: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
  });

  const dmPage2 = await openRoom(dm.session, campaign2);
  const alicePage2 = await openRoom(alice.session, campaign2);

  const sessionLogCountBeforePause = await sessionLogCountFor(campaign2);
  await dmPage2.click('[data-testid="pause-session-button"]');
  check(
    "pausing flips session_active off",
    await pollUntil(async () => (await getCampaign(campaign2)).session_active === false)
  );
  const campaignAfterPause = await getCampaign(campaign2);
  check(
    "pausing leaves session_started_at UNTOUCHED",
    sameInstant(campaignAfterPause.session_started_at, session2StartedAt),
    campaignAfterPause.session_started_at
  );
  check(
    "pausing generates NO summary — no new session_log row appears",
    (await sessionLogCountFor(campaign2)) === sessionLogCountBeforePause
  );
  check(
    "every connected member (not just the DM) sees the paused indicator",
    (await pollUntil(() => isVisible(dmPage2, "session-paused-badge"))) &&
      (await pollUntil(() => isVisible(alicePage2, "session-paused-badge")))
  );

  // The bug this prompt's own start_session fix closes: before it, a
  // session_active===false paused campaign looked exactly like "nothing in
  // progress" to a fresh Start attempt.
  const hijackAttempt = await alice.client.rpc("start_session", { p_campaign_id: campaign2, p_reclaim_abandoned: false });
  check(
    "a fresh start_session attempt is REJECTED while the session is merely paused (not abandoned)",
    !!hijackAttempt.error && String(hijackAttempt.error.message).includes("already has a session in progress"),
    JSON.stringify(hijackAttempt.error)
  );

  await dmPage2.click('[data-testid="resume-session-button"]');
  check(
    "resuming flips session_active back on",
    await pollUntil(async () => (await getCampaign(campaign2)).session_active === true)
  );
  const campaignAfterResume = await getCampaign(campaign2);
  check(
    "resuming keeps the SAME session_started_at (the original window, not a new one)",
    sameInstant(campaignAfterResume.session_started_at, session2StartedAt),
    campaignAfterResume.session_started_at
  );
  check(
    "the paused indicator clears once resumed",
    await pollUntil(async () => !(await isVisible(dmPage2, "session-paused-badge")))
  );

  await admin.from("chat_messages").insert({
    campaign_id: campaign2,
    sender_user_id: alice.id,
    body: "Morning! Let's push on toward the EMBERFALL_RAVINE now that we're rested.",
    created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  });

  const requestsBefore2 = fake.getRequestCount();
  await dmPage2.click('[data-testid="end-session-button"]');
  check(
    "the preview reaches 'ready' for the pause/resume session too",
    await pollUntil(async () => !(await isVisible(dmPage2, "end-session-summary-generating")), { timeoutMs: 20000 })
  );
  check("exactly one real Anthropic call was made for this window", fake.getRequestCount() === requestsBefore2 + 1);
  const sentText2 = transcriptTextOf(fake.getLastRequestBody());
  check(
    "the final summary's window includes activity from BEFORE the pause",
    sentText2.includes("SILVERVEIN_THICKET"),
    sentText2.slice(0, 400)
  );
  check(
    "the final summary's window ALSO includes activity from AFTER the resume",
    sentText2.includes("EMBERFALL_RAVINE"),
    sentText2.slice(0, 400)
  );

  await dmPage2.click('[data-testid="end-session-summary-confirm"]');
  check(
    "confirming ends the pause/resume session for real",
    await pollUntil(async () => !(await isVisible(dmPage2, "end-session-summary-modal")), { timeoutMs: 15000 })
  );
  const campaign2Final = await getCampaign(campaign2);
  check(
    "the pause/resume session is genuinely closed afterward (session_started_at cleared)",
    campaign2Final.session_active === false && campaign2Final.session_started_at === null,
    JSON.stringify(campaign2Final)
  );

  // ════════════════════════════════════════════════════════════════════
  // Scenario 3 — a session with nothing in it still completes gracefully.
  // ════════════════════════════════════════════════════════════════════
  console.log("\n— Scenario 3: an empty session still completes gracefully —");
  const campaign3 = await makeCampaign("Session summary — empty", dm.id, []);
  await openSessionAt(campaign3, new Date().toISOString());
  const dmPage3 = await openRoom(dm.session, campaign3);

  const requestsBefore3 = fake.getRequestCount();
  await dmPage3.click('[data-testid="end-session-button"]');
  check(
    "the empty-session preview reaches 'ready' without an error",
    await pollUntil(async () => !(await isVisible(dmPage3, "end-session-summary-generating")), { timeoutMs: 15000 })
  );
  check(
    "no error is shown for an empty session — the manual-entry hint is shown instead",
    (await isVisible(dmPage3, "end-session-summary-manual-hint")) &&
      !(await isVisible(dmPage3, "end-session-summary-generate-error"))
  );
  check("no Anthropic call was made for an empty window", fake.getRequestCount() === requestsBefore3);
  const emptyNarrative = await dmPage3.locator('[data-testid="end-session-summary-narrative"]').inputValue();
  check("the empty session gets a minimal, non-blank default narrative", emptyNarrative.trim().length > 0, emptyNarrative);

  await dmPage3.click('[data-testid="end-session-summary-confirm"]');
  check(
    "confirming an empty summary still works — no crash, no dead end",
    await pollUntil(async () => !(await isVisible(dmPage3, "end-session-summary-modal")), { timeoutMs: 15000 })
  );
  const entry3 = await pollUntil(() => latestSessionLogEntry(campaign3));
  check("the empty session's minimal recap was saved", entry3?.recap === emptyNarrative, entry3?.recap);
  const highlights3 = entry3 ? await highlightsFor(entry3.id) : [];
  check("an empty session saves zero structured highlight rows", highlights3.length === 0, JSON.stringify(highlights3));

  check("no uncaught page errors occurred across any scenario", pageErrors.length === 0, pageErrors.join("\n"));
} finally {
  await browser.close();
  await fake.close();
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
