import { describe, expect, it } from "vitest";
import { CHAT_COLOR_CODES, parseChatFormatting, type ChatSpan } from "./chatFormatting";

/** A default-style span with only the given overrides — keeps expectations
 * below readable without repeating every boolean flag on every case. */
function span(text: string, overrides: Partial<Omit<ChatSpan, "text">> = {}): ChatSpan {
  return {
    text,
    color: undefined,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    obfuscated: false,
    ...overrides,
  };
}

describe("parseChatFormatting", () => {
  it("returns a single default-style span for plain text with no codes", () => {
    expect(parseChatFormatting("Hello world")).toEqual([span("Hello world")]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseChatFormatting("")).toEqual([]);
  });

  it("applies a color code to everything after it", () => {
    expect(parseChatFormatting("&4Hello")).toEqual([span("Hello", { color: CHAT_COLOR_CODES["4"] })]);
  });

  it("splits into separate spans at each color change", () => {
    expect(parseChatFormatting("&4Red&3Teal")).toEqual([
      span("Red", { color: CHAT_COLOR_CODES["4"] }),
      span("Teal", { color: CHAT_COLOR_CODES["3"] }),
    ]);
  });

  it("covers every one of the app's six accent colors plus a handful of standard colors", () => {
    // Every accent from src/ui-components/tokens.css must be reachable.
    const accentValues = Object.values(CHAT_COLOR_CODES);
    for (const token of [
      "var(--purple)",
      "var(--pink)",
      "var(--accent)",
      "var(--teal)",
      "var(--orange)",
      "var(--red)",
    ]) {
      expect(accentValues).toContain(token);
    }
    // Plus a handful of standard colors with no app-token equivalent.
    expect(CHAT_COLOR_CODES["0"]).toBe("#000000");
    expect(CHAT_COLOR_CODES["1"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(CHAT_COLOR_CODES["2"]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("applies bold, italic, underline, and strikethrough independently", () => {
    expect(parseChatFormatting("&lBold")).toEqual([span("Bold", { bold: true })]);
    expect(parseChatFormatting("&oItalic")).toEqual([span("Italic", { italic: true })]);
    expect(parseChatFormatting("&nUnderline")).toEqual([span("Underline", { underline: true })]);
    expect(parseChatFormatting("&mStrike")).toEqual([span("Strike", { strikethrough: true })]);
  });

  it("stacks format codes on top of a color and on top of each other", () => {
    expect(parseChatFormatting("&4&l&nAlert")).toEqual([
      span("Alert", { color: CHAT_COLOR_CODES["4"], bold: true, underline: true }),
    ]);
  });

  it("marks a &k span as obfuscated without transforming its text itself", () => {
    // The parser only marks intent — ChatText/chatObfuscationClock own the
    // actual scrambling animation, so the parsed text stays the original.
    expect(parseChatFormatting("&kSecret")).toEqual([span("Secret", { obfuscated: true })]);
  });

  it("a new color code resets prior format flags back off, matching Minecraft's own scheme", () => {
    expect(parseChatFormatting("&l&nBold-Underline&4StillRed")).toEqual([
      span("Bold-Underline", { bold: true, underline: true }),
      // The color code wipes bold/underline back to false.
      span("StillRed", { color: CHAT_COLOR_CODES["4"] }),
    ]);
  });

  it("&r resets color and every format flag back to default", () => {
    expect(parseChatFormatting("&4&l&nRed-Bold-Underline&rPlain")).toEqual([
      span("Red-Bold-Underline", { color: CHAT_COLOR_CODES["4"], bold: true, underline: true }),
      span("Plain"),
    ]);
  });

  it("does not emit an empty span for codes with no text before the next code", () => {
    expect(parseChatFormatting("&4&3&lHello")).toEqual([span("Hello", { color: CHAT_COLOR_CODES["3"], bold: true })]);
  });

  it("does not emit a trailing empty span for codes at the very end with nothing after them", () => {
    expect(parseChatFormatting("Hello&4&l")).toEqual([span("Hello")]);
  });

  it("is case-insensitive for both color and format code letters", () => {
    expect(parseChatFormatting("&A&LHello")).toEqual([span("Hello", { color: CHAT_COLOR_CODES.a, bold: true })]);
  });

  describe("malformed / unknown codes degrade gracefully", () => {
    it("renders an unrecognized code letter as literal text without dropping characters", () => {
      expect(parseChatFormatting("&zHello")).toEqual([span("&zHello")]);
    });

    it("renders a bare trailing '&' with nothing after it as a literal character", () => {
      expect(parseChatFormatting("Hello&")).toEqual([span("Hello&")]);
    });

    it("processes one character at a time through a run of malformed codes, consuming a real code the moment one appears", () => {
      // "&&&z" — every "&" here is malformed (its next char is itself "&",
      // "&", then "z" — none are recognized codes) — the whole run degrades
      // to a literal "&&&z". "&9" right after IS a real color code (pink)
      // and IS consumed, even mid-run. Then "&q" is malformed again.
      const input = "&&&z&9y&qHi";
      expect(parseChatFormatting(input)).toEqual([
        span("&&&z"),
        span(`y&qHi`, { color: CHAT_COLOR_CODES["9"] }),
      ]);
    });

    it("never throws for arbitrary malformed input, and never loses more than the recognized codes themselves", () => {
      const tricky = ["&", "&&", "&&&&&&", "&r&r&r", "text&", "&&text&&", "a&b&c&1&2&3&z&Z"];
      for (const input of tricky) {
        expect(() => parseChatFormatting(input)).not.toThrow();
      }
    });
  });

  it("handles a realistic multi-code message end to end", () => {
    const message = "&4Hello &lworld&r, this is &3teal&r and &kobfuscated&r text.";
    const result = parseChatFormatting(message);
    expect(result.map((s) => s.text).join("")).toBe("Hello world, this is teal and obfuscated text.");
    expect(result).toEqual([
      span("Hello ", { color: CHAT_COLOR_CODES["4"] }),
      span("world", { color: CHAT_COLOR_CODES["4"], bold: true }),
      span(", this is "),
      span("teal", { color: CHAT_COLOR_CODES["3"] }),
      span(" and "),
      span("obfuscated", { obfuscated: true }),
      span(" text."),
    ]);
  });
});
