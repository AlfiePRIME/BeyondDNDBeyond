import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "app", pattern: "src/app/**" },
        { type: "ui-components", pattern: "src/ui-components/**" },
        { type: "scene-3d", pattern: "src/scene-3d/**" },
        { type: "rules-engine", pattern: "src/rules-engine/**" },
        { type: "realtime", pattern: "src/realtime/**" },
        { type: "data-access", pattern: "src/data-access/**" },
        { type: "ai", pattern: "src/ai/**" },
      ],
      // Element patterns match folders, not individual files — proxy.ts (the
      // Next.js 16 rename of middleware.ts) is a lone top-level file Next.js
      // requires at this exact path, so it needs a file descriptor instead
      // (see the boundaries/dependencies policies below, which check
      // `file.category` for it in addition to `element.type` for everything
      // else).
      "boundaries/files": [{ category: "proxy", pattern: "src/proxy.ts" }],
    },
    rules: {
      // Every module boundary rule below exists to keep the modules
      // established in Prompt 2 (plus src/ai, added in Prompt 37 under the
      // same pattern) independently changeable — see that prompt's README
      // section on module boundaries before adding a new exception.
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          // External-origin imports (like @supabase/supabase-js) are skipped
          // by default — this plugin only checks local imports unless told
          // otherwise, which would silently defeat the data-access gatekeeper
          // policy below.
          checkAllOrigins: true,
          policies: [
            {
              // Only data-access may talk to Supabase directly.
              from: { element: { type: "!data-access" } },
              disallow: {
                to: { module: { origin: "external", source: "@supabase/supabase-js" } },
              },
              message:
                "Only the data-access module may import @supabase/supabase-js directly — go through @/data-access instead.",
            },
            {
              // Same rule for proxy.ts specifically — it's a lone file (not
              // a folder), so it's matched via file.category rather than
              // element.type and needs its own explicit entry.
              from: { file: { categories: { anyOf: ["proxy"] } } },
              disallow: {
                to: { module: { origin: "external", source: "@supabase/supabase-js" } },
              },
              message:
                "proxy.ts may not import @supabase/supabase-js directly — go through @/data-access instead.",
            },
            {
              // Only the ai module may talk to the Anthropic API directly —
              // same gatekeeper shape as the Supabase rule above, so the
              // external LLM credential and client stay in one place.
              from: { element: { type: "!ai" } },
              disallow: {
                to: { module: { origin: "external", source: "@anthropic-ai/sdk" } },
              },
              message:
                "Only the ai module may import @anthropic-ai/sdk directly — go through @/ai instead.",
            },
            {
              from: { file: { categories: { anyOf: ["proxy"] } } },
              disallow: {
                to: { module: { origin: "external", source: "@anthropic-ai/sdk" } },
              },
              message:
                "proxy.ts may not import @anthropic-ai/sdk directly — go through @/ai instead.",
            },
            {
              // rules-engine is pure game logic: no UI, DB, realtime, scene, or AI deps.
              from: { element: { type: "rules-engine" } },
              disallow: {
                to: {
                  element: {
                    types: {
                      anyOf: ["data-access", "realtime", "scene-3d", "ui-components", "app", "ai"],
                    },
                  },
                },
              },
              message:
                "rules-engine must stay pure — no UI, database, realtime, 3D scene, or AI dependencies.",
            },
          ],
        },
      ],
      // Entry-point enforcement: import a module's barrel (@/data-access),
      // never its internal files (@/data-access/supabase-server). A plain
      // core-ESLint rule rather than eslint-plugin-boundaries' equivalent
      // (boundaries/no-private) since that rule is deprecated in favor of a
      // relationship-graph API (parent/child/sibling/uncle) that isn't a
      // straightforward fit for a simple "entry point only" restriction.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/ui-components/**",
                "@/scene-3d/**",
                "@/rules-engine/**",
                "@/realtime/**",
                "@/ai/**",
              ],
              message:
                "Import from the module's barrel (e.g. \"@/ui-components\") instead of reaching into its internal files.",
            },
            {
              // data-access has three additional, deliberate entry points
              // beyond its main barrel — see the comment atop
              // src/data-access/index.ts for why (Next.js runtime
              // restrictions on next/headers, next/server, etc.).
              group: [
                "@/data-access/**",
                "!@/data-access/supabase-server",
                "!@/data-access/supabase-browser",
                "!@/data-access/supabase-middleware",
              ],
              message:
                "Import from the module's barrel (\"@/data-access\") or one of its three documented sub-entry-points, not another internal file.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not application source — the self-hosted Supabase Docker Compose
    // project (contains container-owned runtime data once it's been run).
    "supabase/**",
  ]),
]);

export default eslintConfig;
