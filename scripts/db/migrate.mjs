#!/usr/bin/env node
// Lightweight migration runner (Prompt 4) — no Supabase CLI available in
// this environment, so migrations are plain numbered .sql files under
// supabase/migrations/, applied in order and tracked in a _migrations
// table so re-running is a no-op for already-applied files. Reapplying to
// a fresh database just means running this against a fresh container.
//
// Usage: node scripts/db/migrate.mjs

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(rootDir, "supabase", "migrations");

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

const env = { ...loadEnv(join(rootDir, "supabase", ".env")), ...process.env };

// The host only exposes Supavisor (the pooler), not Postgres directly, and
// Supavisor is multi-tenant — it needs the tenant-qualified username
// "postgres.<POOLER_TENANT_ID>", not plain "postgres".
const client = new pg.Client({
  host: "localhost",
  port: Number(env.POSTGRES_PORT ?? 5432),
  user: `postgres.${env.POOLER_TENANT_ID}`,
  password: env.POSTGRES_PASSWORD,
  database: env.POSTGRES_DB ?? "postgres",
});

await client.connect();

try {
  await client.query(`
    create table if not exists public._migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const { rows: appliedRows } = await client.query("select filename from public._migrations");
  const applied = new Set(appliedRows.map((r) => r.filename));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ranAny = false;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    console.log(`apply ${file}`);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into public._migrations (filename) values ($1)", [file]);
      await client.query("commit");
      ranAny = true;
    } catch (err) {
      await client.query("rollback");
      console.error(`FAILED applying ${file}:`, err.message);
      process.exitCode = 1;
      break;
    }
  }

  if (!process.exitCode) {
    console.log(ranAny ? "All migrations applied." : "Nothing to do — already up to date.");
  }
} finally {
  await client.end();
}
