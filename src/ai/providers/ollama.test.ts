import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaChatRequest,
  extractOllamaText,
  generateTextOllama,
  OLLAMA_GENERATION_TIMEOUT_MS,
  OLLAMA_REACHABILITY_TIMEOUT_MS,
} from "./ollama";

afterEach(() => {
  vi.useRealTimers();
});

describe("buildOllamaChatRequest", () => {
  it("builds a non-streaming /api/chat request from the common params", () => {
    const request = buildOllamaChatRequest(
      { system: "You are terse.", prompt: "a suspicious dockworker", maxTokens: 256 },
      "llama3.1:8b"
    ) as Record<string, unknown>;
    expect(request.model).toBe("llama3.1:8b");
    expect(request.stream).toBe(false);
    expect(request.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "a suspicious dockworker" },
    ]);
    expect((request.options as { num_predict: number }).num_predict).toBe(256);
  });
});

describe("extractOllamaText", () => {
  it("pulls the assistant message content out of an /api/chat response", () => {
    expect(extractOllamaText({ message: { role: "assistant", content: "  Hello.  " } })).toBe(
      "Hello."
    );
  });

  it("throws when there is no message content", () => {
    expect(() => extractOllamaText({})).toThrow(/no draft text/);
  });
});

function respondingFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => handler(String(input))) as unknown as typeof fetch;
}

/** A fetch that never settles on its own — only when the caller's
 * AbortSignal fires. Used to prove the reachability probe actually times
 * out on its own short budget instead of hanging indefinitely. */
function neverRespondingFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("The operation was aborted."));
      });
    });
  }) as unknown as typeof fetch;
}

describe("generateTextOllama", () => {
  it("probes /api/version before ever calling /api/chat", async () => {
    const urlsHit: string[] = [];
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urlsHit.push(url);
      if (url.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.20.7" }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: { content: "A dockworker." } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await generateTextOllama(
      { system: "s", prompt: "p", maxTokens: 10 },
      { hostUrl: "http://localhost:11434", model: "llama3.1:8b" },
      { fetch: fakeFetch }
    );

    expect(urlsHit).toEqual([
      "http://localhost:11434/api/version",
      "http://localhost:11434/api/chat",
    ]);
  });

  it("fails fast with a clear, specific error when the host is unreachable — never an indefinite hang", async () => {
    vi.useFakeTimers();
    const promise = generateTextOllama(
      { system: "s", prompt: "p", maxTokens: 10 },
      { hostUrl: "http://unreachable.invalid:11434", model: "llama3.1:8b" },
      { fetch: neverRespondingFetch() }
    );
    const assertion = expect(promise).rejects.toThrow(/reach Ollama/i);
    await vi.advanceTimersByTimeAsync(OLLAMA_REACHABILITY_TIMEOUT_MS);
    await assertion;
  });

  it("reports a clear error when the host responds but with a non-2xx status", async () => {
    const fakeFetch = respondingFetch(() => new Response("not found", { status: 404 }));
    await expect(
      generateTextOllama(
        { system: "s", prompt: "p", maxTokens: 10 },
        { hostUrl: "http://localhost:11434", model: "llama3.1:8b" },
        { fetch: fakeFetch }
      )
    ).rejects.toThrow(/reach Ollama/i);
  });

  it("does NOT apply the short reachability timeout to the real generation call — a slow-but-working generation still succeeds", async () => {
    vi.useFakeTimers();
    // The generation call takes 3x the reachability timeout to resolve —
    // comfortably longer than the reachability budget, comfortably shorter
    // than the generation budget. If the two timeouts were ever conflated,
    // this would be killed early.
    const slowDelayMs = OLLAMA_REACHABILITY_TIMEOUT_MS * 3;
    expect(slowDelayMs).toBeLessThan(OLLAMA_GENERATION_TIMEOUT_MS);

    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/version")) {
        return new Response(JSON.stringify({ version: "0.20.7" }), { status: 200 });
      }
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
            new Response(JSON.stringify({ message: { content: "Slow but working." } }), {
              status: 200,
            })
          );
        }, slowDelayMs);
      });
    }) as unknown as typeof fetch;

    const promise = generateTextOllama(
      { system: "s", prompt: "p", maxTokens: 10 },
      { hostUrl: "http://localhost:11434", model: "llama3.1:8b" },
      { fetch: fakeFetch }
    );
    await vi.advanceTimersByTimeAsync(slowDelayMs + 10);
    await expect(promise).resolves.toBe("Slow but working.");
  });
});
