import type { GenerateTextParams, GenerateTextTransport } from "./providers/types";
import { generateTextAnthropic } from "./providers/anthropic";
import { generateTextOpenAI } from "./providers/openai";
import { generateTextOllama } from "./providers/ollama";
import { resolveActiveProvider } from "./activeProvider";

export type { GenerateTextParams, GenerateTextTransport } from "./providers/types";

/**
 * The common internal interface AI Backend & Admin D3 introduces: one
 * `generateText({system, prompt, maxTokens}) => Promise<string>` entry
 * point, with three provider implementations behind it (see ./providers).
 * Which one actually runs is decided by app_settings.active_provider
 * (0072) — switching the active provider (via D2's admin UI, or directly
 * in app_settings for testing) changes which backend THIS function uses on
 * its very next call, with no redeploy and no restart.
 *
 * This is the module's one narrow use of resolveActiveProvider — a second,
 * separate call site from isAiConfigured() (see activeProvider.ts's own
 * header comment for why both exist and what each one does and doesn't
 * expose). The resolved provider/credentials are used immediately, in this
 * function's own stack frame, to build one outbound request to that
 * provider; nothing about app_settings' contents is ever part of this
 * function's return value, which is always just the generated text.
 *
 * Same injectable-`transport.fetch` testing seam as every provider it
 * dispatches to, and as generateDraft.ts's own pre-D3 generateNarrativeDraft
 * — unit tests substitute a canned response, and an end-to-end run can
 * point a provider at a local fake server.
 */
export async function generateText(
  params: GenerateTextParams,
  transport?: GenerateTextTransport
): Promise<string> {
  const resolved = await resolveActiveProvider();

  switch (resolved.provider) {
    case "anthropic":
      return generateTextAnthropic(params, transport);

    case "openai":
      if (!resolved.openaiApiKey) {
        throw new Error(
          "OpenAI is the active AI provider, but no API key is configured. Ask an app admin to set one in Admin settings."
        );
      }
      return generateTextOpenAI(params, { apiKey: resolved.openaiApiKey }, transport);

    case "ollama":
      if (!resolved.ollamaHostUrl || !resolved.ollamaModel) {
        throw new Error(
          "Ollama is the active AI provider, but its host URL and/or model are not configured. Ask an app admin to set them in Admin settings."
        );
      }
      return generateTextOllama(
        params,
        { hostUrl: resolved.ollamaHostUrl, model: resolved.ollamaModel },
        transport
      );

    default: {
      const exhaustive: never = resolved.provider;
      throw new Error(`Unknown AI provider: ${String(exhaustive)}`);
    }
  }
}
