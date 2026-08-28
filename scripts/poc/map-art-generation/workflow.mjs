// The ONE fixed default ComfyUI workflow this spike settled on (E1
// deliverable #4) — no admin-editable workflow JSON in v1, so this is the
// single shape E2-E6 build against. Every node type/input here was
// confirmed against the real instance's /object_info before use; see
// docs/map-art-generation-research.md for the reasoning behind each
// choice (why UNETLoader+CLIPLoader(type:"flux2") instead of
// CheckpointLoaderSimple, why ReferenceLatent instead of a ControlNet
// node, why the turbo LoRA, why 8 steps).
import { controlImageCategory } from "./controlImage.mjs";

export const MODELS = {
  unet: "flux2_dev_fp8mixed.safetensors",
  clip: "mistral_3_small_flux2_fp8.safetensors",
  vae: "flux2-vae.safetensors",
  turboLora: "Flux_2-Turbo-LoRA_comfyui.safetensors",
};

// Live-tested default sampling settings (docs/map-art-generation-research.md's
// "settled defaults" section) — 8 steps only works this well BECAUSE the
// turbo LoRA is loaded; without it this step count would underbake badly.
export const DEFAULTS = {
  steps: 8,
  guidance: 2.5,
  loraStrength: 1.0,
  samplerName: "euler",
};

/** A minimal, unconditioned text-to-image graph — deliberately the
 * SMALLEST possible real workflow, used only to prove the queue/poll/fetch
 * mechanics and the checkpoint/CLIP/VAE loading path work at all,
 * independent of the map-art-specific conditioning wiring below. */
export function buildBaselineWorkflow({
  prompt,
  width = 512,
  height = 512,
  steps = DEFAULTS.steps,
  guidance = DEFAULTS.guidance,
  seed = 0,
  filenamePrefix = "poc_baseline",
} = {}) {
  return {
    unet: { class_type: "UNETLoader", inputs: { unet_name: MODELS.unet, weight_dtype: "default" } },
    lora: {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["unet", 0], lora_name: MODELS.turboLora, strength_model: DEFAULTS.loraStrength },
    },
    clip: { class_type: "CLIPLoader", inputs: { clip_name: MODELS.clip, type: "flux2" } },
    vae: { class_type: "VAELoader", inputs: { vae_name: MODELS.vae } },
    pos: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["clip", 0] } },
    guidance: { class_type: "FluxGuidance", inputs: { conditioning: ["pos", 0], guidance } },
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

/**
 * The real map-art default: the same graph as buildBaselineWorkflow, plus
 * the control image loaded, VAE-encoded, and stitched into the positive
 * conditioning via ReferenceLatent — FLUX.2's own native in-context
 * image-conditioning node (see the research doc's "conditioning approach"
 * section for why this is used instead of a classic ControlNet, which
 * has no model installed for FLUX on this instance). `width`/`height` MUST
 * match the uploaded control image's real pixel dimensions exactly (the
 * PoC's controlImage.mjs already rounds to a multiple of 16) — the encoded
 * reference latent and the freshly-generated empty latent share the same
 * canvas size, which is what makes this a same-layout edit rather than an
 * unrelated reference.
 */
export function buildMapArtWorkflow({
  controlImageFilename,
  prompt,
  width,
  height,
  steps = DEFAULTS.steps,
  guidance = DEFAULTS.guidance,
  seed = 0,
  filenamePrefix = "map_art",
}) {
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

// One legend line per category, fixed to match controlImage.mjs's actual
// HUE_BY_CATEGORY assignment — kept as plain material descriptions (not
// "the red region") so the wording survives if the exact hue numbers are
// retuned later without the prompt going stale. Ordered so a room's
// structural elements (walls, floor, hazards) are described before
// decorative ground dressing, roughly the order a DM would narrate a room.
const LEGEND_LINES = {
  void: "Solid black areas are stone walls (or, outdoors, impassable rock/cliff) — opaque, no floor.",
  water: "Blue areas are water — a pool, pond, or lake.",
  pit: "Small violet/purple patches are dark bottomless pit holes in the floor.",
  normal: "Magenta-pink areas are plain unadorned floor.",
  difficult: "Bright red patches are a rubble/hazard strewn floor that's difficult to cross.",
  stone: "Pink/crimson areas are worked stone floor (flagstones).",
  rock: "Red-orange areas are bare natural rock ground.",
  path: "Orange/gold stripes are a worn dirt path.",
  sand: "Yellow areas are sandy ground.",
  swamp: "Olive/yellow-green areas are boggy swamp ground with reeds.",
  grass: "Green areas are open grass.",
  forest: "Saturated green areas are forest tree canopy seen from above.",
  dense_forest: "Teal-green areas are extra-dense forest canopy.",
};

// Lighter regions of the SAME hue are higher elevation (a step, terrace, or
// dais) than darker regions of that hue — stated once, generically, rather
// than as a per-map fact, since it's a fixed property of the control-image
// renderer's own encoding (controlImage.mjs's lightnessForElevation).
const ELEVATION_NOTE =
  "Within any single-colored region, a visibly lighter patch of that same color is raised higher " +
  "(a step, ledge, terrace, or dais) than a darker patch of it — render that as an actual change in " +
  "height, not just a lighter floor tint.";

/**
 * Builds the positive prompt from the map's OWN data — the reusable
 * mechanism E2-E6 need instead of this spike's hand-written per-fixture
 * prompts: scans which categories the grid actually uses (via the exact
 * same controlImageCategory precedence controlImage.mjs's renderer uses,
 * so the description can never mention a category that isn't really in
 * the image) and emits one line per category present, in each case
 * exactly matching the fixed palette baked into controlImage.mjs.
 *
 * Wording note (a real, live-tested finding — see
 * docs/map-art-generation-research.md's "prompt wording" section): an
 * earlier version of this framed the reference image as a "layout key" to
 * "reinterpret" and told the model each area "marks" a material. That
 * wording measurably backfired — the model treated the input as an
 * abstract reference chart and redrew it as a four-quadrant collage of
 * unrelated vignettes instead of one coherent map, discarding the actual
 * spatial layout it was conditioned on. The fix is to assert the input IS
 * already the map, verbatim, and to explicitly forbid rearranging,
 * duplicating, or tiling it — not just to describe the categories.
 */
export function buildLegendPrompt(gridWidth, gridHeight, overlay, defaultCell, styleNote) {
  const present = new Set();
  for (let y = 0; y < gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const state = overlay.get(`${x},${y}`) ?? defaultCell;
      present.add(controlImageCategory(state));
    }
  }

  const legend = Object.entries(LEGEND_LINES)
    .filter(([category]) => present.has(category))
    .map(([, line]) => line);

  return [
    "The attached reference image IS the top-down floorplan of a real map: every flat-colored area " +
      "already has its final shape, size, and position. Repaint it in place as painted fantasy " +
      "tabletop RPG battle-map art — do not redesign, rearrange, resize, duplicate, or tile any " +
      "region, and do not split the scene into separate panels or vignettes. It stays one single " +
      "continuous top-down scene with the same framing and aspect ratio as the reference. Replace " +
      "each flat color with the real material it represents, using this key:",
    ...legend,
    ELEVATION_NOTE,
    styleNote ??
      "Render with realistic top-down textures appropriate to each material (stone flagstones, " +
        "wood grain, rippling water, loose rubble, grass, tree canopy, sand, reeds) and natural " +
        "lighting, while leaving every region's boundary exactly where the reference image has it.",
  ].join("\n");
}
