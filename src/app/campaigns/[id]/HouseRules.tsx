"use client";

import { useState } from "react";
import { Button } from "@/ui-components";
import { setHouseRules } from "@/data-access";
import { createBrowserSupabaseClient } from "@/data-access/supabase-browser";
import styles from "./campaign.module.css";

/**
 * A single free-text field on campaigns itself (Prompt 32), not a list like
 * dm_notes or session_log — one running house-rules document per campaign,
 * editable in place by the DM.
 */
export function HouseRules({
  campaignId,
  initialHouseRules,
  canManage,
}: {
  campaignId: string;
  initialHouseRules: string | null;
  canManage: boolean;
}) {
  const [houseRules, setHouseRulesState] = useState(initialHouseRules ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setDraft(houseRules);
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await setHouseRules(createBrowserSupabaseClient(), campaignId, draft.trim());
      setHouseRulesState(draft.trim());
      setEditing(false);
    } catch {
      setError("Couldn't save house rules — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {editing ? (
        <div className={styles.houseRulesForm}>
          <label className={styles.textareaField}>
            <span className={styles.textareaLabel}>House rules</span>
            <textarea
              className={styles.textarea}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Action economy strictness, house-specific crit rules, table etiquette…"
              disabled={busy}
              data-testid="house-rules-input"
            />
          </label>
          <div className={styles.houseRulesActions}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="accent"
              disabled={busy}
              onClick={handleSave}
              data-testid="save-house-rules-button"
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
          {error ? (
            <p role="alert" className={styles.errorText} data-testid="house-rules-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {houseRules ? (
            <p className={styles.houseRulesText} data-testid="house-rules-text">
              {houseRules}
            </p>
          ) : (
            <p className={styles.emptyHint} data-testid="house-rules-empty">
              {canManage
                ? "No house rules yet — document any table-specific agreements here."
                : "The DM hasn't documented any house rules yet."}
            </p>
          )}
          {canManage ? (
            <Button size="sm" variant="ghost" onClick={startEditing} data-testid="edit-house-rules-button">
              Edit house rules
            </Button>
          ) : null}
        </>
      )}
    </>
  );
}
