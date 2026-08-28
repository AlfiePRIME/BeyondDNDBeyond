import Anthropic from "@anthropic-ai/sdk";
import type { GenerateTextParams, GenerateTextTransport } from "./types";

// Sonnet 5: upgraded from Haiku 4.5 per the project owner's request, for
// better narrative-generation quality — re-exported from here as `MODEL` for
// generateMapArea.ts's own direct (structured, forced-tool-use) Anthropic
// call, which is out of scope for the provider-switching this file's
// generateTextAnthropic implements. See this directory's README for why
// that one stays Anthropic-only for now.
export const ANTHROPIC_TEXT_MODEL = "claude-sonnet-5";

/** Exported for unit tests — the exact request body sent to the Messages
 * API. Behavior unchanged from generateDraft.ts's pre-D3 buildDraftRequest:
 * same model, same non-streaming shape, just parameterized by the common
 * {system, prompt, maxTokens} interface instead of a domain-specific
 * (prompt, kind) pair. */
export function buildAnthropicTextRequest(
  params: GenerateTextParams
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: ANTHROPIC_TEXT_MODEL,
    max_tokens: params.maxTokens,
    system: params.system,
    messages: [{ role: "user", content: params.prompt }],
  };
}

/** Exported for unit tests — pulls the generated prose out of an API
 * response. Identical logic to generateDraft.ts's pre-D3 extractDraftText. */
export function extractAnthropicText(message: Anthropic.Message): string {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("The model returned no draft text.");
  }
  return text;
}

/**
 * Whether Anthropic SPECIFICALLY is configured — its own env var, unrelated
 * to app_settings.active_provider. Synchronous and side-effect-free: no
 * database read, since the two callers below never consult active_provider
 * at all.
 *
 * Used only by generateMapArea.ts and generateSessionSummary.ts (and the
 * map editor's own page-level gate for its "Generate Area" tool) — both
 * still Anthropic-only regardless of the admin's chosen active provider,
 * because both rely on Anthropic's forced-tool-use structured output, a
 * capability the common generateText() interface (plain text in, plain
 * text out) doesn't cover for the other two providers. Gating them on the
 * multi-provider-aware isAiConfigured() instead would be a real bug: if an
 * admin switches active_provider to "ollama", isAiConfigured() correctly
 * starts reflecting Ollama's readiness, but generateMapArea/
 * generateSessionSummary would still only ever call Anthropic — so a
 * "Generate Area" button that lit up because Ollama was configured would
 * fail every time. Gating these two on Anthropic's own readiness instead
 * keeps them exactly as available as they were before D1/D2/D3 introduced
 * other providers at all.
 */
export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * The Anthropic implementation of the common generateText interface.
 * Behavior and output unchanged from generateDraft.ts's pre-D3 direct
 * Anthropic call: same client construction (including the `transport.fetch`
 * injection seam and ANTHROPIC_BASE_URL honoring, both handled by the SDK
 * itself), same model, same request/response shape. Requires
 * ANTHROPIC_API_KEY — callers should gate on isAiConfigured() first, same
 * as before. Anthropic's own credential deliberately stays exactly where it
 * was pre-D1 (the env var, read directly here) — see migration 0072's own
 * comment on why it was never moved into app_settings alongside the two new
 * providers.
 */
export async function generateTextAnthropic(
  params: GenerateTextParams,
  transport?: GenerateTextTransport
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  const client = new Anthropic({ fetch: transport?.fetch });
  const message = await client.messages.create(buildAnthropicTextRequest(params));
  return extractAnthropicText(message);
}
