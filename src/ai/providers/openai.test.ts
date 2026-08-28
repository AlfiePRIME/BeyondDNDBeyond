import { describe, expect, it } from "vitest";
import {
  buildOpenAiChatRequest,
  extractOpenAiText,
  generateTextOpenAI,
  OPENAI_TEXT_MODEL,
} from "./openai";

// No live OpenAI key is available in this environment — every test here
// exercises request-building/response-parsing purely via the injected-
// transport pattern (never a real network call), per this module's own
// testing seam documented in ./types.ts.

describe("buildOpenAiChatRequest", () => {
  it("builds a chat-completions request from the common params", () => {
    const request = buildOpenAiChatRequest({
      system: "You are terse.",
      prompt: "a suspicious dockworker",
      maxTokens: 256,
    }) as Record<string, unknown>;
    expect(request.model).toBe(OPENAI_TEXT_MODEL);
    expect(request.max_tokens).toBe(256);
    expect(request.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "a suspicious dockworker" },
    ]);
  });
});

describe("extractOpenAiText", () => {
  it("pulls the assistant message content out of a chat-completions response", () => {
    const body = { choices: [{ message: { role: "assistant", content: "  Hello there.  " } }] };
    expect(extractOpenAiText(body)).toBe("Hello there.");
  });

  it("throws when there is no choice content", () => {
    expect(() => extractOpenAiText({ choices: [] })).toThrow(/no draft text/);
  });

  it("throws on a malformed body", () => {
    expect(() => extractOpenAiText(null)).toThrow(/no draft text/);
  });
});

describe("generateTextOpenAI", () => {
  it("completes a request end to end via the injected transport: correct URL, auth header, body, and parsed response", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      seen.url = String(input);
      seen.init = init;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "A dockworker with a secret." } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const text = await generateTextOpenAI(
      { system: "You write NPC descriptions.", prompt: "a dockworker", maxTokens: 300 },
      { apiKey: "sk-test-openai-key" },
      { fetch: fakeFetch }
    );

    expect(text).toBe("A dockworker with a secret.");
    expect(seen.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = seen.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test-openai-key");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(seen.init?.body));
    expect(body.model).toBe(OPENAI_TEXT_MODEL);
    expect(body.max_tokens).toBe(300);
    expect(body.messages).toEqual([
      { role: "system", content: "You write NPC descriptions." },
      { role: "user", content: "a dockworker" },
    ]);
  });

  it("throws a clear error on a non-2xx response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("invalid api key", { status: 401 });
    await expect(
      generateTextOpenAI(
        { system: "s", prompt: "p", maxTokens: 10 },
        { apiKey: "bad-key" },
        { fetch: fakeFetch }
      )
    ).rejects.toThrow(/401/);
  });
});
