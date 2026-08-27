/**
 * Weather & Enemies C3 — thunderstorm lightning scheduling.
 *
 * The acceptance criteria's one hard requirement is synchronization: "the DM
 * and every player must see the SAME flash at the SAME time, not
 * independently randomized per client." Two designs were on the table (the
 * C3 prompt's own Notes name both and leave the choice open):
 *
 *   1. Broadcast each flash as a realtime event (this project already has
 *      `joinCampaignChannel`'s publish/subscribe for exactly this shape of
 *      thing — see DICE_ROLLED_EVENT etc. in GameRoom.tsx).
 *   2. Derive flash timing from a shared, deterministic seed/clock, so every
 *      client computes the identical schedule independently.
 *
 * This file implements (2). Reasons broadcast was NOT chosen:
 *   - It needs a single elected sender. There's no natural "who broadcasts
 *     lightning" here the way there's a natural "who broadcasts a dice
 *     roll" (whoever rolled it) — every client is a peer. Electing the DM
 *     as sender means the DM's own client leaving/reloading silently stops
 *     lightning for everyone else until it reconnects.
 *   - Every OTHER client's flash would then land at "whenever the broadcast
 *     happens to arrive" — real, if usually small, network latency/jitter
 *     between clients, which is exactly the "out-of-sync flash" the C3
 *     prompt's own Notes calls out as the one thing worth real care.
 *   - A client that loads mid-storm has nothing to resync from (no
 *     "current flash schedule" message exists to request) until the next
 *     broadcast happens to fire.
 *
 * A pure function of (campaign-scoped seed, current wall-clock time) has
 * none of those problems: every client computes the identical schedule
 * independently and instantly (including a client that just loaded), there
 * is no elected sender and nothing to miss on a dropped connection, and the
 * only network dependency is however campaigns.weather_kind itself already
 * reaches every client (subscribeToCampaignChanges) — which only needs to
 * arrive ONCE, not once per flash. The one assumption this trades in return
 * is that connected clients' system clocks agree to within, say, a couple
 * hundred ms — true of ordinary NTP-synced machines/devices, and exactly
 * true (the same OS clock) of the two browser contexts a real Playwright
 * check of this drives.
 */

// Average time between flashes. The actual gap between two consecutive
// flashes still varies (see the per-bucket offset below), so the rhythm
// reads as storm-like, not a metronome.
export const LIGHTNING_BUCKET_MS = 4500;

// Each flash fires somewhere in the first 80% of its own bucket, never
// right up against the following bucket's own flash — keeps two flashes
// from ever landing back-to-back, and keeps this file's own "a flash never
// straddles a bucket boundary" invariant comfortably true (max offset
// 3600ms + max duration 380ms is still well inside one 4500ms bucket).
const OFFSET_FRACTION = 0.8;

// A flash is brief and readable, not a subtle flicker (the acceptance
// criteria's own words) — 160 to 380ms, well under half a second.
const MIN_DURATION_MS = 160;
const DURATION_RANGE_MS = 220;

// Real lightning is a near-instant, very bright pop with a slower fade —
// most of a flash's own duration is decay, not attack.
const ATTACK_FRACTION = 0.12;

const MIN_PEAK_OPACITY = 0.55;
const PEAK_OPACITY_RANGE = 0.35;

/**
 * A stable numeric seed from any string (this feature always passes a
 * campaign id) — every campaign gets its own flash rhythm, but the SAME
 * campaign always gets the SAME rhythm on every client, which is the only
 * property that actually matters here.
 */
export function seedFromString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return (h >>> 0) % 100000;
}

// Deterministic, dependency-free pseudo-random in [0, 1) — same
// sin-based hashing family already used by this project's own
// Glitch.tsx (its own local `hash(n)`), extended with a second input
// (`salt`) so several independent values can be derived from one bucket
// index without correlating with each other.
function hash(seed: number, salt: number): number {
  const s = Math.sin(seed * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export interface LightningFlashState {
  /** True while a flash is currently inside its attack/decay window. */
  active: boolean;
  /** 0 (no flash) to ~1 (peak brightness) overlay opacity for THIS instant. */
  opacity: number;
  /** The deterministic bucket index `nowMs` falls in — identical across
   * every client at the same wall-clock moment. Exposed (rather than kept
   * private) so a real Playwright check can directly compare two clients'
   * computed schedules, not just their momentary opacity, which is a
   * stronger proof that they're running the identical schedule rather than
   * two independent ones that happen to agree once by chance. */
  bucket: number;
}

/**
 * Pure function of (seed, nowMs). Every connected client calls this with
 * its own `Date.now()` and the SAME campaign-derived seed and gets back the
 * identical answer — see this file's own top-of-file doc comment for why
 * that's the whole synchronization mechanism.
 */
export function computeLightningFlash(seed: number, nowMs: number): LightningFlashState {
  const bucket = Math.floor(nowMs / LIGHTNING_BUCKET_MS);
  const bucketStart = bucket * LIGHTNING_BUCKET_MS;
  const offset = hash(seed, bucket * 3) * LIGHTNING_BUCKET_MS * OFFSET_FRACTION;
  const duration = MIN_DURATION_MS + hash(seed, bucket * 3 + 1) * DURATION_RANGE_MS;
  const peak = MIN_PEAK_OPACITY + hash(seed, bucket * 3 + 2) * PEAK_OPACITY_RANGE;
  const flashStart = bucketStart + offset;
  const t = nowMs - flashStart;

  if (t < 0 || t >= duration) {
    return { active: false, opacity: 0, bucket };
  }

  const attackMs = duration * ATTACK_FRACTION;
  const opacity =
    t < attackMs ? (t / attackMs) * peak : peak * (1 - (t - attackMs) / (duration - attackMs));
  return { active: true, opacity: Math.max(0, Math.min(1, opacity)), bucket };
}
