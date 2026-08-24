"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, TextInput } from "@/ui-components";
import { createLorePage } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import { GenerateDraftControl } from "../../GenerateDraftControl";
import styles from "../lore.module.css";

export function NewLorePageForm({
  campaignId,
  aiEnabled,
}: {
  campaignId: string;
  /** Resolved server-side via isAiConfigured() — gates the generate action. */
  aiEnabled: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!title.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const page = await createLorePage(supabase, {
        campaignId,
        title,
        body: body.trim() || undefined,
      });
      router.push(`/campaigns/${campaignId}/lore/${page.id}`);
    } catch {
      setError("Couldn't create this page — try again.");
      setBusy(false);
    }
  }

  return (
    <div className={styles.form}>
      <TextInput
        label="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="e.g. The Sunken Keep"
        disabled={busy}
        data-testid="lore-page-title-input"
      />
      <GenerateDraftControl
        campaignId={campaignId}
        kind="lore"
        aiEnabled={aiEnabled}
        disabled={busy}
        onDraft={setBody}
      />
      <label className={styles.textareaField}>
        <span className={styles.textareaLabel}>Content</span>
        <textarea
          className={styles.textarea}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="The history, the rumors, the truth…"
          disabled={busy}
          data-testid="lore-page-body-input"
        />
      </label>
      {error ? (
        <p role="alert" className={styles.errorText} data-testid="lore-page-form-error">
          {error}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <Button
          variant="accent"
          disabled={busy || !title.trim()}
          onClick={handleCreate}
          data-testid="save-lore-page-button"
        >
          {busy ? "Creating…" : "Create page"}
        </Button>
      </div>
    </div>
  );
}
