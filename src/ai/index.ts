// Public entry point for the ai module — the app's one external, non-self-
// hosted integration (the Anthropic API; see README.md). This is the ONLY
// module allowed to import @anthropic-ai/sdk directly — enforced by
// eslint-plugin-boundaries (see eslint.config.mjs) — so a future consumer
// (e.g. map-content generation) reuses this client instead of standing up a
// second one.
//
// Server-side only: everything here reads ANTHROPIC_API_KEY from the server
// process's environment. Route Handlers and Server Components may import it;
// client components must never — they get a boolean prop derived from
// isAiConfigured() and call the generate Route Handler over fetch.
export {
  isAiConfigured,
  generateNarrativeDraft,
  MAX_PROMPT_CHARS,
  type DraftKind,
} from "./generateDraft";
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
