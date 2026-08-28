/**
 * Sound Effects SP1 — the shared audio foundation every other Sound Effects
 * prompt (SP2-SP9) is built on. Two things live here that must never
 * change shape carelessly, since every downstream prompt imports them:
 *
 *   1. SOUND_KEYS — the ONE central registry of every sound key this whole
 *      plan will ever use. Every trigger prompt (SP3 token_move, SP4
 *      door_transition, SP5 hit_normal/hit_critical/hit_miss, SP6 death,
 *      SP7 pit_fall, SP8 dice_impact, SP9 rain_loop/wind_loop/thunder/
 *      fire_loop) must import its key from here — never invent an ad-hoc
 *      string. SP2's admin override system also keys its override table off
 *      these exact values (a CHECK constraint against this list, not a
 *      foreign key, since this registry is a code-level constant).
 *   2. playSound / startLoop / stopLoop — the manager's public playback API.
 *      Real Web Audio API objects underneath (AudioContext + GainNode
 *      graph), not a stand-in — see the module-level graph below.
 *
 * Architecture: one lazily-created AudioContext per page, one master
 * GainNode between every sound and `ctx.destination`. Every one-shot
 * (playSound) and every loop (startLoop) connects straight into that same
 * master gain, so a single `setMasterVolume`/`setMuted` call immediately
 * changes the REAL, already-playing audible level of everything currently
 * scheduled — including an active loop — with no need to touch each
 * playing node individually. Master volume/mute itself is persisted
 * per-user via profiles.ui_preferences (see DraggablePanel.tsx's
 * `useSoundSettings` — this module has no Supabase/React dependency for
 * THAT; whatever calls setMasterVolume/setMuted is responsible for wiring
 * that persistence up). The one deliberate exception is resolveSoundUrl
 * below (SP2): it does depend on @/data-access, to check for a live admin
 * override before falling back to SOUND_FILES — see its own doc comment.
 * Every other function here stays exactly as framework-agnostic as before.
 *
 * Loop crossfade discipline deliberately mirrors Droplets.tsx's own
 * fade-to-fully-silent rule (see that file's top-of-file doc comment and
 * its `stopLoop`/`clearToTransparent`): every stopLoop ramps its channel's
 * OWN gain node to exactly 0 over `fadeMs`, then — once that fade has had
 * time to complete — stops and disconnects the underlying source node.
 * Applied to gain instead of shader alpha, but the same guarantee: a
 * stopped loop can never linger audibly, and a rapid stop-then-start
 * (SP9's weather-kind flip-flopping) cancels the in-flight fade instead of
 * stacking a second overlapping source.
 */

// Sound Effects SP2: the one real dependency this otherwise plain module
// has — see resolveSoundUrl's own doc comment below. "@/data-access/
// supabase-browser" is one of data-access's four documented sub-entry-points
// (see that module's own index.ts header comment) for the Client-Component
// browser client specifically; everything else comes from the main barrel,
// same as any other consumer.
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { getSoundOverride, getSoundOverridePublicUrl } from "@/data-access";

/** The one central registry of every sound key this whole Sound Effects
 * plan (SP1-SP9) will ever use. A plain string-literal union underneath
 * (see SoundKey below) — every other prompt imports THESE constants, never
 * a hand-typed string, so a typo anywhere is a compile error rather than a
 * silently-missing sound. */
export const SOUND_KEYS = {
  /** SP8 — a die making contact with the tray floor/walls/other dice. */
  DICE_IMPACT: "dice_impact",
  /** SP7 — a token failing its save on a concealed pit and actually falling. */
  PIT_FALL: "pit_fall",
  /** SP5 — an ordinary (non-critical) successful attack roll. Pooled: at
   * least 3 distinct files, randomly varied across repeated hits. */
  HIT_NORMAL: "hit_normal",
  /** SP5 — a critical hit. */
  HIT_CRITICAL: "hit_critical",
  /** SP5 — a missed attack roll. */
  HIT_MISS: "hit_miss",
  /** SP3 — a token's slide phase starting a real move. */
  TOKEN_MOVE: "token_move",
  /** SP4 — a pawn's cross-map transition being executed/confirmed. */
  DOOR_TRANSITION: "door_transition",
  /** SP6 — a character's is_dead flipping false -> true, live. */
  DEATH: "death",
  /** SP9 — ambient loop, active while weather_kind is 'rain'/'thunderstorm'. */
  RAIN_LOOP: "rain_loop",
  /** SP9 — ambient loop, active for 'fog'/'thunderstorm'/'acid_storm'/'firestorm'. */
  WIND_LOOP: "wind_loop",
  /** SP9 — one-shot synced to computeLightningFlash's existing evaluation. */
  THUNDER: "thunder",
  /** SP9 — ambient loop, active while weather_kind is 'firestorm'. */
  FIRE_LOOP: "fire_loop",
} as const;

/** Every valid sound key — the type every playSound/startLoop/stopLoop
 * parameter (and SP2's override-table CHECK constraint) is built from. */
export type SoundKey = (typeof SOUND_KEYS)[keyof typeof SOUND_KEYS];

/** All registry keys, in a stable order — for anything (SP2's admin
 * settings section, this module's own generation script) that needs to
 * iterate "every sound key" rather than hardcode a second list. */
export const ALL_SOUND_KEYS: SoundKey[] = Object.values(SOUND_KEYS);

/** The subset of SOUND_KEYS meant to be played as a looping ambient channel
 * via startLoop/stopLoop rather than a one-shot via playSound (SP9's rain/
 * wind/fire channels). `thunder` is a one-shot even though it's
 * weather-related — it fires once per lightning flash, never loops. */
export const LOOP_SOUND_KEYS = [SOUND_KEYS.RAIN_LOOP, SOUND_KEYS.WIND_LOOP, SOUND_KEYS.FIRE_LOOP] as const;

export type LoopSoundKey = (typeof LOOP_SOUND_KEYS)[number];

/**
 * Every registry key's own baked default file(s) under public/sounds/
 * (generated by scripts/assets/generate-sound-effects.mjs — see that
 * script's own comments for the exact ffmpeg command behind each one).
 * `hit_normal` and `dice_impact` are the two pools with real variety (>= 3
 * distinct files each — `dice_impact`'s pool added by SP8, once dice_impact
 * became a sound that genuinely fires more than once per gesture, per the
 * same "must genuinely vary" requirement SP5's hit_normal pool first
 * established); every other key has exactly one canonical file. Array order
 * has no meaning beyond variant selection below — nothing depends on
 * files[0] being "the" file for a pooled key.
 *
 * SP2 EXTENSION POINT: this is the one place resolveSoundUrl (below) reads
 * from. SP2's admin override system should insert its live-pointer lookup
 * inside resolveSoundUrl itself (async — the signature already returns a
 * Promise for exactly this reason), falling back to SOUND_FILES only when
 * no override row exists for that key. Nothing here needs to change shape
 * for that to slot in cleanly.
 */
const SOUND_FILES: Record<SoundKey, string[]> = {
  dice_impact: ["/sounds/dice_impact_1.mp3", "/sounds/dice_impact_2.mp3", "/sounds/dice_impact_3.mp3"],
  pit_fall: ["/sounds/pit_fall.mp3"],
  hit_normal: ["/sounds/hit_normal_1.mp3", "/sounds/hit_normal_2.mp3", "/sounds/hit_normal_3.mp3"],
  hit_critical: ["/sounds/hit_critical.mp3"],
  hit_miss: ["/sounds/hit_miss.mp3"],
  token_move: ["/sounds/token_move.mp3"],
  door_transition: ["/sounds/door_transition.mp3"],
  death: ["/sounds/death.mp3"],
  rain_loop: ["/sounds/rain_loop.mp3"],
  wind_loop: ["/sounds/wind_loop.mp3"],
  thunder: ["/sounds/thunder.mp3"],
  fire_loop: ["/sounds/fire_loop.mp3"],
};

/** How many distinct files a key's pool has — exposed mainly so a
 * verification script can assert "hit_normal has >= 3 variants" without
 * reaching into this module's private SOUND_FILES map directly. */
export function getVariantCount(key: SoundKey): number {
  return SOUND_FILES[key].length;
}

/**
 * Resolves which file URL a given playSound/startLoop call should actually
 * use. `variantIndex`, if given, picks deterministically (mod the pool
 * size) — used by tests that need a specific file rather than whatever
 * Math.random() picks; omitted, a real random pick is made every call
 * (SP5's "repeated hits genuinely vary" requirement). Async on purpose —
 * see SOUND_FILES' own doc comment: SP2's override check is a real
 * asynchronous Supabase read, and every call site below already awaits
 * this.
 *
 * Sound Effects SP2: an admin-uploaded override (src/data-access's
 * sound_overrides table, 0084_sound_overrides.sql) always wins over the
 * baked default when one exists for this key. This is a genuine live
 * pointer — re-read fresh on EVERY call, never cached across calls, the
 * same "always re-resolve, don't cache forever" convention this session
 * already established for campaign_monster_template_overrides/map_art —
 * so an admin's upload or "reset to default" takes effect on the very next
 * playback with no other plumbing anywhere (no realtime channel to
 * subscribe/unsubscribe, no state to invalidate). This is also the one
 * spot in this otherwise plain, framework-agnostic module with a real
 * Supabase dependency (via @/data-access, never @supabase/supabase-js
 * directly — the boundaries/dependencies rule in eslint.config.mjs only
 * gate-keeps THAT), by SP1's own design: everything else here (volume/mute
 * persistence, the debug mirror) stays exactly as framework-agnostic as
 * before, wired up by whatever calls it instead.
 *
 * Any failure resolving the override (offline, an RLS edge case, this
 * migration not yet applied to a given environment) must never block
 * ordinary playback — silently fall back to the baked default, keeping
 * SP2 fully optional/additive per its own acceptance bar: every sound key
 * keeps working using ONLY SP1's baked defaults with zero configuration.
 */
async function resolveSoundUrl(key: SoundKey, variantIndex?: number): Promise<string> {
  const files = SOUND_FILES[key];
  const index = variantIndex !== undefined ? ((variantIndex % files.length) + files.length) % files.length : Math.floor(Math.random() * files.length);
  const defaultUrl = files[index];

  try {
    const supabase = createBrowserSupabaseClient();
    const override = await getSoundOverride(supabase, key);
    if (override) return getSoundOverridePublicUrl(supabase, override.storage_ref);
  } catch {
    // Fall through to the baked default below — see this function's own
    // doc comment on why a resolution failure must never block playback.
  }
  return defaultUrl;
}

// ─────────────────────────────────────────────────────────────────────────
// Master volume/mute state — plain in-memory state, independent of whether
// an AudioContext has been created yet (a page can call setMasterVolume
// before any sound has ever played, e.g. restoring a saved preference on
// load). applyMasterGain pushes it into the real GainNode once one exists.
// ─────────────────────────────────────────────────────────────────────────

interface SoundManagerState {
  volume: number;
  muted: boolean;
}

const state: SoundManagerState = { volume: 1, muted: false };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

let audioContext: AudioContext | null = null;
let masterGain: GainNode | null = null;
let unlockListenersAttached = false;

/** Real, non-experimental Web Audio API feature-detection — mirrors
 * Droplets.tsx's own supportsDroplets() shape (a plain boolean probe,
 * callable before ever attempting real construction). */
export function supportsSoundManager(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
}

/** Attaches a one-time (per page load), never-removed listener that resumes
 * a suspended AudioContext on the next real user gesture — browsers create
 * every AudioContext in a "suspended" state until a user interacts with the
 * page at least once, per the Web Audio spec's autoplay-policy guidance.
 * Never detached: some browsers can re-suspend a context after a long
 * backgrounded period, so this stays armed for the page's whole lifetime
 * rather than firing once and unregistering. */
function attachUnlockListeners(): void {
  if (unlockListenersAttached || typeof window === "undefined") return;
  unlockListenersAttached = true;
  const tryResume = () => {
    if (audioContext && audioContext.state === "suspended") {
      void audioContext.resume();
    }
  };
  window.addEventListener("pointerdown", tryResume, { passive: true });
  window.addEventListener("keydown", tryResume);
}

function applyMasterGain(): void {
  if (!masterGain) return;
  masterGain.gain.value = state.muted ? 0 : state.volume;
}

/** Lazily creates (or returns the existing) AudioContext + master GainNode
 * graph. Never called at module load — only from a real playback call —
 * so importing this module server-side or before any sound is ever
 * triggered is always a safe no-op. */
function ensureContext(): AudioContext {
  if (audioContext) {
    // Defensive resume on every real playback call, not only from the
    // pointerdown/keydown unlock listener below — a real, reproduced issue
    // this closes: a context that's gone completely silent for a stretch
    // (every previous one-shot/loop finished, nothing else scheduled) can
    // have its underlying render callback effectively go idle even while
    // `.state` still reports "running", so a freshly scheduled gain ramp
    // from silence never actually advances until something explicitly
    // re-engages it. `.resume()` on an already-running context is a
    // harmless, spec-defined no-op, so this costs nothing in the common
    // case and fixes the idle-graph case for free.
    if (audioContext.state !== "closed") void audioContext.resume();
    return audioContext;
  }
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  audioContext = new Ctor();
  masterGain = audioContext.createGain();
  applyMasterGain();
  masterGain.connect(audioContext.destination);
  attachUnlockListeners();
  return audioContext;
}

const bufferCache = new Map<string, Promise<AudioBuffer>>();

function loadBuffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  let cached = bufferCache.get(url);
  if (!cached) {
    cached = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`sound file fetch failed: ${url} (${response.status})`);
        return response.arrayBuffer();
      })
      .then((arrayBuffer) => ctx.decodeAudioData(arrayBuffer));
    // A transient failure (network blip, a 404 during local dev before the
    // generation script has run) shouldn't permanently poison this URL for
    // the rest of the session — evict so the next call retries fresh.
    cached.catch(() => bufferCache.delete(url));
    bufferCache.set(url, cached);
  }
  return cached;
}

// ─────────────────────────────────────────────────────────────────────────
// Debug/introspection mirror — this project's established convention
// (GameRoom.tsx's visionDebug/tableSurfaceDebug: a hidden DOM node holding
// a JSON snapshot, since a WebGL canvas — or here, the Web Audio graph —
// has no DOM of its own for Playwright to inspect) applied to audio state.
// SP3/SP5/SP8's own "read the sound manager's own play-call log" checks and
// SP9's "read the sound manager's own active-loop-channel debug state"
// checks are both meant to consume this. src/audio/SoundControl.tsx is
// what actually mirrors this into a hidden DOM node.
// ─────────────────────────────────────────────────────────────────────────

interface PlayLogEntry {
  key: SoundKey;
  url: string;
  /** performance.now()-based, so relative ordering/spacing between entries
   * is meaningful even though the absolute number has no calendar meaning. */
  at: number;
}

const PLAY_LOG_MAX_ENTRIES = 50;
const playLog: PlayLogEntry[] = [];

function recordPlay(key: SoundKey, url: string): void {
  playLog.push({ key, url, at: typeof performance !== "undefined" ? performance.now() : Date.now() });
  if (playLog.length > PLAY_LOG_MAX_ENTRIES) playLog.splice(0, playLog.length - PLAY_LOG_MAX_ENTRIES);
}

/** Clears the play-call log without touching any other state — lets a
 * verify script reset between two gestures it wants to count independently
 * (e.g. "exactly one trigger per move"), matching this project's own
 * flushSeenCells-style "explicit reset between test phases" convention. */
export function clearPlayLog(): void {
  playLog.length = 0;
}

type LoopState = "starting" | "active" | "stopping";

interface LoopEntry {
  source: AudioBufferSourceNode | null;
  gainNode: GainNode | null;
  state: LoopState;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

const loops = new Map<LoopSoundKey, LoopEntry>();
// Guards a startLoop's in-flight buffer load against a stopLoop (or a
// second startLoop) that runs before it resolves — see startLoop/stopLoop's
// own comments below for exactly how this is used.
const loopGenerations = new Map<LoopSoundKey, number>();

const debugListeners = new Set<() => void>();
function notifyDebugListeners(): void {
  for (const listener of debugListeners) listener();
}

/** Subscribes to "something the debug snapshot reports just changed" — no
 * payload (matches this project's other subscribe-then-read-fresh
 * patterns, e.g. subscribeToUiPreferencesChanges' own callers usually just
 * re-derive from the latest value rather than trust a payload's staleness).
 * Fires on every playSound/startLoop/stopLoop/setMasterVolume/setMuted
 * call. Returns an unsubscribe function. */
export function subscribeDebugState(listener: () => void): () => void {
  debugListeners.add(listener);
  return () => {
    debugListeners.delete(listener);
  };
}

export interface SoundManagerDebugSnapshot {
  audioContextState: AudioContextState | "uninitialized";
  volume: number;
  muted: boolean;
  /** The REAL master GainNode's own current .gain.value — falls back to
   * the equivalent computed value before any AudioContext exists yet, so a
   * check made before the first playback still sees the correct number. */
  masterGainValue: number;
  activeLoops: Partial<Record<LoopSoundKey, { state: LoopState; gainValue: number }>>;
  playLog: PlayLogEntry[];
}

/** A live, read-fresh-every-call snapshot of the manager's real state —
 * never a cached object, so "read the actual GainNode state" checks (this
 * prompt's own acceptance criteria) always see this instant's true value,
 * including mid-fade. */
export function getDebugSnapshot(): SoundManagerDebugSnapshot {
  const activeLoops: SoundManagerDebugSnapshot["activeLoops"] = {};
  for (const [key, entry] of loops) {
    activeLoops[key] = { state: entry.state, gainValue: entry.gainNode?.gain.value ?? 0 };
  }
  return {
    audioContextState: audioContext?.state ?? "uninitialized",
    volume: state.volume,
    muted: state.muted,
    masterGainValue: masterGain?.gain.value ?? (state.muted ? 0 : state.volume),
    activeLoops,
    playLog: [...playLog],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public playback API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Plays a one-shot sound by its registry key. For a pooled key (currently
 * only `hit_normal`) a random variant is chosen unless `variantIndex` is
 * given. Fire-and-forget by design (returns a Promise a caller MAY await to
 * know the sound actually started, but every planned SP3-SP8 call site
 * simply calls this without awaiting). A no-op (resolves immediately) when
 * Web Audio isn't available (SSR, or an environment with no AudioContext).
 */
export async function playSound(key: SoundKey, options: { variantIndex?: number } = {}): Promise<void> {
  if (typeof window === "undefined" || !supportsSoundManager()) return;
  const ctx = ensureContext();
  const url = await resolveSoundUrl(key, options.variantIndex);
  const buffer = await loadBuffer(ctx, url);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(masterGain!);
  source.addEventListener("ended", () => source.disconnect());
  source.start(0);
  recordPlay(key, url);
  notifyDebugListeners();
}

/** Smooth linear ramp helper shared by startLoop/stopLoop — cancels
 * whatever ramp might already be scheduled first (the exact case a rapid
 * start/stop/start needs) so two overlapping ramps on the same param can
 * never fight each other. */
function rampGain(gainNode: GainNode, target: number, durationMs: number, ctx: AudioContext): void {
  const now = ctx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  if (durationMs <= 0) {
    gainNode.gain.setValueAtTime(target, now);
  } else {
    gainNode.gain.linearRampToValueAtTime(target, now + durationMs / 1000);
  }
}

/** Default crossfade length for loop start/stop — long enough to read as a
 * deliberate fade rather than a click, short enough that switching weather
 * kinds (SP9) doesn't feel sluggish. No exact precedent to copy (Droplets'
 * own alpha lerp is speed-based, not a fixed duration) — a considered
 * choice, not a magic number picked at random. */
const DEFAULT_LOOP_FADE_MS = 700;

/**
 * Starts (or, if already running, is a no-op; if currently fading out,
 * cancels that fade and ramps back up) a named looping ambient channel,
 * crossfading in from silence over `fadeMs`. Idempotent by design — SP9
 * calls this once per weather-kind evaluation without needing to track
 * "did I already start this one" itself.
 */
export async function startLoop(key: LoopSoundKey, options: { fadeMs?: number } = {}): Promise<void> {
  if (typeof window === "undefined" || !supportsSoundManager()) return;
  const fadeMs = Math.max(0, options.fadeMs ?? DEFAULT_LOOP_FADE_MS);
  const ctx = ensureContext();

  const existing = loops.get(key);
  if (existing && existing.state !== "stopping") return; // already running or already starting
  if (existing && existing.state === "stopping" && existing.gainNode) {
    // Caught mid-fade-out — reverse it in place rather than layering a
    // second source on top of the one still ringing down.
    if (existing.stopTimer) clearTimeout(existing.stopTimer);
    existing.state = "active";
    existing.stopTimer = null;
    rampGain(existing.gainNode, 1, fadeMs, ctx);
    notifyDebugListeners();
    return;
  }

  const generation = (loopGenerations.get(key) ?? 0) + 1;
  loopGenerations.set(key, generation);
  loops.set(key, { source: null, gainNode: null, state: "starting", stopTimer: null });
  notifyDebugListeners();

  const url = await resolveSoundUrl(key);
  const buffer = await loadBuffer(ctx, url);
  if (loopGenerations.get(key) !== generation) return; // superseded by a stopLoop/startLoop while loading

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const gainNode = ctx.createGain();
  gainNode.gain.value = 0;
  source.connect(gainNode).connect(masterGain!);
  source.start(0);
  rampGain(gainNode, 1, fadeMs, ctx);
  loops.set(key, { source, gainNode, state: "active", stopTimer: null });
  notifyDebugListeners();
}

/**
 * Stops a named looping ambient channel, crossfading its own gain node to
 * exactly 0 over `fadeMs` before actually stopping/disconnecting the
 * underlying source — the Droplets.tsx "never leave a stopped loop's audio
 * node lingering audibly" discipline applied to gain. A no-op if the
 * channel isn't running. Synchronous (no buffer load needed to stop
 * something).
 */
export function stopLoop(key: LoopSoundKey, options: { fadeMs?: number } = {}): void {
  if (typeof window === "undefined" || !supportsSoundManager()) return;
  const fadeMs = Math.max(0, options.fadeMs ?? DEFAULT_LOOP_FADE_MS);
  const entry = loops.get(key);
  if (!entry) return;

  if (entry.state === "starting") {
    // Still loading its buffer — bump the generation so startLoop's own
    // load-completion handler sees a stale generation and abandons instead
    // of starting audio that should already be silent.
    loopGenerations.set(key, (loopGenerations.get(key) ?? 0) + 1);
    loops.delete(key);
    notifyDebugListeners();
    return;
  }
  if (entry.state === "stopping") return; // already fading out

  const ctx = ensureContext();
  entry.state = "stopping";
  rampGain(entry.gainNode!, 0, fadeMs, ctx);
  entry.stopTimer = setTimeout(() => {
    try {
      entry.source!.stop();
    } catch {
      // Already stopped/ended on its own — nothing left to do.
    }
    entry.source!.disconnect();
    entry.gainNode!.disconnect();
    // Only delete if this is still the same entry — startLoop may have
    // already reversed the fade (see its own "caught mid-fade-out" branch)
    // and replaced it, in which case this stale cleanup must not touch it.
    if (loops.get(key) === entry) loops.delete(key);
    notifyDebugListeners();
  }, fadeMs + 50);
  loops.set(key, entry);
  notifyDebugListeners();
}

/** Whether a given loop channel is currently active (playing at, or
 * ramping toward, full volume) — `false` while it's fading out or fully
 * stopped. Convenience for callers that just want a boolean rather than
 * the full debug snapshot's per-key state. */
export function isLoopActive(key: LoopSoundKey): boolean {
  const entry = loops.get(key);
  return entry?.state === "active" || entry?.state === "starting";
}

// ─────────────────────────────────────────────────────────────────────────
// Master volume/mute — the real-time control every playback/loop call
// respects live. See this file's own top-of-file doc comment for why a
// single master GainNode makes "already-playing loop updates immediately"
// fall out for free rather than needing to touch each active node.
// ─────────────────────────────────────────────────────────────────────────

export function setMasterVolume(volume: number): void {
  state.volume = clamp01(volume);
  applyMasterGain();
  notifyDebugListeners();
}

export function setMuted(muted: boolean): void {
  state.muted = muted;
  applyMasterGain();
  notifyDebugListeners();
}

export function getMasterVolume(): number {
  return state.volume;
}

export function isMuted(): boolean {
  return state.muted;
}
