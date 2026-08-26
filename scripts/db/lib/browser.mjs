// Playwright's default headless Chromium launch falls back to SwiftShader
// (CPU-based WebGL software rendering) — confirmed via a real renderer-string
// check: with no launch args, WEBGL_debug_renderer_info reports "SwiftShader
// Device (Subzero)"; with these args, it reports the host's real GPU (e.g.
// "Mesa Intel(R) Graphics"). Every verify-*.mjs script here drives a heavy
// react-three-fiber scene, so this is a real, measured speedup, not a
// micro-optimization — use it for every chromium.launch() call in this
// directory instead of the bare default.
export const GPU_LAUNCH_ARGS = [
  "--use-gl=angle",
  "--use-angle=gl-egl",
  "--enable-gpu-rasterization",
  "--ignore-gpu-blocklist",
  "--disable-gpu-sandbox",
];
