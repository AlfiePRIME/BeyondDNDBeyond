import { afterEach, describe, expect, it } from "vitest";
import { getDebugSnapshot } from "./soundManager";
import { applyWeatherAudio, resolveWeatherAudio, type WeatherKind } from "./weatherAudio";

// vitest.config.ts runs this suite under environment: "node" (no `window`,
// no real AudioContext) — see soundManager.test.ts's own doc comment for why
// that's fine for the parts genuinely worth a unit test here: the exact
// per-kind channel matrix (a plain lookup, fully environment-independent),
// and applyWeatherAudio's own SSR/node safety (startLoop/stopLoop are
// already no-ops without a real `window`, so this never throws). Real
// startLoop/stopLoop crossfade behavior driven by a weather-kind change is
// covered by scripts/db/verify-weather-audio.mjs's real-browser Playwright
// checks instead, the same split every other Sound Effects unit test here
// already draws.

afterEach(() => {
  // applyWeatherAudio calls startLoop/stopLoop, which — even as SSR/node
  // no-ops — still touch the shared play log in some environments; keep
  // this suite's own runs from leaking into each other or into
  // soundManager.test.ts's assertions if run in the same process.
  getDebugSnapshot();
});

describe("resolveWeatherAudio", () => {
  // The project owner's own confirmed final channel matrix (weatherAudio.ts's
  // own top-of-file doc comment) — asserted here as a real, independently
  // spelled-out table per kind, not just "matches whatever the app computes."
  const EXPECTED: Record<WeatherKind, { rain: boolean; wind: boolean; fire: boolean }> = {
    clear: { rain: false, wind: false, fire: false },
    fog: { rain: false, wind: true, fire: false },
    cloudy: { rain: false, wind: false, fire: false },
    rain: { rain: true, wind: false, fire: false },
    thunderstorm: { rain: true, wind: true, fire: false },
    firestorm: { rain: false, wind: true, fire: true },
    acid_storm: { rain: false, wind: true, fire: false },
  };

  for (const kind of Object.keys(EXPECTED) as WeatherKind[]) {
    it(`resolves '${kind}' to exactly ${JSON.stringify(EXPECTED[kind])}`, () => {
      expect(resolveWeatherAudio(kind)).toEqual(EXPECTED[kind]);
    });
  }

  it("activates BOTH rain and wind for thunderstorm — not rain alone", () => {
    const channels = resolveWeatherAudio("thunderstorm");
    expect(channels.rain).toBe(true);
    expect(channels.wind).toBe(true);
    expect(channels.fire).toBe(false);
  });

  it("activates BOTH wind and fire for firestorm — not fire alone", () => {
    const channels = resolveWeatherAudio("firestorm");
    expect(channels.wind).toBe(true);
    expect(channels.fire).toBe(true);
    expect(channels.rain).toBe(false);
  });

  it("activates no channel at all for clear or cloudy", () => {
    for (const kind of ["clear", "cloudy"] as WeatherKind[]) {
      const channels = resolveWeatherAudio(kind);
      expect(channels).toEqual({ rain: false, wind: false, fire: false });
    }
  });

  it("is a pure function — repeated calls for the same kind return equal results", () => {
    expect(resolveWeatherAudio("firestorm")).toEqual(resolveWeatherAudio("firestorm"));
  });
});

describe("applyWeatherAudio without a real DOM/AudioContext (SSR/node safety)", () => {
  it("never throws for any weather kind, including the dual-channel ones", () => {
    const kinds: WeatherKind[] = ["clear", "fog", "cloudy", "rain", "thunderstorm", "firestorm", "acid_storm"];
    for (const kind of kinds) {
      expect(() => applyWeatherAudio(kind)).not.toThrow();
    }
  });

  it("reports no active loops outside a browser environment", () => {
    applyWeatherAudio("thunderstorm");
    expect(getDebugSnapshot().activeLoops).toEqual({});
  });
});
