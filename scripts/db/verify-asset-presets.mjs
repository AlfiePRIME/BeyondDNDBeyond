#!/usr/bin/env node
// Built-in preset asset library verification (Prompt 24 acceptance criteria).
//
// Confirms the 0016 seed is visible campaign-agnostically: a campaign member
// and a user in no campaign at all both read the full built-in set, and
// every seeded model_ref points at a real generated .glb on disk.
//
// Usage: node scripts/db/verify-asset-presets.mjs

import { readFileSync, existsSync } from "node:fs";
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

// Mirrors scripts/assets/generate-map-presets.mjs's PRESETS — the fixed
// UUIDs seeded by 0016_asset_library_presets.sql.
const EXPECTED = [
  { uuid: "a55e7001-0000-4000-8000-000000000001", name: "Torch", file: "torch.glb" },
  { uuid: "a55e7002-0000-4000-8000-000000000002", name: "Chest", file: "chest.glb" },
  { uuid: "a55e7003-0000-4000-8000-000000000003", name: "Door", file: "door.glb" },
  { uuid: "a55e7004-0000-4000-8000-000000000004", name: "Table", file: "table.glb" },
  { uuid: "a55e7005-0000-4000-8000-000000000005", name: "Tree", file: "tree.glb" },
  { uuid: "a55e7006-0000-4000-8000-000000000006", name: "Rock", file: "rock.glb" },
  { uuid: "a55e7007-0000-4000-8000-000000000007", name: "Wall Segment", file: "wall.glb" },
  { uuid: "a55e7008-0000-4000-8000-000000000008", name: "Stairs", file: "stairs.glb" },
];

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failures++;
  }
}

async function makeTestUser(label) {
  const email = `asset-presets-${label}-${Date.now()}@example.test`;
  const password = "test-password-1234!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`creating test user ${label}: ${error.message}`);
  await admin.from("profiles").insert({ id: data.user.id, display_name: `Asset Presets Test ${label}` });
  const client = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signing in test user ${label}: ${signInError.message}`);
  return { id: data.user.id, client };
}

function hasFullBuiltInSet(rows) {
  const byId = new Map((rows ?? []).map((row) => [row.id, row]));
  return EXPECTED.every((expected) => {
    const row = byId.get(expected.uuid);
    return (
      row &&
      row.name === expected.name &&
      row.source_type === "preset" &&
      row.campaign_id === null &&
      row.model_ref === `/assets/presets/${expected.file}`
    );
  });
}

const member = await makeTestUser("member");
const loner = await makeTestUser("loner");

try {
  const campaignId = crypto.randomUUID();
  await admin.from("campaigns").insert({ id: campaignId, name: "Asset presets test", creator: member.id });
  await admin.from("campaign_members").insert({ campaign_id: campaignId, user_id: member.id, role: "dm" });

  const { data: memberRows } = await member.client.from("asset_library").select().eq("source_type", "preset");
  check("a campaign member reads all 8 built-in presets", hasFullBuiltInSet(memberRows));

  const { data: lonerRows } = await loner.client.from("asset_library").select().eq("source_type", "preset");
  check("a user in no campaign reads the same full set (campaign-agnostic)", hasFullBuiltInSet(lonerRows));

  for (const expected of EXPECTED) {
    check(
      `${expected.name}'s model_ref points at a real file (public/assets/presets/${expected.file})`,
      existsSync(join(rootDir, "public", "assets", "presets", expected.file))
    );
  }

  await admin.from("campaigns").delete().eq("id", campaignId);
} finally {
  await admin.auth.admin.deleteUser(member.id);
  await admin.auth.admin.deleteUser(loner.id);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll built-in preset asset checks passed.");
