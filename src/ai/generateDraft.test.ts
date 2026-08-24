import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildDraftRequest,
  extractDraftText,
  generateNarrativeDraft,
  isAiConfigured,
  MAX_PROMPT_CHARS,
} from "./generateDraft";

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

function fakeMessage(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as Anthropic.Message;
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

describe("isAiConfigured", () => {
  it("is false with no ANTHROPIC_API_KEY", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isAiConfigured()).toBe(false);
  });

  it("is true when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(isAiConfigured()).toBe(true);
  });
});

describe("buildDraftRequest", () => {
  it("sends the DM's brief as the user message on the Haiku model", () => {
    const request = buildDraftRequest("a suspicious dockworker", "npc");
    expect(request.model).toBe("claude-haiku-4-5-20251001");
    expect(request.messages).toEqual([{ role: "user", content: "a suspicious dockworker" }]);
    expect(request.max_tokens).toBeGreaterThan(0);
  });

  it("tailors the system prompt per kind", () => {
    const npc = buildDraftRequest("x", "npc");
    const lore = buildDraftRequest("x", "lore");
    expect(npc.system).not.toBe(lore.system);
    expect(String(npc.system)).toContain("non-player character");
    expect(String(lore.system)).toContain("lore");
  });
});

describe("extractDraftText", () => {
  it("joins and trims text blocks", () => {
    const message = fakeMessage([textBlock("  First paragraph."), textBlock("Second.  ")]);
    expect(extractDraftText(message)).toBe("First paragraph.\nSecond.");
  });

  it("throws when the response has no text", () => {
    expect(() => extractDraftText(fakeMessage([]))).toThrow(/no draft text/);
  });
});

describe("generateNarrativeDraft", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  it("throws without a configured key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(generateNarrativeDraft("a ruined tower", "lore")).rejects.toThrow(
      /ANTHROPIC_API_KEY/
    );
  });

  it("throws on an empty prompt without calling the API", async () => {
    let called = false;
    const fetchSpy: typeof fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    await expect(generateNarrativeDraft("   ", "npc", { fetch: fetchSpy })).rejects.toThrow(
      /prompt is required/
    );
    expect(called).toBe(false);
  });

  it("returns the draft text from an injected fake transport", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.url = String(input);
      seen.body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify(fakeMessage([textBlock("A weathered dockworker with restless eyes.")])),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const draft = await generateNarrativeDraft(
      "a suspicious dockworker who's secretly a smuggler",
      "npc",
      { fetch: fakeFetch }
    );

    expect(draft).toBe("A weathered dockworker with restless eyes.");
    expect(seen.url).toContain("/v1/messages");
    expect(seen.body?.model).toBe("claude-haiku-4-5-20251001");
    expect(seen.body?.messages).toEqual([
      { role: "user", content: "a suspicious dockworker who's secretly a smuggler" },
    ]);
  });

  it("caps overlong prompts at MAX_PROMPT_CHARS", async () => {
    let sentPrompt = "";
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { content: string }[];
      };
      sentPrompt = body.messages[0].content;
      return new Response(JSON.stringify(fakeMessage([textBlock("ok")])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await generateNarrativeDraft("x".repeat(MAX_PROMPT_CHARS + 100), "lore", {
      fetch: fakeFetch,
    });
    expect(sentPrompt).toHaveLength(MAX_PROMPT_CHARS);
  });
});
