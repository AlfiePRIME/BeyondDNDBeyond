/**
 * AI Backend & Admin D3's common internal interface — every provider
 * implementation in this directory (anthropic.ts, openai.ts, ollama.ts)
 * exposes a `generateText(params, transport?) => Promise<string>` function
 * matching this shape. generateText.ts (one level up) is the only thing
 * that picks between them, based on app_settings.active_provider.
 *
 * Deliberately plain-text in, plain-text out — this is NOT a replacement
 * for generateMapArea.ts/generateSessionSummary.ts's own structured,
 * forced-tool-use calls (schema-constrained JSON output). Those stay
 * Anthropic-specific for now: forcing an equivalent strict-schema contract
 * across three genuinely different provider APIs (Anthropic's forced tool
 * use, OpenAI's function calling, Ollama's much more model-dependent
 * support for either) is a materially bigger, separate problem than the one
 * this prompt asks for, and nothing here forecloses adding it later — see
 * this directory's README.
 */
export interface GenerateTextParams {
  /** The system prompt — instructions, tone, and constraints for the
   * generation, kept separate from the user's own content everywhere a
   * provider's API supports that distinction (all three do). */
  system: string;
  /** The user-authored content to generate from (already trimmed/capped by
   * the caller — see e.g. generateDraft.ts's MAX_PROMPT_CHARS). */
  prompt: string;
  /** Upper bound on generated output length, in the units each provider's
   * own API expects (max_tokens for Anthropic/OpenAI, num_predict for
   * Ollama) — close enough in practice across providers that one caller-
   * supplied number is a reasonable common contract, without pretending
   * token boundaries are identical across tokenizers. */
  maxTokens: number;
}

/**
 * The shared testing seam across all three providers: inject a fetch
 * implementation so unit tests never make a real network call (Anthropic's
 * own SDK already supports this natively; OpenAI/Ollama are implemented
 * with plain fetch specifically so they can share this exact same seam —
 * see openai.ts/ollama.ts's own doc comments for why plain fetch was
 * chosen over an SDK). A real end-to-end run can also point a provider at a
 * local fake server this way, the same pattern generateDraft.ts's own
 * README already documents for Anthropic via ANTHROPIC_BASE_URL.
 */
export interface GenerateTextTransport {
  fetch?: typeof fetch;
}

/** The common shape every provider module's own generateText-like function
 * implements — generateText.ts's dispatcher relies on this for type safety
 * when switching between them, even though each provider's real signature
 * also takes its own provider-specific config (API key, host/model, ...). */
export type GenerateTextFn = (
  params: GenerateTextParams,
  transport?: GenerateTextTransport
) => Promise<string>;
