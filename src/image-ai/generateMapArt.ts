import { ComfyClient, DEFAULT_GENERATION_TIMEOUT_MS, type ComfyClientOptions } from "./comfyClient";
import { buildMapArtWorkflow } from "./workflow";

export interface GenerateMapArtParams {
  /** The configured ComfyUI host (app_settings.comfyui_host_url, E2). */
  hostUrl: string;
  /** The map's tuned control image (E3's renderMapArtControlImagePng),
   * already PNG-encoded. */
  controlImagePng: Buffer;
  /** MUST be the control image's own real pixel dimensions — see
   * workflow.ts's own note on why. */
  width: number;
  height: number;
  /** The finished prompt (e.g. src/app/campaigns/[id]/maps/lib/mapArtPrompt
   * .ts's buildMapArtPrompt output) — this module never builds a prompt
   * itself, only sends the one it's given. */
  prompt: string;
  /** Defaults to a fresh random seed per call, not a fixed one: a DM who
   * doesn't like a result and clicks Generate again should get a genuinely
   * different image for the same map/prompt, not a byte-identical repeat of
   * the same deterministic output. */
  seed?: number;
  /** Generation-wait timeout — defaults to DEFAULT_GENERATION_TIMEOUT_MS.
   * NEVER pass a short "is the host up" timeout here; see comfyClient.ts's
   * own header comment on why the two budgets are deliberately separate. */
  timeoutMs?: number;
  /** The SHORT reachability-check timeout — defaults to
   * ComfyClient.checkReachable's own default. Separate parameter, on
   * purpose, from `timeoutMs` above. */
  reachabilityTimeoutMs?: number;
}

export interface GeneratedMapArt {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * The one production entry point for turning a map's control image + a
 * finished prompt into a real generated PNG via a live ComfyUI instance:
 * check reachability first (fast-fail, its own short timeout — see
 * GenerateMapArtParams.reachabilityTimeoutMs), upload the control image,
 * queue E1's fixed buildMapArtWorkflow graph, wait synchronously for
 * completion (a real multi-minute wait — this project's no-background-
 * polling convention, applied to a real long-running job rather than
 * assumed away), and fetch the resulting PNG. Every ComfyUI HTTP call this
 * app ever makes funnels through here and comfyClient.ts underneath it —
 * see eslint.config.mjs's image-ai module boundary, mirroring src/ai's own
 * @anthropic-ai/sdk restriction.
 *
 * Throws one of comfyClient.ts's ComfyUiError subclasses on any failure
 * (unreachable host, rejected workflow, mid-run failure, or timeout) — never
 * a generic Error — so callers (the generate-art Route Handler) can surface
 * a specific, actionable message instead of "something went wrong".
 */
export async function generateMapArt(
  params: GenerateMapArtParams,
  transport?: ComfyClientOptions
): Promise<GeneratedMapArt> {
  const client = new ComfyClient(params.hostUrl, transport);
  await client.checkReachable(params.reachabilityTimeoutMs);

  const controlImageFilename = await client.uploadImage(params.controlImagePng, "map-art-control.png");
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 31);
  const graph = buildMapArtWorkflow({
    controlImageFilename,
    prompt: params.prompt,
    width: params.width,
    height: params.height,
    seed,
  });

  const promptId = await client.queuePrompt(graph);
  const images = await client.waitForImages(promptId, {
    timeoutMs: params.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
  });
  const png = await client.fetchImage(images[0]);
  return { png, width: params.width, height: params.height };
}
