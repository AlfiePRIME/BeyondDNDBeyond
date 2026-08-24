#!/usr/bin/env node
// Realtime load test (Prompt 2, formalized in Prompt 16).
//
// Opens several simulated concurrent clients, each joining the same
// campaign-shaped channel through the real src/realtime event-bus
// (joinCampaignChannel), and measures round-trip broadcast latency across
// them. Needs the self-hosted Supabase stack running (see supabase/
// directory).
//
// campaignChannel.ts has no runtime imports of its own (its SupabaseClient
// parameter is a type-only import, erased at parse time) — Node's built-in
// TypeScript type-stripping (stable since Node 23.6) can load it directly,
// so this script exercises the actual module rather than a re-implementation
// of its shape.
//
// Usage: node scripts/perf/realtime-load.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { joinCampaignChannel } from "../../src/realtime/campaignChannel.ts";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const budgets = JSON.parse(readFileSync(join(rootDir, "perf-budgets.json"), "utf8"));

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

const env = { ...loadEnv(join(rootDir, ".env")), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !anonKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const CLIENT_COUNT = budgets.realtimeLoad.concurrentClients;
const CAMPAIGN_ID = crypto.randomUUID();
const PING_EVENT = "perf:ping";
const PINGS_PER_CLIENT = 5;

function makeClient(label) {
  const supabase = createClient(supabaseUrl, anonKey, {
    realtime: { params: { eventsPerSecond: 20 } },
  });
  const channel = joinCampaignChannel(supabase, CAMPAIGN_ID, { userId: crypto.randomUUID(), displayName: label });
  return { supabase, channel };
}

function waitFor(predicate, timeoutMs, intervalMs = 25) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`timed out after ${timeoutMs} ms waiting for condition`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function waitForBroadcast(channel, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for "${event}"`));
    }, timeoutMs);
    const unsubscribe = channel.subscribe(event, (payload) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}

// Forces a real network-style drop on one client — closing the raw WebSocket directly rather
// than calling the client's own disconnect()/leave() (which mark the closure "clean" and skip
// realtime-js's own reconnect path entirely). This exercises the actual recovery path: realtime-js
// schedules a reconnect with its own backoff (1s/2s/5s/10s by default), reopens the socket, and
// the dropped channel rejoins itself and re-tracks presence, all without this script's involvement.
async function testDroppedConnectionRecovery(dropTarget, observer, budgets) {
  const RECOVERY_EVENT = "perf:recovery-check";
  console.log("\nSimulating a dropped connection on one client mid-session...");

  const droppedAt = Date.now();
  const rawSocket = dropTarget.supabase.realtime.socketAdapter.getSocket();
  rawSocket.conn?.close();

  await waitFor(() => dropTarget.channel.getConnectionState() === "reconnecting", 5000);
  console.log(`  Reconnecting indicator observed ${Date.now() - droppedAt} ms after the drop.`);

  await waitFor(() => dropTarget.channel.getConnectionState() === "connected", 30000);
  console.log(`  Channel reports "connected" again ${Date.now() - droppedAt} ms after the drop.`);

  // "Connected" alone only proves the rejoin handshake succeeded — actually send messages both
  // ways to confirm the dropped client's broadcast subscriptions and publishes genuinely work
  // again, not just that its status flipped back.
  const observerReceived = waitForBroadcast(observer.channel, RECOVERY_EVENT, 5000);
  await dropTarget.channel.publish(RECOVERY_EVENT, { from: "dropped-client", sentAt: Date.now() });
  await observerReceived;

  const dropTargetReceived = waitForBroadcast(dropTarget.channel, RECOVERY_EVENT, 5000);
  await observer.channel.publish(RECOVERY_EVENT, { from: "observer", sentAt: Date.now() });
  await dropTargetReceived;

  const recoveryTimeMs = Date.now() - droppedAt;
  const budgetMs = budgets.realtimeLoad.maxReconnectRecoveryMs;
  console.log(`Recovery time (drop to confirmed round-trip working again): ${recoveryTimeMs} ms (budget: ${budgetMs} ms)`);

  if (recoveryTimeMs > budgetMs) {
    console.error(`FAIL: recovery time ${recoveryTimeMs} ms exceeds budget ${budgetMs} ms.`);
    process.exitCode = 1;
  } else {
    console.log("PASS");
  }
}

const latencies = [];
const clients = Array.from({ length: CLIENT_COUNT }, (_, i) => makeClient(`perf-client-${i}`));
const channels = clients.map((client) => client.channel);

for (const channel of channels) {
  channel.subscribe(PING_EVENT, (payload) => {
    latencies.push(Date.now() - payload.sentAt);
  });
}

try {
  console.log(`Joining ${CLIENT_COUNT} concurrent campaign-channel clients against ${supabaseUrl} ...`);
  // publish() awaits each channel's own subscribe+presence-track before
  // sending, so this first (unsubscribed-to) broadcast absorbs connection
  // time up front and keeps it out of the timed ping loop below.
  await Promise.all(channels.map((channel) => channel.publish("perf:connect", {})));

  console.log(`Sending ${PINGS_PER_CLIENT} pings per client ...`);
  for (let i = 0; i < PINGS_PER_CLIENT; i++) {
    await Promise.all(channels.map((channel) => channel.publish(PING_EVENT, { sentAt: Date.now() })));
    await new Promise((r) => setTimeout(r, 50));
  }

  // Give in-flight broadcasts time to arrive.
  await new Promise((r) => setTimeout(r, 1000));

  if (latencies.length === 0) {
    console.error("FAIL: no broadcast messages were received — check the Supabase stack is running.");
    process.exitCode = 1;
  } else {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const max = Math.max(...latencies);
    const budgetMs = budgets.realtimeLoad.maxAvgLatencyMs;

    console.log(`Received ${latencies.length} broadcasts across ${CLIENT_COUNT} clients.`);
    console.log(`Average latency: ${avg.toFixed(1)} ms (budget: ${budgetMs} ms), max: ${max} ms`);

    if (avg > budgetMs) {
      console.error(`FAIL: average latency ${avg.toFixed(1)} ms exceeds budget ${budgetMs} ms.`);
      process.exitCode = 1;
    } else {
      console.log("PASS");
    }
  }

  await testDroppedConnectionRecovery(clients[0], clients[1] ?? clients[0], budgets);
} finally {
  await Promise.all(channels.map((channel) => channel.leave()));
}

process.exit(process.exitCode ?? 0);
