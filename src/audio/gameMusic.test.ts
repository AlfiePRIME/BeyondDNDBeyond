import { afterEach, describe, expect, it } from "vitest";
import { getDebugSnapshot } from "./soundManager";
import { applyGameMusic, resolveGameMusic } from "./gameMusic";

// Same environment/split reasoning as weatherAudio.test.ts: resolveGameMusic
// is a plain, fully environment-independent lookup, and applyGameMusic's
// only genuinely testable behavior here (no real window/AudioContext) is
// that it never throws. Real startLoop/stopLoop crossfade behavior driven
// by a combat-active change is covered by scripts/db/verify-game-music.mjs's
// real-browser Playwright checks instead.

afterEach(() => {
  getDebugSnapshot();
});

describe("resolveGameMusic", () => {
  it("resolves combat inactive to calm-only", () => {
    expect(resolveGameMusic(false)).toEqual({ calm: true, combat: false });
  });

  it("resolves combat active to combat-only", () => {
    expect(resolveGameMusic(true)).toEqual({ calm: false, combat: true });
  });

  it("is always mutually exclusive — never both, never neither", () => {
    for (const combatActive of [true, false]) {
      const channels = resolveGameMusic(combatActive);
      expect(channels.calm).toBe(!channels.combat);
    }
  });

  it("is a pure function — repeated calls for the same input return equal results", () => {
    expect(resolveGameMusic(true)).toEqual(resolveGameMusic(true));
  });
});

describe("applyGameMusic without a real DOM/AudioContext (SSR/node safety)", () => {
  it("never throws for either combat state", () => {
    expect(() => applyGameMusic(false)).not.toThrow();
    expect(() => applyGameMusic(true)).not.toThrow();
  });

  it("reports no active loops outside a browser environment", () => {
    applyGameMusic(true);
    expect(getDebugSnapshot().activeLoops).toEqual({});
  });
});
