// Public entry point for the image-ai module (Map Art Generation E4) — this
// app's ComfyUI/image-generation integration, deliberately kept OUT of
// src/ai: src/ai's whole shape (a single text-completion interface,
// SDK-per-provider) is built around LLM text generation, while ComfyUI's
// request/response shape (a node-graph workflow JSON in, polling, a binary
// image out) is architecturally distant enough to deserve its own
// boundary-enforced module rather than overloading src/ai's contract — see
// docs/map-art-generation-research.md and this prompt's own notes.
//
// This is the ONLY module allowed to talk to a ComfyUI host directly,
// mirroring src/ai's own @anthropic-ai/sdk restriction (see
// eslint.config.mjs's boundaries/dependencies + no-restricted-imports
// entries for "image-ai"): every consumer goes through generateMapArt()
// here instead of standing up its own ComfyUI client or raw fetch calls
// against a ComfyUI host. (ComfyUI has no first-party npm SDK to gate an
// import-based rule on — ComfyClient/comfyClient.ts's real fetch calls ARE
// the "SDK" here — so the enforceable half of the mirror is the same one
// src/ai's own OpenAI/Ollama entries already rely on: nothing outside this
// module may import anything but this barrel, exactly like "@/ai/**" is
// barrel-only today.)
//
// Server-side only — Route Handlers/Server Components may import this;
// client components must never (they get a boolean prop derived from
// isMapArtConfigured() and call a generate Route Handler over fetch, the
// same shape @/ai's generateNarrativeDraft/generateMapArea already
// established).
export { generateMapArt, type GenerateMapArtParams, type GeneratedMapArt } from "./generateMapArt";
export {
  ComfyClient,
  ComfyUiError,
  ComfyUiUnreachableError,
  ComfyUiWorkflowRejectedError,
  ComfyUiGenerationError,
  ComfyUiTimeoutError,
  DEFAULT_GENERATION_TIMEOUT_MS,
  type ComfyClientOptions,
} from "./comfyClient";
export { buildMapArtWorkflow, MODELS, DEFAULTS, type MapArtWorkflowParams } from "./workflow";
