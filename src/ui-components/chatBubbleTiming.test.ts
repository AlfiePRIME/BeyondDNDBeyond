import { describe, expect, it } from "vitest";
import { computeChatBubbleDurationMs } from "./chatBubbleTiming";

describe("computeChatBubbleDurationMs", () => {
  it("returns exactly the 5-second floor for a short message", () => {
    expect(computeChatBubbleDurationMs("hi")).toBe(5000);
  });

  it("returns exactly the floor at the base-length boundary (20 characters)", () => {
    expect(computeChatBubbleDurationMs("a".repeat(20))).toBe(5000);
  });

  it("scales up beyond the base length", () => {
    const short = computeChatBubbleDurationMs("a".repeat(20));
    const longer = computeChatBubbleDurationMs("a".repeat(40));
    expect(longer).toBeGreaterThan(short);
  });

  it("is monotonically non-decreasing with message length", () => {
    const lengths = [0, 5, 20, 21, 50, 100, 200, 500];
    const durations = lengths.map((length) => computeChatBubbleDurationMs("a".repeat(length)));
    for (let i = 1; i < durations.length; i++) {
      expect(durations[i]).toBeGreaterThanOrEqual(durations[i - 1]);
    }
  });

  it("caps out at a maximum duration for a very long message", () => {
    const veryLong = computeChatBubbleDurationMs("a".repeat(5000));
    const evenLonger = computeChatBubbleDurationMs("a".repeat(10000));
    expect(veryLong).toBe(evenLonger);
    expect(veryLong).toBeLessThanOrEqual(20000);
  });

  it("counts the raw string length, formatting codes and all", () => {
    // "&c" + "&l" are two literal 2-character codes on top of "Hi" — the raw
    // length (6) is what's counted, not the rendered length (2), per this
    // module's own doc comment.
    expect(computeChatBubbleDurationMs("&c&lHi")).toBe(computeChatBubbleDurationMs("XXXXXX"));
  });
});
