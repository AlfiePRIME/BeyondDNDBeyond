import { describe, expect, it } from "vitest";
import { PAGE_HEIGHT_PT, PAGE_WIDTH_PT, ptBoxToPixelRect } from "./regions";

describe("ptBoxToPixelRect", () => {
  it("matches poppler's real 200dpi output size for a full page", () => {
    const rect = ptBoxToPixelRect({ xPt: 0, yTopPt: PAGE_HEIGHT_PT, wPt: PAGE_WIDTH_PT, hPt: PAGE_HEIGHT_PT }, 200);
    // Confirmed against a real pdftoppm -r 200 render: 1700x2200px.
    expect(rect).toEqual({ left: 0, top: 0, width: 1700, height: 2200 });
  });

  it("flips the y-axis (PDF origin bottom-left → pixel origin top-left)", () => {
    const rect = ptBoxToPixelRect({ xPt: 0, yTopPt: 100, wPt: 10, hPt: 10 }, 72);
    // At 1:1 scale, a box whose top edge is 100pt up from the bottom sits
    // (792 - 100) = 692px down from the top of the page.
    expect(rect.top).toBe(692);
  });
});
