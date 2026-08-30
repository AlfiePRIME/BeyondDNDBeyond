#!/usr/bin/env node
// Name Labels verification: "can we please add username above the
// characters in their chairs so people know who is who, users should be
// able to decide the size font and colour of their name in the account
// page" (the project owner's own follow-up, explicitly narrowing an earlier
// looser "apply effects... or even css/html" idea down to just size and
// color — free-form markup was ruled out as a real stored-XSS vector and is
// NOT part of this feature).
//
// What shipped:
//   - profiles.name_label_color / profiles.name_label_size (migration
//     0100_name_label.sql) — two dedicated, individually-CHECK-validated
//     columns, the default_pawn_color (0079) precedent, not a jsonb blob.
//   - src/scene-3d/SeatNameLabel.tsx — an always-visible <Html> label
//     mounted as a direct child of GameTableScene's own TableSeat group,
//     for EVERY seated member (DM's throne included), showing that
//     member's display name in their own resolved color/size.
//   - src/app/account/NameLabelPicker.tsx — the account-page control (the
//     PawnColorPicker.tsx shape: preset swatches + native color input,
//     saves immediately) plus a Select dropdown for the closed 3-step size
//     preset (small/medium/large).
//
// IMPORTANT — like verify-dm-tray-drag.mjs before it, this script was
// authored and run BEFORE migration 0100_name_label.sql was applied to the
// real database (the task this was built under explicitly forbids an agent
// from running its own migration — that is left for a human to review and
// apply via `node scripts/db/migrate.mjs`). Phase 0 below probes the real
// schema for the two new columns and branches accordingly — the
// verify-token-rotation.mjs/verify-dm-tray-drag.mjs "probe first,
// blocked-not-failed" pattern, reused verbatim in shape:
//   - Missing (expected on first run): every check that doesn't actually
//     need the column still runs for real — the always-visible label above
//     EVERY seat (DM + player) with correct display-name text, the sane
//     default color/size (byte-identical rendered output whether or not the
//     columns exist yet, since an untouched profile's resolved value is the
//     SAME default either way — see page.tsx's own
//     `profile?.name_label_color ?? DEFAULT_NAME_LABEL_COLOR` fallback,
//     which treats a genuinely-missing column exactly like a present-but-
//     never-customized one), a real screenshot, and the account-page
//     controls being reachable. The write-path checks that genuinely need
//     the column (a real customization persisting to the DB, a live
//     cross-client sync of a REAL saved value, surviving reload) are
//     reported BLOCKED, not FAIL — and the one write attempt that DOES need
//     the column is proven to fail SAFE (a visible "Couldn't save..."
//     error, zero DB row change), never a silent no-op or a crash.
//   - Present (re-run after a human applies 0100): every check below runs
//     for real, including the live round-trip DB assertions.
//
// Covers:
//   1. Sane defaults: a fresh, never-customized profile's label renders in
//      the spec'd default color (#ede0ff) at the default 'medium' size
//      (16px) — checked both at the DB layer (when the column exists) and
//      via the real rendered computed style.
//   2. Every seated member gets a label, DM included: the DM's own throne
//      and a player's chair BOTH show an always-visible label with the
//      correct display name — a real screenshot proves both are visible at
//      once (Free camera + a pure zoom-out dolly, the verify-map-art-
//      rendering.mjs precedent for avoiding the documented seat-geometry
//      clipping risk a rotate would risk).
//   3. Real two-client live sync: the DM's own already-open Game Room page
//      (never reloaded) reflects the player's chosen color/size the moment
//      the player changes them via the REAL /account page UI.
//   4. The account-page controls are reachable and persist correctly
//      (save, reload, still there).
//   5. RLS, not just UI: a non-owner cannot set another user's own
//      name_label_color/name_label_size — the setDefaultPawnColor/
//      verify-pawn-customization.mjs precedent, re-run for these two new
//      columns.
//
// Usage: node scripts/db/verify-name-labels.mjs
//        NAME_LABEL_APP_PORT=4501 node scripts/db/verify-name-labels.mjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { GPU_LAUNCH_ARGS } from "./lib/browser.mjs";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = Number(process.env.NAME_LABEL_APP_PORT ?? 4501);
const APP_URL = `http://localhost:${APP_PORT}`;
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

if (!supabaseUrl || !anonKey || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

let failures = 0;
let blocked = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}
function skipBlocked(label, reason) {
  console.log(`BLOCKED  ${label} — ${reason}`);
  blocked++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOk() {
  return fetch(`${APP_URL}/api/health`, { cache: "no-store" }).then((res) => res.ok).catch(() => false);
}

let devServer = null;
async function ensureDevServer() {
  if (await healthOk()) return;
  console.log(`dev server not running on :${APP_PORT} — starting this checkout's own…`);
  devServer = spawn("yarn", ["dev", "-p", String(APP_PORT)], { cwd: rootDir, stdio: "ignore", detached: true });
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (await healthOk()) return;
  }
  throw new Error(`dev server did not become healthy on :${APP_PORT} within 120s`);
}

// The @supabase/ssr cookie format — verify-monster-template-overrides.mjs's
// own established pattern for this app.
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

// Seeds test-setup state directly via the service-role client — never a
// blind UI click-scan (this project's own established lesson).
async function makeTestUser(label, displayName) {
  const email = `name-label-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: displayName });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, email, client, session: signIn.session };
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// Every DraggablePanel this page can mount (GameRoom.tsx's own panelId
// list) — collapsed before a "looks right" screenshot so the floating UI
// doesn't cover the 3D table, the verify-map-art-rendering.mjs precedent
// exactly.
const ALL_PANEL_IDS = [
  "map",
  "liveObjects",
  "tokens",
  "combat",
  "hp",
  "opportunityAttack",
  "quickActions",
  "chatLog",
  "diceLog",
  "diceTray",
  "handout",
];

async function collapseAllPanels(page) {
  for (const panelId of ALL_PANEL_IDS) {
    const panel = page.locator(`[data-testid="draggable-panel-${panelId}"]`);
    if ((await panel.count()) === 0) continue;
    const toggle = page.locator(`[data-testid="collapse-toggle-${panelId}"]`);
    const label = await toggle.getAttribute("aria-label").catch(() => null);
    if (label === "Collapse panel") await toggle.click().catch(() => {});
  }
  await sleep(200);
}

/** Reads a seated member's own real, rendered SeatNameLabel — a genuine DOM
 * node (drei's <Html>, unlike WebGL geometry), so this is read directly via
 * textContent/getComputedStyle, no hidden debug-mirror div needed at all
 * (the ChatBubble.tsx precedent this component itself follows). Null if the
 * label isn't in the DOM yet (a null/empty display name, or the page hasn't
 * finished its first frame). */
async function readLabel(page, userId) {
  const selector = `[data-testid="seat-name-label-${userId}"]`;
  if ((await page.locator(selector).count()) === 0) return null;
  const [text, color, fontSize] = await Promise.all([
    page.textContent(selector),
    page.$eval(selector, (el) => getComputedStyle(el).color),
    page.$eval(selector, (el) => getComputedStyle(el).fontSize),
  ]);
  return { text, color, fontSize };
}

async function pollLabel(page, userId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readLabel(page, userId);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  return last;
}

/** Free camera, then a pure zoom-out dolly — no rotation at all, the
 * verify-map-art-rendering.mjs angleCameraOverTable precedent (that
 * script's own doc comment: a calibration pass found that ANY left-drag
 * rotation on this scene swings the orbit camera into an unusable close-up
 * of nearby seat geometry; a pure, un-rotated zoom carries none of that
 * risk). Zooming OUT (not in, unlike that script's own use case) from the
 * default orbit vantage — which starts at this viewer's own SEATED camera
 * position, itself INSET from their own chair toward the table center
 * (seating.ts's CAMERA_FORWARD_INSET) — dollies the camera back out past
 * that inset and toward/through the viewer's own chair, widening the
 * covered area enough to bring BOTH the viewer's own seat (now near the
 * camera) and the far side of the table (any other seat, DM's throne
 * included) into the same frame at once.
 */
async function zoomOutOrbit(page, { zoomTicks = 14 } = {}) {
  await page.click('[data-testid="camera-mode-toggle"]');
  await sleep(300);
  const box = await page.locator("canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < zoomTicks; i++) {
    await page.mouse.wheel(0, 120);
    await sleep(15);
  }
  await sleep(400);
}

const DEFAULT_COLOR_HEX = "#ede0ff";
const DEFAULT_COLOR_RGB = hexToRgb(DEFAULT_COLOR_HEX);
const DEFAULT_SIZE_PX = "16px"; // NAME_LABEL_FONT_SIZE_PX.medium
const CHANGED_COLOR_HEX = "#3399ff";
const CHANGED_COLOR_RGB = hexToRgb(CHANGED_COLOR_HEX);
const CHANGED_SIZE_PX = "21px"; // NAME_LABEL_FONT_SIZE_PX.large

await ensureDevServer();

const dm = await makeTestUser("dm", "Dungeon Master Vex");
const player = await makeTestUser("player", "Player Wick");
const browser = await chromium.launch({ args: GPU_LAUNCH_ARGS });
const campaignId = crypto.randomUUID();

try {
  // ═══════════════════════════════════════════════════════════════════
  // Phase 0: does profiles.name_label_color/name_label_size exist yet?
  // ═══════════════════════════════════════════════════════════════════
  const probe = await admin.from("profiles").select("name_label_color, name_label_size").limit(1);
  const columnsExist = !probe.error;
  if (columnsExist) {
    console.log(
      "Phase 0: profiles.name_label_color/name_label_size EXIST — migration 0100 has been applied. Running full live checks.\n"
    );
  } else {
    console.log(
      `Phase 0: profiles.name_label_color/name_label_size do NOT exist yet (${probe.error?.message ?? "unknown error"}).\n` +
        "Running every check that renders correctly with today's schema (the always-visible label, defaults, both\n" +
        "seated members, the screenshot, account-page reachability). Every check that genuinely needs the column\n" +
        "is reported as BLOCKED, not FAIL — the real write attempt is also proven to fail SAFE.\n"
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Seed: one campaign, DM + one player, no live map needed at all —
  // name labels render above every seat regardless of what's on the table.
  // ═══════════════════════════════════════════════════════════════════
  await admin.from("campaigns").insert({ id: campaignId, name: "Name Label Test", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);

  if (columnsExist) {
    const { data: freshDmProfile } = await admin
      .from("profiles")
      .select("name_label_color, name_label_size")
      .eq("id", dm.id)
      .single();
    check(
      "a fresh, never-customized profile defaults to the sane readable color (#ede0ff) at the DB layer",
      freshDmProfile?.name_label_color === DEFAULT_COLOR_HEX,
      freshDmProfile
    );
    check(
      "a fresh, never-customized profile defaults to 'medium' size at the DB layer",
      freshDmProfile?.name_label_size === "medium",
      freshDmProfile
    );
  } else {
    skipBlocked("fresh-profile DB column defaults", "profiles.name_label_color/name_label_size do not exist yet");
  }

  // ═══════════════════════════════════════════════════════════════════
  // The DM's own already-open Game Room page — used both for the initial
  // "every seat gets a label" proof AND, later, as the live cross-client
  // observer of the player's own account-page change (never reloaded).
  // ═══════════════════════════════════════════════════════════════════
  const dmContext = await browser.newContext();
  await dmContext.addCookies(sessionCookies(dm.session));
  const dmPage = await dmContext.newPage();
  await dmPage.goto(`${APP_URL}/campaigns/${campaignId}/room`);
  await dmPage.waitForSelector("canvas", { timeout: 30000 });
  await collapseAllPanels(dmPage);

  const playerLabelInitial = await pollLabel(dmPage, player.id, (l) => l.text === "Player Wick");
  check(
    "the player's own seat renders an always-visible name label with their real display name",
    playerLabelInitial?.text === "Player Wick",
    playerLabelInitial
  );
  check(
    "a never-customized member's label uses the sane default color (#ede0ff)",
    playerLabelInitial?.color === DEFAULT_COLOR_RGB,
    playerLabelInitial
  );
  check(
    "a never-customized member's label uses the default 'medium' font size (16px)",
    playerLabelInitial?.fontSize === DEFAULT_SIZE_PX,
    playerLabelInitial
  );

  // The DM's OWN seat (their throne) also gets a label — "who is who"
  // includes the DM. Read here on the DM's OWN client: the label is a
  // plain DOM node regardless of whether it's currently inside this
  // client's own camera frustum (that only affects visibility, not
  // presence/attributes), so this assertion doesn't depend on camera mode.
  const dmLabelInitial = await pollLabel(dmPage, dm.id, (l) => l.text === "Dungeon Master Vex");
  check(
    "the DM's own throne ALSO renders an always-visible name label with the DM's real display name",
    dmLabelInitial?.text === "Dungeon Master Vex",
    dmLabelInitial
  );

  // ═══════════════════════════════════════════════════════════════════
  // Real screenshot: Free camera + pure zoom-out dolly brings BOTH the
  // DM's own seat and the player's seat into the same frame at once —
  // see zoomOutOrbit's own doc comment for why a pure dolly (no rotation)
  // is the safe way to get this shot on this scene.
  // ═══════════════════════════════════════════════════════════════════
  await zoomOutOrbit(dmPage);
  const screenshotPath = join(SCREENSHOT_DIR, "name-labels-dm-and-player.png");
  await dmPage.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved: ${screenshotPath}`);
  // A real on-screen-bounds check, not a bare isVisible(): drei's <Html>
  // (unlike a plain DOM element) never hides itself when its projected
  // position lands outside the canvas or behind the camera — DmBookProp.tsx
  // computes its OWN "behind camera" check for exactly this reason. Only a
  // label whose actual bounding box falls WITHIN the canvas's own visible
  // rect counts as "really on screen", the same thing a human looking at
  // the screenshot would judge.
  const canvasBox = await dmPage.locator("canvas").boundingBox();
  function withinCanvas(box) {
    if (!box || !canvasBox) return false;
    return (
      box.x >= canvasBox.x &&
      box.y >= canvasBox.y &&
      box.x + box.width <= canvasBox.x + canvasBox.width &&
      box.y + box.height <= canvasBox.y + canvasBox.height
    );
  }
  const dmLabelBox = await dmPage.locator(`[data-testid="seat-name-label-${dm.id}"]`).boundingBox();
  const playerLabelBox = await dmPage.locator(`[data-testid="seat-name-label-${player.id}"]`).boundingBox();
  check(
    "both the DM's own and the player's own name labels are simultaneously within the visible canvas frame at once (see the saved screenshot for visual confirmation)",
    withinCanvas(dmLabelBox) && withinCanvas(playerLabelBox),
    { dmLabelBox, playerLabelBox, canvasBox, screenshotPath }
  );

  // ═══════════════════════════════════════════════════════════════════
  // RLS, not just UI: a non-owner (the DM's own session) cannot set the
  // player's own name-label color/size — the setDefaultPawnColor/
  // verify-pawn-customization.mjs precedent, re-run for these two columns.
  // ═══════════════════════════════════════════════════════════════════
  if (columnsExist) {
    const hijackAttempt = await dm.client
      .from("profiles")
      .update({ name_label_color: "#000000", name_label_size: "large" })
      .eq("id", player.id)
      .select();
    const { data: afterHijack } = await admin
      .from("profiles")
      .select("name_label_color, name_label_size")
      .eq("id", player.id)
      .single();
    check(
      "a non-owner (the DM) cannot set the player's own name-label color/size (RLS)",
      (hijackAttempt.data?.length ?? 0) === 0 &&
        afterHijack?.name_label_color === DEFAULT_COLOR_HEX &&
        afterHijack?.name_label_size === "medium",
      { returned: hijackAttempt.data, afterHijack }
    );
  } else {
    skipBlocked("non-owner RLS write check", "profiles.name_label_color/name_label_size do not exist yet");
  }

  // ═══════════════════════════════════════════════════════════════════
  // The real /account page UI: reachability, then a real customization —
  // via the player's OWN separate context/session, exactly the
  // verify-pawn-customization.mjs "REAL /account page UI, not a direct
  // DB write" shape.
  // ═══════════════════════════════════════════════════════════════════
  const playerAccountContext = await browser.newContext();
  await playerAccountContext.addCookies(sessionCookies(player.session));
  const playerAccountPage = await playerAccountContext.newPage();
  await playerAccountPage.goto(`${APP_URL}/account`);

  const colorInput = playerAccountPage.getByTestId("name-label-color-custom-input");
  const sizeSelect = playerAccountPage.getByTestId("name-label-size-select");
  await colorInput.waitFor({ state: "attached", timeout: 20000 });
  await sizeSelect.waitFor({ state: "attached", timeout: 20000 });
  check("the account page's name-label color control (custom color input) is reachable", await colorInput.isVisible());
  check("the account page's name-label size control (Select dropdown) is reachable", await sizeSelect.isVisible());
  const sizeOptionValues = await sizeSelect.locator("option").evaluateAll((opts) => opts.map((o) => o.value));
  check(
    "the size control offers exactly the 3 spec'd presets (small/medium/large), no free numeric input",
    JSON.stringify(sizeOptionValues) === JSON.stringify(["small", "medium", "large"]),
    sizeOptionValues
  );
  check(
    "the size control starts on 'medium' — this profile's own never-customized default",
    (await sizeSelect.inputValue()) === "medium"
  );

  // A preset swatch is reachable and clickable too (PawnColorPicker.tsx's
  // own reused PRESET_COLORS row) — a cheap reachability check; the real
  // persisted-value proof below uses the free-form custom input, which
  // covers strictly more ground (any hex, not just a preset).
  const firstSwatch = playerAccountPage.getByTestId("name-label-color-swatch").first();
  await firstSwatch.click();
  await sleep(300);
  check("clicking a preset color swatch visibly selects it", (await firstSwatch.getAttribute("data-selected")) === "true");

  // The real customization: a genuinely non-preset hex via the native
  // color input, plus a change to the 'large' size preset.
  await colorInput.fill(CHANGED_COLOR_HEX);
  await sleep(400);
  if (columnsExist) {
    await playerAccountPage.getByTestId("name-label-saved").waitFor({ state: "visible", timeout: 10000 });
    const { data: rowAfterColor } = await admin
      .from("profiles")
      .select("name_label_color")
      .eq("id", player.id)
      .single();
    check(
      "the real /account page UI persisted the new color to the DB",
      rowAfterColor?.name_label_color?.toLowerCase() === CHANGED_COLOR_HEX,
      rowAfterColor
    );
  } else {
    const alert = playerAccountPage.locator('[role="alert"]').first();
    await alert.waitFor({ state: "visible", timeout: 10000 });
    const alertText = await alert.textContent();
    check(
      "BLOCKED-BUT-FAILS-SAFE: with the column missing, the real /account UI shows a visible error, not a silent no-op or a crash",
      /couldn.?t save/i.test(alertText ?? ""),
      alertText
    );
    skipBlocked("account-page color change persisting to the DB", "profiles.name_label_color does not exist yet");
  }

  await sizeSelect.selectOption("large");
  await sleep(400);
  if (columnsExist) {
    await playerAccountPage.getByTestId("name-label-saved").waitFor({ state: "visible", timeout: 10000 });
    const { data: rowAfterSize } = await admin.from("profiles").select("name_label_size").eq("id", player.id).single();
    check(
      "the real /account page UI persisted the new size to the DB",
      rowAfterSize?.name_label_size === "large",
      rowAfterSize
    );
  } else {
    skipBlocked("account-page size change persisting to the DB", "profiles.name_label_size does not exist yet");
  }

  // ═══════════════════════════════════════════════════════════════════
  // THE LIVE PROOF: the DM's SAME already-open Game Room page (never
  // reloaded since it was first opened) picks up the player's brand-new
  // color/size on the SAME rendered label — a live postgres_changes feed
  // (subscribeToProfileChanges), not a page reload or a broadcast the DM
  // had to be actively watching for.
  // ═══════════════════════════════════════════════════════════════════
  if (columnsExist) {
    const dmObservedChange = await pollLabel(
      dmPage,
      player.id,
      (l) => l.color === CHANGED_COLOR_RGB && l.fontSize === CHANGED_SIZE_PX
    );
    check(
      "THE LIVE PROOF: the DM's own already-open page (never reloaded) reflects the player's NEW color AND size on the player's own label",
      dmObservedChange?.color === CHANGED_COLOR_RGB && dmObservedChange?.fontSize === CHANGED_SIZE_PX,
      dmObservedChange
    );
    // A second real screenshot, now showing the VISUAL result of the
    // customization side by side with the DM's still-default label — the
    // project owner's own design constraint that legibility against this
    // scene's dark, moody lighting be checked via a real screenshot, not
    // just code review.
    const afterScreenshotPath = join(SCREENSHOT_DIR, "name-labels-after-customization.png");
    await dmPage.screenshot({ path: afterScreenshotPath });
    console.log(`Screenshot saved: ${afterScreenshotPath}`);
    // Zero regression, inline: the DM's OWN label is completely unaffected
    // by the player's own account-page change.
    const dmLabelUnaffected = await readLabel(dmPage, dm.id);
    check(
      "zero regression: the DM's own label is unaffected by the player's own account-page change",
      dmLabelUnaffected?.color === DEFAULT_COLOR_RGB && dmLabelUnaffected?.fontSize === DEFAULT_SIZE_PX,
      dmLabelUnaffected
    );
  } else {
    skipBlocked(
      "live cross-client sync of the player's new color/size",
      "the write itself never reached the DB (column missing), so no postgres_changes event was ever emitted to observe"
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Persistence: reload the account page — the saved choice (or, in the
  // blocked case, the still-unsaved default) is exactly what the controls
  // show afterward.
  // ═══════════════════════════════════════════════════════════════════
  await playerAccountPage.reload();
  await playerAccountPage.getByTestId("name-label-color-custom-input").waitFor({ state: "attached", timeout: 20000 });
  const colorAfterReload = await playerAccountPage.getByTestId("name-label-color-custom-input").inputValue();
  const sizeAfterReload = await playerAccountPage.getByTestId("name-label-size-select").inputValue();
  if (columnsExist) {
    check(
      "the account page's color control still shows the saved custom color after a reload",
      colorAfterReload.toLowerCase() === CHANGED_COLOR_HEX,
      colorAfterReload
    );
    check(
      "the account page's size control still shows the saved 'large' size after a reload",
      sizeAfterReload === "large",
      sizeAfterReload
    );
  } else {
    // Nothing was actually persisted (the write failed safe, above) — a
    // reload correctly shows the profile's own real, unsaved default
    // again, not a phantom client-side-only value.
    check(
      "BLOCKED-BUT-CONSISTENT: with nothing persisted, a reload correctly reverts to the real (unsaved) default color",
      colorAfterReload.toLowerCase() === DEFAULT_COLOR_HEX,
      colorAfterReload
    );
    check(
      "BLOCKED-BUT-CONSISTENT: with nothing persisted, a reload correctly reverts to the real (unsaved) default size",
      sizeAfterReload === "medium",
      sizeAfterReload
    );
  }

  await playerAccountContext.close();
  await dmContext.close();

  console.log(
    failures === 0
      ? `\nAll runnable checks passed.${blocked > 0 ? ` ${blocked} check(s) BLOCKED pending migration 0100.` : ""}`
      : `\n${failures} check(s) FAILED, ${blocked} BLOCKED.`
  );
} catch (err) {
  console.error("\nUnexpected error:", err);
  failures++;
} finally {
  try {
    await admin.from("campaigns").delete().eq("id", campaignId);
  } catch {
    // best-effort cleanup only
  }
  for (const user of [dm, player]) {
    await admin.auth.admin.deleteUser(user.id).catch(() => {});
  }
  await browser.close().catch(() => {});
  if (devServer) {
    try {
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
