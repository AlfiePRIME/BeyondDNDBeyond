// Playwright's default headless Chromium launch falls back to SwiftShader
// (CPU-based WebGL software rendering) — confirmed via a real renderer-string
// check: with no launch args, WEBGL_debug_renderer_info reports "SwiftShader
// Device (Subzero)"; with these args, it reports the host's real GPU (e.g.
// "Mesa Intel(R) Graphics"). Every verify-*.mjs script here drives a heavy
// react-three-fiber scene, so this is a real, measured speedup, not a
// micro-optimization — use it for every chromium.launch() call in this
// directory instead of the bare default.
//
// Deliberately just these three: --ignore-gpu-blocklist and
// --disable-gpu-sandbox were tried too, but they weaken a real security
// boundary (Chromium's own GPU-process sandbox / blocklist) rather than
// just picking a rendering backend, and a subagent correctly declined to
// add them without direct user authorization. Confirmed via a live process
// check (the real chrome-headless-shell GPU process reporting
// --use-angle=gl-egl) that these three alone are sufficient for real GPU
// rendering on this host — the other two bought nothing extra.
export const GPU_LAUNCH_ARGS = ["--use-gl=angle", "--use-angle=gl-egl", "--enable-gpu-rasterization"];
