import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRawAiProviderConfig, getRawMapArtConfig, isMapArtConfigured } from "./appSettings";

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

/** Minimal stub covering exactly the narrow query isMapArtConfigured
 * issues — only comfyui_host_url, never the full row. */
function mapArtStubClient(row: { comfyui_host_url: string | null } | null): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "app_settings") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: (columns: string) => {
          expect(columns).toBe("comfyui_host_url");
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

function mapArtThrowingClient(): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            throw new Error("simulated read failure");
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("isMapArtConfigured", () => {
  it("returns a strict boolean — never the row or the host URL itself — when a host URL is set", async () => {
    const hostUrl = "http://10.10.1.10:8188";
    const result = await isMapArtConfigured(mapArtStubClient({ comfyui_host_url: hostUrl }));

    expect(result).toBe(true);
    expect(typeof result).toBe("boolean");
    // Belt-and-braces, matching isAiConfigured's own test: inspect exactly
    // what the function returned, not just that some caller renders
    // correctly around it.
    expect(JSON.stringify(result)).toBe("true");
    expect(JSON.stringify(result)).not.toContain(hostUrl);
  });

  it("returns false when comfyui_host_url is null (not yet configured)", async () => {
    expect(await isMapArtConfigured(mapArtStubClient({ comfyui_host_url: null }))).toBe(false);
  });

  it("returns false when the singleton row is missing entirely", async () => {
    expect(await isMapArtConfigured(mapArtStubClient(null))).toBe(false);
  });

  it("fails closed (false) rather than throwing when the underlying read fails — this is the exact case a non-admin DM relies on to safely get a yes/no answer", async () => {
    await expect(isMapArtConfigured(mapArtThrowingClient())).resolves.toBe(false);
  });
});

/** Minimal stub covering exactly the query shape getRawMapArtConfig
 * issues — both ComfyUI columns, never the whole app_settings row. */
function rawMapArtStubClient(
  row: { comfyui_host_url: string | null; comfyui_style_prompt: string | null } | null
): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "app_settings") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: (columns: string) => {
          expect(columns).toBe("comfyui_host_url, comfyui_style_prompt");
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

describe("getRawMapArtConfig", () => {
  it("returns the RAW host URL and style prompt — unlike isMapArtConfigured, not just a boolean", async () => {
    const config = await getRawMapArtConfig(
      rawMapArtStubClient({
        comfyui_host_url: "http://10.10.1.10:8188",
        comfyui_style_prompt: "moody watercolor fantasy art",
      })
    );
    expect(config).toEqual({
      hostUrl: "http://10.10.1.10:8188",
      stylePrompt: "moody watercolor fantasy art",
    });
  });

  it("returns null values when neither ComfyUI column is set", async () => {
    const config = await getRawMapArtConfig(
      rawMapArtStubClient({ comfyui_host_url: null, comfyui_style_prompt: null })
    );
    expect(config).toEqual({ hostUrl: null, stylePrompt: null });
  });

  it("returns null when the singleton row is missing", async () => {
    await expect(getRawMapArtConfig(rawMapArtStubClient(null))).resolves.toBeNull();
  });
});
