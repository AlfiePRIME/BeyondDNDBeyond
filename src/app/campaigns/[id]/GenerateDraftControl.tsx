"use client";

import { useState } from "react";
import { Button, TextInput } from "@/ui-components";
import styles from "./generate-draft.module.css";

// Kept in sync with MAX_PROMPT_CHARS in @/ai — not imported from there
// because this is a client component and the ai module is server-only.
const MAX_PROMPT_LENGTH = 500;

const PLACEHOLDER: Record<"npc" | "lore", string> = {
  npc: "e.g. a suspicious dockworker who's secretly a smuggler",
  lore: "e.g. an abandoned watchtower overrun with ivy",
};

/**
 * The "Generate a draft" action shared by the NPC roster and lore-page
 * editors. The DM types a short plain-language brief; the app asks the
 * server's generate Route Handler for a draft and hands the text to the host
 * form via onDraft, where it pre-fills the description/body textarea as
 * fully editable content — nothing is saved until the form's own save
 * action, mirroring the D&D Beyond import's review-before-save flow.
 *
 * aiEnabled comes from a Server Component calling isAiConfigured() — when
 * false (no ANTHROPIC_API_KEY on the server) the action is replaced by an
 * explanation instead of a button that would error.
 */
export function GenerateDraftControl({
  campaignId,
  kind,
  aiEnabled,
  disabled,
  onDraft,
}: {
  campaignId: string;
  kind: "npc" | "lore";
  aiEnabled: boolean;
  disabled?: boolean;
  onDraft: (draft: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!aiEnabled) {
    return (
      <p className={styles.unavailable} data-testid={`generate-${kind}-draft-unavailable`}>
        AI drafting is off — this server has no Anthropic API key configured. Everything else
        works without it; add the key to the server&apos;s .env (see .env.example) to enable
        draft generation.
      </p>
    );
  }

  async function handleGenerate() {
    if (!prompt.trim() || generating) return;
    setError(null);
    setGenerating(true);
    try {
      const response = await fetch(`/campaigns/${campaignId}/generate-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), kind }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        draft?: string;
        message?: string;
      } | null;
      if (!response.ok || !payload?.ok || typeof payload.draft !== "string") {
        setError(payload?.message ?? "Couldn't generate a draft — try again.");
        return;
      }
      onDraft(payload.draft);
    } catch {
      setError("Couldn't generate a draft — try again.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <TextInput
          label="Generate a draft"
          className={styles.promptField}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={PLACEHOLDER[kind]}
          maxLength={MAX_PROMPT_LENGTH}
          disabled={disabled || generating}
          data-testid={`generate-${kind}-draft-prompt-input`}
        />
        <Button
          variant="teal"
          size="sm"
          className={styles.generateButton}
          disabled={disabled || generating || !prompt.trim()}
          onClick={handleGenerate}
          data-testid={`generate-${kind}-draft-button`}
        >
          {generating ? "Generating…" : "Generate"}
        </Button>
      </div>
      <p className={styles.hint}>
        Describe what you want in a sentence — the draft pre-fills the{" "}
        {kind === "npc" ? "description" : "content"} below for you to edit before saving.
      </p>
      {error ? (
        <p role="alert" className={styles.error} data-testid={`generate-${kind}-draft-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
