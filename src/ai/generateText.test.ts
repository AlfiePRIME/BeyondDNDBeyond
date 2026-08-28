import { afterEach, describe, expect, it, vi } from "vitest";

// Mock every dependency generateText() dispatches to, so this file tests
// ONLY the dispatch logic itself: given a resolved provider, does the right
// underlying provider function get called with the right arguments? Each
// provider's own request-building/response-parsing/timeout behavior has its
// own dedicated test file (./providers/*.test.ts).
const mocks = vi.hoisted(() => ({
  resolveActiveProvider: vi.fn(),
  generateTextAnthropic: vi.fn(async () => "anthropic text"),
  generateTextOpenAI: vi.fn(async () => "openai text"),
  generateTextOllama: vi.fn(async () => "ollama text"),
}));
vi.mock("./activeProvider", () => ({ resolveActiveProvider: mocks.resolveActiveProvider }));
vi.mock("./providers/anthropic", () => ({ generateTextAnthropic: mocks.generateTextAnthropic }));
vi.mock("./providers/openai", () => ({ generateTextOpenAI: mocks.generateTextOpenAI }));
vi.mock("./providers/ollama", () => ({ generateTextOllama: mocks.generateTextOllama }));

import { generateText } from "./generateText";

const PARAMS = { system: "s", prompt: "p", maxTokens: 100 };

afterEach(() => {
  vi.clearAllMocks();
});

describe("generateText", () => {
  it("dispatches to the Anthropic provider when active_provider is anthropic", async () => {
    mocks.resolveActiveProvider.mockResolvedValue({ provider: "anthropic" });
    await expect(generateText(PARAMS)).resolves.toBe("anthropic text");
    expect(mocks.generateTextAnthropic).toHaveBeenCalledWith(PARAMS, undefined);
    expect(mocks.generateTextOpenAI).not.toHaveBeenCalled();
    expect(mocks.generateTextOllama).not.toHaveBeenCalled();
  });

  it("dispatches to the OpenAI provider, with its resolved key, when active_provider is openai", async () => {
    mocks.resolveActiveProvider.mockResolvedValue({ provider: "openai", openaiApiKey: "sk-test" });
    const transport = { fetch: vi.fn() };
    await expect(generateText(PARAMS, transport)).resolves.toBe("openai text");
    expect(mocks.generateTextOpenAI).toHaveBeenCalledWith(PARAMS, { apiKey: "sk-test" }, transport);
    expect(mocks.generateTextAnthropic).not.toHaveBeenCalled();
    expect(mocks.generateTextOllama).not.toHaveBeenCalled();
  });

  it("dispatches to the Ollama provider, with its resolved host+model, when active_provider is ollama", async () => {
    mocks.resolveActiveProvider.mockResolvedValue({
      provider: "ollama",
      ollamaHostUrl: "http://localhost:11434",
      ollamaModel: "llama3.1:8b",
    });
    await expect(generateText(PARAMS)).resolves.toBe("ollama text");
    expect(mocks.generateTextOllama).toHaveBeenCalledWith(
      PARAMS,
      { hostUrl: "http://localhost:11434", model: "llama3.1:8b" },
      undefined
    );
    expect(mocks.generateTextAnthropic).not.toHaveBeenCalled();
    expect(mocks.generateTextOpenAI).not.toHaveBeenCalled();
  });

  it("switching the active provider between calls changes which backend the next call uses", async () => {
    mocks.resolveActiveProvider.mockResolvedValueOnce({ provider: "anthropic" });
    await expect(generateText(PARAMS)).resolves.toBe("anthropic text");

    mocks.resolveActiveProvider.mockResolvedValueOnce({
      provider: "ollama",
      ollamaHostUrl: "http://localhost:11434",
      ollamaModel: "llama3.1:8b",
    });
    await expect(generateText(PARAMS)).resolves.toBe("ollama text");

    expect(mocks.generateTextAnthropic).toHaveBeenCalledTimes(1);
    expect(mocks.generateTextOllama).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when OpenAI is active but no key is configured, without calling the provider", async () => {
    mocks.resolveActiveProvider.mockResolvedValue({ provider: "openai", openaiApiKey: undefined });
    await expect(generateText(PARAMS)).rejects.toThrow(/OpenAI.*no API key/i);
    expect(mocks.generateTextOpenAI).not.toHaveBeenCalled();
  });

  it("throws a clear error when Ollama is active but host/model are incomplete, without calling the provider", async () => {
    mocks.resolveActiveProvider.mockResolvedValue({
      provider: "ollama",
      ollamaHostUrl: "http://localhost:11434",
      ollamaModel: undefined,
    });
    await expect(generateText(PARAMS)).rejects.toThrow(/Ollama.*not configured/i);
    expect(mocks.generateTextOllama).not.toHaveBeenCalled();
  });
});
