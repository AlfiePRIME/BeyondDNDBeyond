// The ONE fixed default ComfyUI workflow (Map Art Generation E1 deliverable
// #4 — docs/map-art-generation-research.md §9) — no admin-editable workflow
// JSON in this version, so this exact graph shape is what every real
// generateMapArt() call sends. Ported near-verbatim from
// scripts/poc/map-art-generation/workflow.mjs's buildMapArtWorkflow (the
// research doc's own recommendation #3: "unmodified in structure"). The only
// real change from the PoC is TypeScript types plus dropping
// buildLegendPrompt/LEGEND_LINES, which the PoC colocated here for
// convenience: production prompt-building lives in the app layer instead
// (src/app/campaigns/[id]/maps/lib/mapArtPrompt.ts), since it needs the real
// CellState/GroundType/TerrainType types this architecturally-separate
// module has no business depending on — this file only ever receives the
// FINISHED prompt string.
export const MODELS = {
  unet: "flux2_dev_fp8mixed.safetensors",
  clip: "mistral_3_small_flux2_fp8.safetensors",
  vae: "flux2-vae.safetensors",
  turboLora: "Flux_2-Turbo-LoRA_comfyui.safetensors",
} as const;

// Live-tested default sampling settings (research doc's "settled defaults")
// — 8 steps only works this well BECAUSE the turbo LoRA is loaded; without
// it this step count would underbake badly.
export const DEFAULTS = {
  steps: 8,
  guidance: 2.5,
  loraStrength: 1.0,
  samplerName: "euler",
} as const;

export interface MapArtWorkflowParams {
  /** The filename ComfyUI's own /upload/image returned for the uploaded
   * control PNG. */
  controlImageFilename: string;
  prompt: string;
  /** MUST exactly match the uploaded control image's real pixel dimensions
   * — see this file's own note below on why. */
  width: number;
  height: number;
  steps?: number;
  guidance?: number;
  seed?: number;
  filenamePrefix?: string;
}

/**
 * The real map-art workflow: a control image loaded, VAE-encoded, and
 * stitched into the positive conditioning via ReferenceLatent — FLUX.2's own
 * native in-context image-conditioning node (research doc §2 on why this
 * replaces a classic ControlNet, which has no model installed for FLUX on
 * the validated instance). `width`/`height` MUST match the uploaded control
 * image's real pixel dimensions exactly — the encoded reference latent and
 * the freshly-generated empty latent share the same canvas size, which is
 * what makes this a same-layout edit rather than an unrelated reference.
 */
export function buildMapArtWorkflow(params: MapArtWorkflowParams): Record<string, unknown> {
  const {
    controlImageFilename,
    prompt,
    width,
    height,
    steps = DEFAULTS.steps,
    guidance = DEFAULTS.guidance,
    seed = 0,
    filenamePrefix = "map_art",
  } = params;

  return {
    loadimg: { class_type: "LoadImage", inputs: { image: controlImageFilename } },
    unet: { class_type: "UNETLoader", inputs: { unet_name: MODELS.unet, weight_dtype: "default" } },
    lora: {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["unet", 0], lora_name: MODELS.turboLora, strength_model: DEFAULTS.loraStrength },
    },
    clip: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.clip, type: "flux2" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: MODELS.vae } },
    refLatent: { class_type: "VAEEncode", inputs: { pixels: ["loadimg", 0], vae: ["vae", 0] } },
    pos: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["clip", 0] } },
    refCond: { class_type: "ReferenceLatent", inputs: { conditioning: ["pos", 0], latent: ["refLatent", 0] } },
    guidance: { class_type: "FluxGuidance", inputs: { conditioning: ["refCond", 0], guidance } },
    noise: { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    samplerSel: { class_type: "KSamplerSelect", inputs: { sampler_name: DEFAULTS.samplerName } },
    sigmas: { class_type: "Flux2Scheduler", inputs: { steps, width, height } },
    guider: { class_type: "BasicGuider", inputs: { model: ["lora", 0], conditioning: ["guidance", 0] } },
    latent: { class_type: "EmptyFlux2LatentImage", inputs: { width, height, batch_size: 1 } },
    sample: {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["noise", 0],
        guider: ["guider", 0],
        sampler: ["samplerSel", 0],
        sigmas: ["sigmas", 0],
        latent_image: ["latent", 0],
      },
    },
    decode: { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["vae", 0] } },
    save: { class_type: "SaveImage", inputs: { images: ["decode", 0], filename_prefix: filenamePrefix } },
  };
}
