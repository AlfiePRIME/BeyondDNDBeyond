# ai

LLM text generation behind a small typed interface — every call to the Anthropic API goes
through this module; no other module (and never the browser) talks to it directly. Module
boundary registered in `eslint.config.mjs` alongside the original five from Prompt 2, with
the same two enforcement rules: only this module may import `@anthropic-ai/sdk`, and other
modules import the barrel (`@/ai`), not internal files.

**This is the app's one deliberate exception to being fully self-hosted.** Everything else
runs on the local Supabase stack; this module calls the external Anthropic API and needs its
own credential, `ANTHROPIC_API_KEY` (see `.env.example`). The key is optional — with it
unset, `isAiConfigured()` is false and every AI-assisted surface hides itself with an
explanation instead of erroring. The key lives only in the server process's environment:
client components receive a boolean derived from `isAiConfigured()` in a Server Component
and call a Route Handler; nothing key-shaped ever reaches a client bundle.

As of Prompt 37, `generateDraft.ts`:

- `isAiConfigured()` — whether `ANTHROPIC_API_KEY` is set. Server-side only.
- `generateNarrativeDraft(prompt, kind)` — a short editable draft from a DM's
  plain-language brief, `kind: "npc" | "lore"` selecting a per-kind system prompt (an NPC
  draft reads like a roster description, a lore draft like a wiki entry). Runs on
  `claude-haiku-4-5-20251001` — the fast/cheap tier is the right fit for short creative
  drafts a DM is actively waiting on. Consumed by the DM-gated Route Handler at
  `src/app/campaigns/[id]/generate-draft/route.ts`, whose UI (the NPC roster and lore-page
  editors) shows the result as pre-filled, fully editable, not-yet-saved form content —
  the same review-before-save shape as the D&D Beyond import.

Testability without a key: the network call is injectable — `generateNarrativeDraft`
accepts a custom `fetch` (unit tests substitute a canned Messages API response), and the
underlying SDK honors `ANTHROPIC_BASE_URL`, so an end-to-end run can point the server at a
local fake. `buildDraftRequest`/`extractDraftText` are exported for direct unit testing of
prompt construction and response handling.

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
  same auth/DM/isAiConfigured gating as generate-draft) surfaces as a clear
  generation-failed message — a partially-invalid draft is never forwarded to the client.
  The route computes `occupiedCells` from the map's existing objects inside the selected
  region before calling `generateMapArea`. The editor renders the validated draft as an
  adjustable preview; nothing persists until the DM explicitly accepts it.
