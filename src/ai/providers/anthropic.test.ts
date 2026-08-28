import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_TEXT_MODEL,
  buildAnthropicTextRequest,
  extractAnthropicText,
  generateTextAnthropic,
  isAnthropicConfigured,
} from "./anthropic";

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
    model: ANTHROPIC_TEXT_MODEL,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as Anthropic.Message;
}

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null };
}

describe("isAnthropicConfigured", () => {
  it("is false with no ANTHROPIC_API_KEY", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(isAnthropicConfigured()).toBe(false);
  });

  it("is true when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(isAnthropicConfigured()).toBe(true);
  });
});

describe("buildAnthropicTextRequest", () => {
  it("builds a non-streaming Messages API request from the common params", () => {
    const request = buildAnthropicTextRequest({
      system: "You are terse.",
      prompt: "a suspicious dockworker",
      maxTokens: 1024,
    });
    expect(request.model).toBe(ANTHROPIC_TEXT_MODEL);
    expect(request.system).toBe("You are terse.");
    expect(request.max_tokens).toBe(1024);
    expect(request.messages).toEqual([{ role: "user", content: "a suspicious dockworker" }]);
  });
});

describe("extractAnthropicText", () => {
  it("joins and trims text blocks", () => {
    const message = fakeMessage([textBlock("  First paragraph."), textBlock("Second.  ")]);
    expect(extractAnthropicText(message)).toBe("First paragraph.\nSecond.");
  });

  it("throws when the response has no text", () => {
    expect(() => extractAnthropicText(fakeMessage([]))).toThrow(/no draft text/);
  });
});

describe("generateTextAnthropic", () => {
  it("throws without a configured key, never touching the network", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    let called = false;
    const fetchSpy: typeof fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    await expect(
      generateTextAnthropic({ system: "s", prompt: "p", maxTokens: 100 }, { fetch: fetchSpy })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(called).toBe(false);
  });

  it("completes a real generation request end to end via the injected transport", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.url = String(input);
      seen.body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify(fakeMessage([textBlock("A weathered dockworker with restless eyes.")])),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const text = await generateTextAnthropic(
      { system: "You write NPC descriptions.", prompt: "a dockworker", maxTokens: 512 },
      { fetch: fakeFetch }
    );

    expect(text).toBe("A weathered dockworker with restless eyes.");
    expect(seen.url).toContain("/v1/messages");
    expect(seen.body?.model).toBe(ANTHROPIC_TEXT_MODEL);
    expect(seen.body?.system).toBe("You write NPC descriptions.");
    expect(seen.body?.max_tokens).toBe(512);
  });
});
