import type { GenerateTextParams, GenerateTextTransport } from "./types";

/**
 * TWO distinct timeouts, on purpose — conflating them breaks real usage in
 * both directions:
 *
 * - OLLAMA_REACHABILITY_TIMEOUT_MS guards a tiny, near-instant probe
 *   (GET /api/version) whose only job is to fail fast with a clear "can't
 *   reach Ollama at this host" error when the configured host URL is wrong
 *   or the service is down. Measured live against a real local Ollama
 *   instance during development: this responds in single-digit
 *   milliseconds when the service is up, so a few seconds of budget is
 *   already generous slack for a slow LAN/DNS hop, not a real generation
 *   wait.
 * - OLLAMA_GENERATION_TIMEOUT_MS guards the actual /api/chat generation
 *   call, which is genuinely slow on modest hardware: local inference is
 *   CPU/GPU-bound on whatever box is running Ollama, not a fast hosted API.
 *   Measured live in this same environment (llama3.1:8b, Q4_K_M, warm
 *   model already loaded): ~6.5s for a ~340-token response, roughly 50
 *   tokens/sec. This module's own realistic maxTokens (order of a
 *   thousand, e.g. generateDraft.ts's MAX_DRAFT_TOKENS) would comfortably
 *   finish in well under a minute on hardware like this — but a cold model
 *   load adds several more seconds on top, slower/older/more-loaded
 *   hardware or a larger model can easily be several times slower, and
 *   nothing here should punish a real, working, unusually-slow response by
 *   killing it early. Applying the reachability check's few-second budget
 *   to this call would kill genuine, correct generations outright; 3
 *   minutes leaves real headroom for "slow but working" without waiting
 *   indefinitely on a truly wedged request.
 */
export const OLLAMA_REACHABILITY_TIMEOUT_MS = 5_000;
export const OLLAMA_GENERATION_TIMEOUT_MS = 180_000;

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The short reachability probe — deliberately separate from, and much
 * shorter than, the real generation call below. Hits Ollama's own
 * lightweight /api/version endpoint (no model load, no inference) so a
 * wrong host or a down service is reported as a clear, specific error
 * within a few seconds instead of only surfacing much later as a confusing
 * generation-call failure (or, without any timeout at all, an indefinite
 * hang on a host that never responds).
 */
async function checkOllamaReachable(doFetch: typeof fetch, baseUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      doFetch,
      `${baseUrl}/api/version`,
      { method: "GET" },
      OLLAMA_REACHABILITY_TIMEOUT_MS
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach Ollama at ${baseUrl} within ${OLLAMA_REACHABILITY_TIMEOUT_MS / 1000}s ` +
        `(${reason}). Check the configured Ollama host URL and that the service is running.`
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not reach Ollama at ${baseUrl}: the server responded with HTTP ${response.status}.`
    );
  }
}

/** Exported for unit tests — the exact request body sent to Ollama's own
 * /api/chat endpoint. stream: false keeps this a single JSON response,
 * matching this module's non-streaming contract; options.num_predict is
 * Ollama's own name for a generation length cap, the closest equivalent to
 * max_tokens on the other two providers. */
export function buildOllamaChatRequest(
  params: GenerateTextParams,
  model: string
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.prompt },
    ],
    stream: false,
    options: { num_predict: params.maxTokens },
  };
}

/** Exported for unit tests — pulls the generated prose out of a parsed
 * /api/chat JSON response body. */
export function extractOllamaText(body: unknown): string {
  const content = (body as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The model returned no draft text.");
  }
  return content.trim();
}

/**
 * The Ollama implementation of the common generateText interface — a plain
 * fetch to the configured host's own /api/chat endpoint. No SDK: Ollama has
 * no first-party TypeScript SDK to speak of, and its API is a small,
 * stable, self-documented REST surface that a raw fetch call handles
 * completely.
 *
 * config.hostUrl and config.model come from app_settings.ollama_host_url /
 * ollama_model (0072) — both admin-configured, both required for this
 * function to run at all (generateText.ts's dispatcher checks this before
 * calling in).
 */
export async function generateTextOllama(
  params: GenerateTextParams,
  config: { hostUrl: string; model: string },
  transport?: GenerateTextTransport
): Promise<string> {
  const doFetch = transport?.fetch ?? fetch;
  const baseUrl = trimTrailingSlash(config.hostUrl);

  // Reachability first, on its own short timeout — see the module doc
  // comment above for why this must never share a timeout with the real
  // generation call that follows.
  await checkOllamaReachable(doFetch, baseUrl);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      doFetch,
      `${baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildOllamaChatRequest(params, config.model)),
      },
      OLLAMA_GENERATION_TIMEOUT_MS
    );
  } catch (err) {
    throw new Error(
      `Ollama at ${config.hostUrl} did not finish generating within ` +
        `${OLLAMA_GENERATION_TIMEOUT_MS / 1000}s (${err instanceof Error ? err.message : String(err)}).`
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Ollama generation request failed (${response.status}): ${bodyText.slice(0, 500)}`);
  }
  const json = await response.json();
  return extractOllamaText(json);
}
