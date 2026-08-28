import type { GenerateTextParams, GenerateTextTransport } from "./types";

/**
 * gpt-4o-mini: OpenAI's own fast/cheap chat-completions tier, the closest
 * analog to ANTHROPIC_TEXT_MODEL's role (claude-haiku-4-5) in this module —
 * a short, schema-free creative draft doesn't need a frontier-reasoning
 * model, and whoever is waiting on this (a DM in a modal) is latency-
 * sensitive. Not user-configurable: app_settings (0072) only stores the
 * OpenAI *key*, not a model id, so this is the one fixed choice for the
 * "openai" provider, matching how ANTHROPIC_TEXT_MODEL is likewise a fixed
 * constant rather than admin-configurable.
 */
export const OPENAI_TEXT_MODEL = "gpt-4o-mini";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

// A hosted, generally-reliable API (unlike Ollama, which this app itself
// might be pointed at a misconfigured or down host) — one straightforward
// timeout is enough here. A wrong/expired key or bad request surfaces
// immediately as a non-2xx response, not a hang; this timeout exists only
// to bound a genuinely stuck connection (e.g. a network partition) rather
// than to distinguish "unreachable" from "slow," the way Ollama's two
// timeouts have to.
const OPENAI_REQUEST_TIMEOUT_MS = 60_000;

/** Exported for unit tests — the exact request body sent to OpenAI's
 * chat-completions endpoint. */
export function buildOpenAiChatRequest(params: GenerateTextParams): Record<string, unknown> {
  return {
    model: OPENAI_TEXT_MODEL,
    max_tokens: params.maxTokens,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.prompt },
    ],
  };
}

/** Exported for unit tests — pulls the generated prose out of a parsed
 * chat-completions JSON response body. Returns unknown-shaped input as a
 * parameter (not Response) so tests can exercise it without a real fetch
 * Response object. */
export function extractOpenAiText(body: unknown): string {
  const choice = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)
    ?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("The model returned no draft text.");
  }
  return content.trim();
}

/**
 * The OpenAI implementation of the common generateText interface — a plain
 * `fetch` call to the chat-completions endpoint, deliberately NOT the
 * `openai` npm package. Reasoning: the interface this module needs from
 * OpenAI is exactly one thing — send {system, user, max_tokens}, read back
 * one message's text — a single REST round trip with no streaming, no
 * Assistants/Files/Batches surface, nothing the `openai` SDK's much larger
 * dependency and API surface would buy over `fetch` for. Staying on `fetch`
 * also means every provider in this directory shares the exact same
 * `transport.fetch` testing seam (see ./types.ts) instead of Anthropic
 * having one seam (its SDK's built-in fetch injection) and OpenAI having a
 * different one (an SDK-specific client/test-double mechanism) — one fewer
 * inconsistency to reason about when writing or reading tests across all
 * three providers. If a future prompt needs more of OpenAI's API surface
 * (streaming, structured outputs, etc.), reconsider then; a defensive
 * eslint-plugin-boundaries rule already exists in eslint.config.mjs so that
 * decision, if made, still keeps src/ai the sole importer.
 *
 * config.apiKey comes from app_settings.openai_api_key (0072) — this
 * function never reads it from anywhere else, and never persists or logs
 * it.
 */
export async function generateTextOpenAI(
  params: GenerateTextParams,
  config: { apiKey: string },
  transport?: GenerateTextTransport
): Promise<string> {
  const doFetch = transport?.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildOpenAiChatRequest(params)),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `OpenAI request did not complete within ${OPENAI_REQUEST_TIMEOUT_MS / 1000}s.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(`OpenAI request failed (${response.status}): ${bodyText.slice(0, 500)}`);
  }
  const json = await response.json();
  return extractOpenAiText(json);
}
