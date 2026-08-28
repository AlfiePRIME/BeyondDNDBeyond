import { afterEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@/data-access";
import { isAiConfigured, resolveActiveProvider } from "./activeProvider";

/** Minimal stub covering exactly the query shape activeProvider.ts (via
 * getRawAiProviderConfig) issues — same scope/spirit as
 * profiles.test.ts's own stubClient. Never touches a real database, unlike
 * the real service-role client this module constructs in production. */
function stubClient(
  row: {
    active_provider: string;
    openai_api_key: string | null;
    ollama_host_url: string | null;
    ollama_model: string | null;
  } | null
): SupabaseClient {
  return {
    from: (table: string) => {
      if (table !== "app_settings") throw new Error(`unexpected table in stub: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

function throwingClient(): SupabaseClient {
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

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
});

describe("isAiConfigured", () => {
  it("returns a strict boolean — never the row or any secret value — even when a real secret is present", async () => {
    const secret = "sk-real-secret-value-should-never-leak";
    const client = stubClient({
      active_provider: "openai",
      openai_api_key: secret,
      ollama_host_url: null,
      ollama_model: null,
    });

    const result = await isAiConfigured(client);

    expect(result).toBe(true);
    expect(typeof result).toBe("boolean");
    // Belt-and-braces: inspect exactly what the function returned, not just
    // that some caller renders correctly around it.
    expect(JSON.stringify(result)).toBe("true");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("reflects Anthropic's own env var when Anthropic is the active provider", async () => {
    const client = stubClient({
      active_provider: "anthropic",
      openai_api_key: null,
      ollama_host_url: null,
      ollama_model: null,
    });

    delete process.env.ANTHROPIC_API_KEY;
    expect(await isAiConfigured(client)).toBe(false);

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(await isAiConfigured(client)).toBe(true);
  });

  it("reflects OpenAI's stored key presence when OpenAI is active — regardless of ANTHROPIC_API_KEY", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"; // deliberately set; must not matter

    const noKey = stubClient({
      active_provider: "openai",
      openai_api_key: null,
      ollama_host_url: null,
      ollama_model: null,
    });
    expect(await isAiConfigured(noKey)).toBe(false);

    const withKey = stubClient({
      active_provider: "openai",
      openai_api_key: "sk-openai-real",
      ollama_host_url: null,
      ollama_model: null,
    });
    expect(await isAiConfigured(withKey)).toBe(true);
  });

  it("reflects Ollama's stored host+model presence when Ollama is active — both fields required", async () => {
    const hostOnly = stubClient({
      active_provider: "ollama",
      openai_api_key: null,
      ollama_host_url: "http://localhost:11434",
      ollama_model: null,
    });
    expect(await isAiConfigured(hostOnly)).toBe(false);

    const modelOnly = stubClient({
      active_provider: "ollama",
      openai_api_key: null,
      ollama_host_url: null,
      ollama_model: "llama3.1:8b",
    });
    expect(await isAiConfigured(modelOnly)).toBe(false);

    const both = stubClient({
      active_provider: "ollama",
      openai_api_key: null,
      ollama_host_url: "http://localhost:11434",
      ollama_model: "llama3.1:8b",
    });
    expect(await isAiConfigured(both)).toBe(true);
  });

  it("fails closed (false) rather than throwing when the underlying read fails", async () => {
    await expect(isAiConfigured(throwingClient())).resolves.toBe(false);
  });

  it("defaults to treating Anthropic as active when the app_settings row is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await isAiConfigured(stubClient(null))).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(await isAiConfigured(stubClient(null))).toBe(true);
  });
});

describe("resolveActiveProvider", () => {
  it("resolves the provider and only that provider's own credentials", async () => {
    const client = stubClient({
      active_provider: "ollama",
      openai_api_key: null,
      ollama_host_url: "http://localhost:11434",
      ollama_model: "llama3.1:8b",
    });
    const resolved = await resolveActiveProvider(client);
    expect(resolved).toEqual({
      provider: "ollama",
      openaiApiKey: undefined,
      ollamaHostUrl: "http://localhost:11434",
      ollamaModel: "llama3.1:8b",
    });
  });

  it("defaults to anthropic when the row is missing", async () => {
    const resolved = await resolveActiveProvider(stubClient(null));
    expect(resolved.provider).toBe("anthropic");
  });

  it("propagates a read failure to its caller, unlike isAiConfigured", async () => {
    await expect(resolveActiveProvider(throwingClient())).rejects.toThrow(/simulated read failure/);
  });
});
