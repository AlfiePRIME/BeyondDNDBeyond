import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_SOUND_KEYS,
  LOOP_SOUND_KEYS,
  SOUND_KEYS,
  clearPlayLog,
  getDebugSnapshot,
  getMasterVolume,
  getVariantCount,
  isMuted,
  playSound,
  setMasterVolume,
  setMuted,
  startLoop,
  stopLoop,
  subscribeDebugState,
} from "./soundManager";

// vitest.config.ts runs this suite under environment: "node" (no `window`,
// no real AudioContext) — soundManager's own `typeof window === "undefined"`
// guards make playSound/startLoop/stopLoop safe no-ops there, so this suite
// exercises the parts that are genuinely environment-independent: the
// registry's own shape (the thing every other Sound Effects prompt imports
// and must never see change unexpectedly) and the master volume/mute state
// machine, which is plain JS state regardless of whether a real audio graph
// exists yet. Real AudioContext/GainNode behavior is covered by
// scripts/db/verify-sound-infra.mjs's real-browser Playwright checks
// instead — the same split every other WebGL/canvas-backed effect in this
// project draws between a unit test and its verify-*.mjs.

afterEach(() => {
  // Reset the module's shared, mutable state between tests — setMasterVolume
  // /setMuted intentionally have no "reset" API of their own (a real running
  // app never needs one), but this suite's own tests must not leak into
  // each other.
  setMasterVolume(1);
  setMuted(false);
  clearPlayLog();
});

describe("SOUND_KEYS registry", () => {
  it("defines exactly the 17 keys this whole Sound Effects plan (SP1-SP9 plus the natural-roll and game-music follow-ups) uses", () => {
    expect(new Set(ALL_SOUND_KEYS)).toEqual(
      new Set([
        "dice_impact",
        "pit_fall",
        "hit_normal",
        "hit_critical",
        "hit_miss",
        "token_move",
        "door_transition",
        "death",
        "rain_loop",
        "wind_loop",
        "thunder",
        "fire_loop",
        "nat_20",
        "nat_1",
        "lobby_music",
        "calm_music",
        "combat_music",
      ])
    );
    expect(ALL_SOUND_KEYS).toHaveLength(17);
  });

  it("gives every registry key at least one baked file", () => {
    for (const key of ALL_SOUND_KEYS) {
      expect(getVariantCount(key)).toBeGreaterThanOrEqual(1);
    }
  });

  it("gives hit_normal a real pool of at least 3 distinct variants (SP5's randomization requirement)", () => {
    expect(getVariantCount(SOUND_KEYS.HIT_NORMAL)).toBeGreaterThanOrEqual(3);
  });

  it("gives dice_impact a real pool of at least 3 distinct variants (SP8: a tumble now plays this repeatedly, not just once, so it needs the same genuine variety hit_normal's pool established)", () => {
    expect(getVariantCount(SOUND_KEYS.DICE_IMPACT)).toBeGreaterThanOrEqual(3);
  });

  it("marks exactly rain_loop/wind_loop/fire_loop/lobby_music/calm_music/combat_music as loop-capable channels — thunder is a one-shot, not a loop", () => {
    expect(new Set(LOOP_SOUND_KEYS)).toEqual(
      new Set(["rain_loop", "wind_loop", "fire_loop", "lobby_music", "calm_music", "combat_music"])
    );
    expect(LOOP_SOUND_KEYS).not.toContain(SOUND_KEYS.THUNDER);
  });
});

describe("master volume/mute state", () => {
  it("clamps volume to the 0-1 range", () => {
    setMasterVolume(1.5);
    expect(getMasterVolume()).toBe(1);
    setMasterVolume(-0.5);
    expect(getMasterVolume()).toBe(0);
    setMasterVolume(0.42);
    expect(getMasterVolume()).toBeCloseTo(0.42);
  });

  it("tracks muted independently of the stored volume level (unmuting restores it, never resets to a default)", () => {
    setMasterVolume(0.7);
    setMuted(true);
    expect(isMuted()).toBe(true);
    expect(getMasterVolume()).toBeCloseTo(0.7);
    setMuted(false);
    expect(isMuted()).toBe(false);
    expect(getMasterVolume()).toBeCloseTo(0.7);
  });

  it("reflects volume/mute in the debug snapshot's masterGainValue even before any AudioContext exists", () => {
    setMasterVolume(0.3);
    setMuted(false);
    expect(getDebugSnapshot().masterGainValue).toBeCloseTo(0.3);

    setMuted(true);
    expect(getDebugSnapshot().masterGainValue).toBe(0);
  });

  it("notifies debug subscribers on every volume/mute change", () => {
    let notifications = 0;
    const unsubscribe = subscribeDebugState(() => {
      notifications++;
    });
    setMasterVolume(0.5);
    setMuted(true);
    unsubscribe();
    setMasterVolume(0.9);
    expect(notifications).toBe(2);
  });
});

describe("playback API without a real DOM/AudioContext (SSR/node safety)", () => {
  it("playSound resolves without throwing and never touches the play log", async () => {
    await expect(playSound(SOUND_KEYS.TOKEN_MOVE)).resolves.toBeUndefined();
    expect(getDebugSnapshot().playLog).toEqual([]);
  });

  it("startLoop/stopLoop resolve without throwing and report no active loops", async () => {
    await expect(startLoop(SOUND_KEYS.RAIN_LOOP)).resolves.toBeUndefined();
    expect(getDebugSnapshot().activeLoops).toEqual({});
    expect(() => stopLoop(SOUND_KEYS.RAIN_LOOP)).not.toThrow();
  });

  it("reports audioContextState as uninitialized until a real browser creates one", () => {
    expect(getDebugSnapshot().audioContextState).toBe("uninitialized");
  });
});
