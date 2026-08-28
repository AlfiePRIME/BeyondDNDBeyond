import { describe, expect, it } from "vitest";
import { resolveOverlaps, type PanelRect, type Rect } from "./panelCollision";

const VIEWPORT = { width: 1440, height: 900 };
const MARGIN = 12;

function rect(left: number, top: number, width: number, height: number): Rect {
  return { left, top, width, height };
}

function panels(entries: Record<string, Rect>): PanelRect[] {
  return Object.entries(entries).map(([id, r]) => ({ id, rect: r }));
}

describe("resolveOverlaps", () => {
  it("does nothing when no panel overlaps the anchor", () => {
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(100, 100, 200, 200),
        b: rect(500, 500, 200, 200),
      }),
      viewport: VIEWPORT,
      margin: MARGIN,
    });
    expect(result.offsets).toEqual({});
    expect(result.docks).toEqual([]);
  });

  it("pushes an overlapping panel along the axis with the smaller overlap", () => {
    // a: 100..300 x 100..300. b: 250..450 x 120..320 — overlaps a by 50px
    // horizontally (300-250) and 180px vertically (300-120), so the
    // minimum-travel push is horizontal, away from a (to the right).
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(100, 100, 200, 200),
        b: rect(250, 120, 200, 200),
      }),
      viewport: VIEWPORT,
      margin: MARGIN,
    });
    expect(result.docks).toEqual([]);
    expect(result.offsets.b).toBeDefined();
    expect(result.offsets.b.dy).toBe(0);
    expect(result.offsets.b.dx).toBeGreaterThan(0);
    // Applying the push should leave the two rectangles no longer
    // overlapping at all.
    const pushed = { ...panels({ b: rect(250, 120, 200, 200) })[0].rect, left: 250 + result.offsets.b.dx };
    expect(pushed.left).toBeGreaterThanOrEqual(300); // a's right edge
  });

  it("pushes vertically when the vertical overlap is smaller", () => {
    // a: 100..300 x 100..300. b: 120..320 x 280..480 — overlaps a by
    // 180px horizontally and 20px vertically, so it should push down.
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(100, 100, 200, 200),
        b: rect(120, 280, 200, 200),
      }),
      viewport: VIEWPORT,
      margin: MARGIN,
    });
    expect(result.offsets.b).toBeDefined();
    expect(result.offsets.b.dx).toBe(0);
    expect(result.offsets.b.dy).toBeGreaterThan(0);
  });

  it("pushes away from the anchor's center, not always in a fixed direction", () => {
    // b is to the LEFT of a this time — the push must be leftward (negative
    // dx), the mirror image of the earlier rightward case.
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(300, 100, 200, 200),
        b: rect(150, 120, 200, 200),
      }),
      viewport: VIEWPORT,
      margin: MARGIN,
    });
    expect(result.offsets.b.dx).toBeLessThan(0);
  });

  it("never moves the anchor itself, even if something is passed for it", () => {
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(100, 100, 200, 200),
        b: rect(250, 120, 200, 200),
      }),
      viewport: VIEWPORT,
      margin: MARGIN,
    });
    expect(result.offsets.a).toBeUndefined();
  });

  it("docks a panel instead of pushing it off-screen", () => {
    // b sits right at the left edge of the viewport, and the anchor
    // overlaps it enough that the only clearing direction is further left
    // — off-screen. It should be docked, not partially pushed.
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(60, 100, 300, 200),
        b: rect(MARGIN, 150, 100, 100),
      }),
      viewport: VIEWPORT,
      margin: MARGIN,
    });
    expect(result.docks).toEqual(["b"]);
    expect(result.offsets.b).toBeUndefined();
  });

  it("docks a panel pushed toward the bottom-right corner off-screen", () => {
    const viewport = { width: 400, height: 300 };
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(50, 50, 300, 200),
        b: rect(250, 150, 140, 140), // hugging the bottom-right corner already
      }),
      viewport,
      margin: MARGIN,
    });
    expect(result.docks).toEqual(["b"]);
  });

  it("cascades a push through a chain of panels", () => {
    // a overlaps b; pushing b to the right lands it on top of c; c must
    // then also get pushed further right to clear b's NEW position. All
    // three sit at top:50 (comfortably clear of the 12px margin), so only
    // the horizontal push matters here.
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(0, 50, 150, 100),
        b: rect(120, 50, 150, 100), // overlaps a by 30px horizontally
        c: rect(260, 50, 150, 100), // doesn't overlap a, but will overlap b once b is pushed to ~270
      }),
      viewport: { width: 2000, height: 900 },
      margin: MARGIN,
    });
    expect(result.docks).toEqual([]);
    expect(result.offsets.b).toBeDefined();
    expect(result.offsets.c).toBeDefined();
    const bFinalLeft = 120 + result.offsets.b.dx;
    const cFinalLeft = 260 + result.offsets.c.dx;
    // b and c must no longer overlap each other after both pushes.
    expect(cFinalLeft).toBeGreaterThanOrEqual(bFinalLeft + 150);
    // ...and neither overlaps the anchor.
    expect(bFinalLeft).toBeGreaterThanOrEqual(150);
  });

  it("returns an empty result if the anchor itself isn't in the panel list", () => {
    const result = resolveOverlaps({
      anchorId: "missing",
      panels: panels({ a: rect(0, 0, 100, 100) }),
      viewport: VIEWPORT,
      margin: MARGIN,
    });
    expect(result.offsets).toEqual({});
    expect(result.docks).toEqual([]);
  });

  it("leaves an already-non-overlapping panel untouched even if another panel is being pushed", () => {
    const result = resolveOverlaps({
      anchorId: "a",
      panels: panels({
        a: rect(0, 50, 150, 100),
        b: rect(120, 50, 150, 100),
        c: rect(1000, 1000, 100, 100), // nowhere near anything
      }),
      viewport: { width: 2000, height: 2000 },
      margin: MARGIN,
    });
    expect(result.offsets.c).toBeUndefined();
  });
});
