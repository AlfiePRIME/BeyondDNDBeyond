import Anthropic from "@anthropic-ai/sdk";

/** Which editor the draft is for — picks the system prompt and prose shape. */
export type DraftKind = "npc" | "lore";

// Haiku 4.5: a short creative-text draft doesn't need Sonnet/Opus-tier
// reasoning, and the DM is waiting on the response in a modal. Shared with
// generateMapArea — structured area drafts are schema-constrained fill-in
// work, not deep reasoning, so the same fast tier fits there too.
export const MODEL = "claude-haiku-4-5-20251001";

const MAX_DRAFT_TOKENS = 1024;

export const MAX_PROMPT_CHARS = 500;

const SYSTEM_PROMPTS: Record<DraftKind, string> = {
  npc: [
    "You are a prep assistant for a Dungeons & Dragons 5e campaign.",
    "The DM will give you a short brief for a non-player character; write the",
    "description field of their NPC roster entry. Two or three short paragraphs",
    "of evocative, table-usable prose: appearance and manner, how they speak and",
    "act, and any hook or secret the brief implies. Plain prose only — no",
    "markdown headings, no stat blocks, no bullet lists, and no preamble like",
    '"Here is your NPC". Do not invent a name if the brief doesn\'t give one;',
    'refer to them by role (e.g. "the dockworker") instead.',
  ].join(" "),
  lore: [
    "You are a prep assistant for a Dungeons & Dragons 5e campaign.",
    "The DM will give you a short brief for a page in their campaign's lore",
    "wiki; write the body of that page. Two to four short paragraphs in an",
    "in-world encyclopedia tone: what the place, faction, event, or thing is,",
    "its history or significance, and a rumor or unresolved thread the DM can",
    "pull on later. Plain prose only — no markdown headings, no bullet lists,",
    'and no preamble like "Here is your lore page".',
  ].join(" "),
};

/**
 * Whether the external LLM integration is usable at all. Server-side only —
 * call it from Server Components / Route Handlers and pass the boolean down,
 * never from client code (the key must not shape a client bundle).
 */
export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Exported for unit tests — the exact request body sent to the Messages API. */
export function buildDraftRequest(
  prompt: string,
  kind: DraftKind
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: MAX_DRAFT_TOKENS,
    system: SYSTEM_PROMPTS[kind],
    messages: [{ role: "user", content: prompt }],
  };
}

/** Exported for unit tests — pulls the draft prose out of an API response. */
export function extractDraftText(message: Anthropic.Message): string {
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
 * Generate a short editable draft (an NPC description or a lore-page body)
 * from the DM's plain-language brief. Requires ANTHROPIC_API_KEY — callers
 * should gate on isAiConfigured() first.
 *
 * `transport.fetch` is the injectable seam for tests: the Anthropic client
 * routes every HTTP call through it (and honors ANTHROPIC_BASE_URL from the
 * environment), so both unit tests and end-to-end runs can substitute a fake
 * Messages API response without a real key or network call.
 */
export async function generateNarrativeDraft(
  prompt: string,
  kind: DraftKind,
  transport?: { fetch?: typeof fetch }
): Promise<string> {
  if (!isAiConfigured()) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("A prompt is required to generate a draft.");
  }
  const client = new Anthropic({ fetch: transport?.fetch });
  const message = await client.messages.create(
    buildDraftRequest(trimmed.slice(0, MAX_PROMPT_CHARS), kind)
  );
  return extractDraftText(message);
}
