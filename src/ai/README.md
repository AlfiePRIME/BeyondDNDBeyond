# ai

LLM text generation behind a small typed interface. Module boundary registered in
`eslint.config.mjs` alongside the original five from Prompt 2: only this module may import
`@anthropic-ai/sdk` (or, should either provider ever gain one, an `openai`/`ollama` SDK
package — those disallow rules already exist, pre-emptively), and other modules import the
barrel (`@/ai`), not internal files.

**This is the app's one deliberate exception to being fully self-hosted** — well, three
exceptions now. Everything else runs on the local Supabase stack; this module calls out to
whichever external (Anthropic, OpenAI) or self-hosted-elsewhere (Ollama) LLM backend
`app_settings.active_provider` (0072) names. `isAiConfigured()` reflects the ACTIVE
provider's own specific readiness — Anthropic's env var, OpenAI's stored key, or Ollama's
stored host+model — not just Anthropic's. When it's false, every AI-assisted surface hides
itself with an explanation instead of erroring. Nothing provider-shaped (keys, hosts, model
ids) ever reaches a client bundle: client components receive a boolean derived from
`isAiConfigured()` in a Server Component and call a Route Handler.

## AI Backend & Admin D3 — the common provider interface

`generateText({system, prompt, maxTokens}) => Promise<string>` (`generateText.ts`) is the
common interface every provider implements (`providers/anthropic.ts`, `providers/openai.ts`,
`providers/ollama.ts`) — switching `active_provider` (via the `/admin` UI, D2) changes which
one `generateText()` actually calls, with no redeploy. `generateNarrativeDraft` below is its
first real consumer.

- **Anthropic** (`providers/anthropic.ts`) — the pre-D3 behavior, refactored to fit the
  interface: same request/response shape, model upgraded to `claude-sonnet-5` per the project
  owner's request (was `claude-haiku-4-5-20251001`). Its own SDK's native fetch-injection is
  the testing seam.
- **OpenAI** (`providers/openai.ts`) — plain `fetch` to `/v1/chat/completions` (`gpt-4o-mini`),
  deliberately not the `openai` npm package: this module needs exactly one REST round trip,
  and staying on `fetch` means every provider shares one testing seam instead of Anthropic
  having the SDK's and OpenAI having a different one. See the file's own doc comment.
- **Ollama** (`providers/ollama.ts`) — plain fetch to the configured host's own `/api/chat`;
  no SDK exists to speak of. Two DELIBERATELY separate timeouts: a short one (a few seconds)
  on a `/api/version` reachability probe, so a wrong host or a down service fails fast with a
  specific error instead of hanging; a much longer one (3 minutes) on the real `/api/chat`
  generation call, since local inference on modest hardware genuinely takes tens of seconds
  to a couple of minutes and must not be killed by the reachability check's short budget. See
  the file's own doc comment for the (measured, not guessed) reasoning behind both numbers.

`isAiConfigured()` lives in `activeProvider.ts`, not `generateDraft.ts`, as of D3 — it (and
its internal sibling `resolveActiveProvider`, used only by `generateText()`'s own dispatch)
are the only two things in this module that read `app_settings` at all, and they do it via a
narrow, server-side-only, service-role Supabase client
(`@/data-access/supabase-service-role`) specifically because a non-admin DM's own session is
blocked by RLS from reading that table, yet still needs an accurate yes/no answer and a
working "Generate" action. `isAiConfigured()` returns ONLY a boolean, never the row or any
secret, regardless of who calls it. See `activeProvider.ts`'s own header comment for the full
story, and `@/data-access/supabase-service-role`'s doc comment for why this exception exists
at all.

`generateMapArea.ts` and `generateSessionSummary.ts` (below) stay Anthropic-only regardless
of `active_provider` — they use Anthropic's forced-tool-use structured output, which the
common `generateText()` interface (plain text in, plain text out) doesn't cover for the other
two providers. They gate on `isAnthropicConfigured()` (`providers/anthropic.ts`), a plain,
synchronous, database-free check of `ANTHROPIC_API_KEY` alone — gating them on the
multi-provider `isAiConfigured()` instead would be a real bug (a "Generate Area" button that
lit up because Ollama was configured, then failed every time it was clicked, since the
function behind it only ever calls Anthropic).

As of Prompt 37, `generateDraft.ts`:

- `generateNarrativeDraft(prompt, kind)` — a short editable draft from a DM's
  plain-language brief, `kind: "npc" | "lore"` selecting a per-kind system prompt (an NPC
  draft reads like a roster description, a lore draft like a wiki entry). As of D3, this
  calls the common `generateText()` — which provider actually runs it depends on
  `app_settings.active_provider` (default: Anthropic, same model and behavior as before D3).
  Consumed by the DM-gated Route Handler at `src/app/campaigns/[id]/generate-draft/route.ts`,
  whose UI (the NPC roster and lore-page editors) shows the result as pre-filled, fully
  editable, not-yet-saved form content — the same review-before-save shape as the D&D Beyond
  import.

Testability without a key: the network call is injectable — `generateNarrativeDraft` (and
every provider's own `generateText`-shaped function) accepts a custom `fetch` (unit tests
substitute a canned response), and Anthropic's SDK additionally honors `ANTHROPIC_BASE_URL`,
so an end-to-end run can point the server at a local fake. Each provider file exports its own
`build*Request`/`extract*Text` pair for direct unit testing of request construction and
response handling.

As of Prompt 38, `generateMapArea.ts` extends the module (same client construction, same
injectable-fetch seam — no second API client):

- `generateMapArea(prompt, region, assets)` — a structured map-area draft for a DM-selected
  region of the map editor's grid: sparse per-cell terrain/elevation plus object placements
  drawn only from the campaign's asset palette. Structured output comes from forced tool use
  (a strict-schema `propose_map_area` tool with `tool_choice` pinned to it), which is far
  more reliable than parsing JSON out of prose. The model reasons in region-relative
  coordinates (0..width-1 / 0..height-1) so bounds-checking is trivial; callers translate to
  absolute grid coordinates. Same Haiku model as the narrative drafts — schema-constrained
  fill-in work, not deep reasoning.
- `validateGeneratedArea(draft, region, assets, occupiedCells?)` — the server-side gate
  between the model's output and anything a DM ever sees: coordinates in-region, terrain a
  real `TerrainType`, elevations sane integers, every asset reference resolved by id against
  the campaign's actual palette (the same `listAssetsForCampaign` result the prompt was built
  from), object elevation consistent with its cell's generated ground, no duplicate cells or
  stacked objects. Nothing from the model is trusted, including the shape itself.
  `occupiedCells` (region-relative keys) marks cells a pre-existing live object already
  sits on — the model is never told about these, so a proposal landing there is quietly
  dropped from the result rather than failing validation and burning a retry the model has
  no way to act on.
- On a validation failure `generateMapArea` retries exactly once, feeding the validation
  errors back to the model as feedback; a second failure throws `AreaGenerationError`, which
  the consuming Route Handler (`src/app/campaigns/[id]/maps/[mapId]/generate-area/route.ts`,
  same auth/DM gating as generate-draft, but isAnthropicConfigured- not isAiConfigured-gated —
  see this file's own note above) surfaces as a clear
  generation-failed message — a partially-invalid draft is never forwarded to the client.
  The route computes `occupiedCells` from the map's existing objects inside the selected
  region before calling `generateMapArea`. The editor renders the validated draft as an
  adjustable preview; nothing persists until the DM explicitly accepts it.
