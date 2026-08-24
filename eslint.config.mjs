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
      ],
    },
    rules: {
      // Every module boundary rule below exists to keep the five modules
      // established in Prompt 2 independently changeable — see that prompt's
      // README section on module boundaries before adding a new exception.
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
              // rules-engine is pure game logic: no UI, DB, realtime, or scene deps.
              from: { element: { type: "rules-engine" } },
              disallow: {
                to: {
                  element: {
                    types: { anyOf: ["data-access", "realtime", "scene-3d", "ui-components", "app"] },
                  },
                },
              },
              message:
                "rules-engine must stay pure — no UI, database, realtime, or 3D scene dependencies.",
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
