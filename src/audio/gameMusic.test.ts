import { afterEach, describe, expect, it } from "vitest";
import { getDebugSnapshot } from "./soundManager";
import { applyGameMusic, resolveGameMusic, type GameMusicSettings } from "./gameMusic";

// Same environment/split reasoning as weatherAudio.test.ts: resolveGameMusic
// is a plain, fully environment-independent lookup, and applyGameMusic's
// only genuinely testable behavior here (no real window/AudioContext) is
// that it never throws. Real startLoop/stopLoop crossfade behavior driven
// by a combat-active/toggle change is covered by
// scripts/db/verify-game-music.mjs's real-browser Playwright checks instead.

afterEach(() => {
  getDebugSnapshot();
});

const BOTH_ENABLED: GameMusicSettings = { calmEnabled: true, combatEnabled: true };
const CALM_DISABLED: GameMusicSettings = { calmEnabled: false, combatEnabled: true };
const COMBAT_DISABLED: GameMusicSettings = { calmEnabled: true, combatEnabled: false };
const BOTH_DISABLED: GameMusicSettings = { calmEnabled: false, combatEnabled: false };

describe("resolveGameMusic", () => {
  it("resolves combat inactive + both enabled to calm-only", () => {
    expect(resolveGameMusic(false, BOTH_ENABLED)).toEqual({ calm: true, combat: false });
  });

  it("resolves combat active + both enabled to combat-only", () => {
    expect(resolveGameMusic(true, BOTH_ENABLED)).toEqual({ calm: false, combat: true });
  });

  it("is mutually exclusive when both toggles are enabled — never both, never neither", () => {
    for (const combatActive of [true, false]) {
      const channels = resolveGameMusic(combatActive, BOTH_ENABLED);
      expect(channels.calm).toBe(!channels.combat);
    }
  });

  it("a disabled calm toggle means silence outside combat — does NOT fall back to combat_music", () => {
    expect(resolveGameMusic(false, CALM_DISABLED)).toEqual({ calm: false, combat: false });
  });

  it("a disabled calm toggle doesn't affect combat_music during combat", () => {
    expect(resolveGameMusic(true, CALM_DISABLED)).toEqual({ calm: false, combat: true });
  });

  it("a disabled combat toggle means silence during combat — does NOT fall back to calm_music", () => {
    expect(resolveGameMusic(true, COMBAT_DISABLED)).toEqual({ calm: false, combat: false });
  });

  it("a disabled combat toggle doesn't affect calm_music outside combat", () => {
    expect(resolveGameMusic(false, COMBAT_DISABLED)).toEqual({ calm: true, combat: false });
  });

  it("both toggles disabled means total silence regardless of combat state", () => {
    expect(resolveGameMusic(false, BOTH_DISABLED)).toEqual({ calm: false, combat: false });
    expect(resolveGameMusic(true, BOTH_DISABLED)).toEqual({ calm: false, combat: false });
  });

  it("is a pure function — repeated calls for the same input return equal results", () => {
    expect(resolveGameMusic(true, BOTH_ENABLED)).toEqual(resolveGameMusic(true, BOTH_ENABLED));
  });
});

describe("applyGameMusic without a real DOM/AudioContext (SSR/node safety)", () => {
  it("never throws for any combat/toggle combination", () => {
    for (const combatActive of [true, false]) {
      for (const settings of [BOTH_ENABLED, CALM_DISABLED, COMBAT_DISABLED, BOTH_DISABLED]) {
        expect(() => applyGameMusic(combatActive, settings)).not.toThrow();
      }
    }
  });

  it("reports no active loops outside a browser environment", () => {
    applyGameMusic(true, BOTH_ENABLED);
    expect(getDebugSnapshot().activeLoops).toEqual({});
  });
});
