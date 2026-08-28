import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRawAiProviderConfig } from "./appSettings";

/** Minimal stub covering exactly the query shape getRawAiProviderConfig
 * issues — same scope/spirit as profiles.test.ts's own stubClient. */
function stubClient(row: Record<string, unknown> | null): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "app_settings") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: (columns: string) => {
          // getAppSettings and getRawAiProviderConfig select the same
          // columns today — assert that so a future divergence is caught,
          // not to constrain either function's own column list.
          expect(columns).toContain("active_provider");
          return {
            eq: () => ({
              maybeSingle: async () => ({ data: row, error: null }),
            }),
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("getRawAiProviderConfig", () => {
  it("returns the RAW row, including the actual openai_api_key plaintext", async () => {
    const config = await getRawAiProviderConfig(
      stubClient({
        active_provider: "openai",
        openai_api_key: "sk-real-secret-value",
        ollama_host_url: null,
        ollama_model: null,
      })
    );
    // Unlike getAppSettings, this is deliberately the one function in this
    // module that DOES hand back the plaintext — see its own doc comment
    // for why, and its only caller's (src/ai/activeProvider.ts) contract
    // for what happens to it next.
    expect(config?.openaiApiKey).toBe("sk-real-secret-value");
    expect(config?.activeProvider).toBe("openai");
  });

  it("returns null when the singleton row is missing", async () => {
    await expect(getRawAiProviderConfig(stubClient(null))).resolves.toBeNull();
  });

  it("maps ollama_host_url/ollama_model through unchanged", async () => {
    const config = await getRawAiProviderConfig(
      stubClient({
        active_provider: "ollama",
        openai_api_key: null,
        ollama_host_url: "http://localhost:11434",
        ollama_model: "llama3.1:8b",
      })
    );
    expect(config).toEqual({
      activeProvider: "ollama",
      openaiApiKey: null,
      ollamaHostUrl: "http://localhost:11434",
      ollamaModel: "llama3.1:8b",
    });
  });
});
