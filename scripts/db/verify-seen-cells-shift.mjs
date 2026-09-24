#!/usr/bin/env node
// Migration 0121 verification: growing a map north/west shifts every
// player's remembered fog-of-war cells with the map, and a player still
// can't call the shift themselves. Pure RPC test with fresh test users.
//
// Usage: node scripts/db/verify-seen-cells-shift.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
function loadEnv(path) {
  const env = {};
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq !== -1) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}
const env = { ...loadEnv(join(rootDir, ".env")), ...loadEnv(join(rootDir, "supabase", ".env")), ...process.env };
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    console.error(`FAIL  ${label}${detail ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}

async function makeUser(label) {
  const email = `seen-shift-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Seen Shift ${label}` });
  const client = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  return { id: data.user.id, client };
}

const dm = await makeUser("dm");
const player = await makeUser("player");
const campaignId = crypto.randomUUID();
const mapId = crypto.randomUUID();

try {
  await admin.from("campaigns").insert({ id: campaignId, name: "Seen cells shift", creator: dm.id });
  await admin.from("campaign_members").insert([
    { campaign_id: campaignId, user_id: dm.id, role: "dm" },
    { campaign_id: campaignId, user_id: player.id, role: "player" },
  ]);
  await admin.from("campaign_maps").insert({ id: mapId, campaign_id: campaignId, name: "Fog", grid_width: 4, grid_height: 4 });
  // Adjacent remembered cells — a naive one-pass shift would collide.
  const seen = [[0, 0], [1, 0], [2, 0], [0, 1]].map(([x, y]) => ({
    map_id: mapId, user_id: player.id, x, y, terrain_type: "normal", elevation: 0, light_level: "bright",
  }));
  const { error: seedError } = await admin.from("map_seen_cells").insert(seen);
  if (seedError) throw seedError;

  const { error: playerShiftError } = await player.client.rpc("shift_map_seen_cells", { p_map_id: mapId, p_dx: 5, p_dy: 5 });
  check("a player can't shift fog memory themselves", playerShiftError !== null);

  const { error: growError } = await dm.client.rpc("grow_map_grid", { p_map_id: mapId, p_edge: "west", p_amount: 1 });
  if (growError) throw growError;
  const { error: growError2 } = await dm.client.rpc("grow_map_grid", { p_map_id: mapId, p_edge: "north", p_amount: 2 });
  if (growError2) throw growError2;

  const { data: after } = await admin.from("map_seen_cells").select("x, y").eq("map_id", mapId).eq("user_id", player.id);
  const cells = new Set(after.map((c) => `${c.x},${c.y}`));
  const expected = ["1,2", "2,2", "3,2", "1,3"];
  check(
    "after growing west 1 and north 2, the player's remembered cells moved by (+1, +2)",
    after.length === 4 && expected.every((c) => cells.has(c)),
    [...cells]
  );

  const { error: eastError } = await dm.client.rpc("grow_map_grid", { p_map_id: mapId, p_edge: "east", p_amount: 3 });
  if (eastError) throw eastError;
  const { data: afterEast } = await admin.from("map_seen_cells").select("x, y").eq("map_id", mapId).eq("user_id", player.id);
  check(
    "growing east leaves remembered cells where they were",
    afterEast.every((c) => cells.has(`${c.x},${c.y}`)),
    afterEast
  );
} finally {
  await admin.from("campaigns").delete().eq("id", campaignId);
  await admin.auth.admin.deleteUser(dm.id);
  await admin.auth.admin.deleteUser(player.id);
}

console.log(failures === 0 ? "\nAll seen-cells shift checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
