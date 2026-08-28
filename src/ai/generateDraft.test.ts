import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// generateNarrativeDraft now delegates provider selection to generateText(),
// which in turn calls activeProvider.ts's resolveActiveProvider()/
// isAiConfigured() — both of which do a real (service-role) Supabase read
// in production. Mocking this one module keeps these tests hermetic (no
// real database, matching this project's existing unit-test convention of
// stubbing at the Supabase-client boundary) while leaving generateText.ts
// and every providers/*.ts file itself real — these tests still exercise
// the genuine generateDraft -> generateText -> provider -> fetch wiring,
// which is the whole point of the "switching the active provider changes
// which backend actually runs" acceptance bar.
interface MockResolvedProvider {
  provider: "anthropic" | "openai" | "ollama";
  openaiApiKey?: string;
  ollamaHostUrl?: string;
  ollamaModel?: string;
}

const activeProviderMocks = vi.hoisted(() => ({
  isAiConfigured: vi.fn(async () => true),
  resolveActiveProvider: vi.fn(
    async (): Promise<MockResolvedProvider> => ({ provider: "anthropic" })
  ),
}));
vi.mock("./activeProvider", () => activeProviderMocks);

import { generateNarrativeDraft, MAX_PROMPT_CHARS, MODEL } from "./generateDraft";

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  activeProviderMocks.isAiConfigured.mockReset().mockResolvedValue(true);
  activeProviderMocks.resolveActiveProvider.mockReset().mockResolvedValue({ provider: "anthropic" });
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

describe("generateNarrativeDraft", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  it("throws when isAiConfigured() resolves false — no active provider ready", async () => {
    activeProviderMocks.isAiConfigured.mockResolvedValue(false);
    let called = false;
    const fetchSpy: typeof fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    await expect(
      generateNarrativeDraft("a ruined tower", "lore", { fetch: fetchSpy })
    ).rejects.toThrow(/not configured/);
    expect(called).toBe(false);
  });

  it("throws on an empty prompt without calling generateText at all", async () => {
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

  it("returns the draft text from an injected fake transport (Anthropic, the default active provider)", async () => {
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
    expect(seen.body?.model).toBe(MODEL);
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

  it("switching the active provider changes which backend generateNarrativeDraft actually calls", async () => {
    activeProviderMocks.resolveActiveProvider.mockResolvedValue({
      provider: "ollama",
      ollamaHostUrl: "http://fake-ollama.test:11434",
      ollamaModel: "llama3.1:8b",
    });
    const urlsHit: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      urlsHit.push(url);
      if (url.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.0.0" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ message: { role: "assistant", content: "An Ollama-generated dockworker." } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const draft = await generateNarrativeDraft("a dockworker", "npc", { fetch: fakeFetch });

    expect(draft).toBe("An Ollama-generated dockworker.");
    expect(urlsHit.some((url) => url.endsWith("/api/version"))).toBe(true);
    expect(urlsHit.some((url) => url.endsWith("/api/chat"))).toBe(true);
    // Never touched Anthropic's endpoint once Ollama became the active provider.
    expect(urlsHit.some((url) => url.includes("/v1/messages"))).toBe(false);
  });
});
