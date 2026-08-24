// Public entry point for the rules-engine module. Other modules should only ever
// import from "@/rules-engine" (this file), never reach into internal files —
// enforced by eslint-plugin-boundaries (see eslint.config.mjs).
//
// Placeholder export to prove the module/test/lint wiring end to end. Real 5e
// rules logic (ability modifiers, saves, spell slots, etc.) arrives in Prompt 9.
export const MODULE_NAME = "rules-engine" as const;
