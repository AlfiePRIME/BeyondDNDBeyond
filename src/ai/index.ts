// Public entry point for the ai module — the app's one external, non-self-
// hosted integration (Anthropic, OpenAI, and Ollama — see README.md). This
// is the ONLY module allowed to import @anthropic-ai/sdk (or, should a
// future prompt add one, an "openai"/"ollama" SDK package) directly —
// enforced by eslint-plugin-boundaries (see eslint.config.mjs) — so every
// consumer reuses this module's own generateText() instead of standing up
// its own client.
//
// Server-side only. isAiConfigured() (AI Backend & Admin D3) reflects
// app_settings.active_provider's own readiness via a narrow, server-side-
// only service-role Supabase read — see activeProvider.ts's own header
// comment for the full access-control story. Route Handlers and Server
// Components may import this module; client components must never — they
// get a boolean prop derived from isAiConfigured() and call a generate
// Route Handler over fetch.
export {
  generateNarrativeDraft,
  MAX_PROMPT_CHARS,
  MODEL,
  type DraftKind,
} from "./generateDraft";
export { isAiConfigured } from "./activeProvider";
export { generateText, type GenerateTextParams, type GenerateTextTransport } from "./generateText";
export { isAnthropicConfigured } from "./providers/anthropic";
export {
  generateMapArea,
  validateGeneratedArea,
  AreaGenerationError,
  MAX_AREA_CELLS,
  type AreaAsset,
  type AreaRegionSize,
  type GeneratedArea,
  type GeneratedAreaCell,
  type GeneratedAreaObject,
} from "./generateMapArea";
export {
  generateSessionSummary,
  buildSessionSummaryRequest,
  extractSessionSummaryDraft,
  validateGeneratedSessionSummary,
  SessionSummaryGenerationError,
  SESSION_SUMMARY_MODEL,
  SESSION_SUMMARY_HIGHLIGHT_KINDS,
  type SessionSummaryChatInput,
  type SessionSummaryEventInput,
  type SessionSummaryWindow,
  type SessionSummaryHighlightKind,
  type SessionSummaryHighlightDraft,
  type GeneratedSessionSummary,
} from "./generateSessionSummary";
