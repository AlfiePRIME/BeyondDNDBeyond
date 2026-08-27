// Re-exports the canonical GPU_LAUNCH_ARGS constant from
// scripts/db/lib/browser.mjs — that file's own doc comment has the full
// "why these three flags, confirmed via a real renderer-string check"
// reasoning, which applies identically here; this module exists only so a
// script under scripts/perf/ can `import { GPU_LAUNCH_ARGS } from
// "./lib/browser.mjs"` (the same relative-import shape every scripts/db/
// verify-*.mjs script already uses) without duplicating that constant (and
// its reasoning) a second time in a second location.
export { GPU_LAUNCH_ARGS } from "../../db/lib/browser.mjs";
