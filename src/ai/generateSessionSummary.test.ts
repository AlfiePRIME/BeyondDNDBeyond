import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildSessionSummaryRequest,
  extractSessionSummaryDraft,
  generateSessionSummary,
  SessionSummaryGenerationError,
  SESSION_SUMMARY_MODEL,
  validateGeneratedSessionSummary,
  type SessionSummaryWindow,
} from "./generateSessionSummary";

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

function toolUseMessage(input: unknown): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: SESSION_SUMMARY_MODEL,
    content: [{ type: "tool_use", id: "toolu_test", name: "record_session_summary", input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as Anthropic.Message;
}

const EMPTY_WINDOW: SessionSummaryWindow = {
  campaignName: "The Sunken Spire",
  startedAt: "2026-08-20T19:00:00.000Z",
  endedAt: "2026-08-20T19:00:00.000Z",
  chat: [],
  events: [],
};

const NONEMPTY_WINDOW: SessionSummaryWindow = {
  campaignName: "The Sunken Spire",
  startedAt: "2026-08-20T19:00:00.000Z",
  endedAt: "2026-08-20T22:00:00.000Z",
  chat: [
    // Already-stripped plain text — SessionSummaryChatInput's own doc
    // comment makes stripping B2's "&"-formatting codes the CALLER's job
    // (the end-session-summary route reuses B2's own tested parser for
    // that), not this module's — see generateSessionSummary.ts's own doc
    // comment on SessionSummaryChatInput.
    { senderName: "Aria", body: "Looking for trouble again", createdAt: "2026-08-20T19:05:00.000Z" },
    { senderName: "DM", body: "You spot a glint of metal in the rubble.", createdAt: "2026-08-20T19:06:00.000Z" },
  ],
  events: [
    { category: "interaction", line: 'Aria took "rusty key" from a chest', createdAt: "2026-08-20T19:10:00.000Z" },
    {
      category: "damage",
      line: "Aria: Melee attack vs AC 15 (Goblin) — 18 · Hit — Damage 1d8+3: [5] + 3 = 8 — applied, target at 4 HP",
      createdAt: "2026-08-20T19:15:00.000Z",
    },
  ],
};

const VALID_DRAFT = {
  narrative: "The party pried open a rusted chest and traded blows with a goblin ambush.",
  highlights: [
    { category: "interaction", headline: 'Aria took the rusty key from a chest.' },
    { category: "damage", headline: "Aria dealt 8 damage to the goblin." },
  ],
};

describe("buildSessionSummaryRequest", () => {
  it("forces the structured tool on the Sonnet model", () => {
    const request = buildSessionSummaryRequest(NONEMPTY_WINDOW);
    expect(request.model).toBe(SESSION_SUMMARY_MODEL);
    expect(request.tool_choice).toEqual({ type: "tool", name: "record_session_summary" });
    const tool = request.tools?.[0] as Anthropic.Tool;
    expect(tool.name).toBe("record_session_summary");
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(["narrative", "highlights"]);
  });

  it("interleaves chat and events chronologically", () => {
    const request = buildSessionSummaryRequest(NONEMPTY_WINDOW);
    const content = String(request.messages[0].content);
    expect(content).toContain("The Sunken Spire");
    const chatLineIndex = content.indexOf("Aria (chat): Looking for trouble again");
    const eventLineIndex = content.indexOf('interaction: Aria took "rusty key"');
    const damageLineIndex = content.indexOf("damage: Aria: Melee attack");
    expect(chatLineIndex).toBeGreaterThan(-1);
    expect(eventLineIndex).toBeGreaterThan(chatLineIndex);
    expect(damageLineIndex).toBeGreaterThan(eventLineIndex);
  });

  it("says so explicitly when there is nothing to summarize", () => {
    const request = buildSessionSummaryRequest(EMPTY_WINDOW);
    expect(String(request.messages[0].content)).toContain("no chat or activity recorded");
  });

  it("feeds validation errors back on the retry attempt", () => {
    const request = buildSessionSummaryRequest(NONEMPTY_WINDOW, "a highlight is missing a headline");
    const content = String(request.messages[0].content);
    expect(content).toContain("a highlight is missing a headline");
    expect(content).toContain("rejected");
  });

  it("caps an oversized transcript, keeping the start and end with an omission marker", () => {
    const manyMessages = Array.from({ length: 700 }, (_, index) => ({
      senderName: `Player${index}`,
      body: `message ${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 20, 19, 0, index)).toISOString(),
    }));
    const window: SessionSummaryWindow = { ...NONEMPTY_WINDOW, chat: manyMessages, events: [] };
    const content = String(buildSessionSummaryRequest(window).messages[0].content);
    expect(content).toContain("message 0");
    expect(content).toContain("message 699");
    expect(content).toContain("earlier lines omitted");
    // Well under the raw 700-line input — proves the cap actually trims.
    expect(content.split("\n").length).toBeLessThan(650);
  });
});

describe("extractSessionSummaryDraft", () => {
  it("returns the forced tool call's input", () => {
    expect(extractSessionSummaryDraft(toolUseMessage(VALID_DRAFT))).toEqual(VALID_DRAFT);
  });

  it("throws when the response has no tool_use block", () => {
    const message = {
      ...toolUseMessage(VALID_DRAFT),
      content: [{ type: "text", text: "sorry", citations: null }],
    } as Anthropic.Message;
    expect(() => extractSessionSummaryDraft(message)).toThrow(/no structured session summary/);
  });
});

describe("validateGeneratedSessionSummary", () => {
  it("accepts a fully valid draft", () => {
    expect(validateGeneratedSessionSummary(VALID_DRAFT)).toEqual({ ok: true, summary: VALID_DRAFT });
  });

  it("accepts an empty highlights list — nothing mechanical stood out", () => {
    const draft = { narrative: "A quiet night of tavern talk.", highlights: [] };
    expect(validateGeneratedSessionSummary(draft)).toEqual({ ok: true, summary: draft });
  });

  it("rejects a draft that isn't the expected shape", () => {
    expect(validateGeneratedSessionSummary(null).ok).toBe(false);
    expect(validateGeneratedSessionSummary("nope").ok).toBe(false);
    expect(validateGeneratedSessionSummary({ narrative: "ok" }).ok).toBe(false);
    expect(validateGeneratedSessionSummary({ highlights: [] }).ok).toBe(false);
  });

  it("rejects an empty or whitespace-only narrative", () => {
    expect(validateGeneratedSessionSummary({ narrative: "", highlights: [] }).ok).toBe(false);
    expect(validateGeneratedSessionSummary({ narrative: "   ", highlights: [] }).ok).toBe(false);
  });

  it("rejects a highlight with an invalid category or missing headline", () => {
    const badCategory = { narrative: "x", highlights: [{ category: "loot", headline: "y" }] };
    const missingHeadline = { narrative: "x", highlights: [{ category: "other", headline: "" }] };
    expect(validateGeneratedSessionSummary(badCategory).ok).toBe(false);
    expect(validateGeneratedSessionSummary(missingHeadline).ok).toBe(false);
  });

  it("trims narrative and headline whitespace and caps an overlong headline", () => {
    const draft = {
      narrative: "  Trimmed.  ",
      highlights: [{ category: "other", headline: `  ${"x".repeat(400)}  ` }],
    };
    const result = validateGeneratedSessionSummary(draft);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.summary.narrative).toBe("Trimmed.");
      expect(result.summary.highlights[0].headline).toHaveLength(300);
    }
  });

  it("caps the number of highlights kept from a single generation", () => {
    const draft = {
      narrative: "x",
      highlights: Array.from({ length: 60 }, (_, index) => ({ category: "other", headline: `h${index}` })),
    };
    const result = validateGeneratedSessionSummary(draft);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.summary.highlights.length).toBeLessThanOrEqual(40);
  });
});

describe("generateSessionSummary", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  function fakeTransport(responses: unknown[]): {
    fetch: typeof fetch;
    requests: { body: Record<string, unknown> }[];
  } {
    const requests: { body: Record<string, unknown> }[] = [];
    const transport: typeof fetch = async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)) });
      const draft = responses[Math.min(requests.length - 1, responses.length - 1)];
      return new Response(JSON.stringify(toolUseMessage(draft)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { fetch: transport, requests };
  }

  it("returns an explicitly-empty summary for an empty window without calling the API, even unconfigured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    const summary = await generateSessionSummary(EMPTY_WINDOW, { fetch: spy });
    expect(summary).toEqual({ narrative: "", highlights: [] });
    expect(called).toBe(false);
  });

  it("throws without a configured key for a non-empty window", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(generateSessionSummary(NONEMPTY_WINDOW)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("returns a validated summary on the first attempt", async () => {
    const { fetch: transport, requests } = fakeTransport([VALID_DRAFT]);
    const summary = await generateSessionSummary(NONEMPTY_WINDOW, { fetch: transport });
    expect(summary).toEqual(VALID_DRAFT);
    expect(requests).toHaveLength(1);
  });

  it("retries exactly once with the validation errors as feedback", async () => {
    const invalid = { narrative: "", highlights: [] };
    const { fetch: transport, requests } = fakeTransport([invalid, VALID_DRAFT]);
    const summary = await generateSessionSummary(NONEMPTY_WINDOW, { fetch: transport });
    expect(summary).toEqual(VALID_DRAFT);
    expect(requests).toHaveLength(2);
    const retryContent = String((requests[1].body.messages as { content: string }[])[0].content);
    expect(retryContent).toContain("narrative must not be empty");
  });

  it("throws SessionSummaryGenerationError after two invalid attempts", async () => {
    const invalid = { narrative: "", highlights: [] };
    const { fetch: transport } = fakeTransport([invalid, invalid]);
    await expect(generateSessionSummary(NONEMPTY_WINDOW, { fetch: transport })).rejects.toThrow(
      SessionSummaryGenerationError
    );
  });
});
