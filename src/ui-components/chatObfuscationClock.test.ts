import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getObfuscationClockDebugInfo, scrambleGlyphs, subscribeToObfuscationTick } from "./chatObfuscationClock";

describe("subscribeToObfuscationTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Defensive: if a test forgets to unsubscribe, don't leak a live
    // interval (or its state) into the next test.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("has no active interval and no subscribers before anything subscribes", () => {
    expect(getObfuscationClockDebugInfo()).toEqual({ subscriberCount: 0, intervalActive: false });
  });

  it("starts exactly one interval no matter how many listeners subscribe", () => {
    const unsubA = subscribeToObfuscationTick(() => {});
    expect(vi.getTimerCount()).toBe(1);
    const unsubB = subscribeToObfuscationTick(() => {});
    const unsubC = subscribeToObfuscationTick(() => {});
    // Still exactly one timer — a page with several obfuscated messages on
    // screen at once must not scale interval count with subscriber count.
    expect(vi.getTimerCount()).toBe(1);
    expect(getObfuscationClockDebugInfo()).toEqual({ subscriberCount: 3, intervalActive: true });

    unsubA();
    unsubB();
    unsubC();
  });

  it("tears the interval down once the last subscriber unsubscribes", () => {
    const unsubA = subscribeToObfuscationTick(() => {});
    const unsubB = subscribeToObfuscationTick(() => {});
    unsubA();
    expect(getObfuscationClockDebugInfo()).toEqual({ subscriberCount: 1, intervalActive: true });
    unsubB();
    expect(getObfuscationClockDebugInfo()).toEqual({ subscriberCount: 0, intervalActive: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies every subscriber on every ~50ms tick", () => {
    let countA = 0;
    let countB = 0;
    const unsubA = subscribeToObfuscationTick(() => countA++);
    const unsubB = subscribeToObfuscationTick(() => countB++);

    vi.advanceTimersByTime(50 * 3);

    expect(countA).toBe(3);
    expect(countB).toBe(3);

    unsubA();
    unsubB();
  });

  it("stops notifying a listener once it unsubscribes, without affecting others still subscribed", () => {
    let countA = 0;
    let countB = 0;
    const unsubA = subscribeToObfuscationTick(() => countA++);
    const unsubB = subscribeToObfuscationTick(() => countB++);

    vi.advanceTimersByTime(50);
    unsubA();
    vi.advanceTimersByTime(50 * 4);

    expect(countA).toBe(1);
    expect(countB).toBe(5);

    unsubB();
  });

  it("restarting after everyone unsubscribes works (a fresh interval, not a stale reference)", () => {
    const unsub1 = subscribeToObfuscationTick(() => {});
    unsub1();
    expect(getObfuscationClockDebugInfo().intervalActive).toBe(false);

    let ticks = 0;
    const unsub2 = subscribeToObfuscationTick(() => ticks++);
    expect(getObfuscationClockDebugInfo().intervalActive).toBe(true);
    vi.advanceTimersByTime(50 * 2);
    expect(ticks).toBe(2);
    unsub2();
  });
});

describe("scrambleGlyphs", () => {
  it("preserves overall length and every whitespace character's position", () => {
    const input = "Hi there, friend!";
    const output = scrambleGlyphs(input);
    expect(output.length).toBe(input.length);
    for (let i = 0; i < input.length; i++) {
      if (/\s/.test(input[i])) {
        expect(output[i]).toBe(input[i]);
      }
    }
  });

  it("never crashes on an empty string", () => {
    expect(scrambleGlyphs("")).toBe("");
  });

  it("produces different output across calls (a real scramble, not a static garble)", () => {
    const input = "obfuscatedobfuscatedobfuscatedobfuscated";
    const outputs = new Set<string>();
    for (let i = 0; i < 25; i++) {
      outputs.add(scrambleGlyphs(input));
    }
    // Overwhelmingly unlikely to collide 25 times in a row by chance across
    // a 40+ character string if it's genuinely randomizing each call.
    expect(outputs.size).toBeGreaterThan(1);
  });

  it("never reveals the original non-whitespace characters unchanged across many samples", () => {
    // Not a hard guarantee for any single character on any single call
    // (a random glyph can coincidentally match), but across many samples
    // the scrambled output as a whole should essentially never equal the
    // original text verbatim.
    const input = "SecretMessage";
    let sawOriginal = false;
    for (let i = 0; i < 50; i++) {
      if (scrambleGlyphs(input) === input) sawOriginal = true;
    }
    expect(sawOriginal).toBe(false);
  });
});
