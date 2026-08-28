#!/usr/bin/env node
// AI Backend & Admin D3/D4 verification: the common generateText() interface
// and its three provider implementations, isAiConfigured() rebuilt on a
// narrow service-role read, the non-admin access-control regression D3
// exists to prevent, and (D4's own addition) a genuine regression check that
// the two real generation routes — generate-draft AND generate-area — still
// work end to end with Anthropic as the active provider, plus one real
// switch of the active provider to prove generate-draft actually uses the
// newly-selected backend rather than a stale/cached Anthropic call.
//
// Exercises, via a REAL running Next.js server, REAL Supabase (service-role
// seeding), REAL Playwright browsers, and a REAL local Ollama instance:
//
//   1. Anthropic active (against a local fake Messages API server, the
//      same ANTHROPIC_BASE_URL end-to-end mechanism this app's own
//      src/ai/README.md documents — there is no live Anthropic key in this
//      environment): a real request through the real generate-draft route
//      hits generateText() -> generateTextAnthropic() -> the fake server,
//      and a signed-in NON-ADMIN DM sees the Generate button.
//   1b. (D4) Anthropic active, generate-area/route.ts specifically: a real
//      request through the real route hits generateMapArea() -> the
//      Anthropic SDK's own ANTHROPIC_BASE_URL-honored client -> the SAME
//      fake server (now also answering forced-tool-use requests, branching
//      on tool_choice) -> validateGeneratedArea() -> a genuine structured
//      area draft back to the caller. This is the one D3 left unverified:
//      D3's own script only ever exercised generate-draft: generate-area is
//      a materially different code path (isAnthropicConfigured, not
//      isAiConfigured; forced tool use, not plain text; a DM-owned map and
//      region instead of a bare prompt) and D4's acceptance criteria
//      requires it be checked too.
//   2. Switching active_provider to Ollama (a REAL local instance at
//      http://localhost:11434, model llama3.1:8b) with NO server restart:
//      the very next generate-draft request produces genuine local-model
//      prose and never touches the fake Anthropic server again. The
//      non-admin DM's Generate button stays correctly enabled.
//   3. An Ollama host that is configured but unreachable (wrong port)
//      fails the request FAST, not with an indefinite hang — bounded well
//      under the generation timeout.
//   4. OpenAI active with no key configured: the Generate button goes
//      UNAVAILABLE for the non-admin DM even though ANTHROPIC_API_KEY IS
//      set on this very server process — proof isAiConfigured() reflects
//      the ACTIVE provider's own readiness, not just Anthropic's env var.
//   5. OpenAI active WITH a (fake, non-functional) key: the button comes
//      back, and the seeded key never appears anywhere in the rendered
//      page or the raw HTTP response — no live OpenAI key exists in this
//      environment, so OpenAI's own request-building/response-parsing is
//      covered separately by src/ai/providers/openai.test.ts's transport-
//      injected unit tests, not exercised live here.
//
// Live vs. transport-injected, stated plainly: Ollama is tested LIVE
// end-to-end against a real local instance in every phase below. Anthropic
// is tested end-to-end against a local FAKE server (no real Anthropic key
// exists in this environment) via the documented ANTHROPIC_BASE_URL seam.
// OpenAI has no live key and no analogous end-to-end override in this
// interface, so it is exercised only via src/ai/providers/openai.test.ts's
// injected-transport unit tests (request shape, auth header, response
// parsing) — this script only proves OpenAI's READINESS SIGNAL (button
// enable/disable), never a real or fake OpenAI network call.
//
// generate-area stays Anthropic-only regardless of active_provider (see
// isAnthropicConfigured's own doc comment in src/ai/providers/anthropic.ts),
// so unlike generate-draft it is exercised ONLY under Phase 1b below — there
// is no "switch provider and re-test generate-area" phase, because switching
// the active provider away from Anthropic has no effect on it at all; that
// is the intended, audited behavior, not a gap.
//
// Seeds its one non-admin test user, campaign, and app_settings row
// directly via the service-role client — never a blind UI click-scan.
//
// Deliberately does NOT use the default APP_URL:3000 (a live server on this
// machine) — starts this worktree's own `next dev` on a dedicated, confirmed
// -free port instead.
// Usage: node scripts/db/verify-provider-abstraction.mjs

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH_DIR = "/tmp/claude-1000/-home-alfie/fda45a16-d7f7-41e9-92d5-1ed5b73bb4cb/scratchpad";
mkdirSync(SCRATCH_DIR, { recursive: true });

// A fixed, non-default port, checked against every PORT/localhost:xxxx
// literal under scripts/db/*.mjs at the time this was written (not
// reused), and confirmed free below before use, not just assumed.
const PORT = Number(process.env.PROVIDER_ABSTRACTION_PORT ?? 4187);
const APP_URL = `http://localhost:${PORT}`;

const OLLAMA_HOST_URL = process.env.PROVIDER_ABSTRACTION_OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.PROVIDER_ABSTRACTION_OLLAMA_MODEL ?? "llama3.1:8b";

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
const baseEnv = { ...fileEnv, ...process.env };
const supabaseUrl = baseEnv.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = baseEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = baseEnv.SUPABASE_SERVICE_ROLE_KEY ?? baseEnv.SERVICE_ROLE_KEY;

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const tester = createServer()
      .once("error", (err) => reject(new Error(`port ${port} is not free: ${err.message}`)))
      .once("listening", () => tester.close(() => resolve()))
      .listen(port, "127.0.0.1");
  });
}

async function healthOk() {
  return fetch(`${APP_URL}/api/health`, { cache: "no-store" }).then((res) => res.ok).catch(() => false);
}

// A tiny fake Anthropic Messages API. Both real call sites this script
// exercises against Anthropic — generateNarrativeDraft (generate-draft
// route, plain text) and generateMapArea (generate-area route, forced tool
// use) — construct their SDK client with no injected fetch and rely solely
// on ANTHROPIC_BASE_URL, so a single dev-server process can only ever point
// at ONE fake server for both. This one branches on the request shape: a
// forced-tool-use request (tool_choice.type === "tool", generateMapArea's
// own buildAreaRequest shape) gets a tool_use response; anything else falls
// back to the original plain-text response generateNarrativeDraft expects.
// Unlike scripts/db/lib/fakeAnthropic.mjs (Chat & Summary B6's own fake,
// which ONLY ever answers in the tool_use shape and is parameterized by a
// caller-supplied buildResponse), this fake needs to answer both shapes from
// the same running server, so it stays a separate, purpose-built double
// rather than a reuse.
function startFakeAnthropicTextServer() {
  let requestCount = 0;
  let lastRequestBody = null;
  let areaRequestCount = 0;
  let lastAreaRequestBody = null;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/messages") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = null;
        }

        if (body?.tool_choice?.type === "tool") {
          // generateMapArea's forced-tool-use shape (buildAreaRequest) — echo
          // back a small, deliberately-identifiable, schema-valid proposal:
          // one difficult-terrain, elevation-2 cell at (0,0), no objects (no
          // asset palette is seeded for this phase, so an empty objects
          // array is the only valid response regardless of what's asked).
          areaRequestCount += 1;
          lastAreaRequestBody = body;
          const toolName = body.tool_choice.name;
          const message = {
            id: `msg_fake_area_${areaRequestCount}`,
            type: "message",
            role: "assistant",
            model: body?.model ?? "claude-haiku-4-5-20251001",
            content: [
              {
                type: "tool_use",
                id: `toolu_fake_${areaRequestCount}`,
                name: toolName,
                input: {
                  cells: [{ x: 0, y: 0, elevation: 2, terrain: "difficult" }],
                  objects: [],
                },
              },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 60, output_tokens: 24 },
          };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(message));
          return;
        }

        requestCount += 1;
        lastRequestBody = body;
        const message = {
          id: `msg_fake_${requestCount}`,
          type: "message",
          role: "assistant",
          model: body?.model ?? "claude-haiku-4-5-20251001",
          content: [
            {
              type: "text",
              text: "A weathered dockworker forged by the fake Anthropic server, restless eyes scanning the pier.",
              citations: null,
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 18 },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no such route on the fake" } }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        getRequestCount: () => requestCount,
        getLastRequestBody: () => lastRequestBody,
        getAreaRequestCount: () => areaRequestCount,
        getLastAreaRequestBody: () => lastAreaRequestBody,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

let devServer = null;
async function startServer(env) {
  console.log(`\n--- starting this worktree's own dev server on :${PORT} ---`);
  devServer = spawn(join(rootDir, "node_modules", ".bin", "next"), ["dev", "-p", String(PORT)], {
    cwd: rootDir,
    env,
    stdio: "ignore",
    detached: true,
  });
  devServer.unref();
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${PORT} within 120s`);
}

async function stopServer() {
  if (!devServer) return;
  const pid = devServer.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  devServer = null;
}

// The @supabase/ssr cookie format — verify-admin-role.mjs / verify-admin-
// settings-ui.mjs's own identical helper.
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
  const email = `provider-abstraction-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: displayName });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

async function readAppSettings() {
  const { data, error } = await admin.from("app_settings").select("*").eq("singleton", true).maybeSingle();
  if (error) throw new Error(`reading app_settings: ${error.message}`);
  return data;
}

async function seedAppSettings(patch) {
  const full = {
    active_provider: "anthropic",
    openai_api_key: null,
    ollama_host_url: null,
    ollama_model: null,
    ...patch,
  };
  const { error } = await admin.from("app_settings").update(full).eq("singleton", true);
  if (error) throw new Error(`seeding app_settings: ${error.message}`);
}

const cleanupUserIds = [];
let browser = null;
let originalSettings = null;
let campaignId = null;
let mapId = null;
let fakeAnthropic = null;

try {
  await assertPortFree(PORT);
  originalSettings = await readAppSettings();
  fakeAnthropic = await startFakeAnthropicTextServer();

  // ANTHROPIC_API_KEY is set for the WHOLE server lifetime (a fake, non-
  // functional value — every real request is routed to the fake server
  // below via ANTHROPIC_BASE_URL). This is deliberate: it lets Phase 4
  // prove isAiConfigured() is provider-aware rather than Anthropic-env-var-
  // aware, since the env var stays "configured" throughout while the
  // active provider — and therefore the answer — changes underneath it.
  await startServer({
    ...baseEnv,
    ANTHROPIC_API_KEY: "sk-ant-fake-test-key-for-e2e",
    ANTHROPIC_BASE_URL: fakeAnthropic.url,
  });

  browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });

  const dm = await makeTestUser("dm", "Provider Abstraction DM");
  cleanupUserIds.push(dm.id);

  const { data: dmProfile } = await admin.from("profiles").select("is_admin").eq("id", dm.id).maybeSingle();
  check("the test DM is genuinely a non-admin (the regression this prompt exists to prevent is specifically about non-admins)", dmProfile?.is_admin === false, dmProfile);

  campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Provider Abstraction Test", creator: dm.id });
  await admin.from("campaign_members").insert([{ campaign_id: campaignId, user_id: dm.id, role: "dm" }]);

  // A small map for Phase 1b's generate-area/route.ts exercise — seeded
  // directly via the service-role client (never a blind UI click-scan), same
  // as verify-map-grid-growth.mjs's own pattern. campaign_maps cascades on
  // campaign delete (0014), so no separate cleanup is needed.
  mapId = crypto.randomUUID();
  await admin
    .from("campaign_maps")
    .insert({ id: mapId, campaign_id: campaignId, name: "Provider Abstraction Test Map", grid_width: 5, grid_height: 5 });

  const cookieHeader = sessionCookies(dm.session).map((c) => `${c.name}=${c.value}`).join("; ");

  async function fetchGenerateDraft(prompt) {
    return fetch(`${APP_URL}/campaigns/${campaignId}/generate-draft`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ prompt, kind: "npc" }),
    });
  }

  async function fetchGenerateArea(prompt, region) {
    return fetch(`${APP_URL}/campaigns/${campaignId}/maps/${mapId}/generate-area`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ prompt, ...region }),
    });
  }

  async function openNpcCreateForm() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies(sessionCookies(dm.session));
    const page = await context.newPage();
    await page.goto(`${APP_URL}/campaigns/${campaignId}/npcs`, { waitUntil: "load" });
    await page.click('[data-testid="create-npc-button"]');
    return { context, page };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1 — Anthropic active (against the local fake server).
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n--- Phase 1: Anthropic active ---");
  await seedAppSettings({ active_provider: "anthropic" });

  {
    const { context, page } = await openNpcCreateForm();
    check(
      "Anthropic active: the non-admin DM's Generate button is enabled",
      (await page.$('[data-testid="generate-npc-draft-button"]')) !== null
    );
    await context.close();
  }

  const beforeAnthropicCount = fakeAnthropic.getRequestCount();
  const anthropicRes = await fetchGenerateDraft("a suspicious dockworker who's secretly a smuggler");
  const anthropicBody = await anthropicRes.json().catch(() => null);
  check("generate-draft succeeds when Anthropic is the active provider", anthropicRes.ok && anthropicBody?.ok === true, anthropicBody);
  check(
    "the real request actually reached the fake Anthropic server — proves generateNarrativeDraft -> generateText -> generateTextAnthropic wiring is real, not a stub",
    fakeAnthropic.getRequestCount() === beforeAnthropicCount + 1
  );
  check(
    "the request used ANTHROPIC_TEXT_MODEL (claude-haiku-4-5-20251001)",
    fakeAnthropic.getLastRequestBody()?.model === "claude-haiku-4-5-20251001",
    fakeAnthropic.getLastRequestBody()
  );
  check(
    "the returned draft is genuinely the fake Anthropic server's text (round-tripped correctly)",
    typeof anthropicBody?.draft === "string" && anthropicBody.draft.includes("fake Anthropic server"),
    anthropicBody
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1b (D4) — generate-area/route.ts end to end, Anthropic active.
  // This route is Anthropic-only regardless of active_provider (gated on
  // isAnthropicConfigured, not isAiConfigured — see providers/anthropic.ts),
  // so active_provider is left exactly as Phase 1 set it. Proves the whole
  // chain is real: route -> generateMapArea -> Anthropic SDK (ANTHROPIC_
  // BASE_URL) -> the fake server's tool_use branch -> validateGeneratedArea
  // -> a genuine structured draft handed back to the caller.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n--- Phase 1b: generate-area/route.ts, Anthropic active ---");

  const beforeAreaCount = fakeAnthropic.getAreaRequestCount();
  const areaRes = await fetchGenerateArea("a cracked, difficult patch of ground", {
    x: 0,
    y: 0,
    width: 3,
    height: 3,
  });
  const areaBody = await areaRes.json().catch(() => null);
  check("generate-area succeeds when Anthropic is the active provider", areaRes.ok && areaBody?.ok === true, areaBody);
  check(
    "the real request actually reached the fake Anthropic server's tool-use branch — proves generateMapArea's Anthropic wiring is real, not a stub",
    fakeAnthropic.getAreaRequestCount() === beforeAreaCount + 1
  );
  check(
    "the request used a forced tool_choice naming propose_map_area (generateMapArea's own structured-output contract)",
    fakeAnthropic.getLastAreaRequestBody()?.tool_choice?.type === "tool" &&
      fakeAnthropic.getLastAreaRequestBody()?.tool_choice?.name === "propose_map_area",
    fakeAnthropic.getLastAreaRequestBody()?.tool_choice
  );
  check(
    "the request used the same MODEL as generate-draft (claude-haiku-4-5-20251001)",
    fakeAnthropic.getLastAreaRequestBody()?.model === "claude-haiku-4-5-20251001",
    fakeAnthropic.getLastAreaRequestBody()?.model
  );
  check(
    "the returned area is genuinely the fake server's structured draft, validated and round-tripped correctly",
    areaBody?.area?.cells?.length === 1 &&
      areaBody.area.cells[0].x === 0 &&
      areaBody.area.cells[0].y === 0 &&
      areaBody.area.cells[0].elevation === 2 &&
      areaBody.area.cells[0].terrain === "difficult" &&
      Array.isArray(areaBody.area.objects) &&
      areaBody.area.objects.length === 0,
    areaBody
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2 — switch to Ollama (a REAL local instance), no server
  // restart. Proves: (a) switching active_provider changes which backend
  // generateText() uses on the very next call, (b) a real Ollama
  // generation completes end to end, (c) the reachability check's short
  // timeout does not kill a real, slower generation call.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n--- Phase 2: switch to Ollama (real local instance), no restart ---");
  await seedAppSettings({ active_provider: "ollama", ollama_host_url: OLLAMA_HOST_URL, ollama_model: OLLAMA_MODEL });

  {
    const { context, page } = await openNpcCreateForm();
    check(
      "Ollama active + fully configured: the non-admin DM's Generate button is enabled",
      (await page.$('[data-testid="generate-npc-draft-button"]')) !== null
    );
    await context.close();
  }

  const beforeAnthropicCount2 = fakeAnthropic.getRequestCount();
  const ollamaStart = Date.now();
  // Deliberately asks for a long, detailed answer: MAX_DRAFT_TOKENS (1024)
  // is the real cap either way, but a short natural stopping point would
  // make the "this took genuinely tens of seconds" observation depend on
  // luck. Pushing toward the token cap makes a real multi-second local
  // generation reliable to observe without fabricating anything — the
  // deterministic proof that the SHORT reachability timeout specifically
  // cannot kill this call lives in providers/ollama.test.ts's fake-timer
  // tests; this is corroborating live evidence on real hardware.
  const ollamaRes = await fetchGenerateDraft(
    "a suspicious dockworker who's secretly a smuggler — write the longest, most " +
      "richly detailed description you can, covering appearance, mannerisms, voice, " +
      "history, and secrets at length"
  );
  const ollamaElapsedMs = Date.now() - ollamaStart;
  const ollamaBody = await ollamaRes.json().catch(() => null);
  console.log(`  (live Ollama generate-draft round trip took ${ollamaElapsedMs}ms)`);
  check("generate-draft succeeds when Ollama is the active provider (real local instance)", ollamaRes.ok && ollamaBody?.ok === true, ollamaBody);
  check(
    "the draft is real generated prose from Ollama, not the fake Anthropic server's canned text",
    typeof ollamaBody?.draft === "string" && ollamaBody.draft.length > 40 && !ollamaBody.draft.includes("fake Anthropic server"),
    ollamaBody
  );
  check(
    "switching the active provider did NOT hit Anthropic again — a genuinely different backend actually ran",
    fakeAnthropic.getRequestCount() === beforeAnthropicCount2
  );
  check(
    "the real generation completed well under the 180s generation timeout (not killed, not hung)",
    ollamaElapsedMs < 170_000,
    { ollamaElapsedMs }
  );
  if (ollamaElapsedMs > 5_000) {
    console.log(
      `  PASS  (informational) this real generation took ${ollamaElapsedMs}ms — longer than the 5s reachability ` +
        "timeout — and still succeeded, live confirmation the two timeouts are genuinely separate"
    );
  } else {
    console.log(
      `  (informational) this real generation happened to finish in ${ollamaElapsedMs}ms, under the reachability ` +
        "timeout on this run — the deterministic proof that the short timeout can never apply to this call " +
        "either way is providers/ollama.test.ts's fake-timer test suite"
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3 — Ollama configured but pointed at a host nothing is
  // listening on: fails fast with a clear, specific error, not an
  // indefinite hang.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n--- Phase 3: Ollama misconfigured (unreachable host) ---");
  await seedAppSettings({ active_provider: "ollama", ollama_host_url: "http://localhost:19999", ollama_model: OLLAMA_MODEL });

  {
    const { context, page } = await openNpcCreateForm();
    check(
      "Ollama active with host+model both PRESENT (even though wrong): isAiConfigured() is presence-only, so the button is still enabled — the failure surfaces on generation attempt, not on page load",
      (await page.$('[data-testid="generate-npc-draft-button"]')) !== null
    );
    await context.close();
  }

  const unreachableStart = Date.now();
  const unreachableRes = await fetchGenerateDraft("a dockworker");
  const unreachableElapsedMs = Date.now() - unreachableStart;
  const unreachableBody = await unreachableRes.json().catch(() => null);
  console.log(`  (unreachable-host request failed in ${unreachableElapsedMs}ms)`);
  check("an unreachable Ollama host fails the request rather than succeeding", !unreachableRes.ok || unreachableBody?.ok === false, unreachableBody);
  check(
    "an unreachable Ollama host fails FAST — comfortably bounded by the ~5s reachability timeout, not the 180s generation timeout",
    unreachableElapsedMs < 15_000,
    { unreachableElapsedMs }
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 4 — OpenAI active, no key: the sharpest proof that
  // isAiConfigured() reflects the ACTIVE provider's own readiness, not
  // just Anthropic's env var (which IS set on this very server process
  // throughout this entire script).
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n--- Phase 4: OpenAI active, no key configured ---");
  await seedAppSettings({ active_provider: "openai", openai_api_key: null });

  {
    const { context, page } = await openNpcCreateForm();
    check(
      "OpenAI active with NO key: Generate is UNAVAILABLE even though ANTHROPIC_API_KEY IS set on the server — proves provider-aware readiness, not just an Anthropic env-var check",
      (await page.$('[data-testid="generate-npc-draft-unavailable"]')) !== null
    );
    check(
      "...and the enabled-state button is absent",
      (await page.$('[data-testid="generate-npc-draft-button"]')) === null
    );
    await context.close();
  }

  const openaiNoKeyRes = await fetchGenerateDraft("a dockworker");
  const openaiNoKeyBody = await openaiNoKeyRes.json().catch(() => null);
  check(
    "the route itself also rejects generation when OpenAI is active with no key (defense in depth below the page-level gate)",
    openaiNoKeyRes.status === 503 || openaiNoKeyBody?.ok === false,
    { status: openaiNoKeyRes.status, body: openaiNoKeyBody }
  );

  // ═══════════════════════════════════════════════════════════════════
  // Phase 5 — OpenAI active WITH a key: readiness flips back to true, and
  // the key never leaks anywhere — page render, raw HTTP response, or (see
  // src/ai/activeProvider.test.ts) the isAiConfigured() return value
  // itself. No live OpenAI key exists in this environment, so no real (or
  // fake-server) generation call is attempted here — see this file's own
  // header comment.
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n--- Phase 5: OpenAI active with a (fake) key — readiness + secrecy only ---");
  const seededOpenaiKey = `sk-test-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await seedAppSettings({ active_provider: "openai", openai_api_key: seededOpenaiKey });

  {
    const { context, page } = await openNpcCreateForm();
    check(
      "OpenAI active WITH a key: the Generate button is enabled again",
      (await page.$('[data-testid="generate-npc-draft-button"]')) !== null
    );
    const rawDom = await page.content();
    check("the seeded OpenAI key never appears anywhere in the rendered page's DOM", !rawDom.includes(seededOpenaiKey));
    await context.close();
  }

  const rawFetchRes = await fetch(`${APP_URL}/campaigns/${campaignId}/npcs`, { headers: { Cookie: cookieHeader } });
  const rawFetchBody = await rawFetchRes.text();
  check(
    "the seeded OpenAI key never appears anywhere in the raw HTTP response either — not just 'the UI doesn't show it'",
    !rawFetchBody.includes(seededOpenaiKey)
  );

  // ═══════════════════════════════════════════════════════════════════
  // Defense in depth: a non-admin's own direct authenticated read of
  // app_settings is still rejected by RLS regardless of this whole
  // provider-switching story working through isAiConfigured()'s narrow
  // service-role exception — re-confirms D1's own RLS is untouched by D3.
  // ═══════════════════════════════════════════════════════════════════
  const nonAdminRead = await dm.client.from("app_settings").select("*").eq("singleton", true);
  check(
    "the non-admin DM's own direct API read of app_settings is still rejected by RLS (D3's service-role exception is server-side-only and never exposed to the client)",
    !nonAdminRead.error && Array.isArray(nonAdminRead.data) && nonAdminRead.data.length === 0,
    nonAdminRead
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopServer();
  if (fakeAnthropic) await fakeAnthropic.close().catch(() => {});
  for (const id of cleanupUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  if (campaignId) {
    try {
      await admin.from("campaigns").delete().eq("id", campaignId);
    } catch {
      // best-effort cleanup
    }
  }
  // Restore app_settings to whatever it was before this script ran — this
  // Supabase instance is shared with other work.
  if (originalSettings) {
    await admin
      .from("app_settings")
      .update({
        active_provider: originalSettings.active_provider,
        openai_api_key: originalSettings.openai_api_key,
        ollama_host_url: originalSettings.ollama_host_url,
        ollama_model: originalSettings.ollama_model,
      })
      .eq("singleton", true)
      .then(
        () => {},
        (err) => console.error("warning: failed to restore app_settings:", err.message)
      );
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
