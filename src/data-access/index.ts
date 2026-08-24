// Public entry point for the data-access module. This is the ONLY module allowed
// to import @supabase/supabase-js directly — enforced by eslint-plugin-boundaries
// (see eslint.config.mjs). Every other module goes through here for persistence.
export { supabase } from "./supabase-client";

export const MODULE_NAME = "data-access" as const;
